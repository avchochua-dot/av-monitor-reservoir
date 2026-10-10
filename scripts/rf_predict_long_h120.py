#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A VUONG - LONG HORIZON LIVE PREDICTOR H01 -> H120
==================================================

Kiến trúc:
- 01 model tree-based Long-Horizon:
    models/long_h120/long_h120.joblib
- 06 scenario mưa:
    ECMWF_IFS / GFS / ICON / ECMWF_AIFS / CMA_GRAPES / JMA_GSM
- 120 lead giờ:
    H01 ... H120
- Mỗi run sinh:
    720 dòng scenario
    120 dòng ensemble

Input Supabase:
1) public.reservoir_hourly_data
   - time
   - inflow
   - rainfallreal
   - reservoir_id

2) public.v_rainfall_basin_latest
   - run_time
   - forecast_time
   - rain_ecmwf
   - rain_gfs
   - rain_icon
   - rain_aifs
   - rain_cma
   - rain_jma
   - model_count
   - quality

Output Supabase:
1) public.inflow_forecast_long_scenario
2) public.inflow_forecast_long_ensemble

Ensemble:
- q_mean
- q_median (P50)
- q_p10
- q_p90
- q_min
- q_max

QUAN TRỌNG:
- Model hiện tại được train bằng "perfect future rain".
- Khi live, cùng model được chạy 6 lần bằng 6 chuỗi mưa NWP khác nhau.
- Đây là production candidate/shadow model, chưa tự động thay Mixed/V26.4B.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Tuple

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
        "LONG_MODEL_DIR",
        "models/long_h120",
    )
)

MODEL_FILE = MODEL_DIR / "long_h120.joblib"
META_FILE = MODEL_DIR / "long_h120_meta.json"

SOURCE = os.getenv(
    "LONG_SOURCE",
    "long_h120",
)

MODEL_VERSION = os.getenv(
    "LONG_MODEL_VERSION",
    "LONG_H120_V1_PERFECT_RAIN",
)

MAX_LEAD = int(
    os.getenv(
        "LONG_MAX_LEAD",
        "120",
    )
)

MAX_RAIN_RUN_AGE_HOURS = float(
    os.getenv(
        "MAX_RAIN_RUN_AGE_HOURS",
        "12",
    )
)

# Lấy đủ lịch sử cho lag/API72 + buffer.
OBS_HISTORY_LIMIT = int(
    os.getenv(
        "LONG_OBS_HISTORY_LIMIT",
        "200",
    )
)

SCENARIO_TABLE = (
    "inflow_forecast_long_scenario"
)

ENSEMBLE_TABLE = (
    "inflow_forecast_long_ensemble"
)

RAIN_VIEW = (
    "v_rainfall_basin_latest"
)

OBS_TABLE = (
    "reservoir_hourly_data"
)

# Tên scenario -> cột mưa trong view.
RAIN_SCENARIOS = {
    "ECMWF_IFS": "rain_ecmwf",
    "GFS": "rain_gfs",
    "ICON": "rain_icon",
    "ECMWF_AIFS": "rain_aifs",
    "CMA_GRAPES": "rain_cma",
    "JMA_GSM": "rain_jma",
}

sb = create_client(
    SUPABASE_URL,
    SUPABASE_KEY,
)


# ============================================================
# 2. HELPERS
# ============================================================

def iso_ts(value) -> str:
    return pd.Timestamp(
        value
    ).isoformat()


def num_or_none(value):
    if (
        value is None
        or pd.isna(value)
    ):
        return None

    return float(value)


def worst_quality(
    values: pd.Series,
) -> str:

    vals = set(
        values
        .fillna("UNKNOWN")
        .astype(str)
        .str.upper()
        .tolist()
    )

    if not vals:
        return "UNKNOWN"

    if vals == {"GOOD"}:
        return "GOOD"

    if "BAD" in vals:
        return "BAD"

    return "PARTIAL"


