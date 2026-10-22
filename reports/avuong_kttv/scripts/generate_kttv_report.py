#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Báo cáo vận hành hồ A Vương theo mẫu PDF khách hàng cung cấp.
ĐƯỢC THIẾT KẾ AN TOÀN CHO POC:
 - Khi tailwater_level NULL, hiển thị 60.00 m TẠM TÍNH kèm cảnh báo rõ trên PDF.
 - Không ghi 60.00 vào Supabase.
 - Chỉ cho phép xem trước PDF hoặc gửi thư THỬ NGHIỆM qua SMTP.
 - Khóa đọc dữ liệu / SMTP được lưu trong GitHub Secrets, không đưa lên website.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import smtplib
import ssl
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

VN = ZoneInfo("Asia/Ho_Chi_Minh")
UTC = timezone.utc
Q2 = Decimal("0.01")
Q1 = Decimal("0.1")
EXPECTED_FIELDS = ("inflow", "turbine_flow", "spillway_flow", "rainfallreal")
DEFAULT_PERIOD_HOURS = 6
VERSION = "AVUONG_KTTV_REPORT_POC_V1"


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def decimal_value(value: Any, label: str) -> Decimal:
    if value is None or value == "":
        raise ValueError(f"Thiếu số liệu bắt buộc: {label}")
    try:
        d = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(f"Không phải giá trị số: {label}={value!r}") from None
    if not d.is_finite():
        raise ValueError(f"Giá trị không hữu hạn: {label}")
    return d


def fmt(value: Decimal, decimal_places: int = 2) -> str:
    return f"{value.quantize(Q1 if decimal_places == 1 else Q2, rounding=ROUND_HALF_UP):.{decimal_places}f}"


def vn_day() -> date:
    return datetime.now(VN).date()


def parse_date(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError:
        raise ValueError("Ngày báo cáo phải theo định dạng YYYY-MM-DD.") from None


def local_clock_to_query_utc(local_naive: datetime, source_mode: str) -> datetime:
    """QUAN TRỌNG: dữ liệu cũ có thể lưu giờ VN như thể đó là UTC.

    'vn_label_stored_as_utc': 19:00 giờ VN được ghi nhãn 19:00+00.
    'true_utc': 19:00 giờ VN được lưu đúng 12:00+00.
    KHÔNG chạy UPDATE database để sửa thời gian trong script này.
    """
    if source_mode == "vn_label_stored_as_utc":
        return local_naive.replace(tzinfo=UTC)
    if source_mode == "true_utc":
        return local_naive.replace(tzinfo=VN).astimezone(UTC)
    raise ValueError("SOURCE_TIME_MODE phải là vn_label_stored_as_utc hoặc true_utc")


def build_hourly_instants(report_day: date, hour: int, source_mode: str) -> list[datetime]:
    """Giá trị Q/mưa của 6 khoảng (T-6h,T] với dữ liệu đóng dấu kết thúc mỗi giờ."""
    end = datetime(report_day.year, report_day.month, report_day.day, hour)
    return [local_clock_to_query_utc(end - timedelta(hours=offset), source_mode)
            for offset in range(5, -1, -1)]


def iso_z(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def supabase_request(method: str, table: str, params: dict[str, str] | None = None,
                     payload: dict[str, Any] | list[dict[str, Any]] | None = None,
