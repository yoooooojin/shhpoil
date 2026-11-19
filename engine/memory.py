"""스포 기억장: 작품별 사건 목록 (회차 표시 포함). engine/memory_store/<작품>.json

사건 = {"id": "e1", "text": "최강록 최종 우승", "episode": 13, "source": "출처", "hits": 3,
        "people": ["최강록"], "aliases": ["조림핑", "조림인간"]}   (people·aliases는 있으면)
- 회차는 그 사건을 언급한 '가장 이른 글'의 written_after_episode.
  더 이른 시점의 글에서 다시 나오면 작은 쪽으로 고친다.
- 사건 문장 뽑기(텍스트 생성)는 느리므로 기본은 뒤에서 처리한다 (/judge 응답을 막지 않음).
"""
import json
import os
import queue
import re
import threading

STORE_DIR = os.environ.get("MEMORY_DIR", os.path.join(os.path.dirname(__file__), "memory_store"))
MAX_EVENTS_IN_QUESTION = int(os.environ.get("MAX_EVENTS", "30"))

_lock = threading.Lock()
_recent = {}          # 작품 -> 최근 추가된 사건 (응답에 실어 보낸 뒤 비움)
_jobs = queue.Queue()  # 뒤에서 처리할 사건 추출 작업


def _path(show):
    return os.path.join(STORE_DIR, re.sub(r"[^\w가-힣-]", "_", show) + ".json")


def load(show):
    p = _path(show)
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _save(show, events):
    os.makedirs(STORE_DIR, exist_ok=True)
    tmp = _path(show) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(events, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _path(show))


def reset(show):
    with _lock:
        _save(show, [])
        _recent.pop(show, None)


def for_question(show):
    """판정 질문의 선택지로 넣을 사건들. 많으면 자주 언급된 것부터."""
    events = load(show)
    events.sort(key=lambda e: (-e.get("hits", 1), e["episode"]))
    return events[:MAX_EVENTS_IN_QUESTION]


def touch(show, text, episode):
    """기존 사건이 다시 언급됨: hits +1, 더 이른 회차의 글이면 회차를 고침."""
    with _lock:
        events = load(show)
        for e in events:
            if e["text"] == text:
                e["hits"] = e.get("hits", 1) + 1
                if episode is not None and episode < e["episode"]:
                    e["episode"] = episode
                _save(show, events)
                return e
    return None


def add(show, text, episode, source, people=None, aliases=None, check=None):
    """새 사건 추가. 같은 문장이 이미 있으면 touch로 처리하고 None."""
    text = text.strip()
    if not text:
        return None
    with _lock:
        events = load(show)
        if any(e["text"] == text for e in events):
            pass
        else:
            e = {"id": f"e{len(events) + 1}", "text": text, "episode": episode, "source": source, "hits": 1}
            if people:
                e["people"] = people
            if aliases:
                e["aliases"] = aliases
            if check:
                e["check"] = check
            events.append(e)
            _save(show, events)
            _recent.setdefault(show, []).append({"text": text, "episode": episode})
            return e
    touch(show, text, episode)
    return None


def drain_recent(show):
    with _lock:
        return _recent.pop(show, [])


# ---------------------------------------------------------------- 뒤에서 사건 추출
def submit(job):
    """job = (show, comment_text, episode, source, extract_fn)"""
    _jobs.put(job)


def _worker():
    while True:
        show, text, episode, source, extract = _jobs.get()
        try:
            event = extract(show, text)
            if event:
                add(show, event, episode, source)
        except Exception as e:  # noqa: BLE001
            print(f"[기억장] 사건 추출 실패: {e}")
        finally:
            _jobs.task_done()


def start_worker():
    threading.Thread(target=_worker, daemon=True).start()


def pending():
    return _jobs.qsize()