def chunked(
    rows: List[dict],
    size: int = 500,
):
    for i in range(
        0,
        len(rows),
        size,
    ):
        yield rows[
            i:i + size
        ]


# ============================================================
# 3. LOAD MODEL + META
# ============================================================

def load_model():

    if not MODEL_FILE.exists():
        raise FileNotFoundError(
            f"Missing model: {MODEL_FILE}"
        )

    if not META_FILE.exists():
        raise FileNotFoundError(
            f"Missing metadata: {META_FILE}"
        )

    model = joblib.load(
        MODEL_FILE
    )

    meta = json.loads(
        META_FILE.read_text(
            encoding="utf-8"
        )
    )

    features = meta.get(
        "features",
        [],
    )

    if not features:
        raise RuntimeError(
            "long_h120_meta.json không có features."
        )

    meta_max_lead = int(
        meta.get(
            "max_lead_hour",
            MAX_LEAD,
        )
    )

    if meta_max_lead != MAX_LEAD:
        raise RuntimeError(
            f"MAX_LEAD mismatch: "
            f"runtime={MAX_LEAD}, "
            f"model={meta_max_lead}"
        )

    print(
        "Model              :",
        MODEL_FILE,
    )

    print(
        "Model version      :",
        meta.get(
            "version",
            MODEL_VERSION,
        ),
    )

    print(
        "Features           :",
        len(features),
    )

    return (
        model,
        meta,
        features,
    )


# ============================================================
# 4. OBSERVED HISTORY
# ============================================================

def fetch_recent_observed():

    q = (
        sb.table(
            OBS_TABLE
        )
        .select(
            "time,inflow,rainfallreal,reservoir_id"
        )
        .order(
            "time",
            desc=True,
        )
        .limit(
            OBS_HISTORY_LIMIT
        )
    )

    if RESERVOIR_ID:
        q = q.eq(
            "reservoir_id",
            RESERVOIR_ID,
        )

    rows = (
        q.execute().data
        or []
    )

    if not rows:
        raise RuntimeError(
            f"{OBS_TABLE} không có dữ liệu."
        )

    df = pd.DataFrame(
        rows
    )

    reservoirs = (
        df[
            "reservoir_id"
        ]
        .dropna()
        .astype(str)
        .unique()
    )

    if (
        RESERVOIR_ID is None
        and len(reservoirs) > 1
    ):
        raise RuntimeError(
            "reservoir_hourly_data có nhiều reservoir_id. "
            "Hãy tạo secret RESERVOIR_ID cho A Vương."
        )

    df["time"] = pd.to_datetime(
        df["time"],
        utc=True,
    )

    df["inflow"] = pd.to_numeric(
        df["inflow"],
        errors="coerce",
    )

    df["rainfallreal"] = pd.to_numeric(
        df["rainfallreal"],
        errors="coerce",
    )

    df = (
        df.sort_values(
            "time"
        )
        .drop_duplicates(
            subset=["time"],
            keep="last",
        )
        .set_index(
            "time"
        )
    )

    full_index = pd.date_range(
        start=(
            df.index
            .min()
            .floor("h")
        ),
        end=(
            df.index
            .max()
            .floor("h")
        ),
        freq="1h",
        tz="UTC",
    )

    df = df.reindex(
        full_index
    )

    df.index.name = "time"

    # Đồng nhất với training:
    # chỉ nội suy gap rất ngắn <=2h.
    df["rainfallreal"] = (
        df["rainfallreal"]
        .interpolate(
            method="time",
            limit=2,
            limit_direction="both",
            limit_area="inside",
        )
    )

    df["inflow"] = (
        df["inflow"]
        .interpolate(
            method="time",
            limit=2,
            limit_direction="both",
            limit_area="inside",
        )
    )

    # issue_time mới nhất có đủ Q và Rain thực.
    valid = (
        df.dropna(
            subset=[
                "inflow",
                "rainfallreal",
            ]
        )
    )

    if valid.empty:
        raise RuntimeError(
            "Không có timestamp valid cho Q/Rain."
        )

    issue_time = (
        valid.index.max()
    )

    df = (
        df.loc[
            df.index
            <= issue_time
        ]
        .copy()
    )

    return (
        df,
        issue_time,
    )


