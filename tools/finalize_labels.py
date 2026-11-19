"""검수 기록을 라벨에 남기고, 아직 안 본 글만 뽑고, 원문 없는 라벨 파일을 만든다.

    python3 tools/finalize_labels.py data/labeled/labels_final.csv \
        --reviewed data/labeled/review_labeled.csv data/labeled/review_new_labeled.csv \
        --self data/labeled/calib_서형.csv --name 김서형

하는 일
  1. --reviewed 파일에 있는 글: labeler = "Claude 초벌 → 김서형 검수" (도구에서 고쳤든 그대로 넘겼든)
  2. --self 파일에 있는 글: labeler = "김서형" (처음부터 직접 단 것)
  3. 나머지: "Claude 초벌 (미검수)" -> data/labeled/unreviewed.csv 로 따로 저장 (훑어보며 놓친 스포 찾기용)
  4. eval/labels.csv: comment_id, type, event_episode, labeler 만 (원문·닉네임 없음 → 레포에 올려도 됨)
labels_final.csv 는 그 자리에서 고쳐 쓴다.
"""
import argparse
import csv
import os


def ids_of(paths):
    out = set()
    for p in paths or []:
        with open(p, encoding="utf-8-sig") as f:
            out |= {r.get("comment_id") or r.get("id") for r in csv.DictReader(f)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("labels")
    ap.add_argument("--reviewed", nargs="*", default=[])
    ap.add_argument("--self", nargs="*", default=[], dest="self_")
    ap.add_argument("--name", required=True)
    ap.add_argument("--public", default="eval/labels.csv")
    args = ap.parse_args()

    reviewed, mine = ids_of(args.reviewed), ids_of(args.self_)
    with open(args.labels, encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        fields = list(rd.fieldnames)
        rows = list(rd)
    if "labeler" not in fields:
        fields.append("labeler")

    rest = []
    for r in rows:
        cid = r["comment_id"]
        if cid in mine:
            r["labeler"] = args.name
        elif cid in reviewed:
            r["labeler"] = f"Claude 초벌 → {args.name} 검수"
        else:
            r["labeler"] = "Claude 초벌 (미검수)"
            rest.append(r)

    with open(args.labels, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    out_rest = os.path.join(os.path.dirname(args.labels), "unreviewed.csv")
    with open(out_rest, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rest)
    os.makedirs(os.path.dirname(args.public) or ".", exist_ok=True)
    with open(args.public, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["comment_id", "type", "event_episode", "labeler"])
        for r in rows:
            w.writerow([r["comment_id"], r["type"], r.get("event_episode", ""), r["labeler"]])

    spo = [r for r in rows if (r.get("event_episode") or "").strip()]
    spo_checked = sum(1 for r in spo if "미검수" not in r["labeler"])
    print(f"전체 {len(rows)}개: 직접 {sum(1 for r in rows if r['labeler'] == args.name)} · "
          f"검수 {sum(1 for r in rows if '검수' in r['labeler'] and '미검수' not in r['labeler'])} · 미검수 {len(rest)}")
    print(f"스포 {len(spo)}개 중 사람 확인 {spo_checked}개")
    print(f"미검수 {len(rest)}개 -> {out_rest}  (훑어보며 놓친 스포만 찾기)")
    print(f"원문 없는 라벨 -> {args.public}  (레포에 올려도 됨)")


if __name__ == "__main__":
    main()
