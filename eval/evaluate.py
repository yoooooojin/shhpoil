"""평가 스크립트: 라벨링한 글로 판단 엔진(/judge)과 키워드 방식을 비교한다.

    python3 eval/evaluate.py --labels data/labeled/A.csv,data/labeled/B.csv --show 흑백요리사2 \
        --keywords eval/keywords.흑백요리사2.json --watched 3,7,10,12

라벨 CSV는 tools/collect_comments.py 형식 그대로 (comment_id, published_at, video_title,
parent_id, text, type, event_episode). is_spoiler 칸은 보지 않는다 (본 회차마다 답이 달라서
event_episode로 계산). 답글은 확장처럼 원댓글을 context에 붙여서 보낸다.

정답 정의: event_episode = 이 글을 읽으면 알게 되는 가장 늦은 회차의 사건 (없으면 빈칸).
  본 회차 w에서 스포 정답 = reveals_episode가 있고 > w
  (한 줄 라벨로 모든 w를 평가할 수 있다)

추론 모드 (--reason)
  none    추론 안 함
  always  모든 글 ?reason=true
  band    기준 ±BAND 안의 글만 다시 ?reason=true  (확장의 행동 규칙과 같음)

결과: --out 폴더에 report.md, metrics.json, predictions.csv, 그래프 PNG
"""
import argparse
import csv
import json
import os
import re
import statistics
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
import keyword_baseline as KB  # noqa: E402

TYPES = ["결과 공개", "유출 주장", "루머·추측", "감상·출연자 이야기", "무관"]


# ---------- 입출력 ----------
def load_labels(paths):
    """쉼표로 여러 파일 가능 (각자 라벨링한 절반을 합쳐서 평가). type이 빈 글(미라벨)은 뺀다."""
    rows = []
    for path in paths.split(","):
        with open(path, encoding="utf-8-sig") as f:
            rows += list(csv.DictReader(f))
    # 송유진 님 collect_comments.py 열 이름도 받는다
    alias = {"comment_id": "id", "published_at": "posted_at", "video_title": "context",
             "event_episode": "reveals_episode", "note": "event_note"}
    for r in rows:
        for src, dst in alias.items():
            if src in r and not r.get(dst):
                r[dst] = r[src]
    out = []
    for r in rows:
        if not (r.get("text") or "").strip() or not (r.get("type") or "").strip():
            continue
        nums = re.findall(r"\d+", r.get("reveals_episode") or "")  # "13", "13화", "4~7"(가장 늦은 회차) 모두 받음
        r["reveals_episode"] = max(map(int, nums)) if nums else None
        out.append(r)
    rows = out
    by_id = {r.get("id"): r for r in rows}
    for r in rows:  # 답글: 확장(content.js)처럼 "영상 제목\n원댓글: ..."
        parent = by_id.get(r.get("parent_id") or "")
        if parent and "원댓글:" not in (r.get("context") or ""):
            r["context"] = f"{r.get('context', '')}\n원댓글: {parent['text']}"[:300]
    rows.sort(key=lambda r: r.get("posted_at") or "")
    return rows


