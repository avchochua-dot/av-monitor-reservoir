#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A VUONG - RANDOM FOREST LIVE PREDICTOR V2
==========================================

FIX QUAN TRỌNG SO VỚI V1:
- Không dùng lead_hour của run mưa để gán trực tiếp cho issue_time của Q.
- Mưa tương lai được căn theo forecast_time thực tế:
      observed issue_time + 1h ... +24h
- Nhờ vậy không lấy nhầm các giờ mưa đã nằm trong quá khứ so với thời điểm Q hiện tại.

Input:
1) public.reservoir_hourly_data
2) public.v_rainfall_basin_latest

Models:
  models/rf_v1/rf_h01.joblib
  models/rf_v1/rf_h03.joblib
  models/rf_v1/rf_h06.joblib
  models/rf_v1/rf_h12.joblib
  models/rf_v1/rf_h24.joblib

Output:
  public.inflow_forecast_ml

Đây vẫn là SHADOW forecast.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from supabase import create_client


# ============================================================
# 1. CONFIG
# ============================================================

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

RESERVOIR_ID = os.getenv("RESERVOIR_ID") or None

MODEL_DIR = Path(
    os.getenv(
        "RF_MODEL_DIR",
        "models/rf_v1"
    )
)

SOURCE = os.getenv(
    "RF_SOURCE",
    "rf_v1"
)

MODEL_VERSION = os.getenv(
    "RF_MODEL_VERSION",
    "RF_V1_PERFECT_RAIN"
)

LEADS = [1, 3, 6, 12, 24]

# Nếu forecast mưa cũ quá ngưỡng này thì dừng.
MAX_RAIN_RUN_AGE_HOURS = float(
    os.getenv(
        "MAX_RAIN_RUN_AGE_HOURS",
        "12"
    )
)

sb = create_client(
    SUPABASE_URL,
    SUPABASE_KEY
)


# ============================================================
# 2. HELPERS
# ============================================================

def antecedent_precipitation_index(
    series: pd.Series,
    hours: int,
    decay: float
) -> pd.Series:

    out = pd.Series(
        0.0,
        index=series.index
    )

    for i in range(hours):
        out = (
            out
            + series.shift(i)
            * (decay ** i)
        )

    return out


def num_or_none(value):
    if value is None or pd.isna(value):
        return None

    return float(value)


def iso_ts(value):
    return pd.Timestamp(value).isoformat()


# ============================================================
# 3. LOAD MODELS + METADATA
# ============================================================

def load_models():

    models = {}
    metas = {}

    for lead in LEADS:

        model_path = (
            MODEL_DIR
            / f"rf_h{lead:02d}.joblib"
        )

        meta_path = (
            MODEL_DIR
            / f"rf_h{lead:02d}_meta.json"
        )

        if not model_path.exists():
            raise FileNotFoundError(
                f"Missing model: {model_path}"
            )

        if not meta_path.exists():
            raise FileNotFoundError(
                f"Missing metadata: {meta_path}"
            )

        models[lead] = joblib.load(
            model_path
        )

        metas[lead] = json.loads(
            meta_path.read_text(
                encoding="utf-8"
            )
        )

    return models, metas


# ============================================================
# 4. FETCH OBSERVED Q/RAIN HISTORY
# ============================================================

def fetch_recent_observed():

    q = (
        sb.table(
            "reservoir_hourly_data"
        )
        .select(
            "time,inflow,rainfallreal,reservoir_id"
        )
        .order(
            "time",
            desc=True
        )
        .limit(180)
    )

    if RESERVOIR_ID:
        q = q.eq(
            "reservoir_id",
            RESERVOIR_ID
        )

    rows = q.execute().data or []

    if not rows:
        raise RuntimeError(
            "Không có dữ liệu reservoir_hourly_data."
        )

    df = pd.DataFrame(rows)

    reservoirs = (
        df["reservoir_id"]
        .dropna()
        .astype(str)
        .unique()
    )

    if (
        RESERVOIR_ID is None
        and len(reservoirs) > 1
    ):
        raise RuntimeError(
            "Có nhiều reservoir_id. "
            "Hãy cấu hình RESERVOIR_ID cho A Vương."
        )

    df["time"] = pd.to_datetime(
        df["time"],
        utc=True
    )

    df["inflow"] = pd.to_numeric(
        df["inflow"],
        errors="coerce"
    )

    df["rainfallreal"] = pd.to_numeric(
        df["rainfallreal"],
        errors="coerce"
    )

    df = (
        df.sort_values("time")
        .drop_duplicates(
            subset=["time"],
            keep="last"
        )
        .set_index("time")
    )

    full_index = pd.date_range(
        start=df.index.min().floor("h"),
        end=df.index.max().floor("h"),
        freq="1h",
        tz="UTC"
    )

    df = df.reindex(
        full_index
    )

    df.index.name = "time"

    # Đồng nhất với training:
    # chỉ nội suy gap rất ngắn.
    df["rainfallreal"] = (
        df["rainfallreal"]
        .interpolate(
            method="time",
            limit=2,
            limit_direction="both",
            limit_area="inside"
        )
    )

    df["inflow"] = (
        df["inflow"]
        .interpolate(
            method="time",
            limit=2,
            limit_direction="both",
            limit_area="inside"
        )
    )

    valid = df.dropna(
        subset=[
            "inflow",
            "rainfallreal"
        ]
    )

    if valid.empty:
        raise RuntimeError(
            "Không có timestamp valid cho Q/Rain."
        )

    issue_time = valid.index.max()

    df = df.loc[
        df.index <= issue_time
    ].copy()

    return df, issue_time


