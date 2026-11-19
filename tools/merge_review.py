"""검수한 일부(review)를 전체 라벨 파일에 합친다.

    python3 tools/merge_review.py data/labeled/labels_claude.csv data/labeled/review_labeled.csv data/labeled/labels_서형.csv

review 파일에 있는 글은 검수한 라벨로 바꾸고, 나머지는 전체 파일 그대로 둔다.
"""
import csv
import sys

full, review, out = sys.argv[1:4]
with open(review, encoding="utf-8-sig") as f:
    fixed = {r["comment_id"]: r for r in csv.DictReader(f)}
with open(full, encoding="utf-8-sig") as f:
    rd = csv.DictReader(f)
    fields = list(rd.fieldnames)
    rows = list(rd)
for k in ("labeler",):
    if k not in fields:
        fields.append(k)
changed = 0
for i, r in enumerate(rows):
    if r["comment_id"] in fixed:
        new = fixed[r["comment_id"]]
        if (new.get("type"), new.get("event_episode")) != (r.get("type"), r.get("event_episode")):
            changed += 1
        rows[i] = {k: new.get(k, r.get(k, "")) for k in fields}
with open(out, "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    w.writerows(rows)
print(f"전체 {len(rows)}개 중 검수 {len(fixed)}개 반영 (라벨 바뀐 것 {changed}개) -> {out}")
