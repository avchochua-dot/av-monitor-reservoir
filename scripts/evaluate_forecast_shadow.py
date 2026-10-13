#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
import pandas as pd
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BASIN_ID = os.getenv("BASIN_ID", "AVUONG")
OBS_LIMIT = int(os.getenv("SHADOW_OBS_LIMIT", "3000"))

KEY_HORIZONS_FAIR5 = {1,3,6,12,24}

MODEL_LONG = "LONG_H120_P50"
MODEL_LSTM = "LSTM_H120_P50"
MODEL_CNN = "CNN_LSTM_H120_V3_1"
MODEL_RF = "RF_V1"
MODEL_PERSIST = "PERSISTENCE"

TABLE_LONG = "inflow_forecast_long_ensemble"
TABLE_LSTM = "inflow_forecast_lstm_ensemble"
TABLE_CNN = "inflow_forecast_cnn_lstm_ensemble"
TABLE_RF = "inflow_forecast_ml"
TABLE_OBS = "reservoir_hourly_data"
TABLE_EVAL = "forecast_shadow_eval"

session = requests.Session()
session.headers.update({
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
})

def sb_url(table:str)->str:
    return f"{SUPABASE_URL}/rest/v1/{table}"

def get_rows(table:str, params:Dict[str,str])->List[Dict[str,Any]]:
    r = session.get(sb_url(table), params=params, timeout=90)
    if not r.ok:
        raise RuntimeError(f"GET {table} failed {r.status_code}: {r.text[:2000]}")
    return r.json()

def upsert_rows(table:str, rows:List[Dict[str,Any]], on_conflict:str)->None:
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
            timeout=90
        )
        if not r.ok:
            raise RuntimeError(f"UPSERT {table} failed {r.status_code}: {r.text[:2000]}")

def get_observations()->pd.DataFrame:
    rows = get_rows(TABLE_OBS, {
        "select":"time,inflow,reservoir_id",
        "order":"time.desc",
        "limit":str(OBS_LIMIT),
    })
    if not rows:
        return pd.DataFrame(columns=["time","inflow"])
    df = pd.DataFrame(rows)
    if "reservoir_id" in df.columns:
        ids = df["reservoir_id"].dropna().astype(str).unique().tolist()
        if ids and BASIN_ID in ids:
            df = df[df["reservoir_id"].astype(str)==BASIN_ID].copy()
    df["time"] = pd.to_datetime(df["time"], utc=True, errors="coerce")
    df["inflow"] = pd.to_numeric(df["inflow"], errors="coerce")
    return (df.dropna(subset=["time","inflow"])
              .drop_duplicates("time", keep="last")
              .sort_values("time")[["time","inflow"]]
              .reset_index(drop=True))

def detect_forecast_schema(table:str)->Dict[str,Optional[str]]:
    rows = get_rows(table, {"select":"*","order":"forecast_time.desc","limit":"1"})
    if not rows:
        raise RuntimeError(f"{table} không có dữ liệu để nhận diện schema")
    columns = list(rows[0].keys())
    lower_map = {str(c).lower():c for c in columns}
    def pick(candidates):
        for name in candidates:
            if name.lower() in lower_map:
                return lower_map[name.lower()]
        return None
    schema = {
        "issue":pick(["issue_time","run_time"]),
        "forecast":pick(["forecast_time","time"]),
        "lead":pick(["lead_hour","lead","horizon"]),
        "q":pick(["q_p50","q_median","q_mean","q_forecast","q_pred","forecast_q"]),
        "version":pick(["model_version","version"]),
        "basin":pick(["basin_id"]),
        "source":pick(["source"]),
    }
    print(f"{table} detected Q:", schema["q"])
    if not all([schema["issue"],schema["forecast"],schema["lead"],schema["q"]]):
        raise RuntimeError(f"Không nhận diện đủ schema cho {table}. Columns: {columns}")
    return schema

