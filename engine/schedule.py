"""게시 시각 -> '몇 화까지 공개된 뒤에 쓴 글인가'.

공개 일정은 engine/config/shows.json (mock-server, tools/collect_comments.py와 같은 값).
  {"작품명": {"drops": [["2025-12-16T17:00:00+09:00", 3], ...]}}
  = 그 시각에 3화까지 공개됨. 여러 화가 한 번에 공개되는 작품도 그대로 적으면 된다.
"""
import json
import os
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))
CONFIG = os.environ.get("SHOWS_CONFIG", os.path.join(os.path.dirname(__file__), "config", "shows.json"))
_shows = None


def _parse(ts):
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=KST)  # 시간대가 없으면 한국 시간


_mtime = None


def raw():
    """shows.json 그대로 (설명용 _note 같은 칸은 뺌). GET /shows 응답."""
    with open(CONFIG, encoding="utf-8") as f:
        data = json.load(f)
    return {name: {k: v for k, v in info.items() if not k.startswith("_")} for name, info in data.items()}


def shows():
    global _shows, _mtime
    m = os.path.getmtime(CONFIG)
    if _shows is None or m != _mtime:  # 파일을 고치면 엔진을 다시 켜지 않아도 새 작품이 반영됨
        _mtime = m
        with open(CONFIG, encoding="utf-8") as f:
            raw = json.load(f)
        _shows = {}
        for name, info in raw.items():
            drops = sorted((_parse(t), int(ep)) for t, ep in info["drops"])
            _shows[name] = drops
    return _shows


def known(show):
    return show in shows()


def episode_after(show, posted_at):
    """posted_at 시점까지 공개된 마지막 회차. 첫 공개 전이면 0, 작품·시각을 모르면 None."""
    drops = shows().get(show)
    t = _parse(posted_at)
    if not drops or t is None:
        return None
    last = 0
    for drop_time, ep in drops:
        if t >= drop_time:
            last = ep
    return last


def last_episode(show):
    drops = shows().get(show)
    return drops[-1][1] if drops else None