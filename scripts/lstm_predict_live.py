#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A VUONG - LSTM H120 LIVE PREDICTOR (SHADOW)
"""

from __future__ import annotations
import math, os, sys, traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import joblib
import numpy as np
import pandas as pd
import requests
import tensorflow as tf

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

BASIN_ID = os.getenv("BASIN_ID", "AVUONG")
RESERVOIR_ID = os.getenv("RESERVOIR_ID", "").strip()

LSTM_SOURCE = os.getenv("LSTM_SOURCE", "lstm_h120_v1")
LSTM_MODEL_VERSION = os.getenv("LSTM_MODEL_VERSION", "LSTM_H120_V1_PERFECT_RAIN")
LSTM_MODEL_DIR = Path(os.getenv("LSTM_MODEL_DIR", "models/lstm_h120_v1"))
LSTM_MAX_LEAD = int(os.getenv("LSTM_MAX_LEAD", "120"))
LSTM_LOOKBACK_HOURS = int(os.getenv("LSTM_LOOKBACK_HOURS", "168"))
MAX_RAIN_RUN_AGE_HOURS = float(os.getenv("MAX_RAIN_RUN_AGE_HOURS", "12"))

MODEL_PATH = LSTM_MODEL_DIR / "lstm_h120.keras"
SCALER_PATH = LSTM_MODEL_DIR / "lstm_h120_scalers.joblib"

TABLE_OBS = "reservoir_hourly_data"
TABLE_RAIN = "rainfall_basin_hourly"
TABLE_SCENARIO = "inflow_forecast_lstm_scenario"
TABLE_ENSEMBLE = "inflow_forecast_lstm_ensemble"
TABLE_LOG = "lstm_forecast_run_log"

REQUEST_TIMEOUT = 45
UPSERT_BATCH = 500

RAIN_COLUMNS = {
    "ECMWF_IFS": "rain_ecmwf",
    "GFS": "rain_gfs",
    "ICON": "rain_icon",
    "ECMWF_AIFS": "rain_aifs",
    "CMA_GRAPES": "rain_cma",
    "JMA_GSM": "rain_jma",
}

PAST_FEATURES = [
    "flow","rain","flow_diff_1h","flow_mean_6h","flow_mean_24h",
    "rain_sum_6h","rain_sum_24h","hour_sin","hour_cos","doy_sin","doy_cos"
]
FUTURE_FEATURES = [
    "future_rain","future_rain_cum","lead_norm","hour_sin","hour_cos","doy_sin","doy_cos"
]

SESSION = requests.Session()
SESSION.headers.update({
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
})

def api_url(table: str) -> str:
    return f"{SUPABASE_URL}/rest/v1/{table}"

def supabase_get(table: str, params: Dict[str, str]) -> List[Dict[str, Any]]:
    r = SESSION.get(api_url(table), params=params, timeout=REQUEST_TIMEOUT)
    if not r.ok:
        raise RuntimeError(f"GET {table} failed {r.status_code}: {r.text[:1200]}")
    return r.json()

def supabase_insert(table: str, rows: List[Dict[str, Any]], upsert_on_conflict: Optional[str]=None) -> None:
    if not rows:
        return
    headers = dict(SESSION.headers)
    if upsert_on_conflict:
        headers["Prefer"] = "resolution=merge-duplicates,return=representation"
    for i in range(0, len(rows), UPSERT_BATCH):
        chunk = rows[i:i+UPSERT_BATCH]
        params = {}
        if upsert_on_conflict:
            params["on_conflict"] = upsert_on_conflict
        r = SESSION.post(api_url(table), params=params, headers=headers, json=chunk, timeout=REQUEST_TIMEOUT)
        if not r.ok:
            raise RuntimeError(f"POST {table} failed {r.status_code}: {r.text[:1800]}")

def utcnow() -> datetime:
    return datetime.now(timezone.utc)

def parse_ts(v: Any) -> pd.Timestamp:
    t = pd.Timestamp(v)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")

def iso_utc(v: Any) -> str:
    return parse_ts(v).isoformat()

def finite_or_none(v: Any) -> Optional[float]:
    try:
        x=float(v)
    except Exception:
        return None
    return x if math.isfinite(x) else None

@dataclass
class Artifacts:
    model: tf.keras.Model
    past_scaler: Any
    future_scaler: Any
    target_scaler: Any
    lookback_hours: int
    horizon_hours: int

def load_artifacts() -> Artifacts:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(MODEL_PATH)
    if not SCALER_PATH.exists():
        raise FileNotFoundError(SCALER_PATH)
    model = tf.keras.models.load_model(MODEL_PATH, compile=False)
    s = joblib.load(SCALER_PATH)
    if list(s.get("past_features", [])) != PAST_FEATURES:
        raise RuntimeError("past_features mismatch")
    if list(s.get("future_features", [])) != FUTURE_FEATURES:
        raise RuntimeError("future_features mismatch")
    lookback = int(s.get("lookback_hours", LSTM_LOOKBACK_HOURS))
    horizon = int(s.get("horizon_hours", LSTM_MAX_LEAD))
    if lookback != LSTM_LOOKBACK_HOURS or horizon < LSTM_MAX_LEAD:
        raise RuntimeError(f"artifact shape mismatch: lookback={lookback}, horizon={horizon}")
    return Artifacts(model, s["past_scaler"], s["future_scaler"], s["target_scaler"], lookback, horizon)

def get_latest_rain_run() -> Tuple[pd.Timestamp, List[Dict[str, Any]]]:
    rows = supabase_get(TABLE_RAIN, {
        "select":"forecast_time,run_time,basin_id,lead_hour,rain_ecmwf,rain_gfs,rain_icon,rain_aifs,rain_cma,rain_jma,rain_mean,model_count,quality",
        "basin_id":f"eq.{BASIN_ID}",
        "lead_hour":"gte.1",
        "order":"run_time.desc,lead_hour.asc",
        "limit":"1000",
    })
    if not rows:
        raise RuntimeError("Không có rainfall_basin_hourly")
    latest = max(parse_ts(r["run_time"]) for r in rows)
    selected = [r for r in rows if parse_ts(r["run_time"]) == latest and int(r.get("lead_hour") or 0) <= LSTM_MAX_LEAD]
    selected.sort(key=lambda r:int(r["lead_hour"]))
    if len(selected) < LSTM_MAX_LEAD:
        selected = supabase_get(TABLE_RAIN, {
            "select":"forecast_time,run_time,basin_id,lead_hour,rain_ecmwf,rain_gfs,rain_icon,rain_aifs,rain_cma,rain_jma,rain_mean,model_count,quality",
            "basin_id":f"eq.{BASIN_ID}",
            "run_time":f"eq.{iso_utc(latest)}",
            "lead_hour":"gte.1",
            "order":"lead_hour.asc",
            "limit":"300",
        })
        selected=[r for r in selected if int(r.get("lead_hour") or 0) <= LSTM_MAX_LEAD]
    return latest, selected

def detect_obs_columns() -> Tuple[str, str, str]:
    """
    Tự nhận diện tên cột thật của reservoir_hourly_data.

    Không giả định cố định time/inflow/rain nữa.
    Đọc 1 bản ghi bằng select=* rồi dò alias.
    """

    params = {
        "select": "*",
        "limit": "1",
    }
    if RESERVOIR_ID:
        params["reservoir_id"] = f"eq.{RESERVOIR_ID}"

    rows = supabase_get(TABLE_OBS, params)
    if not rows:
        raise RuntimeError("reservoir_hourly_data không có bản ghi để nhận diện schema")

    columns = list(rows[0].keys())
    lower_map = {str(c).lower(): c for c in columns}

    time_aliases = [
        "time",
        "datetime",
        "timestamp",
        "date_time",
        "observed_at",
        "measurement_time",
        "recorded_at",
        "data_time",
    ]

    q_aliases = [
        "inflow",
        "q_ve",
        "qve",
        "qin",
        "q_in",
        "flow",
        "q",
        "flow_in",
        "inflow_cms",
    ]

    rain_aliases = [
        "rain",
        "rainfall",
        "rainfallreal",
        "rainfall_real",
        "rain_mm",
        "rain_hour",
        "rain_1h",
        "mua",
        "mua_gio",
        "rain_observed",
        "rain_obs",
    ]

    def pick(alias_list):
        for alias in alias_list:
            if alias.lower() in lower_map:
                return lower_map[alias.lower()]
        return None

    time_col = pick(time_aliases)
    q_col = pick(q_aliases)
    rain_col = pick(rain_aliases)

    print("reservoir_hourly_data columns:", columns)
    print("Detected time column:", time_col)
    print("Detected Q column   :", q_col)
    print("Detected rain column:", rain_col)

    if not time_col or not q_col or not rain_col:
        raise RuntimeError(
            "Không tự nhận diện đủ time/Q/rain trong reservoir_hourly_data. "
            f"Columns hiện có: {columns}"
        )

    return str(time_col), str(q_col), str(rain_col)

def get_observed_history(issue_time: pd.Timestamp, lookback_hours: int) -> pd.DataFrame:
    time_col,q_col,rain_col = detect_obs_columns()
    start = issue_time - pd.Timedelta(hours=lookback_hours+12)
    params={
        "select":f"{time_col},{q_col},{rain_col}",
        time_col:f"gte.{iso_utc(start)}",
        "order":f"{time_col}.asc",
        "limit":str(lookback_hours+60),
    }
    if RESERVOIR_ID:
        params["reservoir_id"]=f"eq.{RESERVOIR_ID}"
    rows=supabase_get(TABLE_OBS, params)
    if not rows:
        raise RuntimeError("Không có quan trắc lookback")
    df=pd.DataFrame(rows)
    df["datetime"]=pd.to_datetime(df[time_col], utc=True, errors="coerce")
    df["flow"]=pd.to_numeric(df[q_col], errors="coerce")
    df["rain"]=pd.to_numeric(df[rain_col], errors="coerce")
    df=(df.dropna(subset=["datetime"]).sort_values("datetime").drop_duplicates("datetime", keep="last").set_index("datetime"))
    df=df[df.index<=issue_time].copy()
    if df.empty:
        raise RuntimeError("Không có quan trắc <= issue candidate")
    issue_time=df.index.max()
    expected=pd.date_range(end=issue_time, periods=lookback_hours, freq="h", tz="UTC")
    df=df.reindex(expected)
    df["flow"]=df["flow"].interpolate(method="time", limit=3, limit_area="inside")
    df["rain"]=df["rain"].interpolate(method="time", limit=3, limit_area="inside")
    if df[["flow","rain"]].isna().any().any():
        raise RuntimeError(f"Lookback thiếu: flow={int(df.flow.isna().sum())}, rain={int(df.rain.isna().sum())}")
    df["flow"]=df["flow"].clip(lower=0)
    df["rain"]=df["rain"].clip(lower=0)
    df["flow_diff_1h"]=df["flow"].diff().fillna(0.0)
    df["flow_mean_6h"]=df["flow"].rolling(6,min_periods=1).mean()
    df["flow_mean_24h"]=df["flow"].rolling(24,min_periods=1).mean()
    df["rain_sum_6h"]=df["rain"].rolling(6,min_periods=1).sum()
    df["rain_sum_24h"]=df["rain"].rolling(24,min_periods=1).sum()
    hour=df.index.hour.to_numpy(float)
    doy=df.index.dayofyear.to_numpy(float)
    df["hour_sin"]=np.sin(2*np.pi*hour/24)
    df["hour_cos"]=np.cos(2*np.pi*hour/24)
    df["doy_sin"]=np.sin(2*np.pi*doy/365.25)
    df["doy_cos"]=np.cos(2*np.pi*doy/365.25)
    return df

def align_rain_to_issue(rows: List[Dict[str,Any]], issue_time: pd.Timestamp) -> pd.DataFrame:
    df=pd.DataFrame(rows)
    df["forecast_time"]=pd.to_datetime(df["forecast_time"], utc=True, errors="coerce")
    df=(df.dropna(subset=["forecast_time"]).sort_values("forecast_time").drop_duplicates("forecast_time",keep="last").set_index("forecast_time"))
    expected=pd.date_range(start=issue_time+pd.Timedelta(hours=1), periods=LSTM_MAX_LEAD, freq="h", tz="UTC")
    return df.reindex(expected)

def build_future_tensor(index: pd.DatetimeIndex, rain_values: np.ndarray) -> np.ndarray:
    rain=np.asarray(rain_values,dtype=float)
    if len(rain)!=LSTM_MAX_LEAD or np.isnan(rain).any():
        raise ValueError("future rain H001-H120 không đầy đủ")
    rain=np.clip(rain,0,None)
    lead=np.arange(1,LSTM_MAX_LEAD+1,dtype=float)
    hour=index.hour.to_numpy(float)
    doy=index.dayofyear.to_numpy(float)
    return np.column_stack([
        rain,np.cumsum(rain),lead/LSTM_MAX_LEAD,
        np.sin(2*np.pi*hour/24),np.cos(2*np.pi*hour/24),
        np.sin(2*np.pi*doy/365.25),np.cos(2*np.pi*doy/365.25),
    ]).astype(np.float32)

def predict_scenario(a:Artifacts, xpast:np.ndarray, future_index:pd.DatetimeIndex, rain:np.ndarray)->np.ndarray:
    fraw=build_future_tensor(future_index,rain)
    fscaled=a.future_scaler.transform(fraw).astype(np.float32)[None,:,:]
    pred=a.model.predict({"past_sequence":xpast,"future_rain_sequence":fscaled},verbose=0)
    q=a.target_scaler.inverse_transform(pred[0,:LSTM_MAX_LEAD,0].reshape(-1,1)).reshape(-1)
    return np.maximum(q,0.0)

def build_output(issue_time, rain_run, q_now, preds):
    times=pd.date_range(start=issue_time+pd.Timedelta(hours=1), periods=LSTM_MAX_LEAD, freq="h", tz="UTC")
    names=list(RAIN_COLUMNS.keys())
    scenario_rows=[]
    ensemble_rows=[]
    for lead in range(1,LSTM_MAX_LEAD+1):
        ft=times[lead-1]
        vals=np.array([preds[n][lead-1] for n in names],dtype=float)
        for n in names:
            scenario_rows.append({
                "issue_time":iso_utc(issue_time),"forecast_time":iso_utc(ft),"lead_hour":lead,
                "basin_id":BASIN_ID,"source":LSTM_SOURCE,"model_version":LSTM_MODEL_VERSION,
                "rain_scenario":n,"rainfall_run_time":iso_utc(rain_run),"q_now":finite_or_none(q_now),
                "q_forecast":finite_or_none(preds[n][lead-1]),"scenario_count":6,"status":"SHADOW",
                "created_at":iso_utc(utcnow()),
            })
        ensemble_rows.append({
            "issue_time":iso_utc(issue_time),"forecast_time":iso_utc(ft),"lead_hour":lead,
            "basin_id":BASIN_ID,"source":LSTM_SOURCE,"model_version":LSTM_MODEL_VERSION,
            "rainfall_run_time":iso_utc(rain_run),"q_now":finite_or_none(q_now),
            "q_mean":finite_or_none(vals.mean()),"q_median":finite_or_none(np.median(vals)),
            "q_p10":finite_or_none(np.quantile(vals,.10)),"q_p25":finite_or_none(np.quantile(vals,.25)),
            "q_p50":finite_or_none(np.quantile(vals,.50)),"q_p75":finite_or_none(np.quantile(vals,.75)),
            "q_p90":finite_or_none(np.quantile(vals,.90)),"q_min":finite_or_none(vals.min()),
            "q_max":finite_or_none(vals.max()),"q_std":finite_or_none(vals.std(ddof=0)),
            "scenario_count":6,"status":"SHADOW","created_at":iso_utc(utcnow()),
        })
    return scenario_rows,ensemble_rows

def write_log(started,status,issue,rain_run,q_now,scenario_rows,ensemble_rows,message):
    row={
        "started_at":iso_utc(started),"finished_at":iso_utc(utcnow()),"basin_id":BASIN_ID,
        "source":LSTM_SOURCE,"model_version":LSTM_MODEL_VERSION,
        "issue_time":iso_utc(issue) if issue is not None else None,
        "rainfall_run_time":iso_utc(rain_run) if rain_run is not None else None,
        "q_now":finite_or_none(q_now),"scenario_rows":scenario_rows,"ensemble_rows":ensemble_rows,
        "status":status,"message":message[:4000],"created_at":iso_utc(utcnow()),
    }
    try:
        supabase_insert(TABLE_LOG,[row])
    except Exception as e:
        print("WARNING log:",e)

def main():
    started=utcnow()
    issue=rain_run=None
    q_now=None
    print("="*78)
    print("A VUONG LSTM H120 LIVE - SHADOW")
    print("="*78)
    try:
        a=load_artifacts()
        print("Model/scaler: OK")
        rain_run,rain_rows=get_latest_rain_run()
        age=(utcnow()-rain_run.to_pydatetime()).total_seconds()/3600
        if age>MAX_RAIN_RUN_AGE_HOURS:
            raise RuntimeError(f"Rain run stale: {age:.2f}h")
        past=get_observed_history(rain_run,a.lookback_hours)
        issue=past.index.max()
        q_now=float(past["flow"].iloc[-1])
        aligned=align_rain_to_issue(rain_rows,issue)
        for n,col in RAIN_COLUMNS.items():
            miss=int(pd.to_numeric(aligned[col],errors="coerce").isna().sum())
            if miss:
                raise RuntimeError(f"{n} thiếu {miss} giờ trong H001-H120")
        xpast=a.past_scaler.transform(past[PAST_FEATURES].to_numpy(dtype=float)).astype(np.float32)[None,:,:]
        preds={}
        for n,col in RAIN_COLUMNS.items():
            rain=pd.to_numeric(aligned[col],errors="coerce").to_numpy(dtype=float)
            preds[n]=predict_scenario(a,xpast,aligned.index,rain)
            print(f"{n:12s} H001={preds[n][0]:.2f} H024={preds[n][23]:.2f} H072={preds[n][71]:.2f} H120={preds[n][119]:.2f}")
        srows,erows=build_output(issue,rain_run,q_now,preds)
        supabase_insert(TABLE_SCENARIO,srows,"issue_time,forecast_time,source,rain_scenario")
        supabase_insert(TABLE_ENSEMBLE,erows,"issue_time,forecast_time,source")
        write_log(started,"OK",issue,rain_run,q_now,len(srows),len(erows),"LSTM shadow forecast completed")
        print("="*78)
        print("STATUS: OK")
        print("Issue time    :",issue)
        print("Rain run      :",rain_run)
        print("Q now         :",q_now)
        print("Scenario rows :",len(srows))
        print("Ensemble rows :",len(erows))
        print("="*78)
    except Exception as e:
        write_log(started,"ERROR",issue,rain_run,q_now,0,0,f"{type(e).__name__}: {e}")
        traceback.print_exc()
        raise

if __name__=="__main__":
    main()