# ============================================================
# 5. OBSERVED FEATURES
# ============================================================

def build_observed_features(
    df: pd.DataFrame,
    issue_time: pd.Timestamp
):

    x = df.copy()

    x["q_now"] = x["inflow"]

    for h in [
        1, 2, 3, 6,
        12, 24, 48, 72
    ]:
        x[f"q_lag_{h}h"] = (
            x["inflow"].shift(h)
        )

    x["rain_1h"] = (
        x["rainfallreal"]
    )

    for h in [
        3, 6, 12,
        24, 48, 72
    ]:
        x[f"rain_past_{h}h"] = (
            x["rainfallreal"]
            .rolling(
                window=h,
                min_periods=h
            )
            .sum()
        )

    x["api24"] = (
        antecedent_precipitation_index(
            x["rainfallreal"],
            24,
            0.90
        )
    )

    x["api48"] = (
        antecedent_precipitation_index(
            x["rainfallreal"],
            48,
            0.94
        )
    )

    x["api72"] = (
        antecedent_precipitation_index(
            x["rainfallreal"],
            72,
            0.96
        )
    )

    for h in [
        1, 3, 6, 12
    ]:
        x[f"qtrend_{h}h"] = (
            x["inflow"]
            - x["inflow"].shift(h)
        )

    hour = x.index.hour
    month = x.index.month

    x["hour_sin"] = np.sin(
        2 * np.pi * hour / 24.0
    )

    x["hour_cos"] = np.cos(
        2 * np.pi * hour / 24.0
    )

    x["month_sin"] = np.sin(
        2 * np.pi * month / 12.0
    )

    x["month_cos"] = np.cos(
        2 * np.pi * month / 12.0
    )

    if issue_time not in x.index:
        raise RuntimeError(
            f"issue_time {issue_time} "
            f"không có trong feature table."
        )

    row = x.loc[
        issue_time
    ].copy()

    required = [
        "q_now",
        "q_lag_1h",
        "q_lag_2h",
        "q_lag_3h",
        "q_lag_6h",
        "q_lag_12h",
        "q_lag_24h",
        "q_lag_48h",
        "q_lag_72h",
        "rain_1h",
        "rain_past_3h",
        "rain_past_6h",
        "rain_past_12h",
        "rain_past_24h",
        "rain_past_48h",
        "rain_past_72h",
        "api24",
        "api48",
        "api72",
        "qtrend_1h",
        "qtrend_3h",
        "qtrend_6h",
        "qtrend_12h",
        "hour_sin",
        "hour_cos",
        "month_sin",
        "month_cos",
    ]

    missing = [
        col
        for col in required
        if pd.isna(
            row.get(
                col,
                np.nan
            )
        )
    ]

    if missing:
        raise RuntimeError(
            "Observed features bị thiếu: "
            + ", ".join(missing)
        )

    return row


# ============================================================
# 6. FETCH RAIN FORECAST
# ============================================================

