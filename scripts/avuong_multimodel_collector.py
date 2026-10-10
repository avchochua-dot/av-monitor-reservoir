#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A VUONG - MULTI MODEL RAINFALL COLLECTOR V2 (RESILIENT)

Mục tiêu:
1) Lấy precipitation 10 ngày từ 6 model Open-Meteo cho 7 điểm AV01..AV07
2) Retry khi timeout / lỗi tạm thời
3) Lưu RAW vào public.rainfall_forecast_multi
4) Tính lead_hour và chỉ dùng lead_hour >= 1 cho tầng basin
5) Trung bình lưu vực theo từng model
6) Ghi số điểm thực tế tham gia trung bình của từng model
7) Tính ensemble mean / median / std / min / max
8) Ensemble guard:
   - >= 4 model: publish rain_mean
   - < 4 model: rain_mean = NULL, quality = BAD
9) Đánh dấu quality:
   - GOOD    : đủ 6 model và mỗi model dùng đủ 7 điểm
   - PARTIAL : vẫn đủ điều kiện publish nhưng có thiếu điểm/model
   - BAD     : < 4 model khả dụng
10) Ghi log vào public.weather_collect_log

Lưu ý:
- run_time hiện dùng như issue hour của collector, KHÔNG phải model initialization time thật.
- collected_at là thời điểm collector thực sự tải dữ liệu.
- model_run_time để dành cho giai đoạn lấy cycle thật của từng NWP.
"""

import os
import sys
import time
import random
import traceback
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from supabase import create_client


# ============================================================
# 1. SUPABASE - DÙNG GITHUB SECRETS / ENVIRONMENT VARIABLES
# ============================================================

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


# ============================================================
# 2. CẤU HÌNH CHUNG
# ============================================================

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

FORECAST_DAYS = int(os.getenv("FORECAST_DAYS", "10"))
REQUEST_CONNECT_TIMEOUT = int(os.getenv("REQUEST_CONNECT_TIMEOUT", "15"))
REQUEST_READ_TIMEOUT = int(os.getenv("REQUEST_READ_TIMEOUT", "90"))

REQUEST_SLEEP_SEC = float(os.getenv("REQUEST_SLEEP_SEC", "0.35"))
MAX_APP_ATTEMPTS = int(os.getenv("MAX_APP_ATTEMPTS", "3"))
UPSERT_CHUNK_SIZE = int(os.getenv("UPSERT_CHUNK_SIZE", "500"))

BASIN_ID = os.getenv("BASIN_ID", "AVUONG")

EXPECTED_POINTS = 7
EXPECTED_MODELS = 6
MIN_MODELS_FOR_ENSEMBLE = 4


# ============================================================
# 3. 7 ĐIỂM A VƯƠNG
# ============================================================

POINTS = [
    {"id": "AV01", "lat": 15.809, "lon": 107.619},
    {"id": "AV02", "lat": 15.935, "lon": 107.573},
    {"id": "AV03", "lat": 15.942, "lon": 107.475},
    {"id": "AV04", "lat": 15.910, "lon": 107.500},
    {"id": "AV05", "lat": 15.826, "lon": 107.534},
    {"id": "AV06", "lat": 16.004, "lon": 107.504},
    {"id": "AV07", "lat": 15.853, "lon": 107.601},
]


# ============================================================
# 4. 6 MODEL OPEN-METEO
# ============================================================

MODELS = {
    "ECMWF_IFS": "ecmwf_ifs025",
    "GFS": "gfs_global",
    "ICON": "icon_global",
    "ECMWF_AIFS": "ecmwf_aifs025_single",
    "CMA_GRAPES": "cma_grapes_global",
    "JMA_GSM": "jma_gsm",
}

MODEL_TO_COLUMN = {
    "ECMWF_IFS": "rain_ecmwf",
    "GFS": "rain_gfs",
    "ICON": "rain_icon",
    "ECMWF_AIFS": "rain_aifs",
    "CMA_GRAPES": "rain_cma",
    "JMA_GSM": "rain_jma",
}

MODEL_TO_POINT_COLUMN = {
    "ECMWF_IFS": "points_ecmwf",
    "GFS": "points_gfs",
    "ICON": "points_icon",
    "ECMWF_AIFS": "points_aifs",
    "CMA_GRAPES": "points_cma",
    "JMA_GSM": "points_jma",
}

RAIN_COLUMNS = [
    "rain_ecmwf",
    "rain_gfs",
    "rain_icon",
    "rain_aifs",
    "rain_cma",
    "rain_jma",
]

POINT_COUNT_COLUMNS = [
    "points_ecmwf",
    "points_gfs",
    "points_icon",
    "points_aifs",
    "points_cma",
    "points_jma",
]


# ============================================================
# 5. HTTP SESSION + RETRY
# ============================================================

retry_strategy = Retry(
    total=2,
    connect=2,
    read=2,
    status=2,
    backoff_factor=1.5,
    status_forcelist=[429, 500, 502, 503, 504],
    allowed_methods=["GET"],
    raise_on_status=False,
)

adapter = HTTPAdapter(
    max_retries=retry_strategy,
    pool_connections=20,
    pool_maxsize=20,
)

SESSION = requests.Session()
SESSION.mount("https://", adapter)
SESSION.mount("http://", adapter)


# ============================================================
# 6. HELPERS
# ============================================================

def utc_now():
    return datetime.now(timezone.utc)


def floor_to_utc_hour(dt):
    return dt.replace(
        minute=0,
        second=0,
        microsecond=0
    )


def iso_utc(dt):
    return dt.astimezone(timezone.utc).isoformat()


def chunked(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def num_or_none(value):
    if value is None or pd.isna(value):
        return None
    return float(value)


def int_or_zero(value):
    if value is None or pd.isna(value):
        return 0
    return int(value)


# ============================================================
# 7. FETCH 1 ĐIỂM x 1 MODEL
# ============================================================

def fetch_forecast_once(
    point,
    model_name,
    model_code,
    issue_time,
    collected_at
):
    params = {
        "latitude": point["lat"],
        "longitude": point["lon"],
        "hourly": "precipitation",
        "models": model_code,
        "timezone": "UTC",
        "forecast_days": FORECAST_DAYS,
    }

    response = SESSION.get(
        OPEN_METEO_URL,
        params=params,
        timeout=(
            REQUEST_CONNECT_TIMEOUT,
            REQUEST_READ_TIMEOUT
        ),
    )

    response.raise_for_status()

    data = response.json()
    hourly = data.get("hourly", {})

    times = hourly.get("time", [])
    rain = hourly.get("precipitation", [])

    if not times:
        raise RuntimeError(
            f"{point['id']} {model_name}: không có hourly.time"
        )

    if len(times) != len(rain):
        raise RuntimeError(
            f"{point['id']} {model_name}: "
            f"time={len(times)} precipitation={len(rain)}"
        )

    rows = []

    for t, p in zip(times, rain):

        forecast_time = pd.Timestamp(
            t,
            tz="UTC"
        ).to_pydatetime()

        lead_hour = int(
            round(
                (
                    forecast_time
                    - issue_time
                ).total_seconds()
                / 3600.0
            )
        )

        rows.append({
            "run_time": iso_utc(issue_time),
            "forecast_time": iso_utc(forecast_time),
            "point_id": point["id"],
            "model": model_name,
            "latitude": float(point["lat"]),
            "longitude": float(point["lon"]),
            "precipitation_mm": float(p or 0.0),
            "lead_hour": lead_hour,
            "collected_at": iso_utc(collected_at),
        })

    return rows


# ============================================================
# 8. APP-LEVEL RETRY
# ============================================================

def fetch_forecast_with_retry(
    point,
    model_name,
    model_code,
    issue_time,
    collected_at
):
    last_error = None

    for attempt in range(
        1,
        MAX_APP_ATTEMPTS + 1
    ):
        try:
            rows = fetch_forecast_once(
                point=point,
                model_name=model_name,
                model_code=model_code,
                issue_time=issue_time,
                collected_at=collected_at,
            )

            if attempt > 1:
                print(
                    f"[RECOVERED] {point['id']} {model_name} "
                    f"success at attempt {attempt}"
                )

            return rows

        except Exception as exc:
            last_error = exc

            print(
                f"[RETRY] {point['id']} {model_name} "
                f"attempt {attempt}/{MAX_APP_ATTEMPTS}: {exc}"
            )

            if attempt < MAX_APP_ATTEMPTS:
                wait_sec = (
                    4 * attempt
                    + random.uniform(0.5, 2.0)
                )

                time.sleep(wait_sec)

    raise last_error


# ============================================================
# 9. UPSERT RAW
# ============================================================

def upsert_raw(rows):
    total = 0

    for chunk in chunked(
        rows,
        UPSERT_CHUNK_SIZE
    ):
        (
            sb.table("rainfall_forecast_multi")
            .upsert(
                chunk,
                on_conflict=
                "run_time,forecast_time,point_id,model",
            )
            .execute()
        )

        total += len(chunk)

        print(
            f"[RAW] Uploaded "
            f"{total}/{len(rows)}"
        )

    return total


# ============================================================
# 10. BUILD BASIN DATAFRAME
# ============================================================

def build_basin_dataframe(raw_rows):

    df = pd.DataFrame(raw_rows)

    if df.empty:
        raise RuntimeError(
            "Không có dữ liệu raw."
        )

    df["run_time"] = pd.to_datetime(
        df["run_time"],
        utc=True
    )

    df["forecast_time"] = pd.to_datetime(
        df["forecast_time"],
        utc=True
    )

    df["lead_hour"] = (
        (
            df["forecast_time"]
            -
            df["run_time"]
        )
        .dt.total_seconds()
        .div(3600)
        .round()
        .astype(int)
    )

    print(
        "[QC] RAW:",
        len(df),
        "| lead:",
        df["lead_hour"].min(),
        "->",
        df["lead_hour"].max()
    )

    # Chỉ giữ tương lai
    df_future = df[
        df["lead_hour"] >= 1
    ].copy()

    if df_future.empty:
        raise RuntimeError(
            "Không có forecast future."
        )

    print(
        "[QC] FUTURE:",
        len(df_future),
        "| lead:",
        df_future["lead_hour"].min(),
        "->",
        df_future["lead_hour"].max()
    )

    # --------------------------------------------------------
    # Trung bình mưa theo model
    # --------------------------------------------------------

    basin_model = (
        df_future
        .groupby(
            [
                "run_time",
                "forecast_time",
                "lead_hour",
                "model"
            ],
            as_index=False
        )
        .agg(
            precipitation_mm=(
                "precipitation_mm",
                "mean"
            ),
            point_count=(
                "point_id",
                "nunique"
            ),
        )
    )

    # --------------------------------------------------------
    # Pivot rain values
    # --------------------------------------------------------

    rain_pivot = (
        basin_model
        .pivot_table(
            index=[
                "run_time",
                "forecast_time",
                "lead_hour"
            ],
            columns="model",
            values="precipitation_mm",
            aggfunc="mean"
        )
        .reset_index()
        .rename_axis(
            None,
            axis=1
        )
        .rename(
            columns=MODEL_TO_COLUMN
        )
    )

    # --------------------------------------------------------
    # Pivot point counts
    # --------------------------------------------------------

    point_pivot = (
        basin_model
        .pivot_table(
            index=[
                "run_time",
                "forecast_time",
                "lead_hour"
            ],
            columns="model",
            values="point_count",
            aggfunc="max"
        )
        .reset_index()
        .rename_axis(
            None,
            axis=1
        )
        .rename(
            columns=MODEL_TO_POINT_COLUMN
        )
    )

    pivot = rain_pivot.merge(
        point_pivot,
        on=[
            "run_time",
            "forecast_time",
            "lead_hour"
        ],
        how="left"
    )

    # --------------------------------------------------------
    # Bảo đảm đủ cột
    # --------------------------------------------------------

    for col in RAIN_COLUMNS:
        if col not in pivot.columns:
            pivot[col] = np.nan

    for col in POINT_COUNT_COLUMNS:
        if col not in pivot.columns:
            pivot[col] = 0

    # --------------------------------------------------------
    # model_count
    # --------------------------------------------------------

    pivot["model_count"] = (
        pivot[RAIN_COLUMNS]
        .notna()
        .sum(axis=1)
    )

    # --------------------------------------------------------
    # Ensemble statistics raw
    # --------------------------------------------------------

    pivot["rain_mean_raw"] = (
        pivot[RAIN_COLUMNS]
        .mean(
            axis=1,
            skipna=True
        )
    )

    pivot["rain_median"] = (
        pivot[RAIN_COLUMNS]
        .median(
            axis=1,
            skipna=True
        )
    )

    pivot["rain_std"] = (
        pivot[RAIN_COLUMNS]
        .std(
            axis=1,
            skipna=True,
            ddof=0
        )
    )

    pivot["rain_min"] = (
        pivot[RAIN_COLUMNS]
        .min(
            axis=1,
            skipna=True
        )
    )

    pivot["rain_max"] = (
        pivot[RAIN_COLUMNS]
        .max(
            axis=1,
            skipna=True
        )
    )

    # --------------------------------------------------------
    # Ensemble guard
    # --------------------------------------------------------

    pivot["rain_mean"] = np.where(
        pivot["model_count"]
        >= MIN_MODELS_FOR_ENSEMBLE,
        pivot["rain_mean_raw"],
        np.nan
    )

    # --------------------------------------------------------
    # Quality
    # GOOD:
    #   6 model và mọi model có đủ 7 điểm
    # PARTIAL:
    #   >= 4 model nhưng thiếu điểm hoặc thiếu model
    # BAD:
    #   < 4 model
    # --------------------------------------------------------

    def classify_quality(row):

        if (
            int(row["model_count"])
            < MIN_MODELS_FOR_ENSEMBLE
        ):
            return "BAD"

        all_points_full = True

        for col in POINT_COUNT_COLUMNS:
            count = int_or_zero(
                row.get(col)
            )

            # Nếu model không tồn tại ở giờ đó,
            # count = 0, nhưng model_count sẽ phản ánh.
            if count > 0 and count < EXPECTED_POINTS:
                all_points_full = False

        if (
            int(row["model_count"])
            == EXPECTED_MODELS
            and all_points_full
            and all(
                int_or_zero(row.get(col))
                == EXPECTED_POINTS
                for col in POINT_COUNT_COLUMNS
            )
        ):
            return "GOOD"

        return "PARTIAL"

    pivot["quality"] = pivot.apply(
        classify_quality,
        axis=1
    )

    pivot["basin_id"] = BASIN_ID

    return (
        df,
        df_future,
        basin_model,
        pivot
    )


# ============================================================
# 11. BUILD BASIN ROWS
# ============================================================

def build_basin_rows(
    pivot,
    collected_at
):
    rows = []

    for _, r in pivot.iterrows():

        rows.append({

            "forecast_time":
                pd.Timestamp(
                    r["forecast_time"]
                ).isoformat(),

            "run_time":
                pd.Timestamp(
                    r["run_time"]
                ).isoformat(),

            "basin_id":
                BASIN_ID,

            "lead_hour":
                int(
                    r["lead_hour"]
                ),

            # 6 model
            "rain_ecmwf":
                num_or_none(
                    r.get("rain_ecmwf")
                ),

            "rain_gfs":
                num_or_none(
                    r.get("rain_gfs")
                ),

            "rain_icon":
                num_or_none(
                    r.get("rain_icon")
                ),

            "rain_aifs":
                num_or_none(
                    r.get("rain_aifs")
                ),

            "rain_cma":
                num_or_none(
                    r.get("rain_cma")
                ),

            "rain_jma":
                num_or_none(
                    r.get("rain_jma")
                ),

            # Ensemble
            "rain_mean":
                num_or_none(
                    r.get("rain_mean")
                ),

            "rain_median":
                num_or_none(
                    r.get("rain_median")
                ),

            "rain_std":
                num_or_none(
                    r.get("rain_std")
                ),

            "rain_min":
                num_or_none(
                    r.get("rain_min")
                ),

            "rain_max":
                num_or_none(
                    r.get("rain_max")
                ),

            # Counts
            "model_count":
                int_or_zero(
                    r.get("model_count")
                ),

            "points_ecmwf":
                int_or_zero(
                    r.get("points_ecmwf")
                ),

            "points_gfs":
                int_or_zero(
                    r.get("points_gfs")
                ),

            "points_icon":
                int_or_zero(
                    r.get("points_icon")
                ),

            "points_aifs":
                int_or_zero(
                    r.get("points_aifs")
                ),

            "points_cma":
                int_or_zero(
                    r.get("points_cma")
                ),

            "points_jma":
                int_or_zero(
                    r.get("points_jma")
                ),

            "quality":
                str(
                    r.get("quality")
                ),

            "collected_at":
                iso_utc(
                    collected_at
                ),
        })

    return rows


# ============================================================
# 12. UPSERT BASIN
# ============================================================

def upsert_basin(rows):

    total = 0

    for chunk in chunked(
        rows,
        UPSERT_CHUNK_SIZE
    ):

        (
            sb.table(
                "rainfall_basin_hourly"
            )
            .upsert(
                chunk,
                on_conflict=
                "forecast_time,run_time,basin_id"
            )
            .execute()
        )

        total += len(chunk)

        print(
            f"[BASIN] Uploaded "
            f"{total}/{len(rows)}"
        )

    return total


# ============================================================
# 13. LOG
# ============================================================

def write_log(
    started_at,
    finished_at,
    raw_rows,
    basin_rows,
    success_calls,
    failed_calls,
    status,
    message
):
    row = {
        "started_at":
            iso_utc(started_at),

        "finished_at":
            iso_utc(finished_at),

        "raw_rows":
            int(raw_rows),

        "basin_rows":
            int(basin_rows),

        "success_models":
            int(success_calls),

        "failed_models":
            int(failed_calls),

        "status":
            status,

        "message":
            message[:4000]
            if message
            else None,
    }

    try:
        (
            sb.table(
                "weather_collect_log"
            )
            .insert(row)
            .execute()
        )

    except Exception as exc:
        print(
            "[WARN] Không ghi được log:",
            exc
        )


# ============================================================
# 14. MAIN
# ============================================================

def main():

    started_at = utc_now()

    issue_time = floor_to_utc_hour(
        started_at
    )

    collected_at = started_at

    print("=" * 72)
    print(
        "A VUONG MULTI-MODEL "
        "RAINFALL COLLECTOR V2"
    )
    print(
        "Issue time:",
        iso_utc(issue_time)
    )
    print(
        "Expected calls:",
        EXPECTED_POINTS
        * EXPECTED_MODELS
    )
    print("=" * 72)

    all_rows = []

    success_calls = 0
    failed_calls = 0

    failures = []

    # --------------------------------------------------------
    # FETCH
    # --------------------------------------------------------

    for point in POINTS:

        for (
            model_name,
            model_code
        ) in MODELS.items():

            try:

                rows = (
                    fetch_forecast_with_retry(
                        point=point,
                        model_name=model_name,
                        model_code=model_code,
                        issue_time=issue_time,
                        collected_at=collected_at
                    )
                )

                all_rows.extend(
                    rows
                )

                success_calls += 1

                print(
                    "[OK]",
                    point["id"],
                    model_name,
                    len(rows)
                )

            except Exception as exc:

                failed_calls += 1

                msg = (
                    f"{point['id']} "
                    f"{model_name}: {exc}"
                )

                failures.append(
                    msg
                )

                print(
                    "[FAILED]",
                    msg
                )

            # tránh dồn request quá nhanh
            time.sleep(
                REQUEST_SLEEP_SEC
            )

    # --------------------------------------------------------
    # VALIDATE
    # --------------------------------------------------------

    if not all_rows:
        raise RuntimeError(
            "Không lấy được dữ liệu từ "
            "bất kỳ model nào."
        )

    print(
        "TOTAL RAW ROWS:",
        len(all_rows)
    )

    # --------------------------------------------------------
    # RAW -> SUPABASE
    # --------------------------------------------------------

    raw_uploaded = upsert_raw(
        all_rows
    )

    # --------------------------------------------------------
    # BUILD BASIN
    # --------------------------------------------------------

    (
        df,
        df_future,
        basin_model,
        pivot
    ) = build_basin_dataframe(
        all_rows
    )

    # --------------------------------------------------------
    # QC
    # --------------------------------------------------------

    print(
        "\n===== CALL SUMMARY ====="
    )

    print(
        "Success:",
        success_calls,
        "/",
        EXPECTED_POINTS
        * EXPECTED_MODELS
    )

    print(
        "Failed:",
        failed_calls,
        "/",
        EXPECTED_POINTS
        * EXPECTED_MODELS
    )

    print(
        "\n===== MODEL SUMMARY ====="
    )

    print(
        df.groupby(
            "model"
        )[
            "precipitation_mm"
        ]
        .agg(
            [
                "count",
                "mean",
                "max"
            ]
        )
        .round(4)
        .to_string()
    )

    print(
        "\n===== QUALITY SUMMARY ====="
    )

    print(
        pivot["quality"]
        .value_counts(
            dropna=False
        )
        .to_string()
    )

    print(
        "\n===== BASIN PREVIEW ====="
    )

    preview_cols = [
        "forecast_time",
        "lead_hour",
        "rain_ecmwf",
        "rain_gfs",
        "rain_icon",
        "rain_aifs",
        "rain_cma",
        "rain_jma",
        "rain_mean",
        "rain_std",
        "model_count",
        "points_ecmwf",
        "points_gfs",
        "points_icon",
        "points_aifs",
        "points_cma",
        "points_jma",
        "quality",
    ]

    print(
        pivot[
            preview_cols
        ]
        .head(15)
        .round(4)
        .to_string(
            index=False
        )
    )

    # --------------------------------------------------------
    # BASIN -> SUPABASE
    # --------------------------------------------------------

    basin_rows = build_basin_rows(
        pivot,
        collected_at
    )

    basin_uploaded = upsert_basin(
        basin_rows
    )

    # --------------------------------------------------------
    # FINAL STATUS
    # --------------------------------------------------------

    finished_at = utc_now()

    # Status tổng job
    if failed_calls == 0:
        status = "OK"
    elif success_calls >= 30:
        status = "PARTIAL"
    else:
        status = "DEGRADED"

    quality_counts = (
        pivot["quality"]
        .value_counts()
        .to_dict()
    )

    message = (
        f"issue_time={iso_utc(issue_time)}; "
        f"raw_uploaded={raw_uploaded}; "
        f"future_rows={len(df_future)}; "
        f"basin_uploaded={basin_uploaded}; "
        f"success_calls={success_calls}; "
        f"failed_calls={failed_calls}; "
        f"quality={quality_counts}"
    )

    if failures:
        message += (
            "; failures="
            +
            " | ".join(
                failures[:20]
            )
        )

    write_log(
        started_at=started_at,
        finished_at=finished_at,
        raw_rows=raw_uploaded,
        basin_rows=basin_uploaded,
        success_calls=success_calls,
        failed_calls=failed_calls,
        status=status,
        message=message,
    )

    print("=" * 72)
    print("STATUS:", status)
    print(
        "RAW uploaded:",
        raw_uploaded
    )
    print(
        "FUTURE rows:",
        len(df_future)
    )
    print(
        "BASIN uploaded:",
        basin_uploaded
    )
    print(
        "Success calls:",
        success_calls,
        "/",
        EXPECTED_POINTS
        * EXPECTED_MODELS
    )
    print(
        "Failed calls:",
        failed_calls,
        "/",
        EXPECTED_POINTS
        * EXPECTED_MODELS
    )
    print(
        "Quality:",
        quality_counts
    )
    print(
        "Finished:",
        iso_utc(finished_at)
    )
    print("=" * 72)

    # Cho GitHub Action fail nếu hệ thống xuống quá thấp
    if success_calls < 30:
        return 2

    return 0


# ============================================================
# 15. RUN
# ============================================================

if __name__ == "__main__":

    try:
        sys.exit(
            main()
        )

    except Exception:
        traceback.print_exc()
        sys.exit(1)
