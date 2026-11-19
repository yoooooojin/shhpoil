"""예전 방식(p_event)과 스포 목록 방식(p_sheet)을 섞는 법을 predictions.csv 하나로 비교 (Zoro 다시 안 부름).

    python3 eval/combo.py eval/out/dev_sheet/predictions.csv [더 많은 predictions.csv ...]

SHEET=1로 돌린 결과여야 p_sheet 칸이 있다. 표: 놓친 스포 % / 잘못 가린 글 % (꼼꼼함 0.4 / 0.5 / 0.7)
마지막 표: 잘못 가린 글을 예전 방식(0.5)과 같은 수준으로 맞췄을 때 놓친 스포 % (공정 비교)
"""
import csv
import sys

TH = {"0.4": 0.63, "0.5": 0.575, "0.7": 0.465}


def load(paths):
    rows = []
    for p in paths:
        with open(p, encoding="utf-8-sig") as f:
            for r in csv.DictReader(f):
                if r.get("p_spoiler") in ("", None) or r.get("p_sheet") in ("", None):
                    continue
                k = r.get("written_after")
                r["_k"] = int(k) if k not in ("", None) else None
                r["_w"] = int(r["watched"])
                r["_g"] = int(r["gold_spoiler"])
                r["_pe"] = float(r["p_event"] or r["p_spoiler"])
                r["_ps"] = float(r["p_sheet"])
                rows.append(r)
    return rows


def methods():
    def sheet(g):
        return lambda r: r["_ps"] * (g if (r["_k"] is not None and r["_k"] <= r["_w"]) else 1.0)
    out = {"예전(event)": lambda r: r["_pe"]}
    for g in (0.3, 0.5, 1.0):
        out[f"목록(sheet,early×{g})"] = sheet(g)
    s5 = sheet(0.5)
    out["max(예전,목록)"] = lambda r: max(r["_pe"], s5(r))
    out["mean(예전,목록)"] = lambda r: (r["_pe"] + s5(r)) / 2
    return out


def rates(rs, f, th):
    pos = [r for r in rs if r["_g"]]
    neg = [r for r in rs if not r["_g"]]
    miss = sum(1 for r in pos if f(r) < th) / len(pos) * 100 if pos else float("nan")
    fa = sum(1 for r in neg if f(r) >= th) / len(neg) * 100 if neg else float("nan")
    return miss, fa


def main():
    rows = load(sys.argv[1:])
    if not rows:
        sys.exit("p_sheet 칸이 없어요. SHEET=1로 엔진을 켜고 evaluate.py를 다시 돌리세요.")
    ws = sorted({r["_w"] for r in rows})
    M = methods()
    for name, th in TH.items():
        print(f"\n== 꼼꼼함 {name} (기준 {th})  놓침/잘못가림")
        print("방식".ljust(22) + "".join(f"{w}화({sum(r['_g'] for r in rows if r['_w']==w)})".rjust(14) for w in ws) + "전체".rjust(14))
        for m, f in M.items():
            cells = [rates([r for r in rows if r["_w"] == w], f, th) for w in ws] + [rates(rows, f, th)]
            print(m.ljust(22) + "".join(f"{a:5.1f}/{b:4.1f}".rjust(14) for a, b in cells))
    # 공정 비교: 잘못 가림을 예전 방식(0.5)과 같게 맞춘 기준에서 놓침
    _, target = rates(rows, M["예전(event)"], TH["0.5"])
    print(f"\n== 잘못 가림을 예전 방식 0.5 수준({target:.1f}%)으로 맞췄을 때 놓친 스포 % (전체)")
    for m, f in M.items():
        best = None
        for i in range(1, 100):
            th = i / 100
            miss, fa = rates(rows, f, th)
            if fa <= target + 1e-9 and (best is None or miss < best[0]):
                best = (miss, fa, th)
        print(f"  {m.ljust(22)} 놓침 {best[0]:5.1f}%  (잘못 가림 {best[1]:.1f}%, 기준 {best[2]})" if best else f"  {m}: -")


if __name__ == "__main__":
    main()