def post(url, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def to_comment(r):
    c = {"id": r["id"], "text": r["text"], "posted_at": r.get("posted_at") or None}
    if r.get("context"):
        c["context"] = r["context"]
    if r.get("posted_at_precision"):
        c["posted_at_precision"] = r["posted_at_precision"]
    return c


def run_engine(args, rows, w):
    try:  # 기억장을 새로 시작 (--memory-seed가 있으면 기사에서 만든 사건 목록으로 채움)
        if args.memory != "keep":
            post(f"{args.url}/memory/reset", {"show": args.show})
        if args.memory_seed:
            if args.memory_seed.endswith(".csv"):  # 팀 기억장 CSV
                sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))
                from learn_from_articles import load_events_csv
                events = load_events_csv(args.memory_seed)
            else:
                events = json.load(open(args.memory_seed, encoding="utf-8"))["events"]
            post(f"{args.url}/memory/add", {"show": args.show, "events": events})
    except Exception:  # noqa: BLE001  가짜 서버엔 없을 수 있음
        pass
    preds, wall = {}, []
    reason_q = "?reason=true" if args.reason == "always" else ""
    for i in range(0, len(rows), args.batch):
        chunk = rows[i:i + args.batch]
        t0 = time.time()
        res = post(f"{args.url}/judge{reason_q}{'&' if reason_q else '?'}memory=sync",
                   {"show": args.show, "watched_episode": w, "comments": [to_comment(r) for r in chunk]})
        batch_ms = (time.time() - t0) * 1000
        dt = batch_ms / max(1, len(chunk))
        for x in res.get("results", []):
            x.setdefault("latency_ms", dt)
            preds[x["id"]] = x
        if len(chunk) == args.batch:
            wall.append(batch_ms)
    preds["__batch_ms__"] = wall

    if args.reason == "band":  # 확장처럼 애매한 글만 1개씩 다시 묻기
        band = [r for r in rows if r["id"] in preds and "p_spoiler" in preds[r["id"]]
                and abs(preds[r["id"]]["p_spoiler"] - args.threshold) <= args.band]
        step = args.band_batch  # 1이면 확장처럼 하나씩, 크면 엔진이 동시에 처리 (평가가 빨라짐)
        for i in range(0, len(band), step):
            chunk = band[i:i + step]
            res = post(f"{args.url}/judge?reason=true",
                       {"show": args.show, "watched_episode": w, "comments": [to_comment(r) for r in chunk]})
            for x in res.get("results", []):
                old = preds.get(x["id"], {})
                x["latency_ms"] = old.get("latency_ms", 0) + x.get("latency_ms", 0)
                x["reasoned"] = True
                preds[x["id"]] = x
    return preds


# ---------- 지표 ----------
def confusion(gold, pred):
    tp = sum(g and p for g, p in zip(gold, pred))
    fp = sum((not g) and p for g, p in zip(gold, pred))
    fn = sum(g and (not p) for g, p in zip(gold, pred))
    tn = sum((not g) and (not p) for g, p in zip(gold, pred))
    pos, neg = tp + fn, fp + tn
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / pos if pos else 0.0
    return {
        "n": len(gold), "spoilers": pos, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "missed_spoiler_rate": round(fn / pos, 4) if pos else None,      # 놓친 스포
        "false_blur_rate": round(fp / neg, 4) if neg else None,          # 잘못 가린 글
        "accuracy": round((tp + tn) / len(gold), 4) if gold else None,
        "precision": round(prec, 4), "recall": round(rec, 4),
        "f1": round(2 * prec * rec / (prec + rec), 4) if prec + rec else 0.0,
    }


def brier(gold, probs):
    return round(sum((p - g) ** 2 for g, p in zip(gold, probs)) / len(gold), 4) if gold else None


def calibration_bins(gold, probs, n=5):
    bins = []
    for b in range(n):
        lo, hi = b / n, (b + 1) / n
        idx = [i for i, p in enumerate(probs) if lo <= p < hi or (b == n - 1 and p == 1.0)]
        if idx:
            bins.append({"bin": f"{lo:.1f}-{hi:.1f}", "n": len(idx),
                         "mean_p": round(statistics.mean(probs[i] for i in idx), 3),
                         "actual": round(statistics.mean(gold[i] for i in idx), 3)})
    return bins


