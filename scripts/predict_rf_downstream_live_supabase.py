#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hourly RF V2 Delta-H sequence: 2 stations x H+1..H+6 = 12 rows."""
import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from rf_downstream_common import (
    VN_TZ, CANDIDATES, build_live_base, build_features, load_bundles,
    latest_common_issue_time, sb_upsert, utc_iso,
)

EXPECTED_RELEASE = "RF_DOWNSTREAM_V2_SEQ6_20261020_R1"
HORIZONS = [1, 2, 3, 4, 5, 6]


def read_manifest(model_dir):
    path = model_dir / "manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"Sequence manifest missing: {path}")
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("release_version") != EXPECTED_RELEASE:
        raise RuntimeError(
            f"Release mismatch: found {manifest.get('release_version')}, "
            f"expected {EXPECTED_RELEASE}. Use the sequence6 manifest."
        )
    for gauge in CANDIDATES:
        found = sorted(int(x) for x in manifest.get("candidates", {}).get(gauge, {}))
        if found != HORIZONS:
            raise RuntimeError(f"Incomplete manifest for {gauge}: {found}")
    return manifest


def forecast_sequence(base, bundles, manifest, issue_time, input_age_h):
    frames = {g: build_features(base, g) for g in CANDIDATES}
    out = []
    for gauge, horizons in CANDIDATES.items():
        h_now = float(base.loc[issue_time, f"h_{gauge}"])
        if not np.isfinite(h_now):
            raise RuntimeError(f"Missing H now: {gauge} {issue_time}")

        for h in horizons:
            bundle = bundles[gauge][h]
            expected_cols = bundle["features"]
            x = frames[gauge].loc[[issue_time], expected_cols]
            absent = x.columns[x.isna().any()].tolist()
            if absent:
                raise RuntimeError(f"Missing {gauge} H+{h} features at {issue_time}: {absent[:12]}")
            if (bundle.get("source_sha256") != manifest["source_sha256"] or
                bundle.get("gauge") != gauge or
                int(bundle.get("horizon_h", -1)) != h or
                bundle.get("target_type") != "delta_h"):
                raise RuntimeError(f"Wrong model bundle lineage: {gauge} H+{h}")

            dh = float(bundle["model"].predict(x)[0])
            hf = h_now + dh
            if not np.isfinite(hf):
                raise RuntimeError(f"Invalid RF forecast: {gauge} H+{h}")
            out.append({
                "model_code": "RF_DOWNSTREAM_V2_DELTA_H_SEQ6",
                # ALL 12 models have one release ID. Old parent provenance is kept in manifest.
                "model_version": manifest["release_version"],
                "station_code": gauge.upper(),
                "horizon_hours": h,
                "issue_time": utc_iso(issue_time),
                "forecast_time": utc_iso(issue_time + pd.Timedelta(hours=h)),
                "h_now_m": round(h_now, 4),
                "delta_h_pred_m": round(dh, 4),
                "forecast_level_m": round(hf, 4),
                "persistence_level_m": round(h_now, 4),
                "status": "SHADOW",
                "input_age_hours": round(input_age_h, 3),
                "source": "PCTT_VERCEL+SUPABASE_DOWNSTREAM",
            })

    expected = {(g.upper(), h) for g in CANDIDATES for h in HORIZONS}
    got = {(r["station_code"], r["horizon_hours"]) for r in out}
    if len(out) != 12 or got != expected:
        raise RuntimeError(f"Sequence incomplete: count {len(out)}; missing={expected - got}")
    for r in out:
        if pd.Timestamp(r["forecast_time"]) - pd.Timestamp(r["issue_time"]) != pd.Timedelta(hours=r["horizon_hours"]):
            raise RuntimeError(f"Timestamp error: {r}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default="rf_downstream_v2_final_models")
    ap.add_argument("--hours", type=int, default=72)
    ap.add_argument("--max-input-age-h", type=float, default=4.0)
    ap.add_argument("--output-dir", default="rf_downstream_v2_live_output")
    ap.add_argument("--no-write", action="store_true")
    a = ap.parse_args()

    mdir, outdir = Path(a.model_dir), Path(a.output_dir)
    outdir.mkdir(parents=True, exist_ok=True)
    manifest = read_manifest(mdir)
    bundles = load_bundles(mdir)

    for gauge, horizons in CANDIDATES.items():
        for h in horizons:
            b = bundles[gauge][h]
            entry = manifest["candidates"][gauge][str(h)]
            if len(b["features"]) != 196 or len(b["features"]) != entry["feature_count"]:
                raise RuntimeError(f"Feature count mismatch for {gauge} H+{h}")

    base = build_live_base(hours=a.hours)
    frames = {g: build_features(base, g) for g in CANDIDATES}
    issue_time = latest_common_issue_time(base, frames, bundles)
    age = (pd.Timestamp.now(tz=VN_TZ) - issue_time).total_seconds() / 3600.0

    if age < -0.5:
        raise RuntimeError(f"Issue time in future: {issue_time} ({age:.2f} h)")
    if age > a.max_input_age_h:
        raise RuntimeError(
            f"DATA_STALE: latest complete issue time {issue_time}, "
            f"age {age:.2f} h > {a.max_input_age_h:.2f} h. No forecast written."
        )

    rows = forecast_sequence(base, bundles, manifest, issue_time, age)
    df = pd.DataFrame(rows).sort_values(["station_code", "horizon_hours"])
    stamp = issue_time.strftime("%Y%m%d_%H%M")
    csv_path = outdir / f"rf_downstream_seq6_{stamp}.csv"
    json_path = outdir / f"rf_downstream_seq6_{stamp}.json"

    df.to_csv(csv_path, index=False, encoding="utf-8-sig")
    df.to_csv(outdir / "rf_downstream_shadow_latest.csv", index=False, encoding="utf-8-sig")
    json_text = json.dumps({
        "release_version": manifest["release_version"],
        "issue_time_vietnam": issue_time.isoformat(),
        "row_count": 12,
        "forecasts": rows,
    }, ensure_ascii=False, indent=2)
    json_path.write_text(json_text, encoding="utf-8")
    (outdir / "rf_downstream_shadow_latest.json").write_text(json_text, encoding="utf-8")

    print("=" * 95)
    print("RF DOWNSTREAM V2 SEQUENCE H+1 TO H+6 (SHADOW ONLY)")
    print("Release:", manifest["release_version"])
    print("Issue time VN:", issue_time, "input age:", round(age, 2), "hours")
    print(df[["station_code","horizon_hours","forecast_time","h_now_m",
              "delta_h_pred_m","forecast_level_m"]].to_string(index=False))
    print("Forecast count:", len(rows), "(must equal 12)")

    if not a.no_write:
        saved = sb_upsert(
            "rf_downstream_shadow_forecasts",
            rows,
            on_conflict="model_version,station_code,horizon_hours,issue_time",
        )
        print("Supabase inserted/updated:", len(saved or []))
        if not isinstance(saved, list) or len(saved) != 12:
            raise RuntimeError("Supabase did not confirm 12 rows. Check API/database.")
    else:
        print("NO-WRITE: Supabase not modified. CSV:", csv_path)


if __name__ == "__main__":
    main()
