# eval/: 평가 (김서형)

라벨링한 유튜브 댓글로 **쉿스포 vs 키워드 방식**을 비교합니다.

```bash
python3 engine/fake_zoro.py & python3 engine/server.py &      # 또는 진짜 Zoro로 띄운 엔진
python3 eval/evaluate.py --labels data/labeled/A.csv,data/labeled/B.csv --show 흑백요리사2 \
    --keywords eval/keywords.흑백요리사2.json --watched 3,7,10,12 --reason band
# -> eval/out/report.md (README 평가 표에 옮길 수치), compare.png, calibration.png, predictions.csv, metrics.json
```

시험용으로 `eval/sample_labels.csv`(demo-page의 지어낸 댓글 14개에 라벨을 단 것)가 있습니다.

## 채점 방식

- 정답: `event_episode` = 이 글을 읽으면 알게 되는 가장 늦은 회차 (없으면 빈칸). **N화까지 본 사람에게 스포 = `event_episode > N`**
- 시간 순서대로 엔진에 보내고 기억장을 처음부터 다시 쌓습니다 (본 회차마다 `/memory/reset`).
- 답글은 확장처럼 원댓글을 `context`에 붙여 보냅니다 (`parent_id` 사용).
- `--reason band`: 확장처럼 기준 ±10%p 안의 글만 1개씩 `?reason=true`로 다시 묻기. `none`, `always`도 가능.

## 나오는 지표

| 지표 | 뜻 |
|---|---|
| 놓친 스포 | 스포인데 안 가린 비율 (가장 중요) |
| 잘못 가린 글 | 스포가 아닌데 가린 비율 |
| 회차 정확도 (±1) | 스포 글에서 엔진이 짚은 회차(기억장 매칭 우선, 없으면 작성 시점)가 라벨과 같은 비율 |
| 글 성격 정확도 | 5개 종류를 맞힌 비율 + 혼동 행렬 (`metrics.json`) |
| 진짜 vs 루머 | 라벨이 `결과 공개`/`루머·추측`인 글에서 둘을 맞게 나눈 비율 |
| Brier · 보정 곡선 | 확률을 믿을 수 있는지 (0이 완벽, 0.25가 동전 던지기). "민감도 슬라이더 = 확률 기준"의 근거 |
| 추론 비율 | 추론 모드로 다시 물은 글의 비율 |
| 20개 판정 | 20개 한 묶음 응답 시간 (README 약속: 2~3초) |
| 기준별 결과 | `metrics.json`의 `sweep`: 기준 0.1~0.9별 놓친 스포 / 잘못 가린 글 |

키워드 방식은 `keywords.흑백요리사2.json`의 세 목록(확장 기본값 / 출연자 이름 / 결과 단어)을 각각 따로 채점합니다. 회차를 모르므로 본 회차와 관계없이 같은 글을 가립니다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `evaluate.py` | 채점 + 보고서 + 그래프 |
| `keyword_baseline.py` | 키워드 방식 비교군 (확장의 키워드 모드와 같은 단순 포함 검사) |
| `keywords.흑백요리사2.json` | 키워드 목록 |
| `agreement.py` | 두 사람 라벨 일치율 (기준 맞추기) |
| `LABELING.md` | 라벨링 기준 |
| `sample_labels.csv` | 시험용 라벨 (지어낸 댓글) |
