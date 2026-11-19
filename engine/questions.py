"""판정 질문 문구. 현장에서 '문구 후보 비교'는 이 파일만 바꿔 가며 eval을 돌린다.

PROMPT_VARIANT 환경변수로 후보를 고른다 (기본 A).
"""
import os
import re

TYPES = ["결과 공개", "유출 주장", "루머·추측", "감상·출연자 이야기", "무관"]
NONE_EVENT = "해당 없음"

TYPE_CRITERIA = {
    "A": {
        "결과 공개": "방송에서 실제로 일어난 결과·전개(우승, 탈락, 반전, 승패 등)를 사실로 말한다. 돌려 말해도 포함.",
        "유출 주장": "방송 전 녹화·관계자·유출 정보를 근거로 결과를 안다고 주장한다.",
        "루머·추측": "결과를 짐작하거나 들은 소문을 전한다 ('~설', '~래', '~일 듯').",
        "감상·출연자 이야기": "출연자, 요리, 분위기에 대한 감상이나 응원. 결과는 드러나지 않는다.",
        "무관": "방송 내용과 관계없는 글.",
    },
    "C": {  # A + 감상처럼 쓴 결과 글 (dev에서 놓친 스포 대부분이 '감상'으로 분류됨)
        "결과 공개": ("방송에서 실제로 일어난 결과·전개(우승, 탈락, 결승 진출, 승패, 점수 등)를 말하거나 전제한다. "
                    "감상·칭찬·아쉬움처럼 쓰여도 누가 이기고 졌는지 알 수 있으면 여기에 속한다."),
        "유출 주장": "방송 전 녹화·관계자·유출 정보를 근거로 결과를 안다고 주장한다.",
        "루머·추측": "결과를 짐작하거나 들은 소문을 전한다 ('~설', '~래', '~일 듯').",
        "감상·출연자 이야기": "출연자, 요리, 분위기에 대한 감상이나 응원. 읽어도 결과(누가 이기고 졌는지)는 알 수 없다.",
        "무관": "방송 내용과 관계없는 글.",
    },
    "B": {  # 짧은 문구 후보
        "결과 공개": "실제 방송 결과를 알려 준다",
        "유출 주장": "유출된 결과를 안다고 주장한다",
        "루머·추측": "결과에 대한 소문이나 추측이다",
        "감상·출연자 이야기": "결과 없이 감상만 말한다",
        "무관": "방송과 관계없다",
    },
}

TYPE_INSTRUCTIONS = {
    "A": "이 댓글이 어떤 종류의 글인지 고르세요. 결과를 직접 쓰지 않고 돌려 말해도 결과를 알 수 있으면 '결과 공개'입니다.",
    "B": "이 댓글의 성격을 고르세요.",
    "C": "이 댓글이 어떤 종류의 글인지 고르세요. 결과를 직접 쓰지 않고 감상처럼 돌려 말해도 결과를 알 수 있으면 '결과 공개'입니다.",
}

EVENT_INSTRUCTIONS_BY_VARIANT = {
    "A": "이 댓글이 아래 사건 중 어떤 것을 드러내거나 암시하나요? 돌려 말한 표현도 포함합니다. 어느 것도 아니면 '해당 없음'.",
    # B: 출연자 이름만 나온 감상을 사건과 엮지 않도록 (송유진 님이 찾은 잘못 가린 글). dev에서 E 설정
    "B": ("이 댓글을 읽은 사람이 아래 사건의 결과(누가 이기고 졌는지, 진출·탈락·우승했는지)를 알게 되나요? "
          "돌려 말한 표현도 포함합니다. 출연자 이름이 나오거나 출연자를 칭찬·응원하는 것만으로는 알게 되지 않으니 '해당 없음'입니다."),
    # C: B + 출연 스포 (특별 심사위원 등장 등도 스포로 라벨링함)
    "C": ("이 댓글을 읽은 사람이 아래 사건의 결과나 전개(누가 이기고 졌는지, 진출·탈락·우승했는지, "
          "누가 특별 심사위원 등으로 새로 등장했는지)를 알게 되나요? "
          "돌려 말한 표현도 포함합니다. 출연자 이름이 나오거나 출연자를 칭찬·응원하는 것만으로는 알게 되지 않으니 '해당 없음'입니다."),
}
EVENT_VARIANT = os.environ.get("EVENT_VARIANT", "A")
EVENT_INSTRUCTIONS = EVENT_INSTRUCTIONS_BY_VARIANT.get(EVENT_VARIANT, EVENT_INSTRUCTIONS_BY_VARIANT["A"])