# ============================================================
# 5. COMMON FEATURES
# ============================================================

def antecedent_precipitation_index(
    series: pd.Series,
    hours: int,
    decay: float,
) -> pd.Series:

    out = pd.Series(
        0.0,
        index=series.index,
    )

    for i in range(
        hours
    ):
        out = (
            out
            + series.shift(i)
            * (decay ** i)
        )

    return out


def build_observed_features(
    df: pd.DataFrame,
    issue_time: pd.Timestamp,
) -> pd.Series:

    x = df.copy()

    x["q_now"] = (
        x["inflow"]
    )

    for h in [
        1, 2, 3,
        6, 12, 24,
        48, 72,
    ]:
        x[
            f"q_lag_{h}h"
        ] = (
            x["inflow"]
            .shift(h)
        )

    x["rain_1h"] = (
        x["rainfallreal"]
    )

    for h in [
        3, 6, 12,
        24, 48, 72,
    ]:
        x[
            f"rain_past_{h}h"
        ] = (
            x[
                "rainfallreal"
            ]
            .rolling(
                window=h,
                min_periods=h,
            )
            .sum()
        )

    x["api24"] = (
        antecedent_precipitation_index(
            x[
                "rainfallreal"
            ],
            24,
            0.90,
        )
    )

    x["api48"] = (
        antecedent_precipitation_index(
            x[
                "rainfallreal"
            ],
            48,
            0.94,
        )
    )

    x["api72"] = (
        antecedent_precipitation_index(
            x[
                "rainfallreal"
            ],
            72,
            0.96,
        )
    )

    for h in [
        1, 3, 6, 12,
    ]:
        x[
            f"qtrend_{h}h"
        ] = (
            x["inflow"]
            - x["inflow"]
            .shift(h)
        )

    hour = (
        x.index.hour
    )

    month = (
        x.index.month
    )

    x["hour_sin"] = (
        np.sin(
            2
            * np.pi
            * hour
            / 24.0
        )
    )

    x["hour_cos"] = (
        np.cos(
            2
            * np.pi
            * hour
            / 24.0
        )
    )

    x["month_sin"] = (
        np.sin(
            2
            * np.pi
            * month
            / 12.0
        )
    )

    x["month_cos"] = (
        np.cos(
            2
            * np.pi
            * month
            / 12.0
        )
    )

    if issue_time not in x.index:
        raise RuntimeError(
            "issue_time không có trong feature table."
        )

    row = (
        x.loc[
            issue_time
        ]
        .copy()
    )

    return row


# ============================================================
# 6. FETCH + ALIGN 120H RAINFALL
# ============================================================

