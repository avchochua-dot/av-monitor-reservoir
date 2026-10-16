#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A VUONG - TimeXer H120 V2 CORE4 LIVE SHADOW PREDICTOR
======================================================

Reads:
- reservoir_hourly_data
- rainfall_basin_hourly

Writes:
- inflow_forecast_timexer_ensemble (120 rows / issue)
- inflow_forecast_timexer_scenario (4 x 120 rows / issue)
- timexer_forecast_run_log

Important:
- issue_time = latest usable observed Q timestamp.
- no future observation is used.
- all 4 NWP scenarios must be available H001-H120.
- SHADOW only. Does not overwrite existing production forecast tables.

Expected secrets:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Expected files:
  models/timexer_h120_v2_nwp_core4_fixed/timexer_h120_v2_nwp_core4_fixed.pt
  models/timexer_h120_v2_nwp_core4_fixed/timexer_h120_v1_2_config.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from supabase import create_client


SCENARIOS = ["ECMWF", "GFS", "ICON", "AIFS"]
RAIN_COLS = ["rain_ecmwf", "rain_gfs", "rain_icon", "rain_aifs"]
FEATURE_ORDER = [
    "Rain",
    "RainSum_3h",
    "RainSum_6h",
    "RainSum_12h",
    "RainSum_24h",
    "RainSum_48h",
    "RainSum_72h",
    "hour_sin",
    "hour_cos",
    "month_sin",
    "month_cos",
    "Q",
]
HYDRO_INDICES = [0,1,2,3,4,5,6,11]
Q_INDEX = 11
MODEL_VERSION = "TIMEXER_H120_V2_NWP_CORE4_FIXED"
SOURCE = "timexer_h120_v2_core4_shadow"
BASIN_ID = "AVUONG"


# ---------------- Model classes ----------------

class PositionalEncoding(nn.Module):
    def __init__(self, n, d_model):
        super().__init__()
        pe = torch.zeros(n, d_model)
        p = torch.arange(n, dtype=torch.float32).unsqueeze(1)
        div = torch.exp(torch.arange(0, d_model, 2, dtype=torch.float32) * (-math.log(10000.0)/d_model))
        pe[:,0::2] = torch.sin(p*div)
        pe[:,1::2] = torch.cos(p*div)
        self.register_buffer("pe", pe.unsqueeze(0), persistent=False)

    def forward(self, x):
        return self.pe[:, :x.shape[1], :]


class TimeXerEncoderLayer(nn.Module):
    def __init__(self, d_model, n_heads, d_ff, dropout):
        super().__init__()
        self.self_attn = nn.MultiheadAttention(d_model, n_heads, dropout=dropout, batch_first=True)
        self.cross_attn = nn.MultiheadAttention(d_model, n_heads, dropout=dropout, batch_first=True)
        self.norm1 = nn.LayerNorm(d_model)
        self.norm2 = nn.LayerNorm(d_model)
        self.norm3 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, d_ff),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(d_ff, d_model),
        )
        self.drop = nn.Dropout(dropout)

    def forward(self, endogenous, exogenous):
        z,_ = self.self_attn(endogenous,endogenous,endogenous,need_weights=False)
        x = self.norm1(endogenous + self.drop(z))
        p,g = x[:,:-1,:], x[:,-1:,:]
        z,_ = self.cross_attn(g,exogenous,exogenous,need_weights=False)
        g = self.norm2(g + self.drop(z))
        x = torch.cat([p,g], dim=1)
        return self.norm3(x + self.drop(self.ffn(x)))


