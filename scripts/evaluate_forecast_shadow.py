#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A Vuong shadow evaluator V2.

Mục tiêu:
- Khi Q thực đã xuất hiện, đối chiếu forecast đã phát hành trước đó.
- V1/V2 hiện chấm:
  + LONG_H120_P50
  + LSTM_H120_P50
- Lưu từng forecast verification vào forecast_shadow_eval.
- Views Supabase tự tổng hợp MAE/RMSE/Bias theo lead.

Không dùng forecast mới để chấm quá khứ; luôn match đúng forecast_time.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, List

import pandas as pd
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BASIN_ID = os.getenv("BASIN_ID", "AVUONG")

session = requests.Session()
session.headers.update({
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
})

def sb_url(table: str) -> str:
    return f"{SUPABASE_URL}/rest/v1/{table}"

def get_rows(table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
    r = session.get(sb_url(table), params=params, timeout=60)
    if not r.ok:
        raise RuntimeError(
            f"GET {table} failed {r.status_code}: {r.text[:1500]}"
        )
    return r.json()

def upsert_rows(
    table: str,
    rows: List[Dict[str, Any]],
    on_conflict: str
) -> None:
    if not rows:
        return

    headers = dict(session.headers)
    headers["Prefer"] = "resolution=merge-duplicates,return=minimal"

    for i in range(0, len(rows), 500):
        r = session.post(
            sb_url(table),
            params={"on_conflict": on_conflict},
            headers=headers,
            json=rows[i:i + 500],
            timeout=60,
        )
        if not r.ok:
            raise RuntimeError(
                f"UPSERT {table} failed {r.status_code}: {r.text[:1500]}"
            )

def get_latest_observations(limit: int = 1000) -> pd.DataFrame:
    rows = get_rows(
        "reservoir_hourly_data",
        {
            "select": "time,inflow",
            "order": "time.desc",
            "limit": str(limit),
        },
    )

    if not rows:
        return pd.DataFrame(columns=["time", "inflow"])

    df = pd.DataFrame(rows)
    df["time"] = pd.to_datetime(df["time"], utc=True, errors="coerce")
    df["inflow"] = pd.to_numeric(df["inflow"], errors="coerce")

    return (
        df.dropna(subset=["time", "inflow"])
          .drop_duplicates("time")
          .sort_values("time")
          .reset_index(drop=True)
    )

def fetch_forecast_rows(
    table: str,
    obs_min: pd.Timestamp,
    obs_max: pd.Timestamp
) -> pd.DataFrame:

    rows = get_rows(
        table,
        {
            "select": "issue_time,forecast_time,lead_hour,q_p50,model_version",
            "forecast_time": f"gte.{obs_min.isoformat()}",
            "order": "forecast_time.asc",
            "limit": "20000",
        },
    )

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    df["issue_time"] = pd.to_datetime(
        df["issue_time"], utc=True, errors="coerce"
    )
    df["forecast_time"] = pd.to_datetime(
        df["forecast_time"], utc=True, errors="coerce"
    )
    df["lead_hour"] = pd.to_numeric(
        df["lead_hour"], errors="coerce"
    )
    df["q_p50"] = pd.to_numeric(
        df["q_p50"], errors="coerce"
    )

    df = df.dropna(
        subset=["issue_time", "forecast_time", "lead_hour", "q_p50"]
    )

    return df[df["forecast_time"] <= obs_max].copy()

def build_eval_rows(
    model_name: str,
    source_table: str,
    fdf: pd.DataFrame,
    obs: pd.DataFrame
) -> List[Dict[str, Any]]:

    if fdf.empty:
        return []

    obs_map = dict(zip(obs["time"], obs["inflow"]))
    evaluated_at = datetime.now(timezone.utc).isoformat()

    out: List[Dict[str, Any]] = []

    for r in fdf.itertuples(index=False):
        ft = pd.Timestamp(r.forecast_time)

        if ft not in obs_map:
            continue

        q_obs = float(obs_map[ft])
        q_fc = float(r.q_p50)
        err = q_fc - q_obs

        out.append({
            "evaluated_at": evaluated_at,
            "basin_id": BASIN_ID,
            "model_name": model_name,
            "model_version": getattr(r, "model_version", None),
            "issue_time": pd.Timestamp(r.issue_time).isoformat(),
            "forecast_time": ft.isoformat(),
            "lead_hour": int(r.lead_hour),
            "q_forecast": q_fc,
            "q_observed": q_obs,
            "error": err,
            "abs_error": abs(err),
            "sq_error": err * err,
            "rain_scenario": "ENSEMBLE",
            "source_table": source_table,
        })

    return out

def main() -> None:
    obs = get_latest_observations()

    if obs.empty:
        print("STATUS: SKIP")
        print("No observed inflow available.")
        return

    obs_min = obs["time"].min()
    obs_max = obs["time"].max()

    print("=" * 72)
    print("A VUONG SHADOW EVALUATOR V2")
    print("=" * 72)
    print("Observed range:", obs_min, "->", obs_max)

    long_df = fetch_forecast_rows(
        "inflow_forecast_long_ensemble",
        obs_min,
        obs_max,
    )

    lstm_df = fetch_forecast_rows(
        "inflow_forecast_lstm_ensemble",
        obs_min,
        obs_max,
    )

    long_rows = build_eval_rows(
        "LONG_H120_P50",
        "inflow_forecast_long_ensemble",
        long_df,
        obs,
    )

    lstm_rows = build_eval_rows(
        "LSTM_H120_P50",
        "inflow_forecast_lstm_ensemble",
        lstm_df,
        obs,
    )

    rows = long_rows + lstm_rows

    upsert_rows(
        "forecast_shadow_eval",
        rows,
        "model_name,issue_time,forecast_time,rain_scenario",
    )

    print("Long verified :", len(long_rows))
    print("LSTM verified :", len(lstm_rows))
    print("Upsert rows   :", len(rows))
    print("STATUS        : OK")
    print("=" * 72)

if __name__ == "__main__":
    main()
