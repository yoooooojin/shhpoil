"""회차 공개 구간마다 그 기간에 나온 뉴스 기사를 네이버 검색 API로 찾는다 (기억장 자동 만들기의 재료).

    export NAVER_CLIENT_ID=...  NAVER_CLIENT_SECRET=...     # 키는 환경변수로만 (레포·채팅에 올리지 않기)
    python3 tools/find_articles.py --show 흑백요리사2 --per-window 8
    python3 engine/learn_from_articles.py --articles data/articles_흑백요리사2_auto.json --show 흑백요리사2_자동

- 공개 일정: engine/config/shows.json (사람이 적었거나 수집기의 --auto-schedule이 추정한 것)
- 네이버 뉴스 검색에는 날짜 범위 옵션이 없어서, 회차·결과 낱말을 붙인 검색어 여러 개로 찾은 뒤 게시 시각으로 구간을 나눈다
- 구간마다 결과 낱말(탈락·우승·진출…)이 제목·요약에 있는 기사를 먼저, --per-window개까지
- 기사 본문을 못 읽는 사이트를 대비해 제목+요약도 함께 저장 (learn_from_articles가 본문 대신 씀)
"""
import argparse
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
API = "https://openapi.naver.com/v1/search/news.json"
RESULT_WORDS = ("탈락", "우승", "진출", "생존", "승리", "결승", "TOP", "톱", "부활", "결과", "최종")


def search(query, cid, secret, start=1):
    url = f"{API}?{urllib.parse.urlencode({'query': query, 'display': 100, 'start': start, 'sort': 'sim'})}"
    req = urllib.request.Request(url, headers={"X-Naver-Client-Id": cid, "X-Naver-Client-Secret": secret})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("items", [])


def clean(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def windows(show):
    with open(os.path.join(ROOT, "engine", "config", "shows.json"), encoding="utf-8") as f:
        info = json.load(f)[show]
    ds = sorted((datetime.fromisoformat(t), int(ep)) for t, ep in info["drops"])
    out = []
    for i, (t, ep) in enumerate(ds):
        prev = ds[i - 1][1] if i else 0
        end = ds[i + 1][0] if i + 1 < len(ds) else t + timedelta(days=7)
        out.append((t, end, ep, prev))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--show", required=True)
    ap.add_argument("--per-window", type=int, default=8)
    ap.add_argument("--out", help="기본 data/articles_<작품>_auto.json")
    args = ap.parse_args()
    cid, secret = os.environ.get("NAVER_CLIENT_ID"), os.environ.get("NAVER_CLIENT_SECRET")
    if not cid or not secret:
        sys.exit("NAVER_CLIENT_ID, NAVER_CLIENT_SECRET 환경변수가 필요해요 (키는 채팅이나 레포에 올리지 마세요)")

    wins = windows(args.show)
    # 검색어: 작품 + 회차 / 작품 + 결과 낱말
    queries = [args.show] + [f"{args.show} {w}" for w in ("탈락", "우승", "진출", "결과", "생존", "결승", "TOP7")]
    for _, _, ep, prev in wins:
        queries += [f"{args.show} {ep}회", f"{args.show} {ep}화", f"{args.show} {prev + 1}~{ep}회"]

    seen, items = set(), []
    for q in queries:
        for start in (1, 101):
            try:
                got = search(q, cid, secret, start)
            except Exception as e:  # noqa: BLE001
                print(f"! 검색 실패 ({e}): {q}", file=sys.stderr)
                break
            for it in got:
                url = it.get("originallink") or it.get("link")
                if not url or url in seen:
                    continue
                seen.add(url)
                try:
                    pub = parsedate_to_datetime(it["pubDate"])
                except Exception:  # noqa: BLE001
                    continue
                items.append({"url": url, "published": pub.isoformat(), "pub": pub,
                              "title": clean(it.get("title")), "summary": clean(it.get("description"))})
            if len(got) < 100:
                break
    print(f"검색어 {len(queries)}개로 기사 {len(items)}개", file=sys.stderr)

    picked = []
    for start, end, ep, _ in wins:
        inwin = [x for x in items if start <= x["pub"] < end and args.show[:4] in (x["title"] + x["summary"])]
        inwin.sort(key=lambda x: (-sum(w in x["title"] + x["summary"] for w in RESULT_WORDS), x["pub"]))
        chosen = inwin[:args.per_window]
        picked += chosen
        print(f"{ep}화 공개 뒤 ({start:%m/%d}~{end:%m/%d}): 후보 {len(inwin)}개 → {len(chosen)}개", file=sys.stderr)
        for x in chosen:
            print(f"   {x['title'][:60]}", file=sys.stderr)

    out = args.out or os.path.join(ROOT, "data", f"articles_{args.show}_auto.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    data = {"show": args.show, "_note": "tools/find_articles.py가 네이버 뉴스 검색으로 찾은 기사 (사람이 고르지 않음)",
            "articles": [{"url": x["url"], "published": x["published"],
                          "fallback_text": f"{x['title']}\n{x['summary']}"} for x in picked]}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"저장: {out} (기사 {len(picked)}개)", file=sys.stderr)


if __name__ == "__main__":
    main()