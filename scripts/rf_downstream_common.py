#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import json
import math
import requests
import joblib
import numpy as np
import pandas as pd

VN_TZ = "Asia/Ho_Chi_Minh"

DEFAULT_PCTT_BASE = "https://av-monitor-reservoir.vercel.app"
DEFAULT_SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")

PCTT_IDS = {
    1: "q_av",
    2: "q_dm4",
    3: "q_sb4",
    4: "q_st2",
}

CANDIDATES = {
    "hoi_khach": [1, 2, 3, 4, 5, 6],
    "ai_nghia": [1, 2, 3, 4, 5, 6],
}

Q_LAGS = [0,1,2,3,4,5,6,8,9,11,12,18,24]
H_LAGS = [0,1,2,3,6,12,24]
ROLL_WINDOWS = [3,6,12,24]
DELTA_WINDOWS = [1,3,6,12]

def to_vn_timestamp(value):
    if value is None or value == "":
        return pd.NaT
    ts = pd.Timestamp(value)
    if ts.tzinfo is None:
        ts = ts.tz_localize(VN_TZ)
    else:
        ts = ts.tz_convert(VN_TZ)
    return ts

def vn_iso(ts):
    ts = to_vn_timestamp(ts)
    if pd.isna(ts):
        return None
    return ts.isoformat(timespec="seconds")

def utc_iso(ts):
    ts = to_vn_timestamp(ts)
    if pd.isna(ts):
        return None
    return ts.tz_convert("UTC").isoformat(timespec="seconds")

def supabase_headers(service_key=None):
    key = service_key or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY")
    if not key:
        raise RuntimeError("Missing SUPABASE_SERVICE_ROLE_KEY (recommended) or SUPABASE_KEY")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

def request_json(url, *, headers=None, params=None, method="GET", json_body=None, timeout=30):
    r = requests.request(
        method, url, headers=headers, params=params, json=json_body, timeout=timeout
    )
    if not r.ok:
        raise RuntimeError(f"HTTP {r.status_code} {url}: {r.text[:500]}")
    if r.text.strip() == "":
        return None
    return r.json()

def fetch_pctt_history(hours=72, api_base=None):
    base = (api_base or os.getenv("PCTT_API_BASE") or DEFAULT_PCTT_BASE).rstrip("/")
    end = pd.Timestamp.now(tz=VN_TZ) + pd.Timedelta(minutes=3)
    start = end - pd.Timedelta(hours=hours)

    url = f"{base}/api/qt1865-compliance"
    params = {
        "mode": "pctt-hydro",
        "start": end.tz_convert(VN_TZ).strftime("%Y-%m-%dT%H:%M:%S+07:00"),
        "end": end.tz_convert(VN_TZ).strftime("%Y-%m-%dT%H:%M:%S+07:00"),
        "ids": "1,2,3,4",
    }
    # Fix start after explicit construction to mirror website logic.
    params["start"] = start.strftime("%Y-%m-%dT%H:%M:%S+07:00")

    payload = request_json(url, params=params)
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise RuntimeError(f"Unexpected PCTT response: {str(payload)[:500]}")
    if payload.get("mode") != "pctt-hydro":
        raise RuntimeError(f"Unexpected PCTT mode: {payload.get('mode')}")
    rows = payload.get("data")
    if not isinstance(rows, list):
        raise RuntimeError("PCTT response missing data[]")

    recs = []
    now_vn = pd.Timestamp.now(tz=VN_TZ)
    for row in rows:
        t = to_vn_timestamp(row.get("time") or row.get("date"))
        if pd.isna(t) or t > now_vn + pd.Timedelta(minutes=15):
            continue

        reservoirs = row.get("reservoirs")
        if not isinstance(reservoirs, list):
            continue

        by_id = {}
        for item in reservoirs:
            try:
                rid = int(item.get("id"))
            except Exception:
                continue
            by_id[rid] = item

        rec = {"time": t}
        for rid, qname in PCTT_IDS.items():
            item = by_id.get(rid, {})
            turbine = pd.to_numeric(item.get("turbineFlow"), errors="coerce")
            spill = pd.to_numeric(item.get("spillwayFlow"), errors="coerce")
            rec[f"{qname}_turbine"] = turbine
            rec[f"{qname}_spill"] = spill
            rec[qname] = turbine + spill if pd.notna(turbine) and pd.notna(spill) else np.nan
        recs.append(rec)

    if not recs:
        raise RuntimeError("No valid PCTT rows")

    df = pd.DataFrame(recs).sort_values("time").drop_duplicates("time", keep="last")
    df = df.set_index("time")
    return df

def fetch_downstream_history(hours=72, supabase_url=None, service_key=None):
    sb = (supabase_url or DEFAULT_SUPABASE_URL).rstrip("/")
    if not sb:
        raise RuntimeError("Missing SUPABASE_URL")

    start_vn = pd.Timestamp.now(tz=VN_TZ) - pd.Timedelta(hours=hours + 6)
    params = {
        "select": "id,obs_time,obs_hour,hoi_khach_m,ai_nghia_m",
        "order": "obs_time.asc",
        "limit": "2000",
        "obs_time": f"gte.{utc_iso(start_vn)}",
    }
    rows = request_json(
        f"{sb}/rest/v1/downstream_manual_observations",
        headers=supabase_headers(service_key),
        params=params,
    )
    if not isinstance(rows, list):
        raise RuntimeError("Supabase downstream_manual_observations did not return a list")

    recs = []
    now_vn = pd.Timestamp.now(tz=VN_TZ)
    for row in rows:
        raw_t = row.get("obs_hour") or row.get("obs_time")
        t = to_vn_timestamp(raw_t)
        if pd.isna(t) or t > now_vn + pd.Timedelta(minutes=15):
            continue
        recs.append({
            "time": t,
            "h_hoi_khach": pd.to_numeric(row.get("hoi_khach_m"), errors="coerce"),
            "h_ai_nghia": pd.to_numeric(row.get("ai_nghia_m"), errors="coerce"),
        })

    if not recs:
        raise RuntimeError("No valid downstream observations")

    df = pd.DataFrame(recs).sort_values("time").drop_duplicates("time", keep="last")
    return df.set_index("time")

