"""유튜브 댓글 수집기 → 라벨링용 CSV

평가 데이터(정답 라벨)를 만들려고 영상 댓글을 모읍니다. 파이썬 기본 기능만 써서 설치할 것 없음.

사용법 (Windows PowerShell)
  $env:YT_API_KEY="여기에_키"        # 키는 코드나 레포에 넣지 말고 이렇게 환경변수로
  python tools/collect_comments.py https://www.youtube.com/watch?v=영상ID 다른영상ID --max 300

결과: data/comments_YYYYMMDD_HHMM.csv (엑셀에서 바로 열림)
  - written_after_episode: 작성 시각 기준으로 몇 화까지 공개된 뒤였는지 (공개 일정으로 자동 계산)
  - is_spoiler / type / event_episode / note: 팀원이 손으로 채우는 라벨 칸

참고
  - 할당량: 요청 1번(댓글 최대 100개)에 1 사용. 하루 기본 10,000이라 넉넉함
  - 작성자 이름은 저장하지 않음 (개인정보 + 판정에 필요 없음)
"""

import argparse
import csv
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = os.environ.get("YT_API_BASE", "https://www.googleapis.com/youtube/v3")
KST = timezone(timedelta(hours=9))

# 흑백요리사2 공개 일정: (공개 시각, 이 시점까지 공개된 마지막 회차). mock-server와 같은 값
DROPS = [
    (datetime(2025, 12, 16, 17, 0, tzinfo=KST), 3),
    (datetime(2025, 12, 23, 17, 0, tzinfo=KST), 7),
    (datetime(2025, 12, 30, 17, 0, tzinfo=KST), 10),
    (datetime(2026, 1, 6, 17, 0, tzinfo=KST), 12),
    (datetime(2026, 1, 13, 17, 0, tzinfo=KST), 13),
]

FIELDS = [
    "video_id", "video_title", "comment_id", "parent_id", "published_at",
    "written_after_episode", "like_count", "reply_count", "text",
    "is_spoiler", "type", "event_episode", "note",  # ← 라벨 칸 (비워 둠)
]


def video_id_of(s):
    """URL이든 ID든 영상 ID만 꺼냄"""
    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", s)
    if m:
        return m.group(1)
    if re.fullmatch(r"[\w-]{11}", s):
        return s
    sys.exit(f"영상 주소를 못 알아봤어요: {s}")


def get(path, **params):
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        reason = ""
        try:
            reason = json.loads(body)["error"]["errors"][0]["reason"]
        except Exception:
            pass
        hint = {
            "commentsDisabled": "이 영상은 댓글이 꺼져 있어요",
            "quotaExceeded": "오늘 할당량을 다 썼어요",
            "keyInvalid": "API 키가 잘못됐어요",
            "forbidden": "키 제한 설정을 확인하세요 (YouTube Data API v3 허용)",
        }.get(reason, body[:200])
        raise RuntimeError(f"HTTP {e.code} {reason}: {hint}") from None


def episode_at(iso):
    """작성 시각에 이미 공개돼 있던 마지막 회차 (첫 공개 전이면 0)"""
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    ep = 0
    for drop, last in DROPS:
        if t >= drop:
            ep = last
    return ep


def row(vid, title, c, parent_id="", reply_count=0):
    sn = c["snippet"]
    return {
        "video_id": vid,
        "video_title": title,
        "comment_id": c["id"],
        "parent_id": parent_id,
        "published_at": sn["publishedAt"],
        "written_after_episode": episode_at(sn["publishedAt"]),
        "like_count": sn.get("likeCount", 0),
        "reply_count": reply_count,
        "text": sn.get("textOriginal") or sn.get("textDisplay", ""),
    }


def collect(vid, key, limit, order, with_replies):
    items = get("videos", part="snippet", id=vid, key=key).get("items", [])
    title = items[0]["snippet"]["title"] if items else ""
    rows, token = [], None
    while len(rows) < limit:
        params = dict(part="snippet,replies", videoId=vid, key=key,
                      maxResults=100, order=order, textFormat="plainText")
        if token:
            params["pageToken"] = token
        data = get("commentThreads", **params)
        for th in data.get("items", []):
            top = th["snippet"]["topLevelComment"]
            rows.append(row(vid, title, top, reply_count=th["snippet"].get("totalReplyCount", 0)))
            if with_replies:
                # 답글은 스레드당 최대 5개까지만 같이 옴 (전부 필요하면 comments.list로 따로)
                for rep in th.get("replies", {}).get("comments", []):
                    rows.append(row(vid, title, rep, parent_id=top["id"]))
        token = data.get("nextPageToken")
        if not token:
            break
    return title, rows[:limit]


def main():
    ap = argparse.ArgumentParser(description="유튜브 댓글 → 라벨링용 CSV")
    ap.add_argument("videos", nargs="+", help="영상 주소 또는 ID (여러 개 가능)")
    ap.add_argument("--max", type=int, default=300, help="영상당 최대 댓글 수 (기본 300)")
    ap.add_argument("--order", choices=["relevance", "time"], default="relevance",
                    help="relevance=인기순(기본), time=최신순")
    ap.add_argument("--replies", action="store_true", help="답글도 같이 (스레드당 최대 5개)")
    ap.add_argument("--out", help="저장 경로 (기본 data/comments_날짜.csv)")
    args = ap.parse_args()

    key = os.environ.get("YT_API_KEY")
    if not key:
        sys.exit('API 키가 없어요. PowerShell에서 먼저:  $env:YT_API_KEY="키"')

    out = Path(args.out or f"data/comments_{datetime.now():%Y%m%d_%H%M}.csv")
    out.parent.mkdir(parents=True, exist_ok=True)

    all_rows, seen = [], set()
    for v in args.videos:
        vid = video_id_of(v)
        try:
            title, rows = collect(vid, key, args.max, args.order, args.replies)
        except RuntimeError as e:
            print(f"✗ {vid}: {e}")
            continue
        rows = [r for r in rows if r["comment_id"] not in seen]
        seen.update(r["comment_id"] for r in rows)
        all_rows += rows
        print(f"✓ {vid} {title[:40]} → {len(rows)}개")

    # utf-8-sig: 엑셀에서 한글 안 깨지게
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(all_rows)

    by_ep = {}
    for r in all_rows:
        by_ep[r["written_after_episode"]] = by_ep.get(r["written_after_episode"], 0) + 1
    print(f"\n저장: {out} (총 {len(all_rows)}개)")
    print("작성 시점 분포 (몇 화 공개 후):", dict(sorted(by_ep.items())))


if __name__ == "__main__":
    main()
