# engine/: 판단 엔진 (김서형)

`mock-server/server.py` 자리에 그대로 들어가는 진짜 판단 엔진입니다. 주소(`localhost:8787`), `/judge` 형식, `/demo/` 시연 페이지가 모두 같아서 **확장 설정을 바꿀 필요가 없습니다.**

## 실행

```bash
# Zoro 없이 (개발용 가짜 Zoro)
python3 engine/fake_zoro.py &          # localhost:30001
python3 engine/server.py               # localhost:8787  (/demo/ 포함)
```

### GPU 서버에서 진짜 Zoro-1 (Brev AWS L40S로 확인)

최신 SGLang은 **CUDA 13**이 필요합니다. `nvidia-smi`의 `CUDA Version`이 12.x면 `sgl_kernel`이 `libnvrtc.so.13`을 못 찾아 실행되지 않으니, 드라이버가 새로운 인스턴스를 쓰세요.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh && source ~/.local/bin/env
uv venv ~/venv --python 3.12 && source ~/venv/bin/activate
git clone https://github.com/trillion-labs/trida-stack.git
git clone https://github.com/yoooooojin/shhpoil.git
uv pip install "sglang>=0.5.22" fastapi uvicorn huggingface_hub
hf auth login                      # Zoro-1 모델 페이지에서 조건 동의 먼저

cd ~/shhpoil
python3 engine/learn_from_articles.py --seed engine/config/memory.흑백요리사2.csv
nohup python3 engine/server.py > ~/engine.log 2>&1 &

cd ~/trida-stack/inference/zoro-1   # tmux 창에서
python serve.py --mode decide --port 30001
```

L40S에서 댓글 20개 묶음 판정이 약 1.3초였습니다(생각 없이).

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
| 결과마다 | `memory_update` | (`LEARN_FROM_COMMENTS=1`일 때) 이 글로 사건을 추가 중이면 `{"pending": true, "episode": 13}` |
| 결과마다 | `latency_ms` | 이 글 판정 시간 |
| 결과마다 | `timing` | `{"zoro_calls": 1, "zoro_ms": 964, "n_event_options": 5, "reasoning": false}` 어디서 시간이 드는지 |
| 응답 맨 위 | `memory` | `{"size": 기억장 크기, "added": [이번에 새로 추가된 사건], "pending": 추출 대기 수}`. "기억장 +1" 표시에 쓰면 됨 |

| 엔드포인트 | 용도 |
|---|---|
| `GET /memory?show=흑백요리사2` | 기억장 전체 (회차순) |
| `GET /memory?show=흑백요리사2&max_episode=7` | 7화까지의 사건만 (시간 돌리기 시연) |
| `POST /memory/reset` `{"show": "흑백요리사2"}` | 기억장 비우기 |
| `POST /memory/add` `{"show": ..., "events": [{"text", "episode", "source"}]}` | 사건 넣기 (평가·시연용) |
| `POST /judge?memory=sync` | 사건 추출을 기다렸다가 응답 (평가·기억장 구축용. 확장에서는 쓰지 않음) |

## 판단 방식

1. **시점**: `posted_at` + `config/shows.json`의 공개 일정 → `written_after_episode`
2. **성격**: Zoro `choice` 질문 하나로 5개 종류의 확률 (문구는 `questions.py`)
3. **사건**: 댓글(과 원댓글)에 나온 출연자 이름·별명으로 기억장 사건을 최대 6개까지 먼저 추리고, 그 후보를 선택지로 넣은 `choice` 질문 ("해당 없음" 포함). 아무도 안 나오면 사건 질문을 빼고 작성 시점으로만 판단. 라벨 밖 답이 안 나오므로 없는 사건을 지어내지 않음
4. **조합**: `server.py` 맨 위 주석의 공식. 유출 주장은 작성 시점보다 뒤 내용으로, 루머는 실제 뒤 사건과 맞을 때만 스포로 계산
5. **기억장 보정**: 댓글이 기존 사건과 맞으면(0.6 이상) 언급 수를 올리고, 더 이른 글이면 회차를 앞으로 고침. 사건 자체는 기사에서 만듦 (아래)

질문 2개를 한 요청(`questions` dict)에 묶어서 글 하나당 Zoro 호출은 한 번이고, 묶음 안의 글들은 동시에 보내 SGLang이 GPU에서 함께 처리합니다 (L40S에서 20개 약 1.3초). 엔진 로그에 묶음마다 `[judge] 20개 1322ms | Zoro 호출 20번 … | 사건 선택지 평균 4.8개`가 찍히고, 결과마다 `timing` 칸이 붙습니다.

## 스포 기억장 만들기

**뼈대는 기사에서, 댓글은 보정용.** 댓글은 대부분 감상이라 사건을 뽑기 어려워서, 회차마다 나온 기사를 에이전트(Zoro)가 읽고 사건을 뽑습니다.

```bash
# 1. Zoro가 기사 목록을 읽고 사건 추출 (기사 내려받기는 이 PC에서. 막힌 사이트는 본문을 .txt로 저장해 "file"로)
python3 engine/learn_from_articles.py --articles engine/config/articles.흑백요리사2.json

