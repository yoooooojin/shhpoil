"""두 라벨(사람 vs 사람, 또는 사람 vs Claude 초벌)이 얼마나 일치하는지.

    python3 eval/agreement.py data/labeled/calib_서형.csv data/labeled/labels_claude.csv

collect_comments.py 형식(comment_id, event_episode)과 예전 형식(id, reveals_episode) 모두 받는다.
두 파일에 같이 있는 글만 비교한다.
"""
import csv
import re
import sys


def load(p):
    out = {}
    with open(p, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if not (r.get("type") or "").strip():
                continue
            cid = r.get("comment_id") or r.get("id")
            nums = re.findall(r"\d+", r.get("event_episode") or r.get("reveals_episode") or "")
            r["_ep"] = max(map(int, nums)) if nums else None
            out[cid] = r
    return out


a, b = load(sys.argv[1]), load(sys.argv[2])
ids = [i for i in a if i in b]
if not ids:
    sys.exit("두 파일에 겹치는 글이 없어요.")
NOSPO = {"감상·출연자 이야기", "무관"}  # 둘 다 '스포 아님' -> 같은 것으로 봄
same = lambda x, y: x == y or {x, y} <= NOSPO  # noqa: E731
t = sum(same(a[i]["type"], b[i]["type"]) for i in ids)
s = sum((a[i]["_ep"] is not None) == (b[i]["_ep"] is not None) for i in ids)
e = sum(a[i]["_ep"] == b[i]["_ep"] for i in ids)
print(f"겹치는 글 {len(ids)}개")
print(f"  글 성격 일치   {t / len(ids):.0%}  (감상·무관은 같은 것으로 봄)")
print(f"  스포 있음/없음 {s / len(ids):.0%}")
print(f"  회차까지 일치  {e / len(ids):.0%}")
diff = [i for i in ids if not same(a[i]["type"], b[i]["type"]) or a[i]["_ep"] != b[i]["_ep"]]
if diff:
    print("\n다른 글:")
    for i in diff:
        print(f"- {a[i]['text'][:60]}\n    앞: {a[i]['type']} / {a[i]['_ep'] or '-'}"
              f"   뒤: {b[i]['type']} / {b[i]['_ep'] or '-'}")
