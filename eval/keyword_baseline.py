"""키워드 방식 비교군 (기존 스포 차단 확장처럼 동작: 회차를 모르고, 단어가 있으면 가림).

eval/keywords.<작품>.json 의 "modes"마다 따로 평가한다.
  확장 기본    extension/popup.js 기본값과 같은 목록 (같은 화면의 키워드 모드와 똑같이)
  출연자 이름  이름이 나오면 가림 (기존 확장의 흔한 사용법)
  결과 단어    '우승/탈락' 같은 결과 단어가 나오면 가림

    python3 eval/keyword_baseline.py eval/keywords.흑백요리사2.json "최강록 셰프 말투 웃김"
"""
import json
import sys


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def modes(kw):
    return list(kw["modes"].keys())


def predict(text, kw, mode):
    # 확장(content.js applyKeyword)과 같은 방식: 단순 포함 검사
    hits = [w for w in kw["modes"][mode] if w and w in text]
    return {"blocked": bool(hits), "p_spoiler": 1.0 if hits else 0.0, "hits": hits}


if __name__ == "__main__":
    kw = load(sys.argv[1])
    for m in modes(kw):
        print(m, predict(sys.argv[2], kw, m))