# 팀이 정리한 기억장 CSV를 그대로 넣기 (Zoro 추출 결과와 비교하는 정답지이기도 함)
python3 engine/learn_from_articles.py --seed engine/config/memory.흑백요리사2.csv

# 시간 돌리기 시연: 7화까지 공개된 시점의 기억장
python3 engine/learn_from_articles.py --seed engine/config/memory.흑백요리사2.csv --until-episode 7

# 2. (선택) 모아 둔 댓글로 보정: 기존 사건과 매칭되면 언급 수 +1, 더 이른 글이면 회차를 앞으로
python3 engine/build_memory.py data/raw/comments_*.csv --show 흑백요리사2
```

- 기사 회차 = 게시 시각 기준 몇 화까지 공개됐는지 (`published`), 또는 목록에 직접 적은 `episode`
- 기사는 게시 순서대로 읽고, 같은 사건이 또 나오면 Zoro에게 "목록의 어떤 사건과 같은가"를 물어 합칩니다 (새로 추가하지 않고 언급 수 +1)
- 엔진은 댓글로 새 사건을 만들지 않습니다 (`LEARN_FROM_COMMENTS=1`로 켤 수 있음)
- 기사 목록: `config/articles.흑백요리사2.json` / 팀 기억장: `config/memory.흑백요리사2.csv` (열: episode, episode_range, event, people, aliases, check, source. people·aliases는 `;`로 구분)
- `people`·`aliases`는 Zoro 질문의 선택지 설명에 들어갑니다 ("관련 인물: 최강록. 이렇게도 불림: 조림핑, 조림인간"). 별명으로 돌려 말한 댓글을 잡는 데 중요해요
- `config/events.흑백요리사2.json`은 예전 형식의 같은 내용 (JSON도 계속 받음)
- 확인: `http://localhost:8787/memory?show=흑백요리사2`

## 조정 손잡이 (환경변수)

| 이름 | 기본 | 뜻 |
|---|---|---|
| `ZORO_URL` | `http://localhost:30001` | Zoro decide 서버 |
| `ZORO_CHAT_URL` | `ZORO_URL` | 사건 추출(생성) 서버가 다르면 |
| `ZORO_CONCURRENCY` | 20 | Zoro에 동시에 보내는 요청 수 |
| `JUDGE_PARALLEL` | 20 | 묶음 안의 글을 동시에 처리하는 수 (1이면 하나씩) |
| `PREFILTER` | 1 | 출연자 이름·별명으로 사건 후보를 먼저 추림 (0이면 기억장 전체) |
| `MAX_CANDIDATES` | 6 | 추린 사건 후보 최대 수 |
| `ZORO_MAX_REASONING_TOKENS` | 4096 | 추론 모드 예산 (모델 카드 권장 최소) |
| `MEMORY_ADD_P` | 0.85 | 이 이상 확실한 `결과 공개`만 사건 추가 |
| `MATCH_EXISTING_P` | 0.6 | 이 이상이면 기존 사건의 재언급 |
| `MATCH_REPORT_P` | 0.3 | 이 이상이면 `matched_event`로 알려 줌 (확장은 0.5 이상만 회차 판단에 씀) |
| `MAX_EVENTS` | 30 | 판정 질문에 넣는 사건 최대 수 |
| `LEARN_FROM_COMMENTS` | 0 | 1이면 확실한 스포 댓글에서도 새 사건 추가 |
| `SAME_EVENT_P` | 0.6 | 기사에서 뽑은 문장을 기존 사건과 같은 것으로 볼 기준 |
| `PROMPT_VARIANT` | A | 질문 문구 후보 (`questions.py`) |
| `W_REACTION` | 0 | `감상` 유형이어도 뒤 화 사건을 짚으면 스포 확률에 더하는 비율 (dev에서 0/0.5/1 비교) |

## 파일

| 파일 | 하는 일 |
|---|---|
| `server.py` | `/judge`, `/health`, `/memory`, `/demo/` |
| `zoro_client.py` | Zoro 호출. **진짜로 바꿀 때 고칠 곳은 여기뿐** |
| `questions.py` | 판정 질문 문구와 선택지 |
| `schedule.py` + `config/shows.json` | 공개 일정 → 몇 화 공개 후 글인지 |
| `memory.py` | 스포 기억장 (`memory_store/<작품>.json`, 레포에 안 올림) |
| `learn_from_articles.py` | 기사를 읽고 기억장 만들기 (`--seed`로 정리된 목록 넣기) |
| `build_memory.py` | 모은 댓글로 기억장 보정 |
| `config/articles.*.json`, `config/events.*.json` | 기사 목록, 정리된 사건 목록 |
| `fake_zoro.py` | 가짜 Zoro (단어 신호로 흉내만 냄, 정확도 의미 없음) |
| `sample_decide.json` | 진짜 Zoro 응답 형식 확인용 요청 |