def evaluate_w(args, rows, w, kw):
    gold = [bool(r["reveals_episode"] and r["reveals_episode"] > w) for r in rows]
    out = {"watched": w}

    preds = run_engine(args, rows, w) if not args.no_engine else {}
    if preds:
        ok = [i for i, r in enumerate(rows) if "p_spoiler" in preds.get(r["id"], {})]
        g = [gold[i] for i in ok]
        p = [preds[rows[i]["id"]]["p_spoiler"] for i in ok]
        e = confusion(g, [x >= args.threshold for x in p])
        e["errors"] = len(rows) - len(ok)
        e["brier"] = brier([int(x) for x in g], p)
        e["calibration"] = calibration_bins([int(x) for x in g], p)
        lat = [preds[rows[i]["id"]].get("latency_ms", 0) for i in ok]
        e["latency_ms_mean"] = round(statistics.mean(lat), 1) if lat else None
        e["latency_ms_p95"] = round(sorted(lat)[int(0.95 * (len(lat) - 1))], 1) if lat else None
        bm = preds.get("__batch_ms__") or []
        e["batch20_ms_mean"] = round(statistics.mean(bm), 0) if bm else None
        e["reasoned_ratio"] = round(sum(bool(preds[rows[i]["id"]].get("reasoned")) for i in ok) / len(ok), 3) if ok else None
        e["sweep"] = [{"threshold": t / 10, **{k: v for k, v in confusion(g, [x >= t / 10 for x in p]).items()
                                                if k in ("missed_spoiler_rate", "false_blur_rate", "f1")}}
                      for t in range(1, 10)]

        # 글 성격 정확도 (라벨에 type이 있는 글만). 감상과 무관은 둘 다 '스포 아님'이라 같은 것으로 채점
        same = lambda x, y: x == y or {x, y} <= {"감상·출연자 이야기", "무관"}  # noqa: E731
        typed = [i for i in ok if rows[i].get("type") in TYPES]
        if typed:
            e["type_accuracy"] = round(sum(same(preds[rows[i]["id"]].get("type"), rows[i]["type"]) for i in typed) / len(typed), 4)
            cm = {gt: {pt: 0 for pt in TYPES} for gt in TYPES}
            for i in typed:
                pt = preds[rows[i]["id"]].get("type")
                if pt in TYPES:
                    cm[rows[i]["type"]][pt] += 1
            e["type_confusion"] = cm
            # 진짜 스포 vs 루머 구분: 정답이 결과 공개/루머인 글에서 둘을 맞게 나눴나
            rr = [i for i in typed if rows[i]["type"] in ("결과 공개", "루머·추측")]
            if rr:
                e["real_vs_rumor_accuracy"] = round(
                    sum(preds[rows[i]["id"]].get("type") == rows[i]["type"] for i in rr) / len(rr), 4)

        # 회차 판단: 스포 정답 글에서 엔진이 짚은 회차가 라벨과 같은가
        ep_idx = [i for i in ok if rows[i]["reveals_episode"]]
        if ep_idx:
            def pred_ep(x):
                m = x.get("matched_event")
                return m["episode"] if m else x.get("written_after_episode")
            exact = sum(pred_ep(preds[rows[i]["id"]]) == rows[i]["reveals_episode"] for i in ep_idx)
            near = sum(pred_ep(preds[rows[i]["id"]]) is not None
                       and abs(pred_ep(preds[rows[i]["id"]]) - rows[i]["reveals_episode"]) <= 1 for i in ep_idx)
            e["episode_accuracy"] = round(exact / len(ep_idx), 4)
            e["episode_accuracy_pm1"] = round(near / len(ep_idx), 4)
        out["engine"] = e

    if kw:
        out["keyword"] = {}
        for mode in KB.modes(kw):
            kp = [KB.predict(r["text"], kw, mode)["blocked"] for r in rows]
            out["keyword"][mode] = confusion(gold, kp)
    return out, preds, gold


# ---------- 보고서 ----------
def fmt(x, pct=True):
    if x is None:
        return "-"
    return f"{x * 100:.1f}%" if pct else f"{x}"


