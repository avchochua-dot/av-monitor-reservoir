#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A Vuong - Open-Meteo Best Match collector
7 basin representative points -> hourly basin mean H001-H120.

This is intentionally separate from the 6 explicit NWP model collector.
It uses Open-Meteo's default/best-match forecast endpoint without models=.
"""

from __future__ import annotations
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

import numpy as np
import pandas as pd
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BASIN_ID = os.getenv("BASIN_ID", "AVUONG")

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

POINTS = {
    "AV01": (15.809, 107.619),
    "AV02": (15.935, 107.573),
    "AV03": (15.942, 107.475),
    "AV04": (15.910, 107.500),
    "AV05": (15.826, 107.534),
    "AV06": (16.004, 107.504),
    "AV07": (15.853, 107.601),
}

TABLE_POINT = "rainfall_openmeteo_best_point"
TABLE_BASIN = "rainfall_openmeteo_best_hourly"

session = requests.Session()
session.headers.update({
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
})

def sb_url(table: str) -> str:
    return f"{SUPABASE_URL}/rest/v1/{table}"

def upsert(table: str, rows: List[Dict[str, Any]], on_conflict: str) -> None:
    if not rows:
        return
    headers = dict(session.headers)
    headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
    for i in range(0, len(rows), 500):
        r = session.post(
            sb_url(table),
            params={"on_conflict": on_conflict},
            headers=headers,
            json=rows[i:i+500],
            timeout=60,
        )
        if not r.ok:
            raise RuntimeError(f"Supabase upsert {table} failed {r.status_code}: {r.text[:1500]}")

def main() -> None:
    now = pd.Timestamp.now(tz="UTC")
    run_time = now.floor("h")

    point_rows: List[Dict[str, Any]] = []

    for point_id, (lat, lon) in POINTS.items():
        params = {
            "latitude": lat,
            "longitude": lon,
            "hourly": "precipitation",
            "timezone": "UTC",
            # Request one extra hour because current-hour value may be included.
            "forecast_hours": 121,
        }

        r = requests.get(OPEN_METEO_URL, params=params, timeout=45)
        r.raise_for_status()
        js = r.json()

        times = pd.to_datetime(js["hourly"]["time"], utc=True)
        rain = pd.to_numeric(pd.Series(js["hourly"]["precipitation"]), errors="coerce")

        df = pd.DataFrame({"forecast_time": times, "precipitation_mm": rain})
        df = df[df["forecast_time"] > run_time].copy()
        df["lead_hour"] = ((df["forecast_time"] - run_time) / pd.Timedelta(hours=1)).astype(int)
        df = df[(df["lead_hour"] >= 1) & (df["lead_hour"] <= 120)].copy()

        if len(df) < 120:
            raise RuntimeError(f"{point_id}: only {len(df)} future hourly values, expected 120")

        for row in df.itertuples(index=False):
            point_rows.append({
                "run_time": run_time.isoformat(),
                "forecast_time": pd.Timestamp(row.forecast_time).isoformat(),
                "lead_hour": int(row.lead_hour),
                "basin_id": BASIN_ID,
                "point_id": point_id,
                "latitude": lat,
                "longitude": lon,
                "precipitation_mm": None if pd.isna(row.precipitation_mm) else float(row.precipitation_mm),
                "quality": "GOOD",
                "created_at": now.isoformat(),
            })

        print(f"{point_id}: {len(df)} hours OK")

    raw = pd.DataFrame(point_rows)
    if len(raw) != 7 * 120:
        raise RuntimeError(f"Point row count {len(raw)} != 840")

    good = raw.dropna(subset=["precipitation_mm"]).copy()

    agg = (
        good.groupby(["run_time", "forecast_time", "lead_hour", "basin_id"], as_index=False)
        .agg(
            rain_openmeteo_best=("precipitation_mm", "mean"),
            point_count=("point_id", "nunique"),
            rain_min=("precipitation_mm", "min"),
            rain_max=("precipitation_mm", "max"),
            rain_std=("precipitation_mm", lambda s: float(np.std(s.to_numpy(float), ddof=0))),
        )
    )

    if len(agg) != 120:
        raise RuntimeError(f"Basin row count {len(agg)} != 120")

    if (agg["point_count"] < 7).any():
        bad = agg[agg["point_count"] < 7]
        raise RuntimeError(f"Some basin hours have <7 points: {bad.head().to_dict('records')}")

    basin_rows = []
    for row in agg.itertuples(index=False):
        basin_rows.append({
            "run_time": row.run_time,
            "forecast_time": row.forecast_time,
            "lead_hour": int(row.lead_hour),
            "basin_id": row.basin_id,
            "rain_openmeteo_best": float(row.rain_openmeteo_best),
            "point_count": int(row.point_count),
            "rain_min": float(row.rain_min),
            "rain_max": float(row.rain_max),
            "rain_std": float(row.rain_std),
            "quality": "GOOD",
            "created_at": now.isoformat(),
        })

    upsert(TABLE_POINT, point_rows, "run_time,forecast_time,point_id")
    upsert(TABLE_BASIN, basin_rows, "run_time,forecast_time,basin_id")

    print("=" * 72)
    print("STATUS: OK")
    print("Run time    :", run_time)
    print("Point rows  :", len(point_rows))
    print("Basin rows  :", len(basin_rows))
    print("Points/hour :", int(agg["point_count"].min()), "->", int(agg["point_count"].max()))
    print("Lead        :", int(agg["lead_hour"].min()), "->", int(agg["lead_hour"].max()))
    print("=" * 72)

if __name__ == "__main__":
    main()
