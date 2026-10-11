#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A VUONG SHADOW EVALUATOR V4
===========================

Evaluates four operational benchmarks:
  1. PERSISTENCE
  2. RF_V1
  3. LONG_H120_P50
  4. LSTM_H120_P50

Fair-comparison logic is implemented in Supabase views:
- Same forecast_time
- Same lead_hour
- All compared models must be present

This script only writes verified forecast-vs-observation rows.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pandas as pd
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BASIN_ID = os.getenv("BASIN_ID", "AVUONG")

# Enough history for current early-stage shadow archive.
OBS_LIMIT = int(os.getenv("SHADOW_OBS_LIMIT", "2000"))

KEY_HORIZONS_4 = {1, 3, 6, 12, 24}

session = requests.Session()
session.headers.update({
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
})


def sb_url(table: str) -> str:
    return f"{SUPABASE_URL}/rest/v1/{table}"


def get_rows(table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
    r = session.get(sb_url(table), params=params, timeout=90)
    if not r.ok:
        raise RuntimeError(
            f"GET {table} failed {r.status_code}: {r.text[:2000]}"
        )
    return r.json()


def upsert_rows(
    table: str,
    rows: List[Dict[str, Any]],
    on_conflict: str,
) -> None:
    if not rows:
        return

    headers = dict(session.headers)
    headers["Prefer"] = "resolution=merge-duplicates,return=minimal"

    for i in range(0, len(rows), 500):
        chunk = rows[i:i + 500]
        r = session.post(
            sb_url(table),
            params={"on_conflict": on_conflict},
            headers=headers,
            json=chunk,
            timeout=90,
        )
        if not r.ok:
            raise RuntimeError(
                f"UPSERT {table} failed {r.status_code}: {r.text[:2000]}"
            )


def get_observations() -> pd.DataFrame:
    params = {
        "select": "time,inflow,reservoir_id",
        "order": "time.desc",
        "limit": str(OBS_LIMIT),
    }

    rows = get_rows("reservoir_hourly_data", params)

    if not rows:
        return pd.DataFrame(columns=["time", "inflow"])

    df = pd.DataFrame(rows)

    # Current A Vuong rows may have reservoir_id = NULL.
    # Only enforce reservoir filter when actual non-null IDs exist.
    if "reservoir_id" in df.columns:
        ids = df["reservoir_id"].dropna().astype(str).unique().tolist()
        if ids and BASIN_ID in ids:
            df = df[df["reservoir_id"].astype(str) == BASIN_ID].copy()

    df["time"] = pd.to_datetime(df["time"], utc=True, errors="coerce")
    df["inflow"] = pd.to_numeric(df["inflow"], errors="coerce")

    return (
        df.dropna(subset=["time", "inflow"])
          .sort_values("time")
          .drop_duplicates(subset=["time"], keep="last")
          .reset_index(drop=True)
    )


def detect_forecast_schema(table: str) -> Dict[str, Optional[str]]:
    rows = get_rows(
        table,
        {
            "select": "*",
            "order": "forecast_time.desc",
            "limit": "1",
        },
    )

    if not rows:
        raise RuntimeError(f"{table} không có dữ liệu để nhận diện schema")

    columns = list(rows[0].keys())
    lower_map = {str(c).lower(): c for c in columns}

    def pick(candidates):
        for name in candidates:
            if name.lower() in lower_map:
                return lower_map[name.lower()]
        return None

    schema = {
        "issue": pick(["issue_time", "run_time"]),
        "forecast": pick(["forecast_time", "time"]),
        "lead": pick(["lead_hour", "lead", "horizon"]),
        "q": pick([
            "q_p50",
            "q_median",
            "q_mean",
            "q_forecast",
            "q_pred",
            "forecast_q",
        ]),
        "version": pick(["model_version", "version"]),
    }

    print(f"{table} columns         :", columns)
    print(f"{table} detected issue  :", schema["issue"])
    print(f"{table} detected target :", schema["forecast"])
    print(f"{table} detected lead   :", schema["lead"])
    print(f"{table} detected Q      :", schema["q"])

    if not all([
        schema["issue"],
        schema["forecast"],
        schema["lead"],
        schema["q"],
    ]):
        raise RuntimeError(
            f"Không nhận diện đủ schema cho {table}. Columns: {columns}"
        )

    return schema


def fetch_generic_forecast(
    table: str,
    obs_min: pd.Timestamp,
    obs_max: pd.Timestamp,
) -> pd.DataFrame:
    schema = detect_forecast_schema(table)

    cols = [
        schema["issue"],
        schema["forecast"],
        schema["lead"],
        schema["q"],
    ]
    if schema["version"]:
        cols.append(schema["version"])

    rows = get_rows(
        table,
        {
            "select": ",".join(cols),
            schema["forecast"]: f"gte.{obs_min.isoformat()}",
            "order": f"{schema['forecast']}.asc",
            "limit": "30000",
        },
    )

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)

    rename = {
        schema["issue"]: "issue_time",
        schema["forecast"]: "forecast_time",
        schema["lead"]: "lead_hour",
        schema["q"]: "q_center",
    }
    if schema["version"]:
        rename[schema["version"]] = "model_version"

    df = df.rename(columns=rename)

    if "model_version" not in df.columns:
        df["model_version"] = None

    df["issue_time"] = pd.to_datetime(
        df["issue_time"], utc=True, errors="coerce"
    )
    df["forecast_time"] = pd.to_datetime(
        df["forecast_time"], utc=True, errors="coerce"
    )
    df["lead_hour"] = pd.to_numeric(
        df["lead_hour"], errors="coerce"
    )
    df["q_center"] = pd.to_numeric(
        df["q_center"], errors="coerce"
    )

    df = df.dropna(
        subset=["issue_time", "forecast_time", "lead_hour", "q_center"]
    )

    return df[
        (df["forecast_time"] >= obs_min) &
        (df["forecast_time"] <= obs_max)
    ].copy()


