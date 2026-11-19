"""모은 댓글을 시간 순서대로 엔진에 흘려 보낸다 (기억장 보정용).

기억장의 뼈대는 기사에서 만든다 (learn_from_articles.py). 이 스크립트는 그 다음에 돌려서
댓글이 기존 사건과 매칭될 때 언급 수를 올리고, 더 이른 댓글이면 회차를 앞으로 고친다.
기본으로 기억장을 비우지 않는다(--reset으로 비움). 댓글에서 새 사건까지 배우려면
엔진을 LEARN_FROM_COMMENTS=1로 켠다 (댓글은 감상이 많아 엉뚱한 사건이 들어가기 쉬움).

    python3 engine/build_memory.py data/all_comments.csv --show 흑백요리사2
    python3 engine/build_memory.py data/all_comments.csv --show 흑백요리사2 --until 2025-12-31   # 그 날까지만

CSV는 tools/collect_comments.py 형식(comment_id, published_at, text, video_title) 또는
eval 라벨 형식(id, posted_at, text, context) 모두 받는다. 라벨 칸은 보지 않는다.
"""
import argparse
import csv
import json
import urllib.request


def rows_of(path):
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            text = (r.get("text") or "").strip()
            if not text:
                continue
            yield {"id": r.get("comment_id") or r.get("id"),
                   "text": text,
                   "posted_at": r.get("published_at") or r.get("posted_at") or None,
                   "context": r.get("video_title") or r.get("context") or ""}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="+")
    ap.add_argument("--show", required=True)
    ap.add_argument("--url", default="http://localhost:8787")
    ap.add_argument("--until", help="이 날짜(포함)까지 쓰인 글만, 예: 2025-12-31")
    ap.add_argument("--reset", action="store_true", help="기억장을 비우고 시작 (기본은 기사로 만든 기억장 위에 이어서)")
    ap.add_argument("--batch", type=int, default=20)
    args = ap.parse_args()

    rows = [r for p in args.csv for r in rows_of(p)]
    rows = [r for r in rows if r["posted_at"]]
    if args.until:
        rows = [r for r in rows if r["posted_at"][:10] <= args.until]
    rows.sort(key=lambda r: r["posted_at"])

    def post(path, body):
        req = urllib.request.Request(f"{args.url}{path}", data=json.dumps(body, ensure_ascii=False).encode(),
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())

    if args.reset:
        post("/memory/reset", {"show": args.show})
    for i in range(0, len(rows), args.batch):
        chunk = rows[i:i + args.batch]
        res = post("/judge?memory=sync", {"show": args.show, "watched_episode": 0, "comments": chunk})
        for ev in res.get("memory", {}).get("added", []):
            print(f"  + {ev['episode']}화  {ev['text']}")
        print(f"{min(i + args.batch, len(rows))}/{len(rows)}  (~{chunk[-1]['posted_at'][:10]})  기억장 {res['memory']['size']}개")

    with urllib.request.urlopen(f"{args.url}/memory?show={urllib.request.quote(args.show)}") as r:
        events = json.loads(r.read())["events"]
    print(f"\n기억장 {len(events)}개")
    for e in events:
        print(f"  {e['episode']:>2}화  {e['text']}  (언급 {e.get('hits', 1)})")


if __name__ == "__main__":
    main()