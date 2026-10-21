#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Read-only diagnostics for downstream RF data freshness.

Uses the exact same source parsers and 196-feature builder as the live RF pipeline.
Does not write to Supabase or alter any forecast/models.
"""
from __future__ import annotations

import argparse
import os
import sys
from typing import Optional

import numpy as np
import pandas as pd

from rf_downstream_common import (
    VN_TZ,
    fetch_pctt_history,
    fetch_downstream_history,
    normalize_hourly,
    build_features,
)

Q_COLS = ["q_av", "q_dm4", "q_sb4", "q_st2"]
H_COLS = ["h_hoi_khach", "h_ai_nghia"]
KEY_COLS = Q_COLS + H_COLS

DISPLAY = {
    "q_av": "A Vương - tổng Q xả",
    "q_dm4": "Đăk Mi 4 - tổng Q xả",
    "q_sb4": "Sông Bung 4 - tổng Q xả",
    "q_st2": "Sông Tranh 2 - tổng Q xả",
    "h_hoi_khach": "Mực nước Hội Khách",
    "h_ai_nghia": "Mực nước Ái Nghĩa",
}

def show_time(ts):
    if ts is None or pd.isna(ts):
        return "KHÔNG CÓ"
    ts = pd.Timestamp(ts)
    if ts.tzinfo is None:
        ts = ts.tz_localize(VN_TZ)
    else:
        ts = ts.tz_convert(VN_TZ)
    return ts.strftime("%d/%m/%Y %H:%M VN")

def age_h(now, ts):
    if ts is None or pd.isna(ts):
        return None
    return (now - ts).total_seconds() / 3600.0

def age_text(now, ts):
    age = age_h(now, ts)
    return "N/A" if age is None else f"{age:.2f}h"

def recent_summary(df, now, cols):
    last24 = pd.date_range(
        now.floor("h") - pd.Timedelta(hours=23),
        now.floor("h"),
        freq="h", tz=VN_TZ,
    )
    aligned = df.reindex(last24)
    print("\nDỮ LIỆU NGUỒN - GIỜ VIỆT NAM (24 giờ gần nhất)")
    print("-" * 104)
    for col in cols:
        if col not in df.columns:
            print(f"{col:<16} KHÔNG TỒN TẠI")
            continue
        valid = df[col].dropna()
        last = valid.index.max() if not valid.empty else None
        missing24 = int(aligned[col].isna().sum())
        print(
            f"{DISPLAY[col]:<31} | mới nhất: {show_time(last):<23} | "
            f"trễ {age_text(now,last):>8} | thiếu {missing24:2d}/24h"
        )

def print_matrix(base, now, n=16):
    # The latest hours are intentionally shown even if currently blank.
    last = now.floor("h")
    begin = last - pd.Timedelta(hours=n-1)
    cut = base.reindex(pd.date_range(begin, last, freq="h", tz=VN_TZ))
    display = pd.DataFrame(index=cut.index)
    for name in KEY_COLS:
        if name in cut:
            display[name] = cut[name].apply(
                lambda v: "--" if pd.isna(v) else f"{float(v):.2f}"
            )
        else:
            display[name] = "--"
    display["ALL_6_PRESENT"] = cut[KEY_COLS].notna().all(axis=1).map(
        {True:"YES", False:"NO"}
    )
    display.index = [t.strftime("%d/%m %H:%M") for t in display.index]
    print("\nMA TRẬN 16 GIỜ GẦN NHẤT (— = không có giá trị, không thay bằng 0)")
    print(display.to_string())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("--max-age-h", type=float, default=4.0)
    args = parser.parse_args()

    now = pd.Timestamp.now(tz=VN_TZ)
    print("="*104)
    print("CHẨN ĐOÁN NGUỒN DỮ LIỆU RF DOWNSTREAM - CHỈ ĐỌC, KHÔNG GHI DATABASE")
    print("Giờ chạy:", show_time(now))
    print("Khoảng truy xuất:", args.hours, "giờ")
    print("="*104)

    # Fetch individually to pinpoint which source failed. The same functions
    # are imported by predict_rf_downstream_live_supabase.py.
    q, h = None, None
    problems = []
    try:
        q = normalize_hourly(fetch_pctt_history(hours=args.hours))
        print(f"\nPCTT: {len(q)} giờ dữ liệu; {show_time(q.index.min())} -> {show_time(q.index.max())}")
    except Exception as exc:
        problems.append("PCTT")
        print(f"\nPCTT FETCH ERROR: {type(exc).__name__}: {str(exc)[:350]}")

    try:
        h = normalize_hourly(fetch_downstream_history(hours=args.hours))
        print(f"HẠ DU: {len(h)} giờ dữ liệu; {show_time(h.index.min())} -> {show_time(h.index.max())}")
    except Exception as exc:
        problems.append("HẠ DU")
        print(f"HẠ DU FETCH ERROR: {type(exc).__name__}: {str(exc)[:350]}")

    if q is None or h is None or q.empty or h.empty:
        msg = " / ".join(problems) if problems else "NGUỒN TRỐNG"
        print(f"::warning title=RF downstream source error::{msg}")
        print("KẾT LUẬN: chưa đủ dữ liệu để kiểm tra feature. Không phát hành dự báo.")
        return 0  # Informative manual diagnostic, not a production forecast step.

    # Match build_live_base() precisely, including common hourly reindexing.
    start = min(q.index.min(), h.index.min()).floor("h")
    end = max(q.index.max(), h.index.max()).floor("h")
    idx = pd.date_range(start, end, freq="h", tz=VN_TZ)
    base = q.reindex(idx).join(h.reindex(idx), how="outer")
    base["q_sum4"] = base[Q_COLS].sum(axis=1, min_count=4)

    recent_summary(base, now, KEY_COLS)
    print_matrix(base, now)

    print("\nĐỘ ĐẦY ĐỦ CỦA 196 FEATURES")
    print("-"*104)
    avail = {}
    for gauge in ("hoi_khach", "ai_nghia"):
        feats = build_features(base, gauge)
        if len(feats.columns) != 196:
            print(
                f"CẢNH BÁO: {gauge} có {len(feats.columns)} features, không phải 196."
            )
        complete = feats.notna().all(axis=1) & base[f"h_{gauge}"].notna()
        avail[gauge] = complete
        valid = complete[complete].index
        last = valid.max() if len(valid) else None
        print(
            f"{gauge:<11} | feature đủ tại: {show_time(last):<24} | trễ {age_text(now,last)}"
        )

    common = avail["hoi_khach"] & avail["ai_nghia"]
    valid_both = common[common].index
    latest_common = valid_both.max() if len(valid_both) else None
    print("\nGIỜ PHÁT HÀNH HỢP LỆ CUỐI CÙNG:", show_time(latest_common))
    print("TUỔI DỮ LIỆU:", age_text(now, latest_common))
    if latest_common is None:
        print("Không có cửa sổ liên tục 24h phù hợp trong dữ liệu truy xuất.")
    elif (age_h(now, latest_common) or 0) > args.max_age_h:
        print(
            f"::warning title=RF downstream DATA_STALE::"
            f"Latest complete issue {show_time(latest_common)}, age "
            f"{age_text(now, latest_common)} > {args.max_age_h:.1f}h"
        )
        print("KẾT LUẬN: DATA_STALE. Không hạ ngưỡng bảo vệ và không điền 0 vào dữ liệu thiếu.")
    else:
        print("KẾT LUẬN: nguồn hiện đủ điều kiện freshness (còn phải chạy predictor thử).")

    # Explain why the latest hour is not usable: missing 196 feature names
    t = base.index.max()
    for gauge in ("hoi_khach", "ai_nghia"):
        feats = build_features(base, gauge)
        bad = feats.loc[t][feats.loc[t].isna()].index.tolist()
        print(
            f"\n{gauge} tại {show_time(t)}: thiếu {len(bad)}/196 features."
        )
        if bad:
            print("Ví dụ features thiếu:", ", ".join(bad[:18]))

    if latest_common is not None and latest_common < base.index.max():
        first_gap_time = latest_common + pd.Timedelta(hours=1)
        raw_gap = base.loc[
            first_gap_time:min(first_gap_time + pd.Timedelta(hours=5), base.index.max()),
            KEY_COLS,
        ]
        print(
            "\nGIỜ ĐẦU TIÊN SAU ISSUE HỢP LỆ "
            "(dấu — thể hiện thiếu dữ liệu nguồn):"
        )
        print(
            raw_gap.to_string(na_rep="—")
        )

    print("\nĐÃ XONG CHẨN ĐOÁN. Không có thao tác ghi Supabase.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