def fetch_rf_forecast(
    obs_min: pd.Timestamp,
    obs_max: pd.Timestamp,
) -> pd.DataFrame:
    rows = get_rows(
        "inflow_forecast_ml",
        {
            "select": (
                "issue_time,forecast_time,lead_hour,"
                "source,model_version,q_forecast"
            ),
            "source": "eq.rf_v1",
            "forecast_time": f"gte.{obs_min.isoformat()}",
            "order": "forecast_time.asc",
            "limit": "30000",
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
    df["q_center"] = pd.to_numeric(
        df["q_forecast"], errors="coerce"
    )

    df = df.dropna(
        subset=["issue_time", "forecast_time", "lead_hour", "q_center"]
    )

    return df[
        (df["forecast_time"] >= obs_min) &
        (df["forecast_time"] <= obs_max)
    ].copy()


def build_eval_rows(
    model_name: str,
    source_table: str,
    fdf: pd.DataFrame,
    obs: pd.DataFrame,
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
        q_fc = float(r.q_center)
        error = q_fc - q_obs

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
            "error": error,
            "abs_error": abs(error),
            "sq_error": error * error,
            "rain_scenario": "ENSEMBLE",
            "source_table": source_table,
        })

    return out


def build_persistence_rows(
    forecast_frames: List[pd.DataFrame],
    obs: pd.DataFrame,
) -> List[Dict[str, Any]]:
    """
    Persistence forecast:
        Q(t + h) = Q(issue_time)

    Generate only for forecast keys actually used by operational models.
    This avoids inventing arbitrary verification samples.
    """
    obs_map = dict(zip(obs["time"], obs["inflow"]))
    evaluated_at = datetime.now(timezone.utc).isoformat()

    keys = set()

    for df in forecast_frames:
        if df is None or df.empty:
            continue

        for r in df.itertuples(index=False):
            lead = int(r.lead_hour)
            if lead not in KEY_HORIZONS_4:
                continue

            issue = pd.Timestamp(r.issue_time)
            ft = pd.Timestamp(r.forecast_time)
            keys.add((issue, ft, lead))

    out: List[Dict[str, Any]] = []

    for issue, ft, lead in sorted(keys):
        if issue not in obs_map or ft not in obs_map:
            continue

        q_issue = float(obs_map[issue])
        q_obs = float(obs_map[ft])
        error = q_issue - q_obs

        out.append({
            "evaluated_at": evaluated_at,
            "basin_id": BASIN_ID,
            "model_name": "PERSISTENCE",
            "model_version": "PERSISTENCE_Q_NOW_V1",
            "issue_time": issue.isoformat(),
            "forecast_time": ft.isoformat(),
            "lead_hour": lead,
            "q_forecast": q_issue,
            "q_observed": q_obs,
            "error": error,
            "abs_error": abs(error),
            "sq_error": error * error,
            "rain_scenario": "ENSEMBLE",
            "source_table": "reservoir_hourly_data",
        })

    return out


def main() -> None:
    obs = get_observations()

    if obs.empty:
        print("STATUS: SKIP - no observed inflow")
        return

    obs_min = obs["time"].min()
    obs_max = obs["time"].max()

    print("=" * 78)
    print("A VUONG SHADOW EVALUATOR V4 - 4 MODELS + FAIR BENCHMARK")
    print("=" * 78)
    print("Observed range:", obs_min, "->", obs_max)

    long_df = fetch_generic_forecast(
        "inflow_forecast_long_ensemble",
        obs_min,
        obs_max,
    )

    lstm_df = fetch_generic_forecast(
        "inflow_forecast_lstm_ensemble",
        obs_min,
        obs_max,
    )

    rf_df = fetch_rf_forecast(obs_min, obs_max)

    rows_long = build_eval_rows(
        "LONG_H120_P50",
        "inflow_forecast_long_ensemble",
        long_df,
        obs,
    )

    rows_lstm = build_eval_rows(
        "LSTM_H120_P50",
        "inflow_forecast_lstm_ensemble",
        lstm_df,
        obs,
    )

    rows_rf = build_eval_rows(
        "RF_V1",
        "inflow_forecast_ml",
        rf_df,
        obs,
    )

    rows_persistence = build_persistence_rows(
        [rf_df, long_df, lstm_df],
        obs,
    )

    all_rows = (
        rows_long +
        rows_lstm +
        rows_rf +
        rows_persistence
    )

    upsert_rows(
        "forecast_shadow_eval",
        all_rows,
        "model_name,issue_time,forecast_time,rain_scenario",
    )

    print("")
    print("Verified LONG_H120 :", len(rows_long))
    print("Verified LSTM_H120 :", len(rows_lstm))
    print("Verified RF_V1     :", len(rows_rf))
    print("Verified persistence:", len(rows_persistence))
    print("Total upsert rows  :", len(all_rows))
    print("STATUS             : OK")
    print("=" * 78)


if __name__ == "__main__":
    main()
