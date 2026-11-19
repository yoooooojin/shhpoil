# engine/: 판단 엔진 (김서형)

`mock-server/server.py` 자리에 그대로 들어가는 진짜 판단 엔진입니다. 주소(`localhost:8787`), `/judge` 형식, `/demo/` 시연 페이지가 모두 같아서 **확장 설정을 바꿀 필요가 없습니다.**

## 실행

```bash
# Zoro 없이 (개발용 가짜 Zoro)
python3 engine/fake_zoro.py &          # localhost:30001
python3 engine/server.py               # localhost:8787  (/demo/ 포함)

# 진짜 Zoro-1 (현장)
git clone https://github.com/trillion-labs/trida-stack && cd trida-stack/inference/zoro-1
pip install "sglang>=0.5.22" fastapi uvicorn
python serve.py --mode decide --port 30001        # 결정(/v1/decide) + 생성(OpenAI 호환) 한 서버
# 레포로 돌아와서
ZORO_URL=http://<GPU 주소>:30001 python3 engine/server.py
```

진짜 Zoro로 바꾼 직후 할 일:
1. `curl -X POST $ZORO_URL/v1/decide -H 'Content-Type: application/json' -d @engine/sample_decide.json`으로 진짜 응답을 한 번 찍어 보기
2. 형식이 다르면 `engine/zoro_client.py`의 `_normalize()`만 고치기
3. `curl localhost:8787/health`가 `"engine": "zoro-1"`인지 확인 (가짜면 `fake-zoro`, Zoro가 꺼져 있으면 `zoro-down`)

## API (README의 약속 + 추가 필드)

기존 필드(`id`, `p_spoiler`, `type`, `written_after_episode`, `matched_event`, `reasoned`)는 약속 그대로입니다. 아래는 **추가**라서 확장이 안 써도 됩니다.

| 위치 | 필드 | 뜻 |
|---|---|---|
| 결과마다 | `type_probs` | 글 종류 5개 각각의 확률 |
| 결과마다 | `reason_brief` | 추론 모드일 때 추론 요약 (툴팁용) |
| 결과마다 | `memory_update` | 이 글로 기억장에 사건을 추가 중이면 `{"pending": true, "episode": 13}` |
| 결과마다 | `latency_ms` | 이 글 판정 시간 |
| 응답 맨 위 | `memory` | `{"size": 기억장 크기, "added": [이번에 새로 추가된 사건], "pending": 추출 대기 수}`. "기억장 +1" 표시에 쓰면 됨 |

| 엔드포인트 | 용도 |
|---|---|
| `GET /memory?show=흑백요리사2` | 기억장 전체 (회차순) |
| `GET /memory?show=흑백요리사2&max_episode=7` | 7화까지의 사건만 (시간 돌리기 시연) |
| `POST /memory/reset` `{"show": "흑백요리사2"}` | 기억장 비우기 |
| `POST /judge?memory=sync` | 사건 추출을 기다렸다가 응답 (평가·기억장 구축용. 확장에서는 쓰지 않음) |

## 판단 방식

1. **시점**: `posted_at` + `config/shows.json`의 공개 일정 → `written_after_episode`
2. **성격**: Zoro `choice` 질문 하나로 5개 종류의 확률 (문구는 `questions.py`)
3. **사건**: 기억장 사건들을 선택지로 넣은 `choice` 질문 ("해당 없음" 포함). 라벨 밖 답이 안 나오므로 없는 사건을 지어내지 않음
4. **조합**: `server.py` 맨 위 주석의 공식. 유출 주장은 작성 시점보다 뒤 내용으로, 루머는 실제 뒤 사건과 맞을 때만 스포로 계산
5. **기억장 학습**: `결과 공개` 확률이 0.85 이상이고 기존 사건과 안 맞으면 Zoro가 사건을 한 줄로 뽑아 회차와 함께 저장 (뒤에서 처리해서 응답을 막지 않음). 기존 사건과 맞으면 언급 수를 올리고, 더 이른 글이면 회차를 앞으로 고침

질문 2개를 한 요청(`questions` dict)에 묶어서 글 하나당 Zoro 호출은 한 번입니다.

## 기억장 미리 쌓기 (초기 구축 · 시연 준비)

실제 유튜브에서는 기억장이 비어 있으면 돌려 말한 글을 못 잡습니다. 시연 전에 모아 둔 댓글을 시간 순서대로 한 번 흘려 둡니다.

```bash
python3 engine/build_memory.py data/all_comments.csv --show 흑백요리사2
python3 engine/build_memory.py data/all_comments.csv --show 흑백요리사2 --until 2025-12-31   # 그 날까지만
```

## 조정 손잡이 (환경변수)

| 이름 | 기본 | 뜻 |
|---|---|---|
| `ZORO_URL` | `http://localhost:30001` | Zoro decide 서버 |
| `ZORO_CHAT_URL` | `ZORO_URL` | 사건 추출(생성) 서버가 다르면 |
| `ZORO_CONCURRENCY` | 2 | Zoro에 동시에 보내는 요청 수 (적을수록 요청당 빠름) |
| `ZORO_MAX_REASONING_TOKENS` | 4096 | 추론 모드 예산 (모델 카드 권장 최소) |
| `MEMORY_ADD_P` | 0.85 | 이 이상 확실한 `결과 공개`만 사건 추가 |
| `MATCH_EXISTING_P` | 0.6 | 이 이상이면 기존 사건의 재언급 |
| `MATCH_REPORT_P` | 0.3 | 이 이상이면 `matched_event`로 알려 줌 (확장은 0.5 이상만 회차 판단에 씀) |
| `MAX_EVENTS` | 30 | 판정 질문에 넣는 사건 최대 수 |
| `PROMPT_VARIANT` | A | 질문 문구 후보 (`questions.py`) |

## 파일

| 파일 | 하는 일 |
|---|---|
| `server.py` | `/judge`, `/health`, `/memory`, `/demo/` |
| `zoro_client.py` | Zoro 호출. **진짜로 바꿀 때 고칠 곳은 여기뿐** |
| `questions.py` | 판정 질문 문구와 선택지 |
| `schedule.py` + `config/shows.json` | 공개 일정 → 몇 화 공개 후 글인지 |
| `memory.py` | 스포 기억장 (`memory_store/<작품>.json`, 레포에 안 올림) |
| `build_memory.py` | 모은 댓글로 기억장 미리 쌓기 |
| `fake_zoro.py` | 가짜 Zoro (단어 신호로 흉내만 냄, 정확도 의미 없음) |
| `sample_decide.json` | 진짜 Zoro 응답 형식 확인용 요청 |
