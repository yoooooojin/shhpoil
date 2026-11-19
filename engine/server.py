"""쉿스포 판단 엔진 (김서형). mock-server/server.py 자리에 그대로 들어간다.

    python3 engine/fake_zoro.py &                          # Zoro 없이 개발할 때 (localhost:30001)
    python3 engine/server.py                               # 판단 엔진 (localhost:8787, /demo/도 같이)
    ZORO_URL=http://<GPU>:30001 python3 engine/server.py   # 진짜 Zoro-1

API (README와 같음, 필드만 추가)
  POST /judge                 일반 판정       (?reason=true 추론 모드, ?memory=sync 기억장 즉시 갱신)
  GET  /health                {"ok": true, "engine": "zoro-1" | "fake-zoro" | "zoro-down"}
  GET  /memory?show=작품[&max_episode=n]   기억장 사건 목록 (시간 돌리기 시연용)
  POST /memory/reset          {"show": "작품"}
  POST /memory/add            {"show": "작품", "events": [{"text", "episode", "source"}]}

기억장: 뼈대는 기사에서 (engine/learn_from_articles.py). 댓글은 기존 사건과 매칭될 때 언급 수를
올리고 회차를 앞으로 고치는 데만 쓴다. 댓글로 새 사건까지 배우려면 LEARN_FROM_COMMENTS=1.
  GET  /demo/                 시연 페이지 (mock-server와 같음)

확률 조합 (w = 본 회차, k = written_after_episode, P(e) = 기억장 사건 매칭 확률)
  later = 회차 > w 인 사건들의 P(e) 합,  none = P(해당 없음) (기억장이 비면 1)
  결과 공개   later + none * [k > w]               결과 글은 k화까지의 내용
  유출 주장   later + none * (1 if k >= w else .5)  작성 시점보다 뒤의 내용을 주장
  루머·추측   later                                실제 뒤 사건과 맞을 때만 스포
  감상·무관   0
  p_spoiler = Σ P(성격) × 위 값.  k를 모르면 [k > w] 대신 0.5
"""
import json
import re
import statistics
from concurrent.futures import ThreadPoolExecutor
import os
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import memory  # noqa: E402
import questions as Q  # noqa: E402
import schedule  # noqa: E402
import zoro_client  # noqa: E402

