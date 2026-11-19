"""자동으로 만든 기억장을 사람이 만든 기억장과 비교한다 (발표용 표).

    python3 eval/compare_memory.py --human 흑백요리사2 --auto 흑백요리사2_자동

사람 기억장의 사건마다 Zoro에게 "자동 기억장의 어느 사건과 같은 일인가 / 없음"을 묻는다 (choice).
  - 찾음: 같은 사건이 자동 기억장에 있음
  - 회차까지 맞음: 그 사건의 회차가 같음 (±0)
  - 자동 기억장에만 있는 사건: 사람 기억장 어디에도 대응이 없는 것 (새로 찾았거나 잡음)
결과: 터미널 표 + eval/out/compare_<auto>.csv (사건 문장만, 댓글 원문 없음)
Zoro(serve.py)가 켜져 있어야 한다.
"""
import argparse
import csv
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "engine"))
import memory  # noqa: E402
import zoro_client  # noqa: E402

NONE = "없음"


def _tokens(t):
    import re
    return set(re.findall(r"[가-힣A-Za-z0-9]{2,}", t.replace(" ", " ")))


def shortlist(text, auto, n):
    """선택지가 많으면 확률이 흩어져 '없음'만 남는다 → 단어가 겹치는 사건 n개로 먼저 추림"""
    tok = _tokens(text)
    flat = text.replace(" ", "")
    def score(e):
        et = _tokens(e["text"])
        return len(tok & et) + sum(1 for w in et if w in flat)
    ranked = sorted(auto, key=lambda e: -score(e))
    return [e for e in ranked if score(e) > 0][:n]


def best_match(show, text, cands, min_p):
    crit = {e["text"]: f"{e['episode']}화 사건" for e in cands}
    crit[NONE] = "목록의 어떤 사건과도 다른 일"
    q = {"same": {"type": "choice", "instructions": "아래 문장과 같은 방송 속 사건을 고르세요. 표현이 달라도 같은 일이면 같은 사건입니다.",
                  "criteria": crit}}
    a = zoro_client.decide({"작품": show, "문장": text}, q)["answers"]["same"]
    probs = a.get("probabilities") or {a["choice"]: 1.0}
    name, p = max(probs.items(), key=lambda x: x[1])  # 보수적으로: 가장 높은 하나가 기준 이상일 때만 (합으로 하면 부풀려짐)
    return (name, p) if name != NONE and p >= min_p else (None, p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--human", default="흑백요리사2")
    ap.add_argument("--auto", default="흑백요리사2_자동")
    ap.add_argument("--min-p", type=float, default=0.5)
    ap.add_argument("--cands", type=int, default=8, help="사람 사건마다 보여 줄 자동 사건 후보 수")
    args = ap.parse_args()

    human, auto = memory.load(args.human), memory.load(args.auto)
    if not human or not auto:
        sys.exit(f"기억장이 비어 있어요: 사람 {len(human)}개, 자동 {len(auto)}개")
    by_text = {e["text"]: e for e in auto}
    rows, used = [], set()
    for h in sorted(human, key=lambda e: e["episode"]):
        cands = shortlist(h["text"], auto, args.cands)
        name, p = best_match(args.human, h["text"], cands, args.min_p) if cands else (None, 0.0)
        a = by_text.get(name)
        if a:
            used.add(a["text"])
        rows.append({"사람_회차": h["episode"], "사람_사건": h["text"],
                     "자동_사건": a["text"] if a else "", "자동_회차": a["episode"] if a else "",
                     "회차_맞음": "Y" if a and a["episode"] == h["episode"] else ("" if not a else "N"),
                     "확률": round(p, 2)})
    extra = [e for e in auto if e["text"] not in used]

    found = sum(1 for r in rows if r["자동_사건"])
    ep_ok = sum(1 for r in rows if r["회차_맞음"] == "Y")
    print(f"사람 기억장 {len(human)}개 중  찾음 {found}개 ({found / len(human):.0%})  ·  회차까지 맞음 {ep_ok}개 ({ep_ok / len(human):.0%})")
    print(f"자동 기억장 {len(auto)}개 중  사람 사건과 짝지어진 것 {len(used)}개 · 사람 기억장에 없는 사건 {len(extra)}개")
    print("  (자동 사건 하나가 사람 사건 여럿과 짝지어지면, 자동 쪽이 뭉뚱그려 적은 것)\n")
    by_ep = {}
    for r in rows:
        d = by_ep.setdefault(r["사람_회차"], [0, 0, 0])
        d[0] += 1
        d[1] += bool(r["자동_사건"])
        d[2] += r["회차_맞음"] == "Y"
    print("회차 | 사람 사건 | 찾음 | 회차까지 맞음")
    for ep in sorted(by_ep):
        n, f_, ok = by_ep[ep]
        print(f"{ep:>4} | {n:>9} | {f_:>4} | {ok:>4}")
    print("\n못 찾은 사건:")
    for r in rows:
        if not r["자동_사건"]:
            print(f"  {r['사람_회차']:>2}화  {r['사람_사건']}")
    print("\n자동 기억장에만 있는 사건 (새로 찾았거나 잡음 — 사람이 확인):")
    for e in sorted(extra, key=lambda e: e["episode"]):
        print(f"  {e['episode']:>2}화  {e['text']}  (언급 {e.get('hits', 1)})")

    out = os.path.join(ROOT, "eval", "out", f"compare_{args.auto}.csv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
        for e in extra:
            w.writerow({"사람_회차": "", "사람_사건": "", "자동_사건": e["text"], "자동_회차": e["episode"],
                        "회차_맞음": "", "확률": ""})
    print(f"\n저장: {out}")


if __name__ == "__main__":
    main()