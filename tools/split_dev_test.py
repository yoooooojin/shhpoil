"""최종 라벨을 조정용(dev)과 평가용(test)으로 나눈다.

    python3 tools/split_dev_test.py data/labeled/labels_final.csv

결과
  data/labeled/dev.csv   약 25%: 질문 문구, 기준값(MEMORY_ADD_P 등)을 고칠 때만 사용
  data/labeled/test.csv  약 75%: 발표용 최종 수치를 낼 때 한 번만 사용 (보면서 고치지 않기)
- 스포 회차(event_episode)와 글 종류별로 비율을 맞춰서 나눔 (seed 고정, 다시 돌려도 같은 결과)
"""
import argparse
import csv
import os
import random
from collections import defaultdict


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("labels")
    ap.add_argument("--dev", type=float, default=0.25)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    with open(args.labels, encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        fields = rd.fieldnames
        rows = [r for r in rd if (r.get("type") or "").strip()]

    groups = defaultdict(list)
    for r in rows:
        ep = (r.get("event_episode") or "").strip()
        groups[(r["type"], ep)].append(r)

    rnd = random.Random(args.seed)
    dev, test = [], []
    for key in sorted(groups):
        g = groups[key]
        rnd.shuffle(g)
        n = round(len(g) * args.dev)
        if len(g) >= 2 and n == 0:
            n = 1
        dev += g[:n]
        test += g[n:]

    out = os.path.dirname(args.labels)
    for name, part in (("dev", dev), ("test", test)):
        with open(os.path.join(out, f"{name}.csv"), "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(part)
        spo = sum(1 for r in part if (r.get("event_episode") or "").strip())
        print(f"{name}.csv  {len(part)}개 (스포 {spo}개, {spo / max(1, len(part)):.0%})")


if __name__ == "__main__":
    main()
