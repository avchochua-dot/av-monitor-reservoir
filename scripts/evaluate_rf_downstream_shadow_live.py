#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
import os
import pandas as pd
import numpy as np

from rf_downstream_common import (
    VN_TZ, DEFAULT_SUPABASE_URL, supabase_headers, request_json,
    to_vn_timestamp, sb_upsert, utc_iso
)

def fetch_pending(limit=500):
    sb = DEFAULT_SUPABASE_URL
    if not sb:
        raise RuntimeError("Missing SUPABASE_URL")
    params = {
        "select": "*",
        "status": "eq.SHADOW",
        "actual_level_m": "is.null",
        "forecast_time": f"lte.{pd.Timestamp.now(tz='UTC').isoformat()}",
        "order": "forecast_time.asc",
        "limit": str(limit),
    }
    return request_json(
        f"{sb}/rest/v1/rf_downstream_shadow_forecasts",
        headers=supabase_headers(),
        params=params
    )

def fetch_observation(station_code, forecast_time):
    sb = DEFAULT_SUPABASE_URL
    t = to_vn_timestamp(forecast_time)
    start = t - pd.Timedelta(minutes=75)
    end = t + pd.Timedelta(minutes=75)

    params = {
        "select": "id,obs_time,obs_hour,hoi_khach_m,ai_nghia_m",
        "obs_time": f"gte.{utc_iso(start)}",
        "order": "obs_time.asc",
        "limit": "10",
    }
    # PostgREST cannot express two conditions on same key in dict,
    # so fetch >= start then filter <= end locally.
    rows = request_json(
        f"{sb}/rest/v1/downstream_manual_observations",
        headers=supabase_headers(),
        params=params
    )

    col = "hoi_khach_m" if station_code == "HOI_KHACH" else "ai_nghia_m"
    candidates = []
    for r in rows or []:
        rt = to_vn_timestamp(r.get("obs_hour") or r.get("obs_time"))
        if pd.isna(rt) or rt > end:
            continue
        v = pd.to_numeric(r.get(col), errors="coerce")
        if pd.isna(v):
            continue
        candidates.append((abs((rt - t).total_seconds()), rt, float(v)))

    if not candidates:
        return None
    candidates.sort(key=lambda x: x[0])
    sec, rt, val = candidates[0]
    if sec > 75 * 60:
        return None
    return rt, val

def patch_forecast(row_id, payload):
    sb = DEFAULT_SUPABASE_URL
    headers = supabase_headers()
    headers["Prefer"] = "return=representation"
    return request_json(
        f"{sb}/rest/v1/rf_downstream_shadow_forecasts",
        headers=headers,
        params={"id": f"eq.{row_id}"},
        method="PATCH",
        json_body=payload
    )

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=500)
    a = ap.parse_args()

    pending = fetch_pending(a.limit)
    print("Pending:", len(pending or []))

    n_eval = 0
    for row in pending or []:
        obs = fetch_observation(row["station_code"], row["forecast_time"])
        if obs is None:
            continue
        obs_time, actual = obs
        fc = float(row["forecast_level_m"])
        pers = float(row["persistence_level_m"])
        err = fc - actual
        p_err = pers - actual

        payload = {
            "actual_time": utc_iso(obs_time),
            "actual_level_m": round(actual, 4),
            "error_m": round(err, 4),
            "abs_error_m": round(abs(err), 4),
            "persistence_error_m": round(p_err, 4),
            "persistence_abs_error_m": round(abs(p_err), 4),
            "evaluated_at": pd.Timestamp.now(tz="UTC").isoformat(),
            "status": "EVALUATED",
        }
        patch_forecast(row["id"], payload)
        n_eval += 1

    print("Evaluated:", n_eval)

if __name__ == "__main__":
    main()
