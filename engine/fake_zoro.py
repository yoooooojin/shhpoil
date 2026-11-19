"""가짜 Zoro-1 결정 서버 (개발용).

진짜 Zoro-1 decide 서버(trida-stack inference/zoro-1, `serve.py --mode decide`)와
같은 주소·비슷한 형식으로 응답한다. 판단 엔진은 zoro_client.py만 거쳐 부르므로
진짜로 바꿀 때는 ZORO_URL만 바꾸면 된다.

    python3 engine/fake_zoro.py            # http://localhost:30001

엔드포인트
  POST /v1/decide            {"request": {"state": ..., "questions": {...}}, "reasoning": false|true|"auto"}
  POST /v1/chat/completions  OpenAI 호환 (사건 한 줄 추출용)
  GET  /health

판단은 단어 신호 + 결정적 잡음으로 흉내만 낸다. 정확도는 의미 없음.
"""
import hashlib
import json
import math
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LATENCY_MS = float(os.environ.get("FAKE_ZORO_LATENCY_MS", "40"))       # 결정 1회
REASON_LATENCY_MS = float(os.environ.get("FAKE_ZORO_REASON_MS", "600"))  # 추론 1회

# 글 성격 신호 (가짜 판단용)
CUES = {
    "결과 공개": r"우승|탈락|결승|최종|이겼|졌|떨어졌|올라갔|살아남|합격|1등|결국|반전|정체",
    "유출 주장": r"유출|스포\s*떴|미리\s*봤|녹화장|촬영장|지인이|관계자",
    "루머·추측": r"설\b|우승설|카더라|래\b|대요|같은데|같음|예상|추측|아닐까|느낌|듯",
    "감상·출연자 이야기": r"웃기|웃김|멋있|말투|매력|팬|좋다|좋아|귀엽|응원|ㅋㅋ|ㅠㅠ",
}


def _noise(*parts) -> float:
    h = hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()
    return int(h[:8], 16) / 0xFFFFFFFF - 0.5  # -0.5 ~ 0.5


def _softmax(scores, temp=1.0):
    m = max(scores)
    ex = [math.exp((s - m) / temp) for s in scores]
    z = sum(ex)
    return [e / z for e in ex]


def _state_text(state) -> str:
    """판단에 쓸 글. 영상 제목(문맥)까지 보면 제목의 '최종/우승' 때문에 모든 댓글이 결과 공개가 되므로 댓글 본문만."""
    if isinstance(state, str):
        return state
    return str(state.get("댓글") or json.dumps(state, ensure_ascii=False))


def _tokens(s: str):
    s = re.sub(r"[^\w가-힣]", " ", s)
    toks = set()
    for w in s.split():
        if len(w) >= 2:
            toks.add(w)
            toks.update(w[i:i + 2] for i in range(len(w) - 1))  # 한국어 2-gram
    return toks


def _label_score(text: str, label: str, desc: str) -> float:
    """선택지 하나에 대한 점수."""
    for cue_label, pattern in CUES.items():
        if label.startswith(cue_label.split("·")[0]):
            return 4.0 * len(re.findall(pattern, text))
    if label in ("무관",):
        return 0.6
    if label in ("해당 없음", "없음", "새 사건"):
        return 3.0
    # 사건 같은 자유 라벨: 글자 겹침
    a, b = _tokens(text), _tokens(label + " " + (desc or ""))
    if not b:
        return 0.0
    return 1.2 * len(a & b)  # 겹치는 글자 조각 수 (별명이 설명에 들어 있으면 별명으로도 매칭)


def decide_one(state, qid, q, reasoning):
    text = _state_text(state)
    qtype = q.get("type", "choice")
    temp = 0.6 if reasoning else 1.0  # 추론하면 확률이 뾰족해짐 (진짜 Zoro도 그렇다)

    if qtype == "noul":
        s = 0.0
        for pattern in (CUES["결과 공개"], CUES["유출 주장"]):
            s += 1.2 * len(re.findall(pattern, text))
        s += _noise(text, qid) - 0.8
        p = 1 / (1 + math.exp(-s / temp))
        return {"type": "noul", "noul": round(p, 4)}

    criteria = q.get("criteria") or {}
    if isinstance(criteria, list):  # score 형식 또는 라벨 리스트
        labels, descs = list(criteria), [""] * len(criteria)
    else:
        labels, descs = list(criteria.keys()), list(criteria.values())
    scores = [_label_score(text, l, d) + 0.8 * _noise(text, qid, l) for l, d in zip(labels, descs)]
    probs = _softmax(scores, temp)
    best = max(range(len(labels)), key=lambda i: probs[i])

    if qtype == "score":
        return {"type": "score", "score": best,
                "legend": {l: round(p, 4) for l, p in zip(labels, probs)}}
    return {"type": "choice", "choice": labels[best], "confidence": round(probs[best], 4),
            "probabilities": {l: round(p, 4) for l, p in zip(labels, probs)}}


def handle_decide(body):
    req = body.get("request", body)
    state = req.get("state", "")
    questions = req.get("questions", {})
    reasoning = body.get("reasoning", False)

    time.sleep(LATENCY_MS / 1000)
    results, reasoned = {}, False
    for qid, q in questions.items():
        r = decide_one(state, qid, q, False)
        top = r.get("confidence", max(r.get("noul", 0), 1 - r.get("noul", 0)))
        if reasoning is True or (reasoning == "auto" and top < 0.7):
            reasoned = True
            r = decide_one(state, qid, q, True)
        results[qid] = r
    out = {"results": results, "reasoned": reasoned}
    if reasoned:
        time.sleep(REASON_LATENCY_MS / 1000)
        out["reasoning"] = "(가짜 추론) 글의 표현이 방송 결과를 돌려 말하는지 다시 살펴봄."
    return out


def handle_chat(body):
    """사건 한 줄 추출 흉내: 마지막 user 메시지의 '댓글:' 뒤 문장을 짧게 자른다."""
    msgs = body.get("messages", [])
    user = next((m["content"] for m in reversed(msgs) if m.get("role") == "user"), "")
    if "기사:" in user:  # 기사에서 사건 여러 줄 뽑기 흉내: 결과 단어가 든 문장을 짧게
        body = user.split("기사:", 1)[1]
        sents = [x.strip() for x in re.split(r"[.!?\n]", body) if re.search(CUES["결과 공개"], x)]
        lines = [re.sub(r"\s+", " ", x)[:30] for x in sents[:5]] or ["없음"]
        return {"id": "fake", "object": "chat.completion", "model": "fake-zoro",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "\n".join(lines)}}]}
    m = re.search(r"댓글:\s*(.+)", user, re.S)
    src = (m.group(1) if m else user).strip().split("\n")[0]
    src = re.sub(r"ㅋ+|ㅠ+|ㄷ+|[!?~.]+", " ", src).strip()
    event = src[:24]
    return {"id": "fake", "object": "chat.completion", "model": "fake-zoro",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": event}}]}


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "engine": "fake-zoro"})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            return self._send(400, {"error": "bad json"})
        if self.path.startswith("/v1/decide"):
            return self._send(200, handle_decide(body))
        if self.path.startswith("/v1/chat/completions"):
            return self._send(200, handle_chat(body))
        self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 30001
    print(f"fake Zoro on http://localhost:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()