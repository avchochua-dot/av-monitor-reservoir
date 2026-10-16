#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Incrementally verifies TimeXer shadow forecasts against reservoir_hourly_data.
Creates/uses forecast_shadow_eval_timeXer separately so existing evaluator is untouched.
"""

from __future__ import annotations
import os
import numpy as np
import pandas as pd
from supabase import create_client

BASIN_ID="AVUONG"
SOURCE="timexer_h120_v2_core4_shadow"

def main():
    sb=create_client(os.environ["SUPABASE_URL"],os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    fc=(sb.table("inflow_forecast_timexer_ensemble")
          .select("basin_id,issue_time,forecast_time,lead_hour,source,model_version,inflow_m3s")
          .eq("basin_id",BASIN_ID)
          .eq("source",SOURCE)
          .lte("forecast_time",pd.Timestamp.now(tz="UTC").isoformat())
          .order("forecast_time")
          .limit(1000)
          .execute().data or [])

    if not fc:
        print("No matured TimeXer forecasts.")
        return

    t0=min(x["forecast_time"] for x in fc)
    t1=max(x["forecast_time"] for x in fc)

    obs=(sb.table("reservoir_hourly_data")
           .select("time,inflow")
           .gte("time",t0)
           .lte("time",t1)
           .order("time")
           .execute().data or [])

    omap={pd.Timestamp(x["time"]).isoformat(): x["inflow"] for x in obs if x.get("inflow") is not None}

    rows=[]
    for r in fc:
        key=pd.Timestamp(r["forecast_time"]).isoformat()
        qobs=omap.get(key)
        if qobs is None:
            continue
        pred=float(r["inflow_m3s"]); qobs=float(qobs); err=pred-qobs
        rows.append({
            "basin_id":r["basin_id"],
            "issue_time":r["issue_time"],
            "forecast_time":r["forecast_time"],
            "lead_hour":r["lead_hour"],
            "source":r["source"],
            "model_version":r["model_version"],
            "q_forecast":pred,
            "q_observed":qobs,
            "error":err,
            "abs_error":abs(err),
            "squared_error":err*err,
        })

    if rows:
        sb.table("forecast_shadow_eval_timexer").upsert(
            rows,
            on_conflict="basin_id,issue_time,forecast_time,source",
        ).execute()

    print("Verified rows:",len(rows))

if __name__=="__main__":
    main()