# 댓글로 기억장 만들기: 거르기 질문 (글 종류보다 '결과가 담겼나'를 직접 묻는 쪽이 훨씬 잘 갈림)
HAS_RESULT_QUESTION = {"has_result": {
    "type": "choice",
    "instructions": "이 댓글에 방송에서 실제로 일어난 결과(탈락, 생존, 진출, 우승, 승패)가 담겨 있나요? 감상처럼 써도 결과를 알 수 있으면 '예'.",
    "criteria": {"예": "실제 결과가 담겨 있음", "아니오": "결과가 없음 (감상, 응원, 질문, 추측)"}}}

# 영상 제목을 같이 주고, '이분' 같은 말 대신 이름을 쓰게 (제목에 출연자 이름이 있는 경우가 많음)
EXTRACT_WITH_TITLE_PROMPT = (
    "다음은 '{show}' 리뷰 영상에 달린 댓글입니다. 댓글이 알려 주는 방송 속 결과를 아래 형식으로만 쓰세요.\n"
    "형식: <누가> <결과>  (결과는 우승, 준우승, 탈락, 생존, 진출, 승리, 패배 중 하나와 필요하면 어느 라운드인지)\n"
    "예: '최강록 우승', '요리괴물 결승 진출', '김도윤 1라운드 탈락', '선재스님 생존권으로 3라운드 진출'\n"
    "댓글 문장을 베끼지 말고, 감상·이유·평가는 빼세요. '이분' 대신 이름이나 별명을 쓰고, "
    "누가 어떤 결과를 얻었는지 알 수 없으면 '없음'만 쓰세요.\n"
    "영상 제목: {title}\n댓글: {text}"
)
# 뽑은 문장에 결과를 뜻하는 말이 없으면 버린다 (댓글을 베낀 감상 문장 거르기)
RESULT_WORDS = ("우승", "준우승", "탈락", "생존", "진출", "승리", "패배", "이겼", "졌", "떨어", "올라", "부활", "합격", "결승", "통과")

EXTRACT_PROMPT = (
    "다음은 '{show}' 관련 댓글입니다. 이 댓글이 드러내는 방송 속 사건을 "
    "'누가 무엇을 했다/됐다' 형식의 한 문장(25자 이내)으로만 쓰세요. 다른 말은 쓰지 마세요.\n"
    "댓글: {text}"
)


def variant():
    return os.environ.get("PROMPT_VARIANT", "A")


# 애매한 글에서 에이전트가 더 달라고 할 수 있는 단서 (확장이 페이지에서 모아 다시 보냄)
CLUES = {
    "parent": "원댓글 전문 (이 글이 답글일 때)",
    "replies": "이 댓글에 달린 답글들",
    "description": "영상 설명과 고정 댓글",
    "timestamp": "댓글에 적힌 시각(예: 12:20) 부근의 영상 내용·챕터",
}
CLUE_NONE = "필요 없음"
CLUE_INSTRUCTIONS = "이 댓글이 스포일러인지 확실히 판단하려면 무엇을 더 보면 가장 도움이 되나요? 지금 정보로 충분하면 '필요 없음'."
_CLUE_LIMIT = 300


def _clip(x, n=_CLUE_LIMIT):
    x = re.sub(r"\s+", " ", str(x or "")).strip()
    return x if len(x) <= n else x[:n] + "…"


def format_clues(clues):
    """확장이 모아 온 단서를 Zoro state에 넣을 짧은 글로. 길이를 잘라 문맥이 너무 길어지지 않게."""
    parts = []
    if clues.get("parent"):
        parts.append(f"원댓글: {_clip(clues['parent'])}")
    if clues.get("replies"):
        reps = [_clip(r, 100) for r in clues["replies"][:5] if r]
        if reps:
            parts.append("답글들: " + " / ".join(reps))
    if clues.get("description"):
        parts.append(f"영상 설명: {_clip(clues['description'])}")
    if clues.get("timestamp"):
        ts = clues["timestamp"]
        parts.append(f"시각 정보: {_clip(ts if isinstance(ts, str) else ' '.join(str(v) for v in ts.values()))}")
    return "\n".join(parts)


def build_state(show, comment):
    state = {"작품": show, "댓글": comment["text"]}
    if comment.get("context"):  # 영상 제목. 답글이면 "\n원댓글: ..."이 붙어 옴
        state["문맥"] = comment["context"]
    if comment.get("clues"):  # 에이전트가 요청해서 확장이 모아 온 단서
        state["단서"] = format_clues(comment["clues"])
    return state


_people_cache = {}


