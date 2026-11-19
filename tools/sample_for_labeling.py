"""모은 댓글에서 라벨링할 만큼만 골라 두 사람 몫으로 나눈다.

    python3 tools/sample_for_labeling.py data/raw/comments_*.csv --total 300

결과 (data/labeled/ 는 레포에 안 올라감)
  data/labeled/calib.csv   둘 다 라벨링할 20개 (기준 맞추기용)
  data/labeled/A.csv       송유진 님 몫
  data/labeled/B.csv       김서형 님 몫
- 중복 댓글 제거, 너무 짧거나(5자 미만) 긴(300자 초과) 댓글 제외
- 작성 시점(written_after_episode)별로 고르게 뽑음. 13화 이후 댓글만 너무 많아지지 않게
"""
import argparse
import csv
import glob
import os
import random
from collections import defaultdict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--total", type=int, default=300, help="A+B 합계 (calib 제외)")
    ap.add_argument("--calib", type=int, default=20)
    ap.add_argument("--out", default="data/labeled")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    paths = [p for f in args.files for p in glob.glob(f)]
    rows, seen, fields = [], set(), None
    for p in paths:
        with open(p, encoding="utf-8-sig") as f:
            rd = csv.DictReader(f)
            fields = fields or rd.fieldnames
            for r in rd:
                text = (r.get("text") or "").strip()
                key = r.get("comment_id") or text
                if key in seen or not (5 <= len(text) <= 300):
                    continue
                seen.add(key)
                rows.append(r)

    rnd = random.Random(args.seed)
    by_ep = defaultdict(list)
    for r in rows:
        by_ep[r.get("written_after_episode", "")].append(r)
    for v in by_ep.values():
        rnd.shuffle(v)

    # 회차 묶음마다 돌아가며 하나씩 뽑기 -> 고르게
    need = args.total + args.calib
    picked = []
    while len(picked) < need and any(by_ep.values()):
        for ep in sorted(by_ep, key=lambda x: int(x) if str(x).isdigit() else 99):
            if by_ep[ep] and len(picked) < need:
                picked.append(by_ep[ep].pop())
    rnd.shuffle(picked)

    calib, rest = picked[:args.calib], picked[args.calib:]
    half = len(rest) // 2
    os.makedirs(args.out, exist_ok=True)
    for name, part in (("calib", calib), ("A", rest[:half]), ("B", rest[half:])):
        with open(os.path.join(args.out, f"{name}.csv"), "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(part)

    dist = defaultdict(int)
    for r in picked:
        dist[r.get("written_after_episode", "?")] += 1
    print(f"댓글 {len(rows)}개 중 {len(picked)}개 선택 -> {args.out}/calib.csv({len(calib)}), A.csv({half}), B.csv({len(rest) - half})")
    print("작성 시점 분포 (몇 화 공개 후):", dict(sorted(dist.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 99)))


if __name__ == "__main__":
    main()