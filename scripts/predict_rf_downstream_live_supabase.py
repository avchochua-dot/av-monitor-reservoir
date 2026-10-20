#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
from datetime import datetime, timezone
from pathlib import Path
import json
import pandas as pd
import numpy as np

from rf_downstream_common import (
    VN_TZ, CANDIDATES, build_live_base, build_features,
    load_bundles, latest_common_issue_time, sb_upsert, utc_iso
)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default="rf_downstream_v2_final_models")
    ap.add_argument("--hours", type=int, default=72)
    ap.add_argument("--output-dir", default="rf_downstream_v2_live_output")
    ap.add_argument("--no-write", action="store_true")
    a = ap.parse_args()

    outdir = Path(a.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)

    base = build_live_base(hours=a.hours)
    bundles = load_bundles(a.model_dir)
    frames = {g: build_features(base, g) for g in CANDIDATES}
    issue_time = latest_common_issue_time(base, frames, bundles)

    age_h = (pd.Timestamp.now(tz=VN_TZ) - issue_time).total_seconds() / 3600.0
    if age_h > 4.0:
        raise RuntimeError(f"Latest complete issue_time is stale: {issue_time}, age={age_h:.2f}h")

    rows = []
    for gauge, horizons in CANDIDATES.items():
        h_now = float(base.loc[issue_time, f"h_{gauge}"])
        for h in horizons:
            bundle = bundles[gauge][h]
            feats = bundle["features"]
            x = frames[gauge].loc[[issue_time], feats]
            missing = x.columns[x.isna().any()].tolist()
            if missing:
                raise RuntimeError(f"{gauge} H+{h}: missing features: {missing[:12]}")

            dh = float(bundle["model"].predict(x)[0])
            hf = h_now + dh
            valid_time = issue_time + pd.Timedelta(hours=h)

            rows.append({
                "model_code": "RF_DOWNSTREAM_V2_DELTA_H",
                "model_version": bundle.get("model_version", "RF_DOWNSTREAM_V2_DELTA_H_FINAL_2025Q4"),
                "station_code": gauge.upper(),
                "horizon_hours": h,
                "issue_time": utc_iso(issue_time),
                "forecast_time": utc_iso(valid_time),
                "h_now_m": round(h_now, 4),
                "delta_h_pred_m": round(dh, 4),
                "forecast_level_m": round(hf, 4),
                "persistence_level_m": round(h_now, 4),
                "status": "SHADOW",
                "input_age_hours": round(age_h, 3),
                "source": "PCTT_VERCEL+SUPABASE_DOWNSTREAM",
            })

    df = pd.DataFrame(rows)
    stamp = issue_time.strftime("%Y%m%d_%H%M")
    csvp = outdir / f"rf_downstream_shadow_{stamp}.csv"
    jsonp = outdir / f"rf_downstream_shadow_{stamp}.json"
    df.to_csv(csvp, index=False, encoding="utf-8-sig")
    jsonp.write_text(
        json.dumps({"issue_time": issue_time.isoformat(), "forecasts": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    df.to_csv(outdir/"rf_downstream_shadow_latest.csv", index=False, encoding="utf-8-sig")

    print("ISSUE TIME:", issue_time, "age_h=", round(age_h, 3))
    print(df.to_string(index=False))

    if not a.no_write:
        saved = sb_upsert(
            "rf_downstream_shadow_forecasts",
            rows,
            on_conflict="model_version,station_code,horizon_hours,issue_time"
        )
        print("Supabase upsert rows:", len(saved or []))
    else:
        print("NO-WRITE mode: Supabase skipped.")

if __name__ == "__main__":
    main()
