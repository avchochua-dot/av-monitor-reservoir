#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
A VUONG - CNN-LSTM H120 V3 LIVE SHADOW PREDICTOR
"""

from __future__ import annotations
import math, os, traceback
from pathlib import Path
from typing import Any, Dict, List, Tuple

import joblib
import numpy as np
import pandas as pd
import requests
import tensorflow as tf

SUPABASE_URL=os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY=os.environ["SUPABASE_SERVICE_ROLE_KEY"]

BASIN_ID=os.getenv("BASIN_ID","AVUONG")
RESERVOIR_ID=os.getenv("RESERVOIR_ID","").strip()

MODEL_DIR=Path(os.getenv("CNN_LSTM_MODEL_DIR","models/cnn_lstm_h120_v3"))
MODEL_PATH=MODEL_DIR/"cnn_lstm_h120_v3.keras"
SCALER_PATH=MODEL_DIR/"cnn_lstm_h120_v3_scalers.joblib"

SOURCE=os.getenv("CNN_LSTM_SOURCE","cnn_lstm_h120_v3")
MODEL_VERSION=os.getenv("CNN_LSTM_MODEL_VERSION","CNN_LSTM_H120_V3_SHORT_PEAK_AWARE")

LOOKBACK=int(os.getenv("CNN_LSTM_LOOKBACK_HOURS","168"))
HORIZON=int(os.getenv("CNN_LSTM_MAX_LEAD","120"))
MAX_RAIN_RUN_AGE_HOURS=float(os.getenv("MAX_RAIN_RUN_AGE_HOURS","12"))

TABLE_OBS="reservoir_hourly_data"
TABLE_RAIN_6="rainfall_basin_hourly"
TABLE_RAIN_BEST="rainfall_openmeteo_best_hourly"
TABLE_SCENARIO="inflow_forecast_cnn_lstm_scenario"
TABLE_ENSEMBLE="inflow_forecast_cnn_lstm_ensemble"
TABLE_LOG="cnn_lstm_forecast_run_log"

RAIN_6_COLUMNS={
    "ECMWF_IFS":"rain_ecmwf",
    "GFS":"rain_gfs",
    "ICON":"rain_icon",
    "ECMWF_AIFS":"rain_aifs",
    "CMA_GRAPES":"rain_cma",
    "JMA_GSM":"rain_jma",
}

HIST_FEATURES=[
    "q","rain","q_diff1","q_diff3",
    "q_lag_1","q_lag_3","q_lag_6","q_lag_12","q_lag_24",
    "rain_sum_1","rain_sum_3","rain_sum_6","rain_sum_12",
    "rain_sum_24","rain_sum_48","rain_sum_72",
    "hour_sin","hour_cos","month_sin","month_cos"
]
STATIC_FEATURES=["q_now","q_diff1_now","q_diff3_now"]
FUTURE_FEATURES=[
    "rain_1h","rain_sum_3h_future","rain_sum_6h_future",
    "rain_sum_12h_future","rain_sum_24h_future"
]

SESSION=requests.Session()
SESSION.headers.update({
    "apikey":SUPABASE_KEY,
    "Authorization":f"Bearer {SUPABASE_KEY}",
    "Content-Type":"application/json"
})

def api_url(table:str)->str:
    return f"{SUPABASE_URL}/rest/v1/{table}"

def sb_get(table:str,params:Dict[str,str])->List[Dict[str,Any]]:
    r=SESSION.get(api_url(table),params=params,timeout=60)
    if not r.ok:
        raise RuntimeError(f"GET {table} failed {r.status_code}: {r.text[:1200]}")
    return r.json()

def sb_insert(table:str,row:Dict[str,Any])->None:
    h=dict(SESSION.headers); h["Prefer"]="return=minimal"
    r=SESSION.post(api_url(table),headers=h,json=row,timeout=60)
    if not r.ok:
        raise RuntimeError(f"INSERT {table} failed {r.status_code}: {r.text[:1200]}")

def sb_upsert(table:str,rows:List[Dict[str,Any]],on_conflict:str)->None:
    h=dict(SESSION.headers); h["Prefer"]="resolution=merge-duplicates,return=minimal"
    for i in range(0,len(rows),400):
        r=SESSION.post(
            api_url(table),
            params={"on_conflict":on_conflict},
            headers=h,json=rows[i:i+400],timeout=60
        )
        if not r.ok:
            raise RuntimeError(f"UPSERT {table} failed {r.status_code}: {r.text[:1600]}")

@tf.keras.utils.register_keras_serializable(package="AVuong")
class PeakAwareWeightedHuber(tf.keras.losses.Loss):
    def __init__(self,delta=1.0,peak_alpha=0.30,peak_cap=2.0,
                 name="peak_aware_weighted_huber",**kwargs):
        super().__init__(name=name,**kwargs)
        self.delta=float(delta); self.peak_alpha=float(peak_alpha); self.peak_cap=float(peak_cap)
    def call(self,y_true,y_pred):
        e=y_pred-y_true; a=tf.abs(e); q=tf.minimum(a,self.delta); l=a-q
        return tf.reduce_mean(0.5*tf.square(q)+self.delta*l)
    def get_config(self):
        c=super().get_config()
        c.update({"delta":self.delta,"peak_alpha":self.peak_alpha,"peak_cap":self.peak_cap})
        return c

def parse_utc(v)->pd.Timestamp:
    x=pd.Timestamp(v)
    if x.tzinfo is None:
        x=x.tz_localize("UTC")
    else:
        x=x.tz_convert("UTC")
    return x

def load_artifacts():
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(f"Missing model {MODEL_PATH}")
    if not SCALER_PATH.is_file():
        raise FileNotFoundError(f"Missing scaler {SCALER_PATH}")

    model=tf.keras.models.load_model(
        MODEL_PATH,
        custom_objects={"PeakAwareWeightedHuber":PeakAwareWeightedHuber},
        compile=False,
        safe_mode=False
    )
    bundle=joblib.load(SCALER_PATH)

    for key in [
        "history_scaler","static_scaler","future_scaler","residual_scaler",
        "history_features","static_features","future_features",
        "lookback","horizon","short_blend_alphas"
    ]:
        if key not in bundle:
            raise RuntimeError(f"Scaler bundle missing key: {key}")

    if list(bundle["history_features"])!=HIST_FEATURES:
        raise RuntimeError("History feature mismatch.")
    if list(bundle["static_features"])!=STATIC_FEATURES:
        raise RuntimeError("Static feature mismatch.")
    if list(bundle["future_features"])!=FUTURE_FEATURES:
        raise RuntimeError("Future feature mismatch.")
    if int(bundle["lookback"])!=LOOKBACK or int(bundle["horizon"])!=HORIZON:
        raise RuntimeError("Lookback/horizon mismatch.")

    return model,bundle

def get_latest_observed_time()->pd.Timestamp:
    params={"select":"time,reservoir_id,inflow,rainfallreal","order":"time.desc","limit":"1"}
    if RESERVOIR_ID:
        params["reservoir_id"]=f"eq.{RESERVOIR_ID}"
    rows=sb_get(TABLE_OBS,params)
    if not rows:
        raise RuntimeError("No observed data.")
    return parse_utc(rows[0]["time"]).floor("h")

def get_history(issue:pd.Timestamp)->Tuple[pd.DataFrame,np.ndarray]:
    start=issue-pd.Timedelta(hours=LOOKBACK+95)
    params={
        "select":"time,reservoir_id,inflow,rainfallreal",
        "time":f"gte.{start.isoformat()}",
        "and":f"(time.lte.{issue.isoformat()})",
        "order":"time.asc",
        "limit":"1000"
    }
    if RESERVOIR_ID:
        params["reservoir_id"]=f"eq.{RESERVOIR_ID}"

    rows=sb_get(TABLE_OBS,params)
    if not rows:
        raise RuntimeError("Observed history is empty.")

    d=pd.DataFrame(rows)
    d["time"]=pd.to_datetime(d["time"],utc=True)
    d["q"]=pd.to_numeric(d["inflow"],errors="coerce")
    d["rain"]=pd.to_numeric(d["rainfallreal"],errors="coerce")
    d=(d[["time","q","rain"]].drop_duplicates("time",keep="last")
       .sort_values("time").set_index("time"))
    full=pd.date_range(start,issue,freq="h",tz="UTC")
    d=d.reindex(full)

    d["q"]=d["q"].interpolate(method="time",limit=3,limit_direction="both")
    d["rain"]=d["rain"].interpolate(method="time",limit=3,limit_direction="both")

    d["q_diff1"]=d["q"].diff(1)
    d["q_diff3"]=d["q"].diff(3)
    for h in [1,3,6,12,24]:
        d[f"q_lag_{h}"]=d["q"].shift(h)
    for h in [1,3,6,12,24,48,72]:
        d[f"rain_sum_{h}"]=d["rain"].rolling(h,min_periods=h).sum()

    hour=d.index.hour.to_numpy()
    month=d.index.month.to_numpy()
    d["hour_sin"]=np.sin(2*np.pi*hour/24)
    d["hour_cos"]=np.cos(2*np.pi*hour/24)
    d["month_sin"]=np.sin(2*np.pi*(month-1)/12)
    d["month_cos"]=np.cos(2*np.pi*(month-1)/12)

    hist=d.tail(LOOKBACK).copy()
    if len(hist)!=LOOKBACK:
        raise RuntimeError(f"History {len(hist)} != {LOOKBACK}")
    if hist[HIST_FEATURES].isna().any().any():
        bad=hist[HIST_FEATURES].isna().sum()
        raise RuntimeError(f"History missing: {bad[bad>0].to_dict()}")

    q_now=float(hist["q"].iloc[-1])
    static=np.array([
        q_now,
        q_now-float(hist["q"].iloc[-2]),
        q_now-float(hist["q"].iloc[-4])
    ],dtype=np.float32)
    return hist,static

def choose_6nwp(issue:pd.Timestamp):
    start=issue+pd.Timedelta(hours=1)
    end=issue+pd.Timedelta(hours=HORIZON)
    rows=sb_get(TABLE_RAIN_6,{
        "select":"run_time,forecast_time,basin_id,rain_ecmwf,rain_gfs,rain_icon,rain_aifs,rain_cma,rain_jma",
        "basin_id":f"eq.{BASIN_ID}",
        "forecast_time":f"gte.{start.isoformat()}",
        "and":f"(forecast_time.lte.{end.isoformat()})",
        "order":"run_time.desc,forecast_time.asc",
        "limit":"5000"
    })
    if not rows:
        raise RuntimeError("No 6-NWP rainfall data.")
    d=pd.DataFrame(rows)
    d["run_time"]=pd.to_datetime(d["run_time"],utc=True)
    d["forecast_time"]=pd.to_datetime(d["forecast_time"],utc=True)
    expected=pd.date_range(start,periods=HORIZON,freq="h",tz="UTC")

    for rt in sorted(d["run_time"].dropna().unique(),reverse=True):
        rt=pd.Timestamp(rt)
        part=(d[d["run_time"]==rt].drop_duplicates("forecast_time",keep="last")
              .set_index("forecast_time").reindex(expected))
        out={}
        ok=True
        for name,col in RAIN_6_COLUMNS.items():
            v=pd.to_numeric(part[col],errors="coerce")
            if len(v)!=HORIZON or v.isna().any():
                ok=False; break
            out[name]=v.to_numpy(np.float32)
        if ok:
            age=float((issue-rt)/pd.Timedelta(hours=1))
            if age>MAX_RAIN_RUN_AGE_HOURS:
                raise RuntimeError(f"6-NWP run too old: {age:.1f}h")
            return rt,out
    raise RuntimeError("No complete 6-NWP run for H001-H120.")

def choose_best(issue:pd.Timestamp):
    start=issue+pd.Timedelta(hours=1)
    end=issue+pd.Timedelta(hours=HORIZON)
    rows=sb_get(TABLE_RAIN_BEST,{
        "select":"run_time,forecast_time,basin_id,rain_openmeteo_best",
        "basin_id":f"eq.{BASIN_ID}",
        "forecast_time":f"gte.{start.isoformat()}",
        "and":f"(forecast_time.lte.{end.isoformat()})",
        "order":"run_time.desc,forecast_time.asc",
        "limit":"5000"
    })
    if not rows:
        raise RuntimeError("No OpenMeteo Best data.")
    d=pd.DataFrame(rows)
    d["run_time"]=pd.to_datetime(d["run_time"],utc=True)
    d["forecast_time"]=pd.to_datetime(d["forecast_time"],utc=True)
    expected=pd.date_range(start,periods=HORIZON,freq="h",tz="UTC")

    for rt in sorted(d["run_time"].dropna().unique(),reverse=True):
        rt=pd.Timestamp(rt)
        part=(d[d["run_time"]==rt].drop_duplicates("forecast_time",keep="last")
              .set_index("forecast_time").reindex(expected))
        v=pd.to_numeric(part["rain_openmeteo_best"],errors="coerce")
        if len(v)==HORIZON and not v.isna().any():
            age=float((issue-rt)/pd.Timedelta(hours=1))
            if age>MAX_RAIN_RUN_AGE_HOURS:
                raise RuntimeError(f"OpenMeteo Best run too old: {age:.1f}h")
            return rt,v.to_numpy(np.float32)
    raise RuntimeError("No complete OpenMeteo Best run for H001-H120.")

def tsum(a,w):
    return pd.Series(a.astype(float)).rolling(w,min_periods=1).sum().to_numpy(np.float32)

def future_features(r):
    return np.column_stack([r,tsum(r,3),tsum(r,6),tsum(r,12),tsum(r,24)]).astype(np.float32)

def inv(a,scaler):
    return scaler.inverse_transform(a.reshape(-1,1)).reshape(a.shape).astype(np.float32)

def alpha(bundle,lead:int)->float:
    a=bundle.get("short_blend_alphas") or {}
    item=a.get(lead) or a.get(str(lead)) or {"alpha_cnn":1.0}
    return float(item.get("alpha_cnn",1.0))

def predict_one(model,bundle,hist,static,rain):
    xh=hist[HIST_FEATURES].to_numpy(np.float32)[None,:,:]
    xs=static[None,:].astype(np.float32)
    xf=future_features(rain)[None,:,:]

    hs=bundle["history_scaler"]; ss=bundle["static_scaler"]
    fs=bundle["future_scaler"]; rs=bundle["residual_scaler"]

    xh=hs.transform(xh.reshape(-1,xh.shape[-1])).reshape(xh.shape).astype(np.float32)
    xs=ss.transform(xs).astype(np.float32)
    xf=fs.transform(xf.reshape(-1,xf.shape[-1])).reshape(xf.shape).astype(np.float32)

    main_s,short_s=model.predict(
        {"history":xh,"static_state":xs,"future_rain_features":xf},
        verbose=0
    )
    resid=inv(main_s,rs)[0,:,0]
    short=inv(short_s[:,:,None],rs)[0,:,0]

    resid[0]=short[0]
    resid[2]=short[1]
    resid[5]=short[2]

    q_now=float(static[0])
    raw=np.maximum(q_now+resid,0.0)
    cal=raw.copy()

    for lead in range(1,7):
        a=alpha(bundle,lead)
        j=lead-1
        cal[j]=max(a*raw[j]+(1-a)*q_now,0.0)
    return raw.astype(float),cal.astype(float)

def write_log(started,finished,issue,run6,runbest,srows,erows,count,status,msg):
    try:
        sb_insert(TABLE_LOG,{
            "started_at":started.isoformat(),
            "finished_at":finished.isoformat(),
            "basin_id":BASIN_ID,
            "source":SOURCE,
            "model_version":MODEL_VERSION,
            "issue_time":issue.isoformat() if issue is not None else None,
            "rain_run_6nwp":run6.isoformat() if run6 is not None else None,
            "rain_run_openmeteo_best":runbest.isoformat() if runbest is not None else None,
            "scenario_rows":int(srows),
            "ensemble_rows":int(erows),
            "scenario_count":int(count),
            "status":status,
            "message":(msg or "")[:4000]
        })
    except Exception as e:
        print("WARNING log insert:",e)

def main():
    started=pd.Timestamp.now(tz="UTC")
    issue=run6=runbest=None
    try:
        print("="*78)
        print("A VUONG CNN-LSTM V3 LIVE SHADOW")
        print("="*78)

        model,bundle=load_artifacts()
        issue=get_latest_observed_time()
        print("Issue time:",issue)

        latest=sb_get(TABLE_ENSEMBLE,{
            "select":"issue_time",
            "basin_id":f"eq.{BASIN_ID}",
            "source":f"eq.{SOURCE}",
            "order":"issue_time.desc",
            "limit":"1"
        })
        if latest and parse_utc(latest[0]["issue_time"]).floor("h")>=issue:
            print("SKIP: latest CNN-LSTM V3 issue already current.")
            write_log(started,pd.Timestamp.now(tz="UTC"),issue,None,None,0,0,0,"SKIP","Already current.")
            return

        hist,static=get_history(issue)
        q_now=float(static[0])

        run6,six=choose_6nwp(issue)
        runbest,best=choose_best(issue)

        rains=dict(six)
        rains["OPENMETEO_BEST"]=best
        runs={k:run6 for k in six}
        runs["OPENMETEO_BEST"]=runbest

        qraws={}; qfcs={}
        for name,rain in rains.items():
            qraw,qfc=predict_one(model,bundle,hist,static,rain)
            qraws[name]=qraw; qfcs[name]=qfc
            print(f"{name:18s} H01={qfc[0]:.2f} H24={qfc[23]:.2f} H120={qfc[119]:.2f}")

        ft=pd.date_range(issue+pd.Timedelta(hours=1),periods=HORIZON,freq="h",tz="UTC")
        now=pd.Timestamp.now(tz="UTC").isoformat()

        srows=[]
        for name in qfcs:
            for j in range(HORIZON):
                lead=j+1
                srows.append({
                    "basin_id":BASIN_ID,
                    "source":SOURCE,
                    "model_version":MODEL_VERSION,
                    "issue_time":issue.isoformat(),
                    "forecast_time":ft[j].isoformat(),
                    "lead_hour":lead,
                    "rain_scenario":name,
                    "rain_run_time":runs[name].isoformat(),
                    "rain_mm":float(rains[name][j]),
                    "q_raw":float(qraws[name][j]),
                    "q_forecast":float(qfcs[name][j]),
                    "q_now":q_now,
                    "calibration_alpha":alpha(bundle,lead) if lead<=6 else 1.0,
                    "quality":"GOOD",
                    "created_at":now
                })

        matrix=np.vstack([qfcs[k] for k in qfcs])
        erows=[]
        for j in range(HORIZON):
            v=matrix[:,j].astype(float)
            erows.append({
                "basin_id":BASIN_ID,
                "source":SOURCE,
                "model_version":MODEL_VERSION,
                "issue_time":issue.isoformat(),
                "forecast_time":ft[j].isoformat(),
                "lead_hour":j+1,
                "q_mean":float(np.mean(v)),
                "q_p50":float(np.percentile(v,50)),
                "q_p10":float(np.percentile(v,10)),
                "q_p90":float(np.percentile(v,90)),
                "q_p25":float(np.percentile(v,25)),
                "q_p75":float(np.percentile(v,75)),
                "q_min":float(np.min(v)),
                "q_max":float(np.max(v)),
                "scenario_count":len(v),
                "quality":"GOOD",
                "created_at":now
            })

        if len(srows)!=840 or len(erows)!=120:
            raise RuntimeError(f"Unexpected output counts scenario={len(srows)} ensemble={len(erows)}")

        sb_upsert(TABLE_SCENARIO,srows,"basin_id,source,issue_time,forecast_time,rain_scenario")
        sb_upsert(TABLE_ENSEMBLE,erows,"basin_id,source,issue_time,forecast_time")

        finished=pd.Timestamp.now(tz="UTC")
        write_log(started,finished,issue,run6,runbest,len(srows),len(erows),7,"OK","CNN-LSTM V3 shadow completed.")

        print("="*78)
        print("STATUS        : OK")
        print("Issue time    :",issue.isoformat())
        print("Scenario rows :",len(srows))
        print("Ensemble rows :",len(erows))
        print("Scenario count: 7")
        print("="*78)

    except Exception as e:
        traceback.print_exc()
        write_log(started,pd.Timestamp.now(tz="UTC"),issue,run6,runbest,0,0,0,"ERROR",f"{type(e).__name__}: {e}")
        raise

if __name__=="__main__":
    main()
