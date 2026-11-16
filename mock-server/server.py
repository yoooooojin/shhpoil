"""
본데까지 - 가짜 판정 서버 (Zoro 자리 표시용)

- API 약속(/judge, /judge?reason=true)과 같은 형식으로 응답합니다.
- 판정은 단순 규칙(키워드)으로 흉내만 냅니다. 팀원분의 진짜 판단 엔진이 준비되면
  확장 설정에서 서버 주소만 바꾸면 됩니다.
- /demo/ 경로로 시연용 커뮤니티 페이지도 같이 띄웁니다.

실행: python3 server.py        (기본 포트 8787)
      python3 server.py 9000   (포트 변경)
외부 패키지 없이 파이썬 표준 라이브러리만 씁니다.
"""

import json
import os
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

KST = timezone(timedelta(hours=9))
DEMO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "demo-page")

# ---------------------------------------------------------------------------
# 작품 정보 (TODO: 실제 공개 일정 확인 후 수정)
# 흑백요리사2: 2025-12-16 17:00 첫 공개, 매주 화요일 17:00, 13회가 최종회(2026-01-13).
# 주차별로 몇 화씩 공개됐는지는 확인이 필요해서 아래는 임시 값입니다.
# ---------------------------------------------------------------------------
SHOWS = {
    "흑백요리사2": {
        "drops": [  # (공개 시각, 이 시점까지 공개된 마지막 회차)
            (datetime(2025, 12, 16, 17, 0, tzinfo=KST), 3),
            (datetime(2025, 12, 23, 17, 0, tzinfo=KST), 6),
            (datetime(2025, 12, 30, 17, 0, tzinfo=KST), 9),
            (datetime(2026, 1, 6, 17, 0, tzinfo=KST), 11),
            (datetime(2026, 1, 13, 17, 0, tzinfo=KST), 13),
        ],
        # 스포 기억장 자리 표시용 예시 사건 (진짜 기억장은 팀원분 엔진이 커뮤니티에서 쌓음)
        "events": [
            {"text": "최강록 최종 우승", "episode": 13, "keys": ["최강록", "우승"]},
            {"text": "결승 대진 확정", "episode": 12, "keys": ["결승"]},
            {"text": "팀전 결과 공개", "episode": 6, "keys": ["팀전"]},
        ],
    }
}

TYPES = ["결과 공개", "유출 주장", "루머·추측", "감상·출연자 이야기", "무관"]

RESULT_WORDS = ["우승", "탈락", "떨어", "결승", "생존", "이겼", "졌", "만장일치", "올라가", "진출"]
LEAK_WORDS = ["지인", "촬영장", "스태프", "관계자", "유출", "찌라시"]
RUMOR_WORDS = ["설 ", "우승설", "루머", "카더라", "~듯", "할듯", "할 듯", "같음", "예상", "진짜임?", "맞음?"]
OFFTOPIC_WORDS = ["몇 시", "몇시", "공개 시간", "자막", "화질"]


def parse_time(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST)
        return dt
    except ValueError:
        return None


def written_after_episode(show, posted_at):
    """게시 시각 기준으로, 그때까지 공개된 마지막 회차 (공개 전이면 0)."""
    dt = parse_time(posted_at)
    info = SHOWS.get(show)
    if dt is None or info is None:
        return None
    last = 0
    for drop_time, ep in info["drops"]:
        if dt >= drop_time:
            last = ep
    return last


def classify(text):
    has = lambda words: any(w in text for w in words)
    if has(OFFTOPIC_WORDS) and not has(RESULT_WORDS):
        return "무관", 0.05
    if has(LEAK_WORDS):
        return "유출 주장", 0.8
    if has(RUMOR_WORDS):
        return "루머·추측", 0.45
    if has(RESULT_WORDS):
        return "결과 공개", 0.85
    return "감상·출연자 이야기", 0.12


def match_event(show, text):
    info = SHOWS.get(show)
    if not info:
        return None
    best = None
    for ev in info["events"]:
        hit = sum(1 for k in ev["keys"] if k in text)
        if hit == 0:
            continue
        p = round(min(0.95, 0.45 + 0.25 * hit), 2)
        if best is None or p > best["p"]:
            best = {"text": ev["text"], "episode": ev["episode"], "p": p}
    return best


def judge(payload, reason=False):
    show = payload.get("show", "")
    results = []
    for c in payload.get("comments", []):
        text = c.get("text", "")
        ctype, p = classify(text)
        # 흉내용 잡음: 실제 모델처럼 약간 흔들리게
        rng = random.Random(hash(text) & 0xFFFFFFFF)
        p = p + rng.uniform(-0.08, 0.08)
        if reason:
            # 추론 모드 흉내: 애매한 확률을 더 분명한 쪽으로 밀어줌
            p = p + (0.15 if p >= 0.5 else -0.15)
        p = round(max(0.01, min(0.99, p)), 2)
        results.append(
            {
                "id": c.get("id"),
                "p_spoiler": p,
                "type": ctype,
                "written_after_episode": written_after_episode(show, c.get("posted_at")),
                "matched_event": match_event(show, text) if ctype in ("결과 공개", "유출 주장", "루머·추측") else None,
                "reasoned": bool(reason),
            }
        )
    return {"results": results, "engine": "mock-rules"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DEMO_DIR, **kwargs)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def end_headers(self):
        self._cors()
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ("/", "/demo"):
            self.send_response(302)
            self.send_header("Location", "/demo/")
            self.end_headers()
            return
        if url.path.startswith("/demo/"):
            self.path = url.path[len("/demo"):] or "/"
            return super().do_GET()
        if url.path == "/health":
            return self._json({"ok": True, "engine": "mock-rules"})
        self.send_error(404)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/judge":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "invalid json")
            return
        reason = parse_qs(url.query).get("reason", ["false"])[0] == "true"
        time.sleep(0.4 if reason else 0.05)  # 추론 모드는 느리다는 걸 흉내
        self._json(judge(payload, reason))

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + fmt % args + "\n")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"본데까지 가짜 서버: http://localhost:{port}  (시연 페이지: http://localhost:{port}/demo/)")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