def fetch_rainfall_120h(
    issue_time: pd.Timestamp,
):

    select_cols = (
        "run_time,"
        "forecast_time,"
        "lead_hour,"
        "rain_ecmwf,"
        "rain_gfs,"
        "rain_icon,"
        "rain_aifs,"
        "rain_cma,"
        "rain_jma,"
        "rain_mean,"
        "model_count,"
        "quality"
    )

    rows = (
        sb.table(
            RAIN_VIEW
        )
        .select(
            select_cols
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
            f"{RAIN_VIEW} không có dữ liệu."
        )

    df = pd.DataFrame(
        rows
    )

    df["run_time"] = pd.to_datetime(
        df["run_time"],
        utc=True,
    )

    df["forecast_time"] = pd.to_datetime(
        df["forecast_time"],
        utc=True,
    )

    numeric_cols = [
        "rain_ecmwf",
        "rain_gfs",
        "rain_icon",
        "rain_aifs",
        "rain_cma",
        "rain_jma",
        "rain_mean",
        "model_count",
    ]

    for col in numeric_cols:
        df[col] = pd.to_numeric(
            df[col],
            errors="coerce",
        )

    if (
        df[
            "run_time"
        ].nunique()
        != 1
    ):
        raise RuntimeError(
            "v_rainfall_basin_latest chứa nhiều run_time."
        )

    rainfall_run_time = (
        df[
            "run_time"
        ].iloc[0]
    )

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
            f"Rain forecast quá cũ: "
            f"{run_age_hours:.1f}h > "
            f"{MAX_RAIN_RUN_AGE_HOURS:.1f}h"
        )

    # Căn theo issue_time của Q,
    # không dùng lead_hour gốc của rainfall run.
    future = (
        df[
            df[
                "forecast_time"
            ]
            > issue_time
        ]
        .copy()
    )

    future[
        "relative_lead"
    ] = (
        (
            future[
                "forecast_time"
            ]
            - issue_time
        )
        .dt.total_seconds()
        .div(3600.0)
        .round()
        .astype(int)
    )

    future = (
        future[
            future[
                "relative_lead"
            ]
            .between(
                1,
                MAX_LEAD,
            )
        ]
        .sort_values(
            "relative_lead"
        )
        .drop_duplicates(
            subset=[
                "relative_lead"
            ],
            keep="last",
        )
        .copy()
    )

    expected = set(
        range(
            1,
            MAX_LEAD + 1,
        )
    )

    actual = set(
        future[
            "relative_lead"
        ]
        .astype(int)
        .tolist()
    )

    missing_leads = sorted(
        expected
        - actual
    )

    if missing_leads:
        raise RuntimeError(
            "Rain forecast không phủ đủ H01-H120. "
            f"Thiếu relative lead: {missing_leads[:20]}"
            + (
                " ..."
                if len(
                    missing_leads
                ) > 20
                else ""
            )
        )

    # Bắt buộc đủ 6 scenario cho bước V1 production candidate.
    missing_by_model = {}

    for (
        scenario,
        col,
    ) in RAIN_SCENARIOS.items():

        bad = (
            future[
                future[col]
                .isna()
            ][
                "relative_lead"
            ]
            .astype(int)
            .tolist()
        )

        if bad:
            missing_by_model[
                scenario
            ] = bad

    if missing_by_model:
        details = "; ".join(
            f"{k}: {v[:10]}"
            for k, v
            in missing_by_model.items()
        )

        raise RuntimeError(
            "Thiếu rainfall scenario data. "
            + details
        )

    min_model_count = int(
        future[
            "model_count"
        ]
        .fillna(0)
        .min()
    )

    if min_model_count < 6:
        raise RuntimeError(
            f"model_count min={min_model_count}. "
            "Long-H120 V1 yêu cầu đủ 6 mô hình."
        )

    quality = (
        worst_quality(
            future[
                "quality"
            ]
        )
    )

    if quality == "BAD":
        raise RuntimeError(
            "Rainfall QC = BAD. Không chạy Long-H120."
        )

    return (
        future,
        rainfall_run_time,
        run_age_hours,
        quality,
        min_model_count,
    )


# ============================================================
# 7. FUTURE RAIN FEATURES - SAME AS TRAIN
# ============================================================

RAIN_BLOCKS = [
    (1, 6, "rain_f_01_06h"),
    (7, 12, "rain_f_07_12h"),
    (13, 24, "rain_f_13_24h"),
    (25, 48, "rain_f_25_48h"),
    (49, 72, "rain_f_49_72h"),
    (73, 96, "rain_f_73_96h"),
    (97, 120, "rain_f_97_120h"),
]


def cumulative_sum(
    rain: np.ndarray,
) -> np.ndarray:

    if (
        len(rain)
        != MAX_LEAD
    ):
        raise RuntimeError(
            f"Rain vector length "
            f"{len(rain)} != {MAX_LEAD}"
        )

    if not np.isfinite(
        rain
    ).all():
        raise RuntimeError(
            "Rain vector có NaN/Inf."
        )

    return np.cumsum(
        rain.astype(
            np.float64
        )
    )