def fetch_generic_forecast(table:str, obs_min:pd.Timestamp, obs_max:pd.Timestamp,
                           expected_source:Optional[str]=None)->pd.DataFrame:
    schema = detect_forecast_schema(table)
    cols = [schema["issue"],schema["forecast"],schema["lead"],schema["q"]]
    for c in [schema["version"],schema["basin"],schema["source"]]:
        if c and c not in cols:
            cols.append(c)
    params = {
        "select":",".join(cols),
        schema["forecast"]:f"gte.{obs_min.isoformat()}",
        "and":f"({schema['forecast']}.lte.{obs_max.isoformat()})",
        "order":f"{schema['forecast']}.asc",
        "limit":"30000",
    }
    if schema["basin"]:
        params[schema["basin"]] = f"eq.{BASIN_ID}"
    if schema["source"] and expected_source:
        params[schema["source"]] = f"eq.{expected_source}"
    rows = get_rows(table, params)
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    rename = {
        schema["issue"]:"issue_time",
        schema["forecast"]:"forecast_time",
        schema["lead"]:"lead_hour",
        schema["q"]:"q_center",
    }
    if schema["version"]:
        rename[schema["version"]] = "model_version"
    df = df.rename(columns=rename)
    if "model_version" not in df.columns:
        df["model_version"] = None
    df["issue_time"] = pd.to_datetime(df["issue_time"], utc=True, errors="coerce")
    df["forecast_time"] = pd.to_datetime(df["forecast_time"], utc=True, errors="coerce")
    df["lead_hour"] = pd.to_numeric(df["lead_hour"], errors="coerce")
    df["q_center"] = pd.to_numeric(df["q_center"], errors="coerce")
    df = df.dropna(subset=["issue_time","forecast_time","lead_hour","q_center"])
    calc_lead = (df["forecast_time"]-df["issue_time"]) / pd.Timedelta(hours=1)
    valid = (calc_lead-df["lead_hour"]).abs() < 0.01
    if (~valid).any():
        print(f"WARNING {table}: dropping {(~valid).sum()} inconsistent rows")
        df = df[valid].copy()
    return df[(df["forecast_time"]>=obs_min)&(df["forecast_time"]<=obs_max)].copy()

def fetch_rf_forecast(obs_min:pd.Timestamp, obs_max:pd.Timestamp)->pd.DataFrame:
    rows = get_rows(TABLE_RF, {
        "select":"issue_time,forecast_time,lead_hour,source,model_version,q_forecast",
        "source":"eq.rf_v1",
        "forecast_time":f"gte.{obs_min.isoformat()}",
        "and":f"(forecast_time.lte.{obs_max.isoformat()})",
        "order":"forecast_time.asc",
        "limit":"30000",
    })
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows)
    df["issue_time"] = pd.to_datetime(df["issue_time"], utc=True, errors="coerce")
    df["forecast_time"] = pd.to_datetime(df["forecast_time"], utc=True, errors="coerce")
    df["lead_hour"] = pd.to_numeric(df["lead_hour"], errors="coerce")
    df["q_center"] = pd.to_numeric(df["q_forecast"], errors="coerce")
    df = df.dropna(subset=["issue_time","forecast_time","lead_hour","q_center"])
    calc_lead = (df["forecast_time"]-df["issue_time"]) / pd.Timedelta(hours=1)
    valid = (calc_lead-df["lead_hour"]).abs() < 0.01
    return df[valid & (df["forecast_time"]>=obs_min) & (df["forecast_time"]<=obs_max)].copy()

def build_eval_rows(model_name:str, source_table:str, fdf:pd.DataFrame,
                    obs:pd.DataFrame)->List[Dict[str,Any]]:
    if fdf is None or fdf.empty:
        return []
    obs_map = dict(zip(obs["time"],obs["inflow"]))
    evaluated_at = datetime.now(timezone.utc).isoformat()
    out=[]
    for r in fdf.itertuples(index=False):
        ft = pd.Timestamp(r.forecast_time)
        if ft not in obs_map:
            continue
        q_obs = float(obs_map[ft])
        q_fc = float(r.q_center)
        err = q_fc-q_obs
        out.append({
            "evaluated_at":evaluated_at,
            "basin_id":BASIN_ID,
            "model_name":model_name,
            "model_version":getattr(r,"model_version",None),
            "issue_time":pd.Timestamp(r.issue_time).isoformat(),
            "forecast_time":ft.isoformat(),
            "lead_hour":int(r.lead_hour),
            "q_forecast":q_fc,
            "q_observed":q_obs,
            "error":err,
            "abs_error":abs(err),
            "sq_error":err*err,
            "rain_scenario":"ENSEMBLE",
            "source_table":source_table,
        })
    return out

