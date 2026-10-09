#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
A VUONG - MULTI MODEL RAINFALL COLLECTOR
FULL VERSION - NHẬP SUPABASE URL/KEY TRỰC TIẾP TRONG FILE

Luồng:
1) Lấy mưa 10 ngày từ 6 model Open-Meteo cho 7 điểm AV01..AV07
2) Ghi raw vào public.rainfall_forecast_multi
3) Tính lead_hour
4) Chỉ giữ lead_hour >= 1 cho tầng basin
5) Trung bình 7 điểm theo từng model
6) Tính mean/median/std/min/max của 6 model
7) Ghi vào public.rainfall_basin_hourly
8) Ghi log vào public.weather_collect_log
"""

import sys
import time
import traceback
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests
from supabase import create_client


# ============================================================
# 1. ĐIỀN THÔNG TIN SUPABASE TẠI ĐÂY
# ============================================================

SUPABASE_URL = "https://ycthhachfxczwkburnfa.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InljdGhoYWNoZnhjendrYnVybmZhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjQ4Nzk1MCwiZXhwIjoyMDgyMDYzOTUwfQ.j6ZvpLQ2MsZ6ExvYFJ1mrx2HDJVCrl9Y_04zm64xhEI"

# Ví dụ:
# SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co"
# SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."

# ============================================================
# 2. CẤU HÌNH CHUNG
# ============================================================

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"

FORECAST_DAYS = 10
REQUEST_TIMEOUT = 60
REQUEST_SLEEP_SEC = 0.25
UPSERT_CHUNK_SIZE = 500

BASIN_ID = "AVUONG"


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

RAIN_COLUMNS = [
    "rain_ecmwf",
    "rain_gfs",
    "rain_icon",
    "rain_aifs",
    "rain_cma",
    "rain_jma",
]


# ============================================================
# 5. KIỂM TRA CẤU HÌNH SUPABASE
# ============================================================

if (
    not SUPABASE_URL
    or not SUPABASE_KEY
    or "DAN_URL" in SUPABASE_URL
    or "DAN_SERVICE" in SUPABASE_KEY
):
    raise RuntimeError(
        "\nCHƯA ĐIỀN SUPABASE.\n"
        "Hãy sửa 2 dòng ở đầu file:\n"
        'SUPABASE_URL = "https://....supabase.co"\n'
        'SUPABASE_KEY = "service_role_key..."\n'
    )

if not SUPABASE_URL.startswith("https://"):
    raise RuntimeError(
        "SUPABASE_URL không hợp lệ. "
        "Phải có dạng https://xxxxxxxx.supabase.co"
    )

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


# ============================================================
# 6. HÀM THỜI GIAN
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


# ============================================================
# 7. LẤY DỮ LIỆU OPEN-METEO
# ============================================================

def fetch_forecast(
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

    response = requests.get(
        OPEN_METEO_URL,
        params=params,
        timeout=REQUEST_TIMEOUT,
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
            "run_time":
                iso_utc(issue_time),

            "forecast_time":
                iso_utc(forecast_time),

            "point_id":
                point["id"],

            "model":
                model_name,

            "latitude":
                float(point["lat"]),

            "longitude":
                float(point["lon"]),

            "precipitation_mm":
                float(p or 0.0),

            "lead_hour":
                lead_hour,

            "collected_at":
                iso_utc(collected_at),
        })

    return rows


# ============================================================
# 8. CHIA CHUNK
# ============================================================

def chunked(items, size):

    for i in range(
        0,
        len(items),
        size
    ):
        yield items[i:i + size]


# ============================================================
# 9. GHI RAW SUPABASE
# ============================================================

def upsert_raw(rows):

    total = 0

    for chunk in chunked(
        rows,
        UPSERT_CHUNK_SIZE
    ):

        sb.table(
            "rainfall_forecast_multi"
        ).upsert(
            chunk,
            on_conflict=
            "run_time,forecast_time,point_id,model"
        ).execute()

        total += len(chunk)

        print(
            f"[RAW] Uploaded "
            f"{total}/{len(rows)}"
        )

    return total


# ============================================================
# 10. TÍNH MƯA TRUNG BÌNH LƯU VỰC
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

    # Chỉ lấy tương lai
    df_future = df[
        df["lead_hour"] >= 1
    ].copy()

    if df_future.empty:
        raise RuntimeError(
            "Không có dòng forecast future."
        )

    print(
        "[QC] FUTURE:",
        len(df_future),
        "| lead:",
        df_future["lead_hour"].min(),
        "->",
        df_future["lead_hour"].max()
    )

    # Trung bình 7 điểm theo từng model
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
        ["precipitation_mm"]
        .mean()
    )

    # Pivot 6 model
    pivot = (
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

    # Nếu model nào lỗi thì vẫn tạo cột
    for col in RAIN_COLUMNS:

        if col not in pivot.columns:
            pivot[col] = np.nan

    # Số model hiện có
    pivot["model_count"] = (
        pivot[RAIN_COLUMNS]
        .notna()
        .sum(axis=1)
    )

    # Ensemble statistics
    pivot["rain_mean"] = (
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

    pivot["basin_id"] = BASIN_ID

    return (
        df,
        df_future,
        basin_model,
        pivot
    )


# ============================================================
# 11. CONVERT NUMERIC
# ============================================================

def num_or_none(value):

    if value is None:
        return None

    if pd.isna(value):
        return None

    return float(value)


# ============================================================
# 12. BUILD BASIN ROWS
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

            "model_count":
                int(
                    r["model_count"]
                ),

            "collected_at":
                iso_utc(
                    collected_at
                ),
        })

    return rows


# ============================================================
# 13. GHI BASIN SUPABASE
# ============================================================

def upsert_basin(rows):

    total = 0

    for chunk in chunked(
        rows,
        UPSERT_CHUNK_SIZE
    ):

        sb.table(
            "rainfall_basin_hourly"
        ).upsert(
            chunk,
            on_conflict=
            "forecast_time,run_time,basin_id"
        ).execute()

        total += len(chunk)

        print(
            f"[BASIN] Uploaded "
            f"{total}/{len(rows)}"
        )

    return total


# ============================================================
# 14. GHI LOG
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

        sb.table(
            "weather_collect_log"
        ).insert(
            row
        ).execute()

    except Exception as e:

        print(
            "[WARN] Không ghi được log:",
            e
        )


# ============================================================
# 15. MAIN
# ============================================================

def main():

    started_at = utc_now()

    # Issue time = giờ UTC hiện tại làm tròn
    issue_time = floor_to_utc_hour(
        started_at
    )

    collected_at = started_at

    print("=" * 72)
    print(
        "A VUONG MULTI-MODEL "
        "RAINFALL COLLECTOR"
    )
    print(
        "Issue time:",
        iso_utc(issue_time)
    )
    print("=" * 72)

    all_rows = []

    success_calls = 0
    failed_calls = 0

    failures = []

    # --------------------------------------------------------
    # FETCH 7 POINTS x 6 MODELS
    # --------------------------------------------------------

    for point in POINTS:

        for (
            model_name,
            model_code
        ) in MODELS.items():

            try:

                rows = fetch_forecast(
                    point,
                    model_name,
                    model_code,
                    issue_time,
                    collected_at
                )

                all_rows.extend(
                    rows
                )

                success_calls += 1

                print(
                    "OK",
                    point["id"],
                    model_name,
                    len(rows)
                )

            except Exception as e:

                failed_calls += 1

                msg = (
                    f"{point['id']} "
                    f"{model_name}: {e}"
                )

                failures.append(
                    msg
                )

                print(
                    "ERROR",
                    msg
                )

            time.sleep(
                REQUEST_SLEEP_SEC
            )

    # --------------------------------------------------------
    # VALIDATE
    # --------------------------------------------------------

    if not all_rows:

        raise RuntimeError(
            "Không lấy được dữ liệu "
            "từ bất kỳ model nào."
        )

    print(
        "TOTAL RAW ROWS:",
        len(all_rows)
    )

    # --------------------------------------------------------
    # UPLOAD RAW
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
    # HIỂN THỊ QC
    # --------------------------------------------------------

    print("\n===== MODEL SUMMARY =====")

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
    ]

    print(
        pivot[
            preview_cols
        ]
        .head(12)
        .round(4)
        .to_string(
            index=False
        )
    )

    # --------------------------------------------------------
    # UPLOAD BASIN
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

    if failed_calls == 0:

        status = "OK"

    else:

        status = "PARTIAL"

    message = (
        f"issue_time={iso_utc(issue_time)}; "
        f"raw_uploaded={raw_uploaded}; "
        f"future_rows={len(df_future)}; "
        f"basin_uploaded={basin_uploaded}; "
        f"success_calls={success_calls}; "
        f"failed_calls={failed_calls}"
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
        started_at,
        finished_at,
        raw_uploaded,
        basin_uploaded,
        success_calls,
        failed_calls,
        status,
        message
    )

    print("=" * 72)
    print("STATUS:", status)
    print(
        "RAW uploaded:",
        raw_uploaded
    )
    print(
        "BASIN uploaded:",
        basin_uploaded
    )
    print(
        "Success calls:",
        success_calls,
        "/ 42"
    )
    print(
        "Failed calls:",
        failed_calls,
        "/ 42"
    )
    print("=" * 72)

    # Tối đa 12 request lỗi
    if failed_calls > 12:

        return 2

    return 0


# ============================================================
# 16. RUN
# ============================================================

if __name__ == "__main__":

    try:

        sys.exit(
            main()
        )

    except Exception:

        traceback.print_exc()

        sys.exit(1)