def last_window_sum(
    cum: np.ndarray,
    lead: int,
    hours: int,
) -> float:

    end_idx = (
        lead - 1
    )

    start_lead = max(
        0,
        lead - hours,
    )

    value = float(
        cum[
            end_idx
        ]
    )

    if start_lead > 0:
        value -= float(
            cum[
                start_lead - 1
            ]
        )

    return value


def block_sum_until_lead(
    cum: np.ndarray,
    lead: int,
    block_start: int,
    block_end: int,
) -> float:

    if lead < block_start:
        return 0.0

    actual_end = min(
        lead,
        block_end,
    )

    value = float(
        cum[
            actual_end - 1
        ]
    )

    if block_start > 1:
        value -= float(
            cum[
                block_start - 2
            ]
        )

    return value


def build_scenario_feature_frame(
    observed_row: pd.Series,
    issue_time: pd.Timestamp,
    rain_vector: np.ndarray,
    feature_order: List[str],
) -> pd.DataFrame:

    cum = cumulative_sum(
        rain_vector
    )

    running_max = (
        np.maximum.accumulate(
            rain_vector
        )
    )

    rows = []

    for lead in range(
        1,
        MAX_LEAD + 1,
    ):

        forecast_time = (
            issue_time
            + pd.Timedelta(
                hours=lead
            )
        )

        row = {}

        # -----------------------------------------
        # Common observed features
        # -----------------------------------------

        for feature in feature_order:

            if feature in observed_row.index:
                row[
                    feature
                ] = float(
                    observed_row[
                        feature
                    ]
                )

        # -----------------------------------------
        # Lead features
        # -----------------------------------------

        row[
            "lead_hour"
        ] = float(
            lead
        )

        row[
            "lead_frac"
        ] = float(
            lead
            / MAX_LEAD
        )

        row[
            "lead_log1p"
        ] = float(
            np.log1p(
                lead
            )
        )

        # -----------------------------------------
        # Target-time cyclic
        # -----------------------------------------

        h = (
            forecast_time.hour
        )

        m = (
            forecast_time.month
        )

        row[
            "target_hour_sin"
        ] = float(
            np.sin(
                2
                * np.pi
                * h
                / 24.0
            )
        )

        row[
            "target_hour_cos"
        ] = float(
            np.cos(
                2
                * np.pi
                * h
                / 24.0
            )
        )

        row[
            "target_month_sin"
        ] = float(
            np.sin(
                2
                * np.pi
                * m
                / 12.0
            )
        )

        row[
            "target_month_cos"
        ] = float(
            np.cos(
                2
                * np.pi
                * m
                / 12.0
            )
        )

        # -----------------------------------------
        # Future rain features
        # Chỉ dùng H01..Hlead.
        # -----------------------------------------

        cum_to_lead = float(
            cum[
                lead - 1
            ]
        )

        row[
            "future_rain_cum_to_lead"
        ] = cum_to_lead

        row[
            "future_rain_last_1h"
        ] = float(
            rain_vector[
                lead - 1
            ]
        )

        row[
            "future_rain_last_3h"
        ] = (
            last_window_sum(
                cum,
                lead,
                3,
            )
        )

        row[
            "future_rain_last_6h"
        ] = (
            last_window_sum(
                cum,
                lead,
                6,
            )
        )

        row[
            "future_rain_last_12h"
        ] = (
            last_window_sum(
                cum,
                lead,
                12,
            )
        )

        row[
            "future_rain_last_24h"
        ] = (
            last_window_sum(
                cum,
                lead,
                24,
            )
        )

        row[
            "future_rain_max_1h_to_lead"
        ] = float(
            running_max[
                lead - 1
            ]
        )

        row[
            "future_rain_mean_to_lead"
        ] = float(
            cum_to_lead
            / lead
        )

        for (
            block_start,
            block_end,
            block_name,
        ) in RAIN_BLOCKS:

            row[
                block_name
            ] = (
                block_sum_until_lead(
                    cum,
                    lead,
                    block_start,
                    block_end,
                )
            )

        # -----------------------------------------
        # Exact feature order from model metadata.
        # -----------------------------------------

        final_row = {}

        for feature in (
            feature_order
        ):

            if feature not in row:
                raise RuntimeError(
                    f"Không tạo được feature: {feature}"
                )

            value = row[
                feature
            ]

            if not np.isfinite(
                value
            ):
                raise RuntimeError(
                    f"Feature {feature} "
                    f"NaN/Inf tại H{lead:03d}"
                )

            final_row[
                feature
            ] = float(
                value
            )

        rows.append(
            final_row
        )

    X = pd.DataFrame(
        rows,
        columns=feature_order,
    )

    return X


