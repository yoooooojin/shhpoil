"""수집한 댓글에서 시험지용으로 무작위 N개 뽑기 (스포를 일부러 더 넣지 않음 = 실제 댓글창과 같은 비율).

    python tools/sample_random.py data/comments_test3.csv --n 250 --per-video 20 --out data/labeled/test3_pool.csv

--per-video: 한 영상에서 너무 많이 뽑히지 않게 상한. 같은 seed면 늘 같은 결과.
"""
import argparse
import csv
import random
from collections import defaultdict

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("--n", type=int, default=250)
ap.add_argument("--per-video", type=int, default=20)
ap.add_argument("--min-len", type=int, default=5, help="이보다 짧은 글(ㅋㅋ 등)은 뺌")
ap.add_argument("--seed", type=int, default=2026)
ap.add_argument("--out", required=True)
a = ap.parse_args()

with open(a.src, encoding="utf-8-sig") as f:
    rd = csv.DictReader(f)
    fields = rd.fieldnames
    rows = [r for r in rd if len((r.get("text") or "").strip()) >= a.min_len]
rng = random.Random(a.seed)
rng.shuffle(rows)
per, out = defaultdict(int), []
for r in rows:
    if per[r["video_id"]] >= a.per_video:
        continue
    per[r["video_id"]] += 1
    out.append(r)
    if len(out) >= a.n:
        break
with open(a.out, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    w.writerows(out)
print(f"{len(rows)}개 중 {len(out)}개 (영상 {len(per)}개) -> {a.out}")