def write_report(args, rows, all_out, path):
    L = [f"# 쉿스포 평가 결과", "",
         f"- 데이터: `{os.path.basename(args.labels)}` ({len(rows)}개 글, 스포 라벨 {sum(1 for r in rows if r['reveals_episode'])}개)",
         f"- 기준(threshold): {args.threshold} · 추론 모드: {args.reason} · 엔진: {args.url}", ""]
    L += ["## 키워드 방식 vs 쉿스포", "",
          "| 본 회차 | 방식 | 놓친 스포 | 잘못 가린 글 | 정확도 | F1 |", "|---|---|---|---|---|---|"]
    for o in all_out:
        rows_ = []
        if "keyword" in o:
            for mode, m in o["keyword"].items():
                rows_.append((f"키워드({mode})", m))
        if "engine" in o:
            rows_.append(("**쉿스포**", o["engine"]))
        for name, m in rows_:
            L.append(f"| {o['watched']} | {name} | {fmt(m['missed_spoiler_rate'])} | {fmt(m['false_blur_rate'])} "
                     f"| {fmt(m['accuracy'])} | {m['f1']:.2f} |")
    L.append("")
    if any("engine" in o for o in all_out):
        L += ["## 쉿스포 세부 지표", "",
              "| 본 회차 | 회차 정확도 (±1) | 글 성격 정확도 | 진짜 vs 루머 | Brier | 추론 비율 | 글당 시간 (p95) | 20개 판정 |",
              "|---|---|---|---|---|---|---|---|"]
        for o in all_out:
            e = o.get("engine")
            if not e:
                continue
            L.append(f"| {o['watched']} | {fmt(e.get('episode_accuracy'))} ({fmt(e.get('episode_accuracy_pm1'))}) "
                     f"| {fmt(e.get('type_accuracy'))} | {fmt(e.get('real_vs_rumor_accuracy'))} "
                     f"| {fmt(e.get('brier'), False)} | {fmt(e.get('reasoned_ratio'))} "
                     f"| {e.get('latency_ms_mean')}ms ({e.get('latency_ms_p95')}ms) "
                     f"| {str(e.get('batch20_ms_mean')) + 'ms' if e.get('batch20_ms_mean') else '-'} |")
        L += ["", "Brier는 낮을수록 확률을 믿을 수 있다는 뜻 (0이 완벽, 0.25가 동전 던지기 수준).", ""]
        e0 = next(o["engine"] for o in all_out if "engine" in o)
        L += ["## 보정 (확률 구간별 실제 스포 비율, 첫 본 회차 기준)", "", "| 확률 구간 | 글 수 | 평균 확률 | 실제 스포 비율 |", "|---|---|---|---|"]
        for b in e0["calibration"]:
            L.append(f"| {b['bin']} | {b['n']} | {b['mean_p']} | {b['actual']} |")
        L.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))