class HistoricalV12(nn.Module):
    def __init__(self, c):
        super().__init__()
        L=int(c["seq_len"]); H=int(c["pred_len"]); pl=int(c["patch_len"])
        d=int(c["d_model"]); nh=int(c["n_heads"]); nl=int(c["e_layers"])
        ff=int(c["d_ff"]); dr=float(c["dropout"]); sh=int(c.get("short_len",6))
        self.pl=pl; self.pn=L//pl
        self.patch_embed=nn.Linear(pl,d,bias=False)
        self.pos_embed=PositionalEncoding(self.pn,d)
        self.global_token=nn.Parameter(torch.randn(1,1,d)*.02)
        self.exog_embed=nn.Linear(L,d,bias=False)
        self.input_drop=nn.Dropout(dr)
        self.layers=nn.ModuleList([TimeXerEncoderLayer(d,nh,ff,dr) for _ in range(nl)])
        self.final_norm=nn.LayerNorm(d)
        flat=(self.pn+1)*d
        self.main_drop=nn.Dropout(dr); self.main_head=nn.Linear(flat,H)
        self.short_drop=nn.Dropout(dr); self.short_head=nn.Linear(flat,sh)

    def normalize_inputs(self,x):
        xn=x.clone()
        idx=torch.tensor(HYDRO_INDICES,device=x.device,dtype=torch.long)
        h=x.index_select(2,idx)
        m=h.mean(1,keepdim=True)
        s=h.std(1,keepdim=True,unbiased=False).clamp_min(1e-5)
        xn[:,:,idx]=(h-m)/s
        return xn,m[:,0,-1:],s[:,0,-1:],x[:,-1,Q_INDEX:Q_INDEX+1]

    def forward(self,x):
        xn,qm,qs,ql=self.normalize_inputs(x)
        q=xn[:,:,Q_INDEX]
        p=q.unfold(1,self.pl,self.pl)
        en=self.patch_embed(p)+self.pos_embed(self.patch_embed(p))
        en=self.input_drop(torch.cat([en,self.global_token.expand(x.shape[0],-1,-1)],1))
        ex=self.input_drop(self.exog_embed(xn[:,:,:Q_INDEX].transpose(1,2)))
        for layer in self.layers:
            en=layer(en,ex)
        flat=torch.flatten(self.final_norm(en),1)
        main=self.main_head(self.main_drop(flat))*qs+qm
        short=ql+self.short_head(self.short_drop(flat))*qs
        return main,short


class TimeXerV2Core4(nn.Module):
    def __init__(self,c,rmean,rstd,caps,d_model=64,n_heads=4,n_layers=2,d_ff=128,dropout=.10):
        super().__init__()
        self.hist=HistoricalV12(c)
        self.register_buffer("rain_log_mean",torch.tensor(float(rmean)))
        self.register_buffer("rain_log_std",torch.tensor(float(max(rstd,1e-6))))
        self.register_buffer("correction_caps",torch.tensor(caps,dtype=torch.float32).view(1,1,120))
        self.rain_proj=nn.Linear(1,d_model)
        self.rain_pos=PositionalEncoding(120,d_model)
        el=nn.TransformerEncoderLayer(d_model,n_heads,d_ff,dropout,activation="gelu",batch_first=True,norm_first=True)
        self.rain_encoder=nn.TransformerEncoder(el,n_layers)
        self.rain_norm=nn.LayerNorm(d_model)
        self.rain_head=nn.Sequential(nn.Linear(d_model,d_model),nn.GELU(),nn.Dropout(dropout),nn.Linear(d_model,1))

    def forward(self,X,R):
        self.hist.eval()
        with torch.no_grad():
            hist,_=self.hist(X)
        B,S,T,F=R.shape
        rr=R.reshape(B*S,T,F)
        rr=(torch.log1p(torch.clamp(rr,min=0))-self.rain_log_mean)/self.rain_log_std
        z=self.rain_proj(rr)+self.rain_pos(self.rain_proj(rr))
        z=self.rain_norm(self.rain_encoder(z))
        raw=self.rain_head(z).squeeze(-1).reshape(B,S,T)
        delta=self.correction_caps*torch.tanh(raw)
        scenarios=hist[:,None,:]+delta
        central=torch.quantile(scenarios,0.5,dim=1)
        return scenarios,central,hist


# ---------------- Data helpers ----------------

def iso(ts):
    return pd.Timestamp(ts).tz_convert("UTC").isoformat()