# ============================================================
# 8. RUN 6 SCENARIOS
# ============================================================

def run_scenarios(
    model,
    features: List[str],
    observed_row: pd.Series,
    issue_time: pd.Timestamp,
    rain_df: pd.DataFrame,
    rainfall_run_time: pd.Timestamp,
    rainfall_quality: str,
    rainfall_model_count: int,
):

    q_now = float(
        observed_row[
            "q_now"
        ]
    )

    # relative_lead -> row
    rain_df = (
        rain_df
        .sort_values(
            "relative_lead"
        )
        .reset_index(
            drop=True
        )
    )

    scenario_rows = []

    forecast_matrix = {}

    for (
        scenario_name,
        rain_col,
    ) in RAIN_SCENARIOS.items():

        print(
            f"Predicting scenario "
            f"{scenario_name} ..."
        )

        rain_vector = (
            rain_df[
                rain_col
            ]
            .to_numpy(
                dtype=float
            )
        )

        if (
            len(
                rain_vector
            )
            != MAX_LEAD
        ):
            raise RuntimeError(
                f"{scenario_name}: "
                f"rain vector != {MAX_LEAD}"
            )

        X = (
            build_scenario_feature_frame(
                observed_row=(
                    observed_row
                ),
                issue_time=(
                    issue_time
                ),
                rain_vector=(
                    rain_vector
                ),
                feature_order=(
                    features
                ),
            )
        )

        pred = (
            model.predict(
                X
            )
        )

        pred = np.maximum(
            np.asarray(
                pred,
                dtype=float,
            ),
            0.0,
        )

        if (
            len(pred)
            != MAX_LEAD
        ):
            raise RuntimeError(
                f"{scenario_name}: "
                "prediction length sai."
            )

        forecast_matrix[
            scenario_name
        ] = pred

        cum = (
            np.cumsum(
                rain_vector
            )
        )

        for lead in range(
            1,
            MAX_LEAD + 1,
        ):

            forecast_time = (
                issue_time
                + pd.Timedelta(
                    hours=lead
                )
            )

            scenario_rows.append({
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

                "rain_model":
                    scenario_name,

                "source":
                    SOURCE,

                "model_version":
                    MODEL_VERSION,

                "q_now":
                    q_now,

                "q_forecast":
                    float(
                        pred[
                            lead - 1
                        ]
                    ),

                "rain_cum_to_lead":
                    float(
                        cum[
                            lead - 1
                        ]
                    ),

                "rain_target_hour":
                    float(
                        rain_vector[
                            lead - 1
                        ]
                    ),

                "rainfall_run_time":
                    iso_ts(
                        rainfall_run_time
                    ),

                "rainfall_quality":
                    rainfall_quality,

                "rainfall_model_count":
                    rainfall_model_count,
            })

    return (
        scenario_rows,
        forecast_matrix,
    )


# ============================================================
# 9. ENSEMBLE P10/P50/P90
# ============================================================

