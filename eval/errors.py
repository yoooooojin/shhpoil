"""틀린 글 모아 보기: 평가 결과(predictions.csv)에 원문을 붙여 '놓친 스포'와 '잘못 가린 글'을 원인별로 나눈다.

    python3 eval/errors.py --pred eval/out/dev_E/predictions.csv --labels data/labeled/dev.csv --watched 3

결과
  - 터미널: 원인별 개수 + 원인마다 예시 몇 개
  - <pred 폴더>/errors_w<본 회차>.csv: 틀린 글 전체 (Jupyter에서 열면 표로 보임)

원문이 들어가므로 이 CSV는 레포에 올리지 않는다 (eval/out/은 .gitignore).
"""
import argparse
import csv
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine"))
import questions as Q  # noqa: E402
import memory  # noqa: E402

TIPS = {
    "놓침: 이름·별명이 안 나옴": "후보 사건이 0개라 사건 질문을 못 함 → 글에 나온 표현을 config/people.<작품>.csv 별명에 추가",
    "놓침: 후보는 있었는데 사건을 못 고름": "Zoro가 '해당 없음'을 고름 → 그 회차 사건이 기억장에 있는지, 사건 문장이 글 표현과 너무 다른지 확인",
    "놓침: 사건은 맞췄는데 확률이 낮음": "사건은 찾았지만 종류(감상 등) 때문에 확률이 깎임 → 기준선/W_REACTION, 또는 글 종류 설명 다듬기",
    "놓침: 다른 회차 사건을 고름": "본 회차 이전 사건과 엮음 → 사건 문장/회차 확인",
    "잘못 가림: 엉뚱한 사건과 엮음": "스포가 아닌데 뒤 화 사건을 골랐음 → 그 사건의 별명이 너무 흔한지(people.csv), 사건 문구 확인",
    "잘못 가림: 작성 시점만으로 가림": "사건 매칭 없이 '결과 공개/유출'로 봐서 가림 → 글 종류 판단 문제",
    "잘못 가림: 정답 라벨 확인 필요": "엔진은 이미 본 회차 뒤 사건을 짚었다고 봄 → 라벨이 맞는지 다시 보기",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--show", default="흑백요리사2")
    ap.add_argument("--watched", type=int, default=3)
    ap.add_argument("--threshold", type=float, default=0.575)
    ap.add_argument("--examples", type=int, default=3)
    args = ap.parse_args()

    text = {}
    with open(args.labels, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            text[r.get("comment_id") or r.get("id")] = r
    events = memory.load(args.show)

    rows = []
    with open(args.pred, encoding="utf-8-sig") as f:
        for p in csv.DictReader(f):
            if int(p["watched"]) != args.watched or p["p_spoiler"] == "":
                continue
            gold = p["gold_spoiler"] == "1"
            pred = float(p["p_spoiler"]) >= args.threshold
            if gold == pred:
                continue
            src = text.get(p["id"], {})
            t = src.get("text", "")
            n_cands = len(Q.candidate_events(events, args.show, t))
            me = p["matched_event"]
            mep = int(p["matched_ep"]) if p["matched_ep"] else None
            if gold:
                if n_cands == 0:
                    why = "놓침: 이름·별명이 안 나옴"
                elif not me:
                    why = "놓침: 후보는 있었는데 사건을 못 고름"
                elif mep is not None and mep <= args.watched:
                    why = "놓침: 다른 회차 사건을 고름"
                else:
                    why = "놓침: 사건은 맞췄는데 확률이 낮음"
            else:
                if me and mep and mep > args.watched and src.get("event_note"):
                    why = "잘못 가림: 정답 라벨 확인 필요"
                elif me:
                    why = "잘못 가림: 엉뚱한 사건과 엮음"
                else:
                    why = "잘못 가림: 작성 시점만으로 가림"
            rows.append({"원인": why, "p_spoiler": p["p_spoiler"], "정답_회차": p["reveals_episode"],
                         "라벨_종류": p["label_type"], "엔진_종류": p["pred_type"],
                         "엔진_사건": me, "엔진_사건_회차": p["matched_ep"], "작성_시점": p["written_after"],
                         "후보_수": n_cands, "글": t.replace("\n", " ")[:200], "id": p["id"]})

    cnt = Counter(r["원인"] for r in rows)
    by = defaultdict(list)
    for r in rows:
        by[r["원인"]].append(r)
    print(f"본 회차 {args.watched}화, 기준선 {args.threshold}: 틀린 글 {len(rows)}개\n")
    for why, n in cnt.most_common():
        print(f"■ {why}: {n}개")
        print(f"  → {TIPS[why]}")
        for r in by[why][:args.examples]:
            ev = f" | 엔진 사건: {r['엔진_사건'][:30]}({r['엔진_사건_회차']}화)" if r["엔진_사건"] else ""
            print(f"    - [{r['p_spoiler']}] {r['글'][:60]}{ev} | 정답 {r['정답_회차'] or '-'}화")
        print()

    out = os.path.join(os.path.dirname(args.pred), f"errors_w{args.watched}.csv")
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        if rows:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(sorted(rows, key=lambda r: r["원인"]))
    print(f"전체 목록: {out}")


if __name__ == "__main__":
    main()