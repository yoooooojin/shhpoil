"""기사를 읽고 스포 기억장을 만든다 (에이전트가 직접 읽고 사건을 뽑음).

    # Zoro가 기사 목록을 읽고 사건 추출 (기사 내려받기는 이 PC에서)
    python3 engine/learn_from_articles.py --articles engine/config/articles.흑백요리사2.json

    # 정리해 둔 사건 목록을 그대로 넣기 (팀 기억장 CSV 또는 JSON)
    python3 engine/learn_from_articles.py --seed engine/config/memory.흑백요리사2.csv
    python3 engine/learn_from_articles.py --seed engine/config/events.흑백요리사2.json

    # 시간 돌리기 시연: 7화까지 공개된 시점의 기억장
    python3 engine/learn_from_articles.py --articles ... --until-episode 7

동작
  1. 기사를 게시 순서대로 읽는다. 회차 = 게시 시각 기준 몇 화까지 공개됐는지 (또는 목록에 적은 episode)
  2. Zoro가 기사에서 방송 결과·전개만 한 줄씩 뽑는다 (예고, 순위, 논란은 제외)
  3. 이미 있는 사건과 같은 일인지 Zoro에게 묻는다 (choice). 같으면 언급 수 +1, 더 이른 기사면 회차를 앞으로
  4. 새 사건이면 회차와 출처(기사 주소)를 붙여 저장 -> engine/memory_store/<작품>.json
엔진(server.py)이 켜져 있어도 되고 꺼져 있어도 된다 (같은 파일을 씀). Zoro(또는 fake_zoro)는 켜져 있어야 한다.
"""
import argparse
import html
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memory  # noqa: E402
import questions as Q  # noqa: E402
import schedule  # noqa: E402
import zoro_client  # noqa: E402

SAME_P = float(os.environ.get("SAME_EVENT_P", "0.6"))
MAX_CHARS = int(os.environ.get("ARTICLE_MAX_CHARS", "4000"))
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"


def fetch_text(article, show):
    if article.get("file"):
        with open(article["file"], encoding="utf-8") as f:
            raw = f.read()
    else:
        req = urllib.request.Request(article["url"], headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read().decode(r.headers.get_content_charset() or "utf-8", "replace")
    raw = re.sub(r"(?is)<(script|style|noscript|header|footer|nav)[^>]*>.*?</\1>", " ", raw)
    text = html.unescape(re.sub(r"(?s)<[^>]+>", "\n", raw))
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.split("\n")]
    lines = [x for x in lines if len(x) >= 15]  # 메뉴·버튼 같은 짧은 조각 제거
    # 작품 이름이 처음 나오는 곳부터 MAX_CHARS만 (기사 본문 근처)
    key = show[:4]
    start = next((i for i, x in enumerate(lines) if key in x), 0)
    return "\n".join(lines[start:])[:MAX_CHARS]


def extract(show, text):
    out = zoro_client.chat(Q.ARTICLE_PROMPT.format(show=show, text=text), max_tokens=400, first_line_only=False)
    events = []
    for line in out.split("\n"):
        line = re.sub(r"^\s*([-*•·]|\d+[.)])\s*", "", line).strip().strip('"')
        if 4 <= len(line) <= 60 and line != "없음":
            events.append(line[:40])
    return events


def learn_event(show, text, episode, source):
    """같은 사건이 있으면 회차·언급 수만 고치고, 없으면 추가. 결과를 문자열로."""
    existing = memory.load(show)
    if existing:
        ans = zoro_client.decide({"작품": show, "문장": text}, Q.build_same_event_question(existing))["answers"]["same"]
        probs = ans.get("probabilities") or {ans["choice"]: 1.0}
        best, p = max(probs.items(), key=lambda x: x[1])
        if best != "새 사건" and p >= SAME_P:
            memory.touch(show, best, episode)
            return f"  = {episode:>2}화  {text}  →  기존 '{best}'"
    if memory.add(show, text, episode, source):
        return f"  + {episode:>2}화  {text}"
    return f"  = {episode:>2}화  {text}  (이미 있음)"