def fetch_forecast_rain(
    issue_time: pd.Timestamp
):

    # Không lọc lead_hour <= 24 ở DB,
    # vì lead_hour là theo rainfall run,
    # không phải theo observed issue_time.
    rows = (
        sb.table(
            "v_rainfall_basin_latest"
        )
        .select(
            "run_time,"
            "forecast_time,"
            "lead_hour,"
            "rain_mean,"
            "model_count,"
            "quality"
        )
        .order(
            "forecast_time"
        )
        .execute()
        .data
        or []
    )

    if not rows:
        raise RuntimeError(
            "v_rainfall_basin_latest không có forecast."
        )

    df = pd.DataFrame(
        rows
    )

    df["run_time"] = pd.to_datetime(
        df["run_time"],
        utc=True
    )

    df["forecast_time"] = pd.to_datetime(
        df["forecast_time"],
        utc=True
    )

    df["rain_mean"] = pd.to_numeric(
        df["rain_mean"],
        errors="coerce"
    )

    df["model_count"] = pd.to_numeric(
        df["model_count"],
        errors="coerce"
    )

    if df["run_time"].nunique() != 1:
        raise RuntimeError(
            "Latest rainfall view chứa nhiều run_time."
        )

    rainfall_run_time = (
        df["run_time"].iloc[0]
    )

    # --------------------------------------------------------
    # STALENESS CHECK
    # --------------------------------------------------------

    run_age_hours = (
        issue_time
        - rainfall_run_time
    ).total_seconds() / 3600.0

    if run_age_hours < -1:
        raise RuntimeError(
            "Rainfall run_time nằm bất thường "
            "sau observed issue_time."
        )

    if (
        run_age_hours
        > MAX_RAIN_RUN_AGE_HOURS
    ):
        raise RuntimeError(
            f"Rainfall forecast quá cũ: "
            f"{run_age_hours:.1f}h > "
            f"{MAX_RAIN_RUN_AGE_HOURS:.1f}h."
        )

    # --------------------------------------------------------
    # CĂN FORECAST THEO issue_time CỦA Q
    # --------------------------------------------------------

    future = df[
        df["forecast_time"]
        > issue_time
    ].copy()

    future["relative_lead"] = (
        (
            future["forecast_time"]
            - issue_time
        )
        .dt.total_seconds()
        .div(3600.0)
        .round()
        .astype(int)
    )

    first24 = (
        future[
            future["relative_lead"]
            .between(
                1,
                24
            )
        ]
        .sort_values(
            "relative_lead"
        )
        .drop_duplicates(
            subset=[
                "relative_lead"
            ],
            keep="last"
        )
        .copy()
    )

    expected = set(
        range(
            1,
            25
        )
    )

    actual = set(
        first24[
            "relative_lead"
        ].astype(int)
    )

    missing = sorted(
        expected
        - actual
    )

    if missing:
        raise RuntimeError(
            "Mưa forecast không phủ đủ "
            "24h sau observed issue_time. "
            f"Thiếu relative lead: {missing}"
        )

    if (
        first24["rain_mean"]
        .isna()
        .any()
    ):
        bad = (
            first24.loc[
                first24["rain_mean"]
                .isna(),
                "relative_lead"
            ]
            .astype(int)
            .tolist()
        )

        raise RuntimeError(
            f"rain_mean NULL tại relative lead: {bad}"
        )

    min_models = (
        first24["model_count"]
        .fillna(0)
        .min()
    )

    if min_models < 4:
        raise RuntimeError(
            "Có forecast hour < 4 model. "
            "Không chạy RF live."
        )

    return (
        first24,
        rainfall_run_time,
        run_age_hours
    )


# ============================================================
# 7. FUTURE RAIN FEATURES
# ============================================================

def build_future_rain_features(
    rain_df: pd.DataFrame
):

    rain_by_lead = {
        int(r["relative_lead"]):
            float(r["rain_mean"])
        for _, r
        in rain_df.iterrows()
    }

    out = {}
    cumulative = 0.0

    for h in range(
        1,
        25
    ):
        cumulative += (
            rain_by_lead[h]
        )

        if h in [
            1, 3, 6, 12, 24
        ]:
            out[
                f"future_rain_{h}h"
            ] = cumulative

    return out


# ============================================================
# 8. PREDICT
# ============================================================

