"""여러 신호를 합쳐 스포 확률을 다시 계산 (다중 정보 결합: Boyd-Graber 2013 메타데이터, Wang 2023 MVSD, MMoE 2024).

Zoro를 다시 부르지 않고 predictions.csv(SHEET=1로 돌린 것)만 씀. 공정하게 보려고 '교차' 검증:
dev로 배워서 dev2에서 재고, dev2로 배워서 dev에서 잼 (배운 세트로는 절대 안 잼).

    python3 eval/fuse.py --a eval/out/dev_sheet/predictions.csv --a-labels data/labeled/dev.csv \
                         --b eval/out/dev2_sheet/predictions.csv --b-labels data/labeled/dev2.csv

신호: 예전 방식 p, 목록 방식 p, 작성 시점이 본 회차 뒤인지, 엔진이 고른 사건이 안 본 회차인지,
      키워드 3종(확장 기본·출연자 이름·결과 단어)이 걸렸는지, 글 종류, 좋아요·답글 수
"""
import argparse
import csv
import math

import numpy as np

TYPES = ["결과 공개", "유출 주장", "루머·추측", "감상·출연자 이야기"]


def num(x, d=None):
    try:
        return float(x)
    except (TypeError, ValueError):
        return d


def load(pred_path, label_path):
    meta = {}
    if label_path:
        with open(label_path, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                meta[r.get("comment_id") or r.get("id")] = r
    rows = []
    with open(pred_path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if r.get("p_sheet") in ("", None):
                continue
            rows.append(r)
    kw_cols = sorted(c for c in rows[0] if c.startswith("kw_")) if rows else []
    X, y, names = [], [], None
    for r in rows:
        w = int(r["watched"])
        k = num(r.get("written_after"))
        me = num(r.get("matched_ep"))
        m = meta.get(r["id"], {})
        feats = {
            "p_event": num(r["p_event"] or r["p_spoiler"], 0.0),
            "p_sheet": num(r["p_sheet"], 0.0),
            "after": 0.5 if k is None else float(k > w),
            "matched_later": float(me is not None and me > w),
            **{c: num(r[c], 0.0) for c in kw_cols},
            **{f"type_{t}": float(r.get("pred_type") == t) for t in TYPES},
            "log_like": math.log1p(num(m.get("like_count"), 0.0) or 0.0),
            "log_reply": math.log1p(num(m.get("reply_count"), 0.0) or 0.0),
        }
        feats["sheet_x_after"] = feats["p_sheet"] * feats["after"]
        names = list(feats)
        X.append([feats[n] for n in names])
        y.append(int(r["gold_spoiler"]))
    return np.array(X, float), np.array(y, float), names, np.array([num(r["p_event"] or r["p_spoiler"], 0.0) for r in rows])


def fit(X, y, l2=1.0, iters=3000, lr=0.1):
    mu, sd = X.mean(0), X.std(0) + 1e-6
    Z = (X - mu) / sd
    w, b = np.zeros(Z.shape[1]), 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(Z @ w + b)))
        g = p - y
        w -= lr * (Z.T @ g / len(y) + l2 * w / len(y))
        b -= lr * g.mean()
    return lambda Xn: 1 / (1 + np.exp(-(((Xn - mu) / sd) @ w + b))), w


def at_false(p, y, target):
    best = None
    for th in np.arange(0.01, 1.0, 0.01):
        fa = ((p >= th) & (y == 0)).sum() / max(1, (y == 0).sum()) * 100
        miss = ((p < th) & (y == 1)).sum() / max(1, (y == 1).sum()) * 100
        if fa <= target + 1e-9 and (best is None or miss < best[0]):
            best = (miss, fa, th)
    return best


def report(tag, Xtr, ytr, Xte, yte, pe_te, names, l2):
    model, w = fit(Xtr, ytr, l2)
    pf = model(Xte)
    target = ((pe_te >= 0.575) & (yte == 0)).sum() / max(1, (yte == 0).sum()) * 100
    base = at_false(pe_te, yte, target)
    fused = at_false(pf, yte, target)
    print(f"\n== {tag}  (잘못 가림을 예전 방식 0.5 수준 {target:.1f}%로 맞춤)")
    print(f"  예전 방식   놓침 {base[0]:5.1f}%  (잘못 가림 {base[1]:.1f}%)")
    print(f"  합친 방식   놓침 {fused[0]:5.1f}%  (잘못 가림 {fused[1]:.1f}%)   차이 {fused[0]-base[0]:+.1f}%p")
    top = sorted(zip(names, w), key=lambda x: -abs(x[1]))[:6]
    print("  많이 쓴 신호:", ", ".join(f"{n} {v:+.2f}" for n, v in top))


ap = argparse.ArgumentParser()
ap.add_argument("--a", required=True)
ap.add_argument("--a-labels")
ap.add_argument("--b", required=True)
ap.add_argument("--b-labels")
ap.add_argument("--l2", type=float, default=1.0)
a = ap.parse_args()
Xa, ya, na, pa = load(a.a, a.a_labels)
Xb, yb, nb, pb = load(a.b, a.b_labels)
assert na == nb, "두 파일의 칸이 달라요"
report("A로 배워서 B에서 잼", Xa, ya, Xb, yb, pb, na, a.l2)
report("B로 배워서 A에서 잼", Xb, yb, Xa, ya, pa, na, a.l2)