def build_ensemble_rows(
    forecast_matrix: Dict[
        str,
        np.ndarray,
    ],
    observed_row: pd.Series,
    issue_time: pd.Timestamp,
    rainfall_run_time: pd.Timestamp,
    rainfall_quality: str,
    rainfall_model_count: int,
):

    scenario_names = list(
        forecast_matrix.keys()
    )

    if len(
        scenario_names
    ) != 6:
        raise RuntimeError(
            f"Scenario count = "
            f"{len(scenario_names)}, "
            "yêu cầu 6."
        )

    matrix = np.vstack(
        [
            forecast_matrix[
                name
            ]
            for name in scenario_names
        ]
    )

    # shape = 6 x 120
    if matrix.shape != (
        6,
        MAX_LEAD,
    ):
        raise RuntimeError(
            f"Forecast matrix shape "
            f"{matrix.shape} không hợp lệ."
        )

    q_now = float(
        observed_row[
            "q_now"
        ]
    )

    rows = []

    for lead in range(
        1,
        MAX_LEAD + 1,
    ):

        values = (
            matrix[
                :,
                lead - 1
            ]
        )

        values = (
            values[
                np.isfinite(
                    values
                )
            ]
        )

        if len(values) < 6:
            raise RuntimeError(
                f"H{lead:03d}: "
                f"chỉ có {len(values)} scenario."
            )

        q_mean = float(
            np.mean(
                values
            )
        )

        q_median = float(
            np.median(
                values
            )
        )

        # numpy linear percentile.
        q_p10 = float(
            np.percentile(
                values,
                10,
            )
        )

        q_p90 = float(
            np.percentile(
                values,
                90,
            )
        )

        q_min = float(
            np.min(
                values
            )
        )

        q_max = float(
            np.max(
                values
            )
        )

        # Bảo đảm constraint do floating.
        q_p10 = max(
            q_min,
            min(
                q_p10,
                q_median,
            )
        )

        q_p90 = min(
            q_max,
            max(
                q_p90,
                q_median,
            )
        )

        forecast_time = (
            issue_time
            + pd.Timedelta(
                hours=lead
            )
        )

        rows.append({
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

            "q_mean":
                q_mean,

            "q_median":
                q_median,

            "q_p10":
                q_p10,

            "q_p90":
                q_p90,

            "q_min":
                q_min,

            "q_max":
                q_max,

            "scenario_count":
                int(
                    len(values)
                ),

            "rainfall_run_time":
                iso_ts(
                    rainfall_run_time
                ),

            "rainfall_quality":
                rainfall_quality,

            "rainfall_model_count":
                rainfall_model_count,
        })

    return rows


# ============================================================
# 10. WRITE SUPABASE
# ============================================================

def upsert_rows(
    table_name: str,
    rows: List[dict],
    conflict_key: str,
):

    total = 0

    for batch in chunked(
        rows,
        400,
    ):

        (
            sb.table(
                table_name
            )
            .upsert(
                batch,
                on_conflict=(
                    conflict_key
                ),
            )
            .execute()
        )

        total += len(
            batch
        )

    return total


# ============================================================
# 11. QC PRINT
# ============================================================

def print_preview(
    ensemble_rows: List[dict],
    forecast_matrix: Dict[
        str,
        np.ndarray,
    ],
):

    selected = [
        1, 3, 6, 12,
        24, 48, 72,
        96, 120,
    ]

    df = pd.DataFrame(
        ensemble_rows
    )

    df = (
        df[
            df[
                "lead_hour"
            ].isin(
                selected
            )
        ][
            [
                "lead_hour",
                "forecast_time",
                "q_median",
                "q_p10",
                "q_p90",
                "q_min",
                "q_max",
                "scenario_count",
            ]
        ]
    )

    print(
        "\n===== LONG-H120 ENSEMBLE PREVIEW ====="
    )

    print(
        df.round(3)
        .to_string(
            index=False
        )
    )

    print(
        "\n===== SCENARIO Q AT H24/H72/H120 ====="
    )

    for lead in [
        24,
        72,
        120,
    ]:

        vals = {
            name:
                round(
                    float(
                        arr[
                            lead - 1
                        ]
                    ),
                    3,
                )
            for (
                name,
                arr,
            )
            in forecast_matrix.items()
        }

        print(
            f"H{lead:03d}:",
            vals,
        )