def predict_all(
    models,
    metas,
    observed_row,
    future_rain,
    issue_time,
    rain_df,
    rainfall_run_time
):

    outputs = []

    q_now = float(
        observed_row["q_now"]
    )

    quality_set = set(
        rain_df[
            "quality"
        ]
        .fillna("UNKNOWN")
        .astype(str)
    )

    if (
        quality_set
        == {"GOOD"}
    ):
        rain_quality = "GOOD"

    elif "BAD" in quality_set:
        rain_quality = "BAD"

    else:
        rain_quality = "PARTIAL"

    rain_model_count = int(
        rain_df[
            "model_count"
        ]
        .min()
    )

    for lead in LEADS:

        features = (
            metas[
                lead
            ][
                "features"
            ]
        )

        row = {}

        for feature in features:

            if feature.startswith(
                "future_rain_"
            ):
                row[feature] = (
                    future_rain[
                        feature
                    ]
                )

            else:
                if (
                    feature
                    not in observed_row.index
                ):
                    raise RuntimeError(
                        f"Thiếu observed feature: "
                        f"{feature}"
                    )

                row[feature] = (
                    observed_row[
                        feature
                    ]
                )

        X = pd.DataFrame(
            [row],
            columns=features
        )

        missing_cols = (
            X.columns[
                X.isna()
                .any()
            ]
            .tolist()
        )

        if missing_cols:
            raise RuntimeError(
                f"H{lead:02d} "
                f"feature NaN: "
                f"{missing_cols}"
            )

        q_pred = float(
            models[
                lead
            ].predict(
                X
            )[0]
        )

        # Guard vật lý cơ bản
        q_pred = max(
            0.0,
            q_pred
        )

        forecast_time = (
            issue_time
            + pd.Timedelta(
                hours=lead
            )
        )

        outputs.append({
            "issue_time":
                iso_ts(
                    issue_time
                ),

            "forecast_time":
                iso_ts(
                    forecast_time
                ),

            "lead_hour":
                lead,

            "source":
                SOURCE,

            "model_version":
                MODEL_VERSION,

            "q_now":
                q_now,

            "q_forecast":
                q_pred,

            "future_rain_1h":
                num_or_none(
                    future_rain.get(
                        "future_rain_1h"
                    )
                ),

            "future_rain_3h":
                num_or_none(
                    future_rain.get(
                        "future_rain_3h"
                    )
                ),

            "future_rain_6h":
                num_or_none(
                    future_rain.get(
                        "future_rain_6h"
                    )
                ),

            "future_rain_12h":
                num_or_none(
                    future_rain.get(
                        "future_rain_12h"
                    )
                ),

            "future_rain_24h":
                num_or_none(
                    future_rain.get(
                        "future_rain_24h"
                    )
                ),

            "rainfall_run_time":
                iso_ts(
                    rainfall_run_time
                ),

            "rainfall_quality":
                rain_quality,

            "rainfall_model_count":
                rain_model_count,
        })

    return outputs


# ============================================================
# 9. WRITE SUPABASE
# ============================================================

def upsert_predictions(
    outputs
):

    (
        sb.table(
            "inflow_forecast_ml"
        )
        .upsert(
            outputs,
            on_conflict=(
                "issue_time,"
                "lead_hour,"
                "source,"
                "model_version"
            )
        )
        .execute()
    )


# ============================================================
# 10. MAIN
# ============================================================

def main():

    print("=" * 76)
    print(
        "A VUONG RF V1 "
        "- LIVE PREDICTOR V2"
    )
    print("=" * 76)

    models, metas = (
        load_models()
    )

    observed_df, issue_time = (
        fetch_recent_observed()
    )

    observed_row = (
        build_observed_features(
            observed_df,
            issue_time
        )
    )

    (
        rain_df,
        rainfall_run_time,
        run_age_hours
    ) = fetch_forecast_rain(
        issue_time
    )

    future_rain = (
        build_future_rain_features(
            rain_df
        )
    )

    print(
        "Observed issue_time :",
        issue_time
    )

    print(
        "Q now               :",
        round(
            float(
                observed_row[
                    "q_now"
                ]
            ),
            3
        )
    )

    print(
        "Rain forecast run   :",
        rainfall_run_time
    )

    print(
        "Rain run age        :",
        f"{run_age_hours:.1f} h"
    )

    print(
        "Rain valid from     :",
        rain_df[
            "forecast_time"
        ].min()
    )

    print(
        "Rain valid to       :",
        rain_df[
            "forecast_time"
        ].max()
    )

    print(
        "Future rain         :",
        {
            k: round(
                v,
                3
            )
            for k, v
            in future_rain.items()
        }
    )

    outputs = predict_all(
        models=models,
        metas=metas,
        observed_row=observed_row,
        future_rain=future_rain,
        issue_time=issue_time,
        rain_df=rain_df,
        rainfall_run_time=rainfall_run_time
    )

    preview = pd.DataFrame(
        outputs
    )[
        [
            "lead_hour",
            "forecast_time",
            "q_now",
            "q_forecast",
            "future_rain_1h",
            "future_rain_3h",
            "future_rain_6h",
            "future_rain_12h",
            "future_rain_24h",
            "rainfall_quality",
        ]
    ]

    print(
        "\n===== RF FORECAST ====="
    )

    print(
        preview
        .round(3)
        .to_string(
            index=False
        )
    )

    upsert_predictions(
        outputs
    )

    print(
        f"\nUploaded "
        f"{len(outputs)} "
        f"RF forecasts to "
        f"inflow_forecast_ml."
    )

    print("=" * 76)


if __name__ == "__main__":
    main()
