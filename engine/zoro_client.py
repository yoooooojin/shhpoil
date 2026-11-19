"""Zoro-1 호출부. 판단 엔진은 이 파일만 거쳐 Zoro를 부른다.

진짜 Zoro로 바꿀 때 할 일
  1. ZORO_URL 환경변수를 진짜 decide 서버 주소로 (기본 http://localhost:30001)
  2. 진짜 /v1/decide 응답을 한 번 찍어 보고, 형식이 다르면 _normalize()만 고친다
  3. 생성(사건 추출)이 다른 포트면 ZORO_CHAT_URL 지정
"""
import json
import os
import threading
import urllib.request

ZORO_URL = os.environ.get("ZORO_URL", "http://localhost:30001")
ZORO_CHAT_URL = os.environ.get("ZORO_CHAT_URL", ZORO_URL)
ZORO_MODEL = os.environ.get("ZORO_MODEL", "trillionlabs/Zoro-1")
TIMEOUT = float(os.environ.get("ZORO_TIMEOUT", "60"))
MAX_REASONING_TOKENS = int(os.environ.get("ZORO_MAX_REASONING_TOKENS", "4096"))  # 모델 카드 권장 최소
# 동시에 보내면 SGLang이 GPU에서 묶어 처리한다. 요청당 속도는 조금 줄지만 묶음 전체는 훨씬 빠르다.
_slots = threading.Semaphore(int(os.environ.get("ZORO_CONCURRENCY", "20")))


def _post(url, body):
    with _slots:
        return _post_raw(url, body)


def _post_raw(url, body):
    req = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def _normalize(raw):
    """응답을 {"answers": {qid: {...}}, "reasoned": bool, "reasoning": str|None}로 맞춘다.

    질문별 답 형식(모델 카드 기준):
      noul   -> {"noul": p}
      choice -> {"choice": label, "confidence": p, "probabilities": {label: p}}
      score  -> {"score": i, "legend": {...}}
    """
    answers = raw.get("results") or raw.get("answers") or raw.get("decisions")
    if answers is None:  # 질문 ID가 최상위에 바로 있는 경우
        answers = {k: v for k, v in raw.items() if isinstance(v, dict)}
    return {"answers": answers,
            # 실제로 추론했을 때만 true: auto 모드는 확신이 높으면 추론을 건너뛴다
            "reasoned": (raw["answers_source"] == "reasoned") if "answers_source" in raw else bool(
                raw.get("reasoned") or (isinstance(raw.get("reasoning"), str) and raw["reasoning"].strip())
                or (raw.get("usage") or {}).get("output_tokens", 0) > 0),
            "reasoning_ms": raw.get("reasoning_ms"),
            "reasoning": raw.get("reasoning") if isinstance(raw.get("reasoning"), str) else None}


def decide(state, questions, reasoning=False):
    body = {"request": {"state": state, "questions": questions}, "reasoning": reasoning}
    if reasoning:
        body["max_reasoning_tokens"] = MAX_REASONING_TOKENS
    return _normalize(_post(f"{ZORO_URL}/v1/decide", body))


# 문장 쓰기(chat)는 생각을 끄고 바로 답하게: 켜 두면 짧은 max_tokens 안에서 생각만 쓰다 답이 비어 버림
CHAT_THINKING = os.environ.get("ZORO_CHAT_THINKING", "0") == "1"


def chat(prompt, max_tokens=64, first_line_only=True):
    body = {"model": ZORO_MODEL, "max_tokens": max_tokens, "temperature": 0,
            "messages": [{"role": "user", "content": prompt}]}
    if not CHAT_THINKING:
        body["chat_template_kwargs"] = {"enable_thinking": False}
    raw = _post(f"{ZORO_CHAT_URL}/v1/chat/completions", body)
    msg = raw["choices"][0]["message"]
    text = msg.get("content") or ""
    if not text.strip() and msg.get("reasoning_content") and max_tokens < 512:
        return chat(prompt, max_tokens=512, first_line_only=first_line_only)  # 생각만 쓰고 잘렸으면 길게 한 번 더
    if "</think>" in text:  # 추론 흔적 제거
        text = text.split("</think>")[-1]
    text = text.strip()
    return text.strip('"').split("\n")[0] if first_line_only else text


def health():
    try:
        with urllib.request.urlopen(f"{ZORO_URL}/health", timeout=3) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}