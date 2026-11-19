"""층화 표본 가중치로 '실제 댓글창 기준' 놓침·잘못 가림 계산.

    python3 eval/weighted.py --weights data/labeled/weights_test34.csv \
        --pred eval/out/test4_final/predictions.csv [--pred eval/out/test3_v2_0.5/predictions.csv] [--col w_combined]

가중치 = 층(키워드에 걸림/안 걸림)의 모집단 수 / 그 층에서 뽑은 수. 스포가 많은 층을 많이 뽑았으니 되돌려 계산.
놓침% = 놓친 스포 가중합 / 스포 가중합, 잘못 가림% = 가린 비스포 가중합 / 비스포 가중합.
"""
import argparse
import csv

TH = {"0.4": 0.63, "0.5": 0.575, "0.7": 0.465}
ap = argparse.ArgumentParser()
ap.add_argument("--weights", required=True)
ap.add_argument("--pred", action="append", required=True)
ap.add_argument("--col", default="w_combined")
a = ap.parse_args()
W = {r["comment_id"]: float(r[a.col]) for r in csv.DictReader(open(a.weights, encoding="utf-8-sig")) if r[a.col]}
rows = []
for p in a.pred:
    for r in csv.DictReader(open(p, encoding="utf-8-sig")):
        if r["id"] in W and r["p_spoiler"] != "":
            rows.append(r)
kwcol = next((c for c in rows[0] if c.startswith("kw_") and "확장" in c), None)


def rate(rs, pred):
    pos = [r for r in rs if r["gold_spoiler"] == "1"]
    neg = [r for r in rs if r["gold_spoiler"] == "0"]
    wp = sum(W[r["id"]] for r in pos) or 1
    wn = sum(W[r["id"]] for r in neg) or 1
    miss = sum(W[r["id"]] for r in pos if not pred(r)) / wp * 100
    fa = sum(W[r["id"]] for r in neg if pred(r)) / wn * 100
    return miss, fa, len(pos)


print(f"가중치 칸: {a.col} · 파일 {len(a.pred)}개 · 글 {len(rows)//4}개 (회차 4개)")
print("회차(스포 수) | 키워드 | 0.4 | 0.5 (기본) | 0.7     (놓친 스포% / 잘못 가린 글%, 실제 댓글창 기준)")
for w in ("3", "7", "10", "12"):
    rs = [r for r in rows if r["watched"] == w]
    cells = []
    k = rate(rs, lambda r: r[kwcol] == "1")
    cells.append(f"{k[0]:.1f} / {k[1]:.1f}")
    for name, th in TH.items():
        m = rate(rs, lambda r, th=th: float(r["p_spoiler"]) >= th)
        cells.append(f"{m[0]:.1f} / {m[1]:.1f}")
    print(f"{w}화({k[2]}) | " + " | ".join(cells))