def build_persistence_rows(forecast_frames:List[pd.DataFrame],
                           obs:pd.DataFrame)->List[Dict[str,Any]]:
    obs_map = dict(zip(obs["time"],obs["inflow"]))
    evaluated_at = datetime.now(timezone.utc).isoformat()
    keys=set()
    for df in forecast_frames:
        if df is None or df.empty:
            continue
        for r in df.itertuples(index=False):
            lead=int(r.lead_hour)
            if lead not in KEY_HORIZONS_FAIR5:
                continue
            keys.add((pd.Timestamp(r.issue_time),pd.Timestamp(r.forecast_time),lead))
    out=[]
    for issue,ft,lead in sorted(keys):
        if issue not in obs_map or ft not in obs_map:
            continue
        q_issue=float(obs_map[issue]); q_obs=float(obs_map[ft]); err=q_issue-q_obs
        out.append({
            "evaluated_at":evaluated_at,
            "basin_id":BASIN_ID,
            "model_name":MODEL_PERSIST,
            "model_version":"PERSISTENCE_Q_NOW_V1",
            "issue_time":issue.isoformat(),
            "forecast_time":ft.isoformat(),
            "lead_hour":lead,
            "q_forecast":q_issue,
            "q_observed":q_obs,
            "error":err,
            "abs_error":abs(err),
            "sq_error":err*err,
            "rain_scenario":"ENSEMBLE",
            "source_table":TABLE_OBS,
        })
    return out

def main()->None:
    obs=get_observations()
    if obs.empty:
        print("STATUS: SKIP - no observed inflow")
        return
    obs_min=obs["time"].min(); obs_max=obs["time"].max()
    print("="*82)
    print("A VUONG SHADOW EVALUATOR V5 - 5 MODELS + FAIR5 READY")
    print("="*82)
    print("Observed range:",obs_min,"->",obs_max)

    long_df=fetch_generic_forecast(TABLE_LONG,obs_min,obs_max)
    lstm_df=fetch_generic_forecast(TABLE_LSTM,obs_min,obs_max)
    cnn_df=fetch_generic_forecast(TABLE_CNN,obs_min,obs_max,expected_source="cnn_lstm_h120_v3")
    rf_df=fetch_rf_forecast(obs_min,obs_max)

    rows_long=build_eval_rows(MODEL_LONG,TABLE_LONG,long_df,obs)
    rows_lstm=build_eval_rows(MODEL_LSTM,TABLE_LSTM,lstm_df,obs)
    rows_cnn=build_eval_rows(MODEL_CNN,TABLE_CNN,cnn_df,obs)
    rows_rf=build_eval_rows(MODEL_RF,TABLE_RF,rf_df,obs)
    rows_persistence=build_persistence_rows([rf_df,long_df,lstm_df,cnn_df],obs)

    all_rows=rows_long+rows_lstm+rows_cnn+rows_rf+rows_persistence

    upsert_rows(
        TABLE_EVAL,
        all_rows,
        "model_name,issue_time,forecast_time,rain_scenario"
    )

    print("")
    print("Verified LONG_H120      :",len(rows_long))
    print("Verified LSTM_H120      :",len(rows_lstm))
    print("Verified CNN-LSTM V3.1  :",len(rows_cnn))
    print("Verified RF_V1          :",len(rows_rf))
    print("Verified persistence    :",len(rows_persistence))
    print("Total upsert rows       :",len(all_rows))
    print("Fair5 key horizons      :",sorted(KEY_HORIZONS_FAIR5))
    print("STATUS                  : OK")
    print("="*82)

if __name__=="__main__":
    main()