def write_charts(all_out, outdir):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return []
    files = []
    ws = [o["watched"] for o in all_out]
    series = []
    if all("keyword" in o for o in all_out):
        en = {"확장 기본": "Keyword (extension default)", "출연자 이름": "Keyword (cast names)", "결과 단어": "Keyword (result words)"}
        greys = ["#7d8590", "#a8aeb5", "#cdd1d5", "#e1e4e7"]
        for j, mode in enumerate(all_out[0]["keyword"]):
            series.append((en.get(mode, f"Keyword {j + 1}"), [o["keyword"][mode] for o in all_out], greys[j % 4]))
    if all("engine" in o for o in all_out):
        series.append(("Shhpoil (Zoro-1)", [o["engine"] for o in all_out], "#3b6ef5"))
    if series:
        fig, axes = plt.subplots(1, 2, figsize=(10, 4))
        for ax, key, title in ((axes[0], "missed_spoiler_rate", "Missed spoilers (lower is better)"),
                               (axes[1], "false_blur_rate", "Wrongly blurred (lower is better)")):
            width = 0.8 / len(series)
            for j, (name, ms, col) in enumerate(series):
                xs = [i + j * width for i in range(len(ws))]
                ax.bar(xs, [(m[key] or 0) * 100 for m in ms], width, label=name, color=col)
            ax.set_xticks([i + width * (len(series) - 1) / 2 for i in range(len(ws))])
            ax.set_xticklabels([f"watched ep {w}" for w in ws])
            ax.set_ylabel("%")
            ax.set_title(title)
            ax.spines[["top", "right"]].set_visible(False)
        axes[0].legend(frameon=False, fontsize=8)
        fig.tight_layout()
        p = os.path.join(outdir, "compare.png")
        fig.savefig(p, dpi=150)
        plt.close(fig)
        files.append(p)
    if all("engine" in o for o in all_out):
        fig, ax = plt.subplots(figsize=(4.5, 4))
        cal = all_out[0]["engine"]["calibration"]
        ax.plot([0, 1], [0, 1], "--", color="#bbb", lw=1)
        ax.plot([b["mean_p"] for b in cal], [b["actual"] for b in cal], "o-", color="#3b6ef5")
        ax.set_xlabel("predicted p_spoiler")
        ax.set_ylabel("actual spoiler rate")
        ax.set_title("Calibration")
        ax.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        p = os.path.join(outdir, "calibration.png")
        fig.savefig(p, dpi=150)
        plt.close(fig)
        files.append(p)
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--show", required=True)
    ap.add_argument("--url", default="http://localhost:8787")
    ap.add_argument("--watched", default="3,7,10,12")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--reason", choices=["none", "always", "band"], default="none")
    ap.add_argument("--band", type=float, default=0.10)
    ap.add_argument("--band-batch", type=int, default=1, help="애매한 글을 몇 개씩 묶어 다시 물을지 (평가 속도용)")
    ap.add_argument("--batch", type=int, default=20)  # 확장이 한 번에 보내는 최대 수
    ap.add_argument("--keywords")
    ap.add_argument("--memory", choices=["reset", "keep"], default="reset",
                    help="reset: 본 회차마다 기억장 비우고 시작 / keep: 지금 엔진의 기억장 그대로 (learn_from_articles.py로 만든 것)")
    ap.add_argument("--memory-seed", help="기억장에 먼저 넣을 사건 목록 (engine/config/events.<작품>.json)")
    ap.add_argument("--no-engine", action="store_true", help="키워드 방식만 평가")
    ap.add_argument("--out", default="eval/out")
    args = ap.parse_args()

    rows = load_labels(args.labels)
    kw = KB.load(args.keywords) if args.keywords else None
    os.makedirs(args.out, exist_ok=True)

    all_out, pred_rows = [], []
    for w in [int(x) for x in args.watched.split(",")]:
        o, preds, gold = evaluate_w(args, rows, w, kw)
        all_out.append(o)
        for r, g in zip(rows, gold):
            x = preds.get(r["id"], {})
            pred_rows.append({"watched": w, "id": r["id"], "gold_spoiler": int(g),
                              "label_type": r.get("type", ""), "reveals_episode": r["reveals_episode"] or "",
                              "p_spoiler": x.get("p_spoiler", ""), "pred_type": x.get("type", ""),
                              "written_after": x.get("written_after_episode", ""),
                              "matched_event": (x.get("matched_event") or {}).get("text", ""),
                              "matched_ep": (x.get("matched_event") or {}).get("episode", ""),
                              "reasoned": x.get("reasoned", ""),
                              "p_event": x.get("p_event", ""), "p_sheet": x.get("p_sheet", ""),
                              **({f"kw_{m}": int(KB.predict(r["text"], kw, m)["blocked"]) for m in KB.modes(kw)} if kw else {})})

    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(all_out, f, ensure_ascii=False, indent=2)
    with open(os.path.join(args.out, "predictions.csv"), "w", encoding="utf-8-sig", newline="") as f:
        wr = csv.DictWriter(f, fieldnames=list(pred_rows[0].keys()))
        wr.writeheader()
        wr.writerows(pred_rows)
    write_report(args, rows, all_out, os.path.join(args.out, "report.md"))
    charts = write_charts(all_out, args.out)
    print(open(os.path.join(args.out, "report.md"), encoding="utf-8").read())
    print("\n저장:", args.out, *[os.path.basename(c) for c in charts])


if __name__ == "__main__":
    main()
