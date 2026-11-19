"""꼼꼼함(민감도) 0.1~0.9에서 '놓친 스포 vs 잘못 가린 글' 곡선. 모델을 다시 돌리지 않고 predictions.csv로 계산.

    python3 eval/sweep.py --pred eval/out/dev_final/predictions.csv [--pred 이름=경로 ...] --out eval/out/sweep_dev.png

- 확장과 같은 식: 기준선 = 0.85 - 0.55 × 꼼꼼함  (0.2 확실한 것만=0.74, 0.5 보통=0.575, 0.8 꼼꼼히=0.41)
- 키워드 3종은 같은 폴더 report.md의 표에서 읽어 점으로 찍음 (회차별 비율을 스포/비스포 수로 가중 평균)
- 표: 본 회차 전체 합계 + 회차별
"""
import argparse
import csv
import os
import re
from collections import defaultdict

SENS = [round(0.1 * i, 1) for i in range(1, 10)]


def th_of(s):
    return round(0.85 - 0.55 * s, 3)


def load(path):
    return [r for r in csv.DictReader(open(path, encoding="utf-8-sig")) if r["p_spoiler"] != ""]


def rates(rows, th):
    pos = sum(r["gold_spoiler"] == "1" for r in rows)
    neg = len(rows) - pos
    miss = sum(r["gold_spoiler"] == "1" and float(r["p_spoiler"]) < th for r in rows)
    fb = sum(r["gold_spoiler"] == "0" and float(r["p_spoiler"]) >= th for r in rows)
    return miss / max(pos, 1), fb / max(neg, 1)


def keyword_points(report_path, rows):
    """report.md의 '| 회차 | 키워드(...) | 놓친 | 잘못 | ...' 줄을 회차별 스포/비스포 수로 가중 평균"""
    if not os.path.exists(report_path):
        return {}
    cnt = defaultdict(lambda: [0, 0])
    for r in rows:
        cnt[int(r["watched"])][0 if r["gold_spoiler"] == "1" else 1] += 1
    acc = defaultdict(lambda: [0.0, 0.0, 0, 0])
    for line in open(report_path, encoding="utf-8"):
        m = re.match(r"\|\s*(\d+)\s*\|\s*(키워드\([^)]*\))\s*\|\s*([\d.]+)%\s*\|\s*([\d.]+)%", line)
        if m:
            w, name, mi, fb = int(m.group(1)), m.group(2), float(m.group(3)) / 100, float(m.group(4)) / 100
            p, n = cnt[w]
            a = acc[name]
            a[0] += mi * p; a[1] += fb * n; a[2] += p; a[3] += n
    return {k: (v[0] / max(v[2], 1), v[1] / max(v[3], 1)) for k, v in acc.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", action="append", required=True, help="경로 또는 이름=경로 (여러 번)")
    ap.add_argument("--out", default="eval/out/sweep.png")
    args = ap.parse_args()

    series = []
    for p in args.pred:
        name, path = (p.split("=", 1) if "=" in p else (os.path.basename(os.path.dirname(p)), p))
        series.append((name, path, load(path)))

    for name, path, rows in series:
        print(f"== {name}  (놓친 스포 / 잘못 가린 글)")
        ws = sorted({int(r["watched"]) for r in rows})
        print("꼼꼼함 기준선 | 전체        | " + " | ".join(f"{w}화" for w in ws))
        for s in SENS:
            th = th_of(s)
            m, f = rates(rows, th)
            per = [rates([r for r in rows if int(r["watched"]) == w], th) for w in ws]
            mark = {0.2: " 확실한 것만", 0.5: " 보통", 0.8: " 꼼꼼히"}.get(s, "")
            print(f"  {s:.1f}  {th:.3f} | {m:4.0%} / {f:3.0%} | " + " | ".join(f"{a:4.0%}/{b:3.0%}" for a, b in per) + mark)
        kw = keyword_points(os.path.join(os.path.dirname(path), "report.md"), rows)
        for k, (m, f) in kw.items():
            print(f"  {k}: {m:4.0%} / {f:3.0%}")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(6.4, 4.8))
        for name, path, rows in series:
            pts = [rates(rows, th_of(s)) for s in SENS]
            ax.plot([f for _, f in pts], [m for m, _ in pts], marker="o", label=f"Shhpoil ({name})")
            for s, (m, f) in zip(SENS, pts):
                if s in (0.2, 0.5, 0.8):
                    ax.annotate(f"{s}", (f, m), textcoords="offset points", xytext=(4, 4), fontsize=8)
        kw = keyword_points(os.path.join(os.path.dirname(series[0][1]), "report.md"), series[0][2])
        for k, (m, f) in kw.items():
            ax.scatter([f], [m], marker="x", s=60, label=k)
        ax.set_xlabel("false blur rate (wrongly hidden)")
        ax.set_ylabel("missed spoiler rate")
        ax.set_title("sensitivity 0.1-0.9 (labels: 0.2 / 0.5 / 0.8)")
        ax.grid(alpha=0.3)
        ax.legend(fontsize=7)
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        fig.tight_layout()
        fig.savefig(args.out, dpi=150)
        print(f"그래프: {args.out}")
    except Exception as e:  # noqa: BLE001
        print(f"(그래프는 건너뜀: {e})")


if __name__ == "__main__":
    main()