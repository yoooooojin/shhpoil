"""기사를 읽고 스포 기억장을 만든다 (에이전트가 직접 읽고 사건을 뽑음).

    # Zoro가 기사 목록을 읽고 사건 추출 (기사 내려받기는 이 PC에서)
    python3 engine/learn_from_articles.py --articles engine/config/articles.흑백요리사2.json

    # 정리해 둔 사건 목록을 그대로 넣기 (팀 기억장 CSV 또는 JSON)
    python3 engine/learn_from_articles.py --seed engine/config/memory.흑백요리사2.csv
    python3 engine/learn_from_articles.py --seed engine/config/events.흑백요리사2.json

    # 댓글로 기억장 자동 만들기 (tools/collect_comments.py --schedule ... --search ... 결과 CSV)
    python3 engine/learn_from_articles.py --comments data/auto_흑백요리사2.csv --show 흑백요리사2

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


# ---------- 댓글로 기억장 자동 만들기 ----------
RESULT_P = float(os.environ.get("AUTO_RESULT_P", "0.5"))     # '실제 결과가 담겨 있나' 예 확률이 이 이상인 글만
SAME_CANDS = int(os.environ.get("AUTO_SAME_CANDS", "25"))     # 같은 사건인지 물을 때 보여 줄 기존 사건 수
LABELED_VIDEOS = {"58uo5T2BU8A", "0yD2KLHXuNs", "duKTefAbPpY", "7h2XvmRcNwM", "zwHzfr8IXPs",
                  "XT5mP8x72_U", "T-XNapr7z6Q", "m3Cj0MvS7fc", "ggvso2ilq_s", "hzN0SPCDIAs"}


def _labeled_comment_ids():
    """평가 정답지(eval/labels.csv)에 있는 댓글은 기억장에 쓰지 않는다 (점수가 부풀지 않게)."""
    import csv
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval", "labels.csv")
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8-sig") as f:
        return {r.get("comment_id") or r.get("id") for r in csv.DictReader(f)}


def _tokens(text):
    return {w for w in re.findall(r"[가-힣A-Za-z0-9]{2,}", text)}


def _same_candidates(existing, text):
    """같은 사건 후보: 단어가 겹치는 사건 + 많이 언급된 사건 (선택지가 너무 길어지지 않게)."""
    tok = _tokens(text)
    overlap = sorted(existing, key=lambda e: (-len(tok & _tokens(e["text"])), -e.get("hits", 1)))
    cands = [e for e in overlap if tok & _tokens(e["text"])][:SAME_CANDS]
    for e in sorted(existing, key=lambda e: -e.get("hits", 1)):
        if len(cands) >= SAME_CANDS:
            break
        if e not in cands:
            cands.append(e)
    return cands


def learn_from_comment(show, text, episode, source):
    existing = memory.load(show)
    if existing:
        cands = _same_candidates(existing, text)
        ans = zoro_client.decide({"작품": show, "문장": text}, Q.build_same_event_question(cands))["answers"]["same"]
        probs = ans.get("probabilities") or {ans["choice"]: 1.0}
        best, p = max(probs.items(), key=lambda x: x[1])
        if best != "새 사건" and p >= SAME_P:
            memory.touch(show, best, episode)  # 더 이른 글이면 회차가 앞으로 (= 가장 이른 작성 시점)
            return "=", best
    table = Q.people_aliases(show)  # 별명 사전이 있는 작품이면 사건 문장에 나온 인물을 붙임
    flat = text.replace(" ", "")
    people = [n for n, al in table.items() if any(x.replace(" ", "") in flat for x in [n, *al] if len(x) >= 2)]
    e = memory.add(show, text, episode, source, people=people or None, check="[댓글로 자동 추가] 사람 확인 필요")
    return ("+", text) if e else ("=", text)


def build_from_comments(show, path, until=None, min_hits=2, review_out=None):
    """① 거르기(결과 공개) → ② 사건 뽑기 → ③ 같은 사건 합치기 → ④ 가장 이른 작성 시점 = 회차 → ⑤ 사람 확인용 CSV"""
    import csv
    from concurrent.futures import ThreadPoolExecutor
    rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
    skip_ids = _labeled_comment_ids()
    rows = [r for r in rows if (r.get("text") or "").strip()
            and r.get("video_id") not in LABELED_VIDEOS and r.get("comment_id") not in skip_ids
            and (r.get("written_after_episode") or "").strip() not in ("", "0")]
    if until is not None:
        rows = [r for r in rows if int(r["written_after_episode"]) <= until]
    rows.sort(key=lambda r: r.get("published_at") or "")  # 이른 글부터: 사건의 회차가 처음 언급된 시점이 됨
    print(f"댓글 {len(rows)}개 (평가에 쓴 영상·댓글, 작성 시점 모름은 뺌)")

    def classify(r):
        out = zoro_client.decide({"작품": show, "댓글": r["text"], "영상 제목": r.get("video_title") or ""},
                                 Q.HAS_RESULT_QUESTION)
        a = out["answers"]["has_result"]
        return float((a.get("probabilities") or {a["choice"]: 1.0}).get("예", 0))

    with ThreadPoolExecutor(max_workers=16) as pool:
        scores = list(pool.map(classify, rows))
    kept = [r for r, sc in zip(rows, scores) if sc >= RESULT_P]
    print(f"① 거르기: '실제 결과가 담겨 있다'고 본 글 {len(kept)}개 (기준 {RESULT_P})")

    def ext(r):
        t = zoro_client.chat(Q.EXTRACT_WITH_TITLE_PROMPT.format(show=show, title=r.get("video_title") or "", text=r["text"]),
                             max_tokens=64).strip().strip('"').rstrip(".")
        return t if 4 <= len(t) <= 60 and t not in ("없음", "해당 없음") else None

    with ThreadPoolExecutor(max_workers=16) as pool:
        texts = list(pool.map(ext, kept))
    print(f"② 사건 뽑기: {sum(1 for t in texts if t)}개")

    support = {}
    for r, t in zip(kept, texts):  # 이른 글부터 차례로 (합치기는 순서가 중요해서 하나씩)
        if not t:
            continue
        ep = int(r["written_after_episode"])
        mark, ev = learn_from_comment(show, t[:40], ep, f"comment:{r.get('comment_id')}")
        support.setdefault(ev, []).append(r)
        print(f"  {mark} {ep:>2}화  {t[:40]}" + (f"  →  '{ev}'" if mark == "=" and ev != t[:40] else ""))

    # 한 번만 나온 사건은 잡음일 가능성이 커서 뺀다 (사람 확인 CSV에는 남김)
    events = memory.load(show)
    keep = [e for e in events if e.get("hits", 1) >= min_hits]
    dropped = [e for e in events if e.get("hits", 1) < min_hits]
    memory.reset(show)
    for e in keep:
        memory.add(show, e["text"], e["episode"], e.get("source"), people=e.get("people"), check=e.get("check"))
        for _ in range(e.get("hits", 1) - 1):  # 언급 수 그대로 되살리기
            memory.touch(show, e["text"], None)
    print(f"③④ 합치기: 사건 {len(events)}개 → 언급 {min_hits}번 이상 {len(keep)}개 남김")

    out = review_out or os.path.join(os.path.dirname(os.path.abspath(path)), f"memory_review_{show}.csv")
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["episode", "episode_range", "event", "people", "aliases", "check", "source", "hits", "keep", "examples"])
        for e in sorted(events, key=lambda e: (e["episode"], -e.get("hits", 1))):
            ex = " / ".join((x["text"] or "").replace("\n", " ")[:60] for x in support.get(e["text"], [])[:3])
            w.writerow([e["episode"], "", e["text"], ";".join(e.get("people") or []), "", "[댓글로 자동 추가] 사람 확인 필요",
                        e.get("source") or "", e.get("hits", 1), "Y" if e in keep else "", ex])
    print(f"⑤ 사람 확인용: {out}  (고치거나 지운 뒤 --seed 로 넣으면 됨. 원문이 있으니 레포에 올리지 마세요)")


def article_episode(show, a):
    if a.get("episode") is not None:
        return int(a["episode"])
    return schedule.episode_after(show, a.get("published"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--articles", help="기사 목록 JSON (engine/config/articles.<작품>.json)")
    ap.add_argument("--seed", help="정리해 둔 사건 목록 JSON을 그대로 넣기 (engine/config/events.<작품>.json)")
    ap.add_argument("--comments", help="댓글 CSV로 기억장 자동 만들기 (collect_comments.py 결과)")
    ap.add_argument("--min-hits", type=int, default=2, help="--comments: 이만큼 언급된 사건만 남김")
    ap.add_argument("--show", help="작품명 (없으면 JSON의 show)")
    ap.add_argument("--until-episode", type=int, help="이 회차까지 공개된 시점까지만 (시간 돌리기)")
    ap.add_argument("--keep", action="store_true", help="기존 기억장을 지우지 않고 이어서")
    args = ap.parse_args()
    if args.comments:
        if not args.show:
            ap.error("--comments 에는 --show 가 필요해요 (일정 파일의 show)")
        h = zoro_client.health()
        if not h.get("ok"):
            sys.exit(f"Zoro에 연결이 안 돼요 ({zoro_client.ZORO_URL}).")
        if not args.keep:
            memory.reset(args.show)
        build_from_comments(args.show, args.comments, args.until_episode, args.min_hits)
        events = sorted(memory.load(args.show), key=lambda e: (e["episode"], -e.get("hits", 1)))
        print(f"\n기억장 {len(events)}개  (engine/memory_store/)")
        for e in events:
            print(f"  {e['episode']:>2}화  {e['text']}  (언급 {e.get('hits', 1)})")
        return
    if not args.articles and not args.seed:
        ap.error("--articles, --seed, --comments 중 하나는 필요해요")

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