def load_events_csv(path):
    """팀 기억장 CSV: episode, episode_range, event, people, check, source  (people은 ; 로 구분)
    별명은 사람별 사전 engine/config/people.<작품>.csv 에 (예전처럼 aliases 열이 있어도 읽음)"""
    import csv
    out = []
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if not (r.get("event") or "").strip() or not (r.get("episode") or "").strip():
                continue
            split = lambda v: [x.strip() for x in (v or "").split(";") if x.strip()]  # noqa: E731
            out.append({"episode": int(r["episode"]), "text": r["event"].strip(),
                        "people": split(r.get("people")), "aliases": split(r.get("aliases")),
                        "check": (r.get("check") or "").strip() or None,
                        "source": (r.get("source") or "").strip() or None})
    return out


def article_episode(show, a):
    if a.get("episode") is not None:
        return int(a["episode"])
    return schedule.episode_after(show, a.get("published"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--articles", help="기사 목록 JSON (engine/config/articles.<작품>.json)")
    ap.add_argument("--seed", help="정리해 둔 사건 목록 JSON을 그대로 넣기 (engine/config/events.<작품>.json)")
    ap.add_argument("--show", help="작품명 (없으면 JSON의 show)")
    ap.add_argument("--until-episode", type=int, help="이 회차까지 공개된 시점까지만 (시간 돌리기)")
    ap.add_argument("--keep", action="store_true", help="기존 기억장을 지우지 않고 이어서")
    args = ap.parse_args()
    if not args.articles and not args.seed:
        ap.error("--articles 또는 --seed 중 하나는 필요해요")

    path = args.articles or args.seed
    if path.endswith(".csv"):
        src = {"show": args.show or "흑백요리사2", "events": load_events_csv(path)}
    else:
        src = json.load(open(path, encoding="utf-8"))
    show = args.show or src["show"]
    if not args.keep:
        memory.reset(show)

    if args.seed:
        events = sorted(src["events"], key=lambda e: e["episode"])
        for e in events:
            if args.until_episode is not None and e["episode"] > args.until_episode:
                continue
            memory.add(show, e["text"], int(e["episode"]), e.get("source"),
                       people=e.get("people"), aliases=e.get("aliases"), check=e.get("check"))
            print(f"  + {e['episode']:>2}화  {e['text']}" + (f"  (별명: {', '.join(e['aliases'])})" if e.get("aliases") else ""))
    else:
        h = zoro_client.health()
        if not h.get("ok"):
            sys.exit(f"Zoro에 연결이 안 돼요 ({zoro_client.ZORO_URL}). fake_zoro.py나 진짜 Zoro를 먼저 켜 주세요.")
        arts = [(article_episode(show, a), a.get("published") or "", a) for a in src["articles"]]
        arts.sort(key=lambda x: (x[0] if x[0] is not None else 99, x[1]))
        for ep, _, a in arts:
            if ep is None:
                print(f"! 회차를 모름 (published나 episode를 적어 주세요): {a.get('url') or a.get('file')}")
                continue
            if args.until_episode is not None and ep > args.until_episode:
                continue
            name = a.get("url") or a.get("file")
            try:
                text = fetch_text(a, show)
            except Exception as e:  # noqa: BLE001
                print(f"! 기사를 못 읽음 ({e}): {name}\n  → 본문을 .txt로 저장해서 \"file\"로 넣어 주세요")
                continue
            found = extract(show, text)
            print(f"[{ep}화까지 공개 후] {name}  → 사건 {len(found)}개")
            for t in found:
                print(learn_event(show, t, ep, a.get("url") or a.get("file")))

    events = sorted(memory.load(show), key=lambda e: (e["episode"], -e.get("hits", 1)))
    print(f"\n기억장 {len(events)}개  (engine/memory_store/)")
    for e in events:
        print(f"  {e['episode']:>2}화  {e['text']}  (언급 {e.get('hits', 1)})")


if __name__ == "__main__":
    main()