DEMO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "demo-page")
MEMORY_ADD_P = float(os.environ.get("MEMORY_ADD_P", "0.85"))        # 이 이상 확실한 '결과 공개'만 사건 추가
MATCH_EXISTING_P = float(os.environ.get("MATCH_EXISTING_P", "0.6"))  # 이 이상이면 기존 사건 재언급
MATCH_REPORT_P = float(os.environ.get("MATCH_REPORT_P", "0.3"))      # 이 이상이면 matched_event로 알려 줌
# 기억장 뼈대는 기사에서 만든다 (learn_from_articles.py). 댓글은 기존 사건 매칭(언급 수·회차 보정)에만 쓰고, 새 사건 추가는 기본 끔
LEARN_FROM_COMMENTS = os.environ.get("LEARN_FROM_COMMENTS", "0") == "1"
# '감상·출연자 이야기'로 분류돼도 뒤 화 사건을 짚으면 스포일 수 있다 ("최강록 우승 미쳤다").
# 0이면 예전 공식 그대로. dev에서 0 / 0.5 / 1 을 비교해 고른다.
W_REACTION = float(os.environ.get("W_REACTION", "0"))
# sum: 뒤 화 사건들의 확률 합 (dev에서 더 좋았음) / max: 가장 확실한 사건 하나만
REACTION_MODE = os.environ.get("REACTION_MODE", "sum")
# 속도: 댓글 묶음을 동시에 Zoro에 보냄 (SGLang이 GPU에서 한꺼번에 처리). 1이면 예전처럼 하나씩.
JUDGE_PARALLEL = int(os.environ.get("JUDGE_PARALLEL", "20"))
# 사건 후보: 댓글에 나온 출연자 이름·별명으로 먼저 추림.
# 1: 이름이 나온 사건만 / 0: 기억장 전체 / fallback: 이름이 나오면 그 사건만, 아무도 안 나오면 전체
PREFILTER = os.environ.get("PREFILTER", "1")
P_SHIFT = float(os.environ.get("P_SHIFT", "0"))  # PREFILTER_TITLE=1이면 0.155 (dev2에서 같은 잘못 가림 기준 0.73 - 0.575)
PREFILTER_TITLE = os.environ.get("PREFILTER_TITLE", "0")  # 0 | fallback | 1
MAX_CANDIDATES = int(os.environ.get("MAX_CANDIDATES", "6"))
# 단서 더 모으기: 애매한 글(확률이 이 범위)이면 에이전트가 어떤 단서를 더 볼지 골라 need_context로 요청
CLUE_ASK = os.environ.get("CLUE_ASK", "1") == "1"
REASON_MODE = os.environ.get("REASON_MODE", "auto")  # auto: Zoro가 확신 낮을 때만 추론 / on: 재판정 때 늘 추론
# all: 기억장 전체에서 어느 사건인지 / later: 본 회차 뒤 사건만 선택지로 (같은 인물의 이전 회차 사건에 끌려가지 않게)
EVENT_SCOPE = os.environ.get("EVENT_SCOPE", "all")
CLUE_LOW = float(os.environ.get("CLUE_LOW", "0.3"))
CLUE_HIGH = float(os.environ.get("CLUE_HIGH", "0.75"))
CLUE_MIN_P = float(os.environ.get("CLUE_MIN_P", "0.15"))
# 스포 목록 방식: 0=끔(예전 방식만) / 1=켬. 켜면 Zoro를 한 번 더 불러 '아직 안 본 내용'을 알게 되는지 직접 묻는다
SHEET = os.environ.get("SHEET", "0") == "1"
COMBINE = os.environ.get("COMBINE", "max")        # event | sheet | max | mean : 최종 p를 어떻게 정할지
SHEET_EARLY = float(os.environ.get("SHEET_EARLY", "0.5"))  # 안 본 회차가 공개되기 전에 쓴 글이면 (유출 말고는 알 수 없으니) 이만큼 곱함
SHEET_LEVELS = int(os.environ.get("SHEET_LEVELS", "2"))   # 2: 알게 됨/모름 · 3: 확실히/짐작/모름
SHEET_HALF = float(os.environ.get("SHEET_HALF", "0.5"))    # 3단계일 때 '짐작하게 됨'의 무게
SHEET_FEWSHOT = os.environ.get("SHEET_FEWSHOT", "0") == "1"  # 목록 질문에 가상 작품 예시 8개
# mean일 때 확률 눈금 맞추기: dev·dev2에서 '예전 방식 기준 0.575'와 같은 잘못 가림이 나온 mean 기준이 0.38·0.42
# → 0.575/0.40 ≈ 1.44배. 확장의 꼼꼼함 3단계(0.63/0.575/0.465)를 그대로 쓰려고. (test 데이터로 정하지 않음)
SHEET_SCALE = float(os.environ.get("SHEET_SCALE", "1.44"))
_sheet_pool = ThreadPoolExecutor(max_workers=JUDGE_PARALLEL)
_TS = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")


def _after(k, w, approx=False):
    if k is None:
        return 0.5
    if approx and abs(k - w) <= 1:  # 상대 시각("10개월 전")이면 경계 회차는 불확실
        return 0.5
    return 1.0 if k > w else 0.0


def extract_event(show, text):
    return zoro_client.chat(Q.EXTRACT_PROMPT.format(show=show, text=text))


def _need_context(c, p, ans):
    """애매한 글이면 Zoro가 고른 단서를 확률 순으로 최대 2개. 확장이 모을 수 있다고 알려 준 것만."""
    if not (CLUE_LOW <= p <= CLUE_HIGH):
        return None
    probs = (ans.get("clue") or {}).get("probabilities") or {}
    ranked = [k_ for k_, v in sorted(probs.items(), key=lambda x: -x[1])
              if k_ in Q.CLUES and v >= CLUE_MIN_P]
    if _TS.search(c.get("text", "")) and "timestamp" not in ranked:
        ranked.append("timestamp")  # 시각이 적혀 있으면 그 장면 정보는 늘 쓸모가 있다
    avail = c.get("available_clues")  # 확장이 이 글에서 모을 수 있는 단서 (없으면 제한 안 함)
    if avail is not None:
        ranked = [k_ for k_ in ranked if k_ in avail]
    return ranked[:2] or None