# ============================================================
# 12. MAIN
# ============================================================

def main():

    print(
        "=" * 78
    )

    print(
        "A VUONG LONG-HORIZON LIVE "
        "PREDICTOR H01 -> H120"
    )

    print(
        "=" * 78
    )

    (
        model,
        meta,
        features,
    ) = load_model()

    (
        observed_df,
        issue_time,
    ) = fetch_recent_observed()

    observed_row = (
        build_observed_features(
            observed_df,
            issue_time,
        )
    )

    q_now = float(
        observed_row[
            "q_now"
        ]
    )

    (
        rain_df,
        rainfall_run_time,
        rain_run_age,
        rainfall_quality,
        rainfall_model_count,
    ) = fetch_rainfall_120h(
        issue_time
    )

    print(
        "Observed issue_time :",
        issue_time,
    )

    print(
        "Q now               :",
        round(
            q_now,
            3,
        ),
    )

    print(
        "Rain forecast run   :",
        rainfall_run_time,
    )

    print(
        "Rain run age        :",
        f"{rain_run_age:.1f} h",
    )

    print(
        "Rain relative lead  :",
        int(
            rain_df[
                "relative_lead"
            ].min()
        ),
        "->",
        int(
            rain_df[
                "relative_lead"
            ].max()
        ),
    )

    print(
        "Rain QC             :",
        rainfall_quality,
    )

    print(
        "Rain model_count min:",
        rainfall_model_count,
    )

    (
        scenario_rows,
        forecast_matrix,
    ) = run_scenarios(
        model=model,
        features=features,
        observed_row=observed_row,
        issue_time=issue_time,
        rain_df=rain_df,
        rainfall_run_time=rainfall_run_time,
        rainfall_quality=rainfall_quality,
        rainfall_model_count=rainfall_model_count,
    )

    ensemble_rows = (
        build_ensemble_rows(
            forecast_matrix=(
                forecast_matrix
            ),
            observed_row=(
                observed_row
            ),
            issue_time=(
                issue_time
            ),
            rainfall_run_time=(
                rainfall_run_time
            ),
            rainfall_quality=(
                rainfall_quality
            ),
            rainfall_model_count=(
                rainfall_model_count
            ),
        )
    )

    if (
        len(
            scenario_rows
        )
        != 720
    ):
        raise RuntimeError(
            f"Scenario rows = "
            f"{len(scenario_rows)}, "
            "expected 720."
        )

    if (
        len(
            ensemble_rows
        )
        != 120
    ):
        raise RuntimeError(
            f"Ensemble rows = "
            f"{len(ensemble_rows)}, "
            "expected 120."
        )

    print_preview(
        ensemble_rows,
        forecast_matrix,
    )

    scenario_uploaded = (
        upsert_rows(
            table_name=(
                SCENARIO_TABLE
            ),
            rows=(
                scenario_rows
            ),
            conflict_key=(
                "issue_time,"
                "lead_hour,"
                "rain_model,"
                "source,"
                "model_version"
            ),
        )
    )

    ensemble_uploaded = (
        upsert_rows(
            table_name=(
                ENSEMBLE_TABLE
            ),
            rows=(
                ensemble_rows
            ),
            conflict_key=(
                "issue_time,"
                "lead_hour,"
                "source,"
                "model_version"
            ),
        )
    )

    print(
        "\n===== UPLOAD ====="
    )

    print(
        "Scenario uploaded :",
        scenario_uploaded,
        "/ 720",
    )

    print(
        "Ensemble uploaded :",
        ensemble_uploaded,
        "/ 120",
    )

    print(
        "Issue time        :",
        issue_time,
    )

    print(
        "Rain run          :",
        rainfall_run_time,
    )

    print(
        "Status            : OK"
    )

    print(
        "=================="
    )


if __name__ == "__main__":

    try:
        main()

    except Exception as exc:

        print(
            "\n[FATAL]",
            exc,
            file=sys.stderr,
        )

        raise