def normalize_hourly(df, tolerance_minutes=20):
    if df.empty:
        return df.copy()
    out = df.copy().sort_index()
    rounded = out.index.round("h")
    drift = np.abs((out.index - rounded).total_seconds()) / 60.0
    out = out.loc[drift <= tolerance_minutes].copy()
    out.index = rounded[drift <= tolerance_minutes]
    out = out[~out.index.duplicated(keep="last")]
    return out.sort_index()

def build_live_base(hours=72, api_base=None, supabase_url=None, service_key=None):
    q = normalize_hourly(fetch_pctt_history(hours=hours, api_base=api_base))
    h = normalize_hourly(fetch_downstream_history(
        hours=hours, supabase_url=supabase_url, service_key=service_key
    ))

    start = min(q.index.min(), h.index.min()).floor("h")
    end = max(q.index.max(), h.index.max()).floor("h")
    idx = pd.date_range(start, end, freq="h", tz=VN_TZ)

    base = q.reindex(idx).join(h.reindex(idx), how="outer")
    base.index.name = "time"
    base["q_sum4"] = base[["q_av","q_dm4","q_sb4","q_st2"]].sum(axis=1, min_count=4)
    return base

def build_features(df, gauge):
    f = {}
    qnames = ["q_av","q_dm4","q_sb4","q_st2","q_sum4"]

    for q in qnames:
        for lag in Q_LAGS:
            f[f"{q}_lag{lag}"] = df[q].shift(lag)
        for w in DELTA_WINDOWS:
            f[f"{q}_delta{w}h"] = df[q] - df[q].shift(w)
        for w in ROLL_WINDOWS:
            r = df[q].rolling(w, min_periods=w)
            mn, mx, av = r.min(), r.max(), r.mean()
            f[f"{q}_mean{w}h"] = av
            f[f"{q}_max{w}h"] = mx
            f[f"{q}_min{w}h"] = mn
            f[f"{q}_range{w}h"] = mx - mn

    hcol = f"h_{gauge}"
    for lag in H_LAGS:
        f[f"{hcol}_lag{lag}"] = df[hcol].shift(lag)
    for w in DELTA_WINDOWS:
        f[f"{hcol}_delta{w}h"] = df[hcol] - df[hcol].shift(w)
    for w in ROLL_WINDOWS:
        r = df[hcol].rolling(w, min_periods=w)
        mn, mx, av = r.min(), r.max(), r.mean()
        f[f"{hcol}_mean{w}h"] = av
        f[f"{hcol}_max{w}h"] = mx
        f[f"{hcol}_min{w}h"] = mn
        f[f"{hcol}_range{w}h"] = mx - mn

    hour = df.index.hour.to_numpy()
    doy = df.index.dayofyear.to_numpy()
    f["hour_sin"] = np.sin(2*np.pi*hour/24.0)
    f["hour_cos"] = np.cos(2*np.pi*hour/24.0)
    f["doy_sin"] = np.sin(2*np.pi*doy/365.25)
    f["doy_cos"] = np.cos(2*np.pi*doy/365.25)

    return pd.DataFrame(f, index=df.index)

def load_bundles(model_dir):
    model_dir = Path(model_dir)
    bundles = {}
    for gauge, horizons in CANDIDATES.items():
        bundles[gauge] = {}
        for h in horizons:
            p = model_dir / f"rf_v2_final_{gauge}_h{h:02d}.joblib"
            if not p.exists():
                raise FileNotFoundError(f"Missing model: {p}")
            bundles[gauge][h] = joblib.load(p)
    return bundles

def latest_common_issue_time(base, frames, bundles):
    masks = []
    for gauge, horizons in CANDIDATES.items():
        needed = sorted(set().union(*[
            set(bundles[gauge][h]["features"]) for h in horizons
        ]))
        m = frames[gauge][needed].notna().all(axis=1) & base[f"h_{gauge}"].notna()
        masks.append(m)

    common = masks[0].copy()
    for m in masks[1:]:
        common &= m

    times = common[common].index
    if len(times) == 0:
        raise RuntimeError("No common issue time with complete 24h feature history")
    return times.max()

def sb_upsert(table, rows, on_conflict, supabase_url=None, service_key=None):
    if not rows:
        return None
    sb = (supabase_url or DEFAULT_SUPABASE_URL).rstrip("/")
    if not sb:
        raise RuntimeError("Missing SUPABASE_URL")
    headers = supabase_headers(service_key)
    headers["Prefer"] = "resolution=merge-duplicates,return=representation"
    params = {"on_conflict": on_conflict}
    return request_json(
        f"{sb}/rest/v1/{table}",
        headers=headers,
        params=params,
        method="POST",
        json_body=rows,
    )