def judge_one(show, w, c, reason, sync_memory):
    t0 = time.time()
    k = schedule.episode_after(show, c.get("posted_at"))
    approx = c.get("posted_at_precision") == "approx"
    events = memory.for_question(show)
    if EVENT_SCOPE == "later":  # "아직 안 본 사건을 알려 주는가"만 묻는다: 본 회차까지의 사건은 선택지에서 뺌
        events = [e for e in events if e["episode"] > w]
    if PREFILTER != "0":
        ctx = c.get("context") or ""
        look = c["text"] + (ctx.split("원댓글:", 1)[1] if "원댓글:" in ctx else "")  # 영상 제목은 빼고
        cands = Q.candidate_events(events, show, look, MAX_CANDIDATES)
        title = ctx.split("\n원댓글:", 1)[0]
        # 영상 제목으로도 후보 찾기: "제자한테 지고서"처럼 대상이 제목에만 있는 글
        # fallback: 댓글에서 후보가 없을 때만 / 1: 늘 제목 이름까지 합쳐서
        if title and (PREFILTER_TITLE == "1" or (PREFILTER_TITLE == "fallback" and not cands)):
            cands = Q.candidate_events(events, show, look + " " + title, MAX_CANDIDATES)
        if cands or PREFILTER != "fallback":
            events = cands

    tz = time.time()
    has_clues = bool(c.get("clues"))
    ask_clue = CLUE_ASK and not has_clues and not reason  # 재판정 땐 단서 질문을 빼야 auto 모드가 괜히 추론하지 않음
    # 재판정(reason=true)일 때만 추론: 기본은 Zoro의 auto 모드 (확신이 낮을 때만 스스로 추론)
    # off: 재판정도 추론 없이 (단서만 더 넣고 판단 헤드로 바로). 스포 판단은 주관적이라 추론이 오히려 일치도를 낮춘다는
    # 모델 카드 안내 + 512토큰처럼 잘린 추론은 안 하느니만 못함(카드: 4096 이상) → 속도와 정확도 둘 다를 위해
    mode = False if (not reason or REASON_MODE == "off") else (True if REASON_MODE == "on" else REASON_MODE)
    sheet_fut = None
    if SHEET:
        st, n_later = Q.build_sheet_state(show, c, memory.load(show), w)
        if n_later:
            sheet_fut = _sheet_pool.submit(zoro_client.decide, st, Q.build_sheet_question(SHEET_LEVELS, SHEET_FEWSHOT), mode)
    out = zoro_client.decide(Q.build_state(show, c), Q.build_questions(events, show, ask_clue), reasoning=mode)
    zoro_ms = (time.time() - tz) * 1000
    ans = out["answers"]
    t = ans["type"]
    probs = t.get("probabilities") or {t["choice"]: 1.0}
    ptype = {name: float(probs.get(name, 0.0)) for name in Q.TYPES}

    later, later_max, none_p, matched = 0.0, 0.0, 1.0, None
    if events and "event" in ans:
        ev = ans["event"].get("probabilities") or {}
        by_text = {e["text"]: e for e in events}
        none_p = float(ev.get(Q.NONE_EVENT, 0.0))
        later = sum(p for name, p in ev.items() if name in by_text and by_text[name]["episode"] > w)
        later_max = max([p for name, p in ev.items() if name in by_text and by_text[name]["episode"] > w], default=0.0)
        best = max(((name, p) for name, p in ev.items() if name in by_text), key=lambda x: x[1], default=None)
        if best and best[1] >= MATCH_REPORT_P:
            e = by_text[best[0]]
            matched = {"text": e["text"], "episode": e["episode"], "p": round(best[1], 3)}

    p = (ptype["결과 공개"] * (later + none_p * _after(k, w, approx))
         + ptype["유출 주장"] * (later + none_p * (1.0 if (k is None or k >= w) else 0.5))
         + ptype["루머·추측"] * later
         + ptype["감상·출연자 이야기"] * (later_max if REACTION_MODE == "max" else later) * W_REACTION)
    p = max(0.0, min(1.0, p - P_SHIFT))  # 눈금 맞추기 (제목 후보를 쓰면 p가 전반적으로 올라가서 dev2 기준으로 내림)
    p_event, p_sheet_raw, p_sheet = p, None, None
    sheet_reasoned = False
    if SHEET:
        p_sheet_raw = 0.0
        if sheet_fut is not None:
            so = sheet_fut.result()
            sheet_reasoned = bool(so["reasoned"])
            sp = so["answers"]["reveal"].get("probabilities") or {so["answers"]["reveal"]["choice"]: 1.0}
            p_sheet_raw = Q.sheet_prob(sp, SHEET_LEVELS, SHEET_HALF)
        early = (k is not None and k <= w)  # 안 본 회차가 나오기 전에 쓴 글
        p_sheet = p_sheet_raw * (SHEET_EARLY if early else 1.0)
        p = {"event": p_event, "sheet": p_sheet, "max": max(p_event, p_sheet),
             "mean": min(1.0, (p_event + p_sheet) / 2 * SHEET_SCALE)}.get(COMBINE, max(p_event, p_sheet))

    # 행동: 확실한 스포에서 사건을 배운다
    memory_update = None
    if matched and matched["p"] >= MATCH_EXISTING_P:
        memory.touch(show, matched["text"], k)
    elif LEARN_FROM_COMMENTS and ptype["결과 공개"] >= MEMORY_ADD_P and k:  # k=0(첫 공개 전 글)은 결과 공개일 수 없으니 배우지 않음
        if sync_memory:
            try:
                added = memory.add(show, extract_event(show, c["text"]), k, c.get("id"))
            except Exception:  # noqa: BLE001  추출 실패해도 판정은 돌려준다
                added = None
            if added:
                memory_update = {"added": added["text"], "episode": added["episode"]}
        else:
            memory.submit((show, c["text"], k, c.get("id"), extract_event))
            memory_update = {"pending": True, "episode": k}

    return {
        "id": c.get("id"),
        "p_spoiler": round(p, 4),
        "type": max(ptype, key=ptype.get),
        "written_after_episode": k,
        "matched_event": matched,
        "reasoned": bool(out["reasoned"]) or sheet_reasoned,
        "p_event": round(p_event, 4),
        "p_sheet": None if p_sheet_raw is None else round(p_sheet_raw, 4),
        # ---- 아래는 추가 필드 (확장이 안 써도 됨)
        "type_probs": {name: round(v, 4) for name, v in ptype.items()},
        "reason_brief": (out.get("reasoning") or "")[:80] or None,
        "need_context": _need_context(c, p, ans) if ask_clue else None,
        "used_clues": sorted(k_ for k_, v in c["clues"].items() if v) if has_clues else None,
        "memory_update": memory_update,
        "latency_ms": round((time.time() - t0) * 1000, 1),
        "timing": {"zoro_calls": 2 if sheet_fut is not None else 1, "zoro_ms": round(zoro_ms, 1), "n_event_options": len(events),
                   "reasoning": bool(reason), "reason_mode": mode if reason else None},
    }


def report(body):
    """사용자 "스포였음" 신고 → 기억장. README의 POST /report 약속.

    1) 판단을 한 번 돌려 기존 사건과 맞으면 그 사건(added: false, 언급 수 +1)
    2) 아니면 Zoro가 댓글에서 사건 한 문장을 뽑아 새 사건으로 추가(added: true)
       회차 = 작성 시점(본 회차보다 뒤일 때), 모르면 본 회차 + 1
    """
    show = body.get("show", "")
    w = int(body.get("watched_episode") or 0)
    c = body.get("comment") or {}
    if not c.get("text"):
        return {"memory_update": None, "error": "comment.text 없음"}
    r = judge_one(show, w, c, False, False)
    m = r.get("matched_event")
    if m and m["p"] >= MATCH_EXISTING_P:
        e = memory.touch(show, m["text"], None) or {"text": m["text"], "episode": m["episode"]}
        return {"memory_update": {"added": False, "event": {"id": e.get("id"), "text": e["text"], "episode": e["episode"]}}}

    text = zoro_client.chat(Q.EXTRACT_PROMPT.format(show=show, text=c["text"]), max_tokens=48).strip().strip('"')
    if not text or text in ("없음", "해당 없음"):
        return {"memory_update": None}
    k = r.get("written_after_episode")
    last = max((ep for _, ep in schedule.shows().get(show, [])), default=None)
    ep = k if (k and k > w) else w + 1
    if last:
        ep = min(ep, last)
    table = Q.people_aliases(show)
    flat = c["text"].replace(" ", "")
    people = [n for n, al in table.items() if any(x.replace(" ", "") in flat for x in [n, *al] if len(x) >= 2)]
    e = memory.add(show, text, ep, "report", people=people or None, check="[신고로 추가] 사람 확인 필요")
    if e is None:  # 같은 문장이 이미 있음
        e = next((x for x in memory.load(show) if x["text"] == text), {"id": None, "text": text, "episode": ep})
        return {"memory_update": {"added": False, "event": {"id": e.get("id"), "text": e["text"], "episode": e["episode"]}}}
    return {"memory_update": {"added": True, "event": {"id": e["id"], "text": e["text"], "episode": e["episode"]}}}


def judge(body, reason=False, sync_memory=False):
    show = body.get("show", "")
    w = int(body.get("watched_episode") or 0)
    comments = body.get("comments", [])
    # 기억장이 시간 순서대로 쌓이도록 오래된 글부터 처리, 응답은 받은 순서대로
    order = sorted(range(len(comments)), key=lambda i: comments[i].get("posted_at") or "")
    results = [None] * len(comments)
    t0 = time.time()

    def one(i):
        c = comments[i]
        try:
            results[i] = judge_one(show, w, c, reason, sync_memory)
        except Exception as e:  # noqa: BLE001  한 글이 실패해도 나머지는 돌려준다 (확장은 이 글을 그대로 보여 줌)
            results[i] = {"id": c.get("id"), "p_spoiler": 0.0, "type": "무관",
                          "written_after_episode": schedule.episode_after(show, c.get("posted_at")),
                          "matched_event": None, "reasoned": False, "error": str(e)}

    # 댓글로 새 사건을 배우는 모드만 시간 순서가 중요해서 하나씩, 평소(평가 포함)에는 동시에
    if (sync_memory and LEARN_FROM_COMMENTS) or JUDGE_PARALLEL <= 1 or len(order) <= 1:
        for i in order:
            one(i)
    else:
        with ThreadPoolExecutor(max_workers=min(JUDGE_PARALLEL, len(order))) as pool:
            list(pool.map(one, order))
    wall = (time.time() - t0) * 1000
    zs = [r.get("timing", {}).get("zoro_ms", 0) for r in results if r]
    opts = [r.get("timing", {}).get("n_event_options", 0) for r in results if r]
    print(f"[judge] {len(comments)}개 {wall:.0f}ms (reason={reason}) | Zoro 호출 {len(zs)}번, "
          f"평균 {statistics.mean(zs) if zs else 0:.0f}ms, 최대 {max(zs) if zs else 0:.0f}ms | "
          f"사건 선택지 평균 {statistics.mean(opts) if opts else 0:.1f}개"
          + (f" | 실제 추론 {sum(1 for r in results if r and r.get('reasoned'))}/{len(results)}" if reason else ""),
          file=sys.stderr, flush=True)
    return {"results": results, "engine": engine_name(),
            "memory": {"size": len(memory.load(show)), "added": memory.drain_recent(show),
                       "pending": memory.pending()}}


_engine_cache = {"t": 0, "name": "zoro-1"}


def engine_name():
    if time.time() - _engine_cache["t"] > 10:
        h = zoro_client.health()
        _engine_cache.update(t=time.time(), name=(h.get("engine") or "zoro-1") if h.get("ok") else "zoro-down")
    return _engine_cache["name"]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DEMO_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/demo"):
            self.send_response(302)
            self.send_header("Location", "/demo/")
            self.end_headers()
            return
        if u.path.startswith("/demo/"):
            self.path = u.path[len("/demo"):] or "/"
            return super().do_GET()
        if u.path == "/shows":  # 작품별 방영 일정 (engine/config/shows.json). 확장이 받아서 작품 고르기에 씀
            return self._json(schedule.raw())
        if u.path == "/health":
            name = engine_name()
            return self._json({"ok": name != "zoro-down", "engine": name})
        if u.path == "/memory":
            show = q.get("show", [""])[0]
            events = sorted(memory.load(show), key=lambda e: (e["episode"], -e.get("hits", 1)))
            if "max_episode" in q:
                events = [e for e in events if e["episode"] <= int(q["max_episode"][0])]
            return self._json({"show": show, "events": events, "pending": memory.pending()})
        self.send_error(404)

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except json.JSONDecodeError:
            return self.send_error(400, "invalid json")
        if u.path == "/judge":
            return self._json(judge(body, reason=q.get("reason", ["false"])[0] == "true",
                                    sync_memory=q.get("memory", [""])[0] == "sync"))
        if u.path == "/report":
            return self._json(report(body))
        if u.path == "/memory/add":  # {"show": ..., "events": [{"text", "episode", "source"}]} 평가·시연에서 기억장 채우기
            added = [memory.add(body.get("show", ""), e["text"], int(e["episode"]), e.get("source"),
                                people=e.get("people"), aliases=e.get("aliases"), check=e.get("check"))
                     for e in body.get("events", [])]
            return self._json({"ok": True, "added": sum(1 for a in added if a)})
        if u.path == "/memory/forget":  # {"show": ..., "source": "report"} 또는 {"show": ..., "ids": ["e26"]}
            n = memory.forget(body.get("show", ""), source=body.get("source"), ids=body.get("ids"))
            return self._json({"ok": True, "removed": n})
        if u.path == "/memory/reset":
            memory.reset(body.get("show", ""))
            return self._json({"ok": True})
        self.send_error(404)

    def log_message(self, fmt, *args):
        sys.stderr.write("[engine] " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    memory.start_worker()
    print(f"쉿스포 판단 엔진: http://localhost:{port}  (Zoro: {zoro_client.ZORO_URL}, 시연: /demo/)")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