def sb_fetch_all(query_builder, page_size=1000):
    rows=[]
    start=0
    while True:
        res=query_builder.range(start,start+page_size-1).execute()
        batch=res.data or []
        rows.extend(batch)
        if len(batch)<page_size:
            break
        start+=page_size
    return rows


def build_history(sb, issue_time):
    """
    IMPORTANT:
    This must match training feature engineering.
    The code uses hourly Rain, inclusive rolling sums, local-VN calendar,
    and Q=inflow. If your Step2 builder used a different rolling convention,
    copy that exact convention here before production use.
    """

    t0=issue_time-pd.Timedelta(hours=239)

    rows=sb_fetch_all(
        sb.table("reservoir_hourly_data")
          .select("time,inflow,rainfallreal")
          .gte("time",iso(t0))
          .lte("time",iso(issue_time))
          .order("time")
    )

    if not rows:
        raise RuntimeError("No reservoir_hourly_data history.")

    df=pd.DataFrame(rows)
    df["time"]=pd.to_datetime(df["time"],utc=True)
    df["Q"]=pd.to_numeric(df["inflow"],errors="coerce")
    df["Rain"]=pd.to_numeric(df["rainfallreal"],errors="coerce")

    # Duplicate guard.
    df=df.sort_values("time").drop_duplicates("time",keep="last").set_index("time")

    full_index=pd.date_range(df.index.min().floor("h"),issue_time.floor("h"),freq="h",tz="UTC")
    df=df.reindex(full_index)

    # Safety: do not manufacture Q.
    if df["Q"].tail(168).isna().any():
        raise RuntimeError("Missing Q inside latest 168h history.")

    # Rain: short gaps may be data-source zeros only if actually stored as zero.
    # Do not silently fill missing database rows.
    if df["Rain"].tail(168).isna().any():
        raise RuntimeError("Missing Rain inside latest 168h history.")

    for h in [3,6,12,24,48,72]:
        df[f"RainSum_{h}h"]=df["Rain"].rolling(h,min_periods=h).sum()

    vn=df.index.tz_convert("Asia/Ho_Chi_Minh")
    hour=vn.hour.to_numpy()
    month=vn.month.to_numpy()

    df["hour_sin"]=np.sin(2*np.pi*hour/24.0)
    df["hour_cos"]=np.cos(2*np.pi*hour/24.0)
    df["month_sin"]=np.sin(2*np.pi*(month-1)/12.0)
    df["month_cos"]=np.cos(2*np.pi*(month-1)/12.0)

    hist=df.tail(168).copy()

    if hist[FEATURE_ORDER].isna().any().any():
        bad=hist[FEATURE_ORDER].isna().sum()
        raise RuntimeError(f"NaN in features: {bad[bad>0].to_dict()}")

    X=hist[FEATURE_ORDER].to_numpy(np.float32)[None,:,:]

    return X,hist.index.min(),hist.index.max()


def latest_issue_time(sb):
    res=(
        sb.table("reservoir_hourly_data")
          .select("time,inflow")
          .not_.is_("inflow","null")
          .order("time",desc=True)
          .limit(1)
          .execute()
    )
    if not res.data:
        raise RuntimeError("No latest inflow observation.")
    ts=pd.Timestamp(res.data[0]["time"])
    if ts.tzinfo is None:
        ts=ts.tz_localize("UTC")
    else:
        ts=ts.tz_convert("UTC")
    return ts.floor("h")


