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
# 속도: 댓글 묶음을 동시에 Zoro에 보냄 (SGLang이 GPU에서 한꺼번에 처리). 1이면 예전처럼 하나씩.
JUDGE_PARALLEL = int(os.environ.get("JUDGE_PARALLEL", "20"))
# 사건 후보: 댓글에 나온 출연자 이름·별명으로 먼저 추림.
# 1: 이름이 나온 사건만 / 0: 기억장 전체 / fallback: 이름이 나오면 그 사건만, 아무도 안 나오면 전체
PREFILTER = os.environ.get("PREFILTER", "1")
MAX_CANDIDATES = int(os.environ.get("MAX_CANDIDATES", "6"))


def _after(k, w, approx=False):
    if k is None:
        return 0.5
    if approx and abs(k - w) <= 1:  # 상대 시각("10개월 전")이면 경계 회차는 불확실
        return 0.5
    return 1.0 if k > w else 0.0


def extract_event(show, text):
    return zoro_client.chat(Q.EXTRACT_PROMPT.format(show=show, text=text))


def judge_one(show, w, c, reason, sync_memory):
    t0 = time.time()
    k = schedule.episode_after(show, c.get("posted_at"))
    approx = c.get("posted_at_precision") == "approx"
    events = memory.for_question(show)
    if PREFILTER != "0":
        ctx = c.get("context") or ""
        look = c["text"] + (ctx.split("원댓글:", 1)[1] if "원댓글:" in ctx else "")  # 영상 제목은 빼고
        cands = Q.candidate_events(events, show, look, MAX_CANDIDATES)
        if cands or PREFILTER != "fallback":
            events = cands

    tz = time.time()
    out = zoro_client.decide(Q.build_state(show, c), Q.build_questions(events, show), reasoning=reason)
    zoro_ms = (time.time() - tz) * 1000
    ans = out["answers"]
    t = ans["type"]
    probs = t.get("probabilities") or {t["choice"]: 1.0}
    ptype = {name: float(probs.get(name, 0.0)) for name in Q.TYPES}

    later, none_p, matched = 0.0, 1.0, None
    if events and "event" in ans:
        ev = ans["event"].get("probabilities") or {}
        by_text = {e["text"]: e for e in events}
        none_p = float(ev.get(Q.NONE_EVENT, 0.0))
        later = sum(p for name, p in ev.items() if name in by_text and by_text[name]["episode"] > w)
        best = max(((name, p) for name, p in ev.items() if name in by_text), key=lambda x: x[1], default=None)
        if best and best[1] >= MATCH_REPORT_P:
            e = by_text[best[0]]
            matched = {"text": e["text"], "episode": e["episode"], "p": round(best[1], 3)}

    p = (ptype["결과 공개"] * (later + none_p * _after(k, w, approx))
         + ptype["유출 주장"] * (later + none_p * (1.0 if (k is None or k >= w) else 0.5))
         + ptype["루머·추측"] * later
         + ptype["감상·출연자 이야기"] * later * W_REACTION)
    p = max(0.0, min(1.0, p))

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
        "reasoned": bool(out["reasoned"]),
        # ---- 아래는 추가 필드 (확장이 안 써도 됨)
        "type_probs": {name: round(v, 4) for name, v in ptype.items()},
        "reason_brief": (out.get("reasoning") or "")[:80] or None,
        "memory_update": memory_update,
        "latency_ms": round((time.time() - t0) * 1000, 1),
        "timing": {"zoro_calls": 1, "zoro_ms": round(zoro_ms, 1), "n_event_options": len(events),
                   "reasoning": bool(reason)},
    }


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
          f"사건 선택지 평균 {statistics.mean(opts) if opts else 0:.1f}개", file=sys.stderr, flush=True)
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
        if u.path == "/memory/add":  # {"show": ..., "events": [{"text", "episode", "source"}]} 평가·시연에서 기억장 채우기
            added = [memory.add(body.get("show", ""), e["text"], int(e["episode"]), e.get("source"),
                                people=e.get("people"), aliases=e.get("aliases"), check=e.get("check"))
                     for e in body.get("events", [])]
            return self._json({"ok": True, "added": sum(1 for a in added if a)})
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