def people_aliases(show):
    """engine/config/people.<작품>.csv: name, aliases(;로 구분). 사람별 별명 사전."""
    if show not in _people_cache:
        import csv
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config", f"people.{show}.csv")
        table = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8-sig") as f:
                for r in csv.DictReader(f):
                    table[r["name"].strip()] = [a.strip() for a in (r.get("aliases") or "").split(";") if a.strip()]
        _people_cache[show] = table
    return _people_cache[show]


def event_desc(e, show=""):
    """선택지 설명: 회차 + 관련 인물(별명) — "관련 인물: 최강록(조림핑, 조림인간), 요리괴물(이하성)" """
    desc = f"{e['episode']}화에서 드러난 사건"
    table = people_aliases(show) if show else {}
    names = []
    for p in e.get("people") or []:
        al = table.get(p) or []
        names.append(f"{p}({', '.join(al)})" if al else p)
    if names:
        desc += ". 관련 인물: " + ", ".join(names)
    elif e.get("aliases"):  # 예전 형식 (사건마다 별명)
        desc += f". 이렇게도 불림: {', '.join(e['aliases'])}"
    return desc


def _name_keys(name, aliases):
    """사람 하나를 찾을 때 쓸 글자들: 이름, 별명, 세 글자 이름이면 이름만(강록)."""
    keys = {name, *aliases}
    if len(name) == 3 and all("가" <= ch <= "힣" for ch in name):
        keys.add(name[1:])
    return {k for k in keys if len(k) >= 2}


def candidate_events(events, show, text, limit=6):
    """댓글에 나온 출연자 이름·별명으로 사건 후보를 먼저 추린다.

    선택지가 적을수록 Zoro가 빠르고 덜 헷갈린다. 아무도 안 나오면 [] (사건 질문 생략).
    """
    table = people_aliases(show) if show else {}
    flat = re.sub(r"\s+", "", text)  # 띄어쓰기 무시: "아기맹수" = "아기 맹수"

    def has(k):
        return re.sub(r"\s+", "", k) in flat

    scored = []
    for e in events:
        people = e.get("people") or []
        hit = sum(1 for p in people if any(has(k) for k in _name_keys(p, table.get(p) or [])))
        hit += sum(1 for a in e.get("aliases") or [] if a and has(a))  # 사건 열쇠말 (메뉴, 라운드 이름 등)
        if not people and not e.get("aliases"):  # 자동으로 만든 사건처럼 인물·열쇠말이 없으면 단어 겹침으로
            words = {w for w in re.findall(r"[가-힣A-Za-z0-9]{2,}", e["text"])}
            hit += sum(1 for w_ in words if w_ in flat)
        if hit:
            scored.append((hit, e.get("hits", 1), e))
    scored.sort(key=lambda x: (-x[0], -x[1], -x[2]["episode"]))
    return [e for _, _, e in scored[:limit]]


def build_questions(events, show="", ask_clue=False):
    v = variant()
    qs = {
        "type": {"type": "choice", "instructions": TYPE_INSTRUCTIONS[v], "criteria": TYPE_CRITERIA[v]},
    }
    if events:
        crit = {e["text"]: event_desc(e, show) for e in events}
        crit[NONE_EVENT] = "목록의 어떤 사건과도 관계없음"
        qs["event"] = {"type": "choice", "instructions": EVENT_INSTRUCTIONS, "criteria": crit}
    if ask_clue:
        crit = dict(CLUES)
        crit[CLUE_NONE] = "지금 정보로 충분히 판단할 수 있음"
        qs["clue"] = {"type": "choice", "instructions": CLUE_INSTRUCTIONS, "criteria": crit}
    return qs


ARTICLE_PROMPT = (
    "다음은 '{show}' 관련 기사입니다. 방송 안에서 실제로 일어난 결과·전개(누가 이겼다, 탈락했다, 진출했다, 우승했다 등)만 골라 "
    "한 줄에 하나씩 '누가 무엇을 했다/됐다' 형식(30자 이내)으로 쓰세요. 예고, 관전 포인트, 시청 순위, 논란, 출연자 근황처럼 "
    "방송 결과가 아닌 내용은 빼세요. 사건이 없으면 '없음'만 쓰세요.\n\n기사:\n{text}"
)


def build_same_event_question(events):
    crit = {e["text"]: f"{e['episode']}화 사건" for e in events}
    crit["새 사건"] = "목록의 어떤 사건과도 다른 새로운 사건"
    return {"same": {"type": "choice",
                     "instructions": "아래 문장과 같은 사건을 목록에서 고르세요. 표현이 달라도 같은 일이면 같은 사건입니다.",
                     "criteria": crit}}