def select_live_nwp(sb,issue_time,max_age_h=24):
    """
    rainfall_basin_hourly currently uses run_time as collector/forecast issue time.
    Select newest archived run available at or before hydrological issue_time.
    """

    runs=(
        sb.table("rainfall_basin_hourly")
          .select("run_time")
          .eq("basin_id",BASIN_ID)
          .lte("run_time",iso(issue_time))
          .order("run_time",desc=True)
          .limit(30)
          .execute()
          .data
        or []
    )

    unique=[]
    seen=set()
    for r in runs:
        rt=r["run_time"]
        if rt not in seen:
            seen.add(rt); unique.append(pd.Timestamp(rt))

    for run_time in unique:
        run_time=run_time.tz_convert("UTC") if run_time.tzinfo else run_time.tz_localize("UTC")
        age=(issue_time-run_time).total_seconds()/3600.0
        if age<0 or age>max_age_h:
            continue

        rows=sb_fetch_all(
            sb.table("rainfall_basin_hourly")
              .select("forecast_time,run_time,lead_hour,rain_ecmwf,rain_gfs,rain_icon,rain_aifs,quality")
              .eq("basin_id",BASIN_ID)
              .eq("run_time",run_time.isoformat())
              .gt("forecast_time",iso(issue_time))
              .lte("forecast_time",iso(issue_time+pd.Timedelta(hours=120)))
              .order("forecast_time")
        )

        if len(rows)<120:
            continue

        df=pd.DataFrame(rows)
        df["forecast_time"]=pd.to_datetime(df["forecast_time"],utc=True)
        df=df.sort_values("forecast_time").drop_duplicates("forecast_time",keep="last")

        expected=pd.date_range(issue_time+pd.Timedelta(hours=1),periods=120,freq="h",tz="UTC")
        df=df.set_index("forecast_time").reindex(expected)

        if len(df)!=120:
            continue

        bad=False
        arrays=[]
        for col in RAIN_COLS:
            v=pd.to_numeric(df[col],errors="coerce").to_numpy(float)
            if not np.isfinite(v).all() or (v<0).any():
                bad=True; break
            arrays.append(v.astype(np.float32))

        if bad:
            continue

        R=np.stack(arrays,axis=0)[:,:,None][None,:,:,:].astype(np.float32)
        return R,run_time,float(age)

    raise RuntimeError("No safe complete CORE4 NWP run H001-H120.")


def log_run(sb, **kwargs):
    try:
        sb.table("timexer_forecast_run_log").insert([kwargs]).execute()
    except Exception as e:
        print("WARN run log failed:",e)


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--checkpoint",required=True)
    ap.add_argument("--config",required=True)
    ap.add_argument("--max-nwp-age-hours",type=float,default=24.0)
    ap.add_argument("--max-q-age-hours",type=float,default=3.0)
    args=ap.parse_args()

    started=time.time()
    url=os.environ["SUPABASE_URL"]
    key=os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    sb=create_client(url,key)

    issue=None
    input_start=None
    input_end=None
    nwp_run=None
    nwp_age=None

    try:
        issue=latest_issue_time(sb)

        now=pd.Timestamp.now(tz="UTC")
        q_age=(now-issue).total_seconds()/3600.0
        if q_age>args.max_q_age_hours:
            raise RuntimeError(f"Latest Q is stale: age={q_age:.2f}h")

        X,input_start,input_end=build_history(sb,issue)
        R,nwp_run,nwp_age=select_live_nwp(sb,issue,args.max_nwp_age_hours)

        cfg=json.load(open(args.config,encoding="utf-8"))
        ck=torch.load(args.checkpoint,map_location="cpu",weights_only=False)

        for required in ["model_state_dict","rain_log_mean","rain_log_std","correction_caps","scenario_order"]:
            if required not in ck:
                raise RuntimeError(f"Checkpoint missing {required}")

        if list(ck["scenario_order"])!=SCENARIOS:
            raise RuntimeError(f"Scenario order mismatch: {ck['scenario_order']}")

        model=TimeXerV2Core4(
            cfg,
            float(ck["rain_log_mean"]),
            float(ck["rain_log_std"]),
            np.asarray(ck["correction_caps"],dtype=np.float32),
        )
        model.load_state_dict(ck["model_state_dict"],strict=True)
        model.eval()

        with torch.no_grad():
            scenarios,central,historical=model(
                torch.from_numpy(X),
                torch.from_numpy(R),
            )

        scenarios=scenarios.numpy()[0]   # [4,120]
        central=central.numpy()[0]       # [120]

        if scenarios.shape!=(4,120) or central.shape!=(120,):
            raise RuntimeError(f"Bad output shapes {scenarios.shape}, {central.shape}")
        if not np.isfinite(scenarios).all() or not np.isfinite(central).all():
            raise RuntimeError("NaN/Inf in model output.")

        # Do not silently publish negative flow.
        if (scenarios<0).any() or (central<0).any():
            raise RuntimeError("Negative Q forecast; investigate before publishing.")

        percentiles=np.quantile(
            scenarios,
            [0.00,0.10,0.25,0.50,0.75,0.90,1.00],
            axis=0,
        )

        ensemble_rows=[]
        scenario_rows=[]

        for j in range(120):
            ft=issue+pd.Timedelta(hours=j+1)

            ensemble_rows.append({
                "basin_id":BASIN_ID,
                "issue_time":iso(issue),
                "forecast_time":iso(ft),
                "lead_hour":j+1,
                "source":SOURCE,
                "model_version":MODEL_VERSION,
                "shadow_status":"SHADOW",
                "inflow_m3s":float(central[j]),
                "q_min":float(percentiles[0,j]),
                "q_p10":float(percentiles[1,j]),
                "q_p25":float(percentiles[2,j]),
                "q_p50":float(percentiles[3,j]),
                "q_p75":float(percentiles[4,j]),
                "q_p90":float(percentiles[5,j]),
                "q_max":float(percentiles[6,j]),
                "nwp_run_time":iso(nwp_run),
                "nwp_age_h":float(nwp_age),
                "scenario_count":4,
            })

            for sidx,scenario in enumerate(SCENARIOS):
                scenario_rows.append({
                    "basin_id":BASIN_ID,
                    "issue_time":iso(issue),
                    "forecast_time":iso(ft),
                    "lead_hour":j+1,
                    "scenario":scenario,
                    "q_forecast":float(scenarios[sidx,j]),
                    "model_version":MODEL_VERSION,
                    "nwp_run_time":iso(nwp_run),
                    "nwp_age_h":float(nwp_age),
                })

        if len(ensemble_rows)!=120 or len(scenario_rows)!=480:
            raise RuntimeError("Output row count guard failed.")

        sb.table("inflow_forecast_timexer_ensemble").upsert(
            ensemble_rows,
            on_conflict="basin_id,issue_time,forecast_time,source",
        ).execute()

        # Chunk scenario upsert.
        for i in range(0,len(scenario_rows),500):
            sb.table("inflow_forecast_timexer_scenario").upsert(
                scenario_rows[i:i+500],
                on_conflict="basin_id,issue_time,forecast_time,scenario",
            ).execute()

        runtime=time.time()-started

        log_run(
            sb,
            basin_id=BASIN_ID,
            model_version=MODEL_VERSION,
            source=SOURCE,
            status="OK",
            issue_time=iso(issue),
            input_start=iso(input_start),
            input_end=iso(input_end),
            nwp_run_time=iso(nwp_run),
            nwp_age_h=float(nwp_age),
            rows_written=120,
            runtime_sec=runtime,
            message="SHADOW ONLY",
        )

        print("="*100)
        print("TIMEXER CORE4 SHADOW OK")
        print("issue_time :",iso(issue))
        print("history    :",iso(input_start),"->",iso(input_end))
        print("nwp_run    :",iso(nwp_run),"age_h=",nwp_age)
        print("rows       : 120 ensemble + 480 scenarios")
        print("runtime_s  :",runtime)
        print("status     : SHADOW")
        print("="*100)

    except Exception as exc:
        runtime=time.time()-started
        log_run(
            sb,
            basin_id=BASIN_ID,
            model_version=MODEL_VERSION,
            source=SOURCE,
            status="FAIL",
            issue_time=iso(issue) if issue is not None else None,
            input_start=iso(input_start) if input_start is not None else None,
            input_end=iso(input_end) if input_end is not None else None,
            nwp_run_time=iso(nwp_run) if nwp_run is not None else None,
            nwp_age_h=float(nwp_age) if nwp_age is not None else None,
            rows_written=0,
            runtime_sec=runtime,
            message=str(exc)[:2000],
        )
        print("TIMEXER CORE4 SHADOW FAIL:",repr(exc),file=sys.stderr)
        raise


if __name__=="__main__":
    main()
