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
                     prefer: str = "") -> Any:
    url = env("SUPABASE_URL").rstrip("/")
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong Secrets.")
    if not (url.startswith("https://") or url.startswith("http://localhost")):
        raise RuntimeError("SUPABASE_URL phải là HTTPS (trừ localhost).")
    suffix = f"/rest/v1/{table}"
    if params:
        suffix += "?" + urlencode(params, safe="(),.*")
    headers = {
        "apikey": key,
        "Authorization": "Bearer " + key,
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url + suffix, data=data, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body.strip() else []
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:650]
        raise RuntimeError(f"Supabase HTTP {e.code} [{table}]: {detail}") from None
    except URLError as e:
        raise RuntimeError(f"Không kết nối được Supabase: {e}") from None


def choose_rows(all_rows: list[dict[str, Any]], instants: list[datetime]) -> list[dict[str, Any]]:
    by_time: dict[str, dict[str, Any]] = {}
    for row in all_rows:
        raw_time = str(row.get("time") or "").replace("Z", "+00:00")
        try:
            ts = datetime.fromisoformat(raw_time).astimezone(UTC)
        except (ValueError, AttributeError):
            raise ValueError(f"Timestamp trong Supabase không hợp lệ: {row.get('time')!r}") from None
        key = iso_z(ts)
        current = by_time.get(key)
        # Nếu API có hai bản ghi cùng giờ, ưu tiên created_at mới nhất; lưu vết ID trong JSON.
        if current is None or (str(row.get("created_at") or ""), int(row.get("id") or 0)) > \
                (str(current.get("created_at") or ""), int(current.get("id") or 0)):
            by_time[key] = row
    missing = [iso_z(t) for t in instants if iso_z(t) not in by_time]
    if missing:
        raise ValueError("DATA_INCOMPLETE: Thiếu giờ trong dữ liệu 6 giờ: " + ", ".join(missing))
    return [by_time[iso_z(t)] for t in instants]


def fetch_six_hours(report_day: date, hour: int, source_mode: str) -> list[dict[str, Any]]:
    times = build_hourly_instants(report_day, hour, source_mode)
    where: dict[str, str] = {
        "select": "id,reservoir_id,time,water_level,tailwater_level,inflow,turbine_flow,spillway_flow,rainfallreal,created_at",
        "time": f"gte.{iso_z(times[0])}",
        "order": "time.asc",
        "limit": "200",
    }
    reservoir_filter = env("RESERVOIR_ID", "is.null")
    if reservoir_filter == "is.null":
        where["reservoir_id"] = "is.null"
    else:
        import uuid
        try:
            uuid.UUID(reservoir_filter)
        except ValueError:
            raise ValueError("RESERVOIR_ID phải là UUID, hoặc is.null theo dữ liệu A Vương hiện tại.")
        where["reservoir_id"] = f"eq.{reservoir_filter}"
    # POSTGREST: cùng cột time có 2 điều kiện dùng URL thủ công hoặc filter 'and=(...)'
    # Tránh dict bị ghi đè key trùng, sử dụng 'and'.
    del where["time"]
    where["and"] = f"(time.gte.{iso_z(times[0])},time.lte.{iso_z(times[-1])})"
    return choose_rows(supabase_request("GET", "reservoir_hourly_data", where), times)


@dataclass
class Report:
    day: date
    hour: int
    source_mode: str
    upstream: Decimal
    tailwater: Decimal
    tailwater_is_temporary: bool
    mean_inflow: Decimal
    mean_turbine: Decimal
    mean_spillway: Decimal
    rain_total: Decimal
    hour_ids: list[int]
    demo: bool = False

    @property
    def provisional(self) -> bool:
        return self.tailwater_is_temporary or self.demo


def aggregate_rows(report_day: date, hour: int, source_mode: str,
                   rows: list[dict[str, Any]], fallback: Decimal) -> Report:
    if len(rows) != DEFAULT_PERIOD_HOURS:
        raise ValueError("Phải có đúng 6 bản ghi giờ.")
    # Mực nước tại đúng thời điểm báo cáo nằm ở bản ghi giờ cuối.
    w = decimal_value(rows[-1].get("water_level"), "water_level tại giờ phát hành")
    if not (Decimal("300") <= w <= Decimal("400")):
        raise ValueError(f"Mực nước thượng lưu ngoài phạm vi QC A Vương: {w}")
    tval = rows[-1].get("tailwater_level")
    temporary = tval is None
    tail = fallback if temporary else decimal_value(tval, "tailwater_level")
    if not (Decimal("0") < tail <= Decimal("100")):
        raise ValueError(f"Mực nước hạ lưu nhà máy ngoài phạm vi QC: {tail}")

    series: dict[str, list[Decimal]] = {}
    for key in EXPECTED_FIELDS:
        nums = [decimal_value(r.get(key), f"{key} giờ #{i+1}")
                for i, r in enumerate(rows)]
        if any(v < 0 for v in nums):
            raise ValueError(f"DATA_QC_FAIL: {key} âm, không được lập báo cáo.")
        if key == "rainfallreal" and any(v > 500 for v in nums):
            raise ValueError("DATA_QC_FAIL: rainfallreal > 500 mm/h; cần rà nguồn.")
        if key != "rainfallreal" and any(v > 20000 for v in nums):
            raise ValueError(f"DATA_QC_FAIL: {key} > 20.000 m3/s; cần rà nguồn.")
        series[key] = nums

    avg = lambda key: sum(series[key], Decimal(0)) / Decimal(DEFAULT_PERIOD_HOURS)
    rain = sum(series["rainfallreal"], Decimal(0))
    return Report(
        day=report_day, hour=hour, source_mode=source_mode,
        upstream=w, tailwater=tail, tailwater_is_temporary=temporary,
        mean_inflow=avg("inflow"), mean_turbine=avg("turbine_flow"),
        mean_spillway=avg("spillway_flow"), rain_total=rain,
        hour_ids=[int(r.get("id") or 0) for r in rows],
    )


def demo_report() -> Report:
    """Giá trị demo sao chép từ PDF người dùng cung cấp, ngoại trừ H hạ lưu tạm tính."""
    return Report(
        day=date(2026, 10, 21), hour=19, source_mode="vn_label_stored_as_utc",
        upstream=Decimal("355.13"), tailwater=Decimal("60.00"),
        tailwater_is_temporary=True, mean_inflow=Decimal("42.44"),
        mean_turbine=Decimal("57.05"), mean_spillway=Decimal("0.00"),
        rain_total=Decimal("4.0"), hour_ids=[], demo=True
    )


def setup_font() -> None:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    candidates = [
        Path("/usr/share/fonts/truetype/dejavu"),
        Path("/usr/local/share/fonts"),
        Path("/usr/share/fonts"),
    ]
    def find(name: str) -> Path | None:
        for folder in candidates:
            p = folder / name
            if p.exists():
                return p
        for folder in candidates:
            if folder.exists():
                files = list(folder.rglob(name))
                if files:
                    return files[0]
        return None
    for face, filename in (
        ("VNSerif", "DejaVuSerif.ttf"),
        ("VNSerifBold", "DejaVuSerif-Bold.ttf"),
        ("VNSerifItalic", "DejaVuSerif-Italic.ttf"),
    ):
        p = find(filename)
        if not p:
            raise RuntimeError("Thiếu DejaVu fonts. Ubuntu: sudo apt-get install fonts-dejavu-core")
        pdfmetrics.registerFont(TTFont(face, str(p)))


def draw_pdf(r: Report, output: Path) -> Path:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import landscape, letter
    from reportlab.pdfgen.canvas import Canvas
    setup_font()
    output.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(letter)
    c = Canvas(str(output), pagesize=(width, height), pageCompression=1)
    c.setTitle(f"Du thao bao cao so lieu KTTV {r.hour:02d}h00 {r.day.isoformat()}")
    ink = colors.HexColor("#172231")
    quiet = colors.HexColor("#526070")
    red = colors.HexColor("#A5252C")
    black = colors.black
    d = r.day
    fmtday = d.strftime("%d/%m/%Y")
    period_start = r.hour - DEFAULT_PERIOD_HOURS
    left, right = 25, 767

    def centered(lines: list[str], center_x: float, top_y: float,
                 face: str = "VNSerif", size: float = 9.3, line_height: float = 14,
                 color=black):
        c.setFont(face, size)
        c.setFillColor(color)
        for j, text in enumerate(lines):
            c.drawCentredString(center_x, top_y - j * line_height, text)

    centered(["TỔNG CÔNG TY PHÁT ĐIỆN 2", "CÔNG TY CỔ PHẦN", "THỦY ĐIỆN A VƯƠNG"],
             193, 582, "VNSerifBold", 10.3, 16)
    centered(["CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM", "Độc lập - Tự do - Hạnh phúc"],
             603, 582, "VNSerifBold", 9.3, 17)
    c.setStrokeColor(black)
    c.setLineWidth(.6)
    c.line(500, 550, 705, 550)
    c.setFont("VNSerifItalic", 9.5)
    c.drawRightString(right, 521, f"Đà Nẵng, ngày {d.day:02d} tháng {d.month:02d} năm {d.year}")

    centered(["BÁO CÁO SỐ LIỆU VẬN HÀNH HỒ THỦY ĐIỆN A VƯƠNG"],
             396, 489, "VNSerifBold", 11.1, 15)
    c.setFillColor(black)
    c.setFont("VNSerif", 8.7)
    c.drawString(34, 462,
        "Thực hiện theo quy định tại Khoản 5, Điều 40 Nghị định số 62/2025/NĐ-CP ngày 04/3/2025, Công ty Cổ phần")
    c.drawString(34, 449, "Thủy điện A Vương cung cấp số liệu vận hành hồ chứa như sau:")

    # Bảng theo mẫu, tỷ lệ trang letter landscape 792 x 612 pt.
    x = [left]
    widths = [110, 68, 94, 95, 82, 82, 82, 129]  # tổng 742
    for wcol in widths:
        x.append(x[-1] + wcol)
    assert abs(x[-1] - right) <= 0.001
    y_top, y_group, y_data, y_bottom = 431, 390, 346, 310
    c.setStrokeColor(black)
    c.setLineWidth(.85)
    c.rect(left, y_bottom, right-left, y_top-y_bottom, fill=0, stroke=1)
    for j, xi in enumerate(x[1:-1], start=1):
        if j in (5, 6):
            # Tiêu đề ba Q được gộp ở hàng trên.
            c.line(xi, y_group, xi, y_bottom)
        else:
            c.line(xi, y_top, xi, y_bottom)
    c.line(x[4], y_group, x[7], y_group)
    c.line(left, y_data, right, y_data)

    def cell(col: int, lines: list[str], top: float, bottom: float,
             size: float = 7.7, face: str = "VNSerifBold", line_height: float = 12):
        cx = (x[col]+x[col+1]) / 2
        n = len(lines)
        totalh = (n - 1)*line_height
        midy = (top + bottom) / 2
        topbase = midy + totalh/2 - 3.0
        centered(lines, cx, topbase, face, size, line_height)

    cell(0, ["Ngày/tháng/năm"], y_top, y_data, 8.0)
    cell(1, ["Giờ"], y_top, y_data, 8.6)
    cell(2, ["Mực nước hồ", "thượng lưu", "(m)"], y_top, y_data, 8.0, line_height=12.5)
    cell(3, ["Mực nước hạ", "lưu nhà máy", "(m)"], y_top, y_data, 8.0, line_height=12.5)

    centered(["Số liệu trung bình từ",
              f"{period_start:02d}h/{d.day:02d}/{d.month:02d} ÷ {r.hour:02d}h/{d.day:02d}/{d.month:02d}/{d.year}"],
             (x[4]+x[7])/2, 416, "VNSerifBold", 8.2, 15)
    cell(4, ["Qđến hồ", "(m³/s)"], y_group, y_data, 7.8)
    cell(5, ["Qchạy máy", "(m³/s)"], y_group, y_data, 7.8)
    cell(6, ["Qxả tràn", "(m³/s)"], y_group, y_data, 7.8)
    centered(["Tổng lượng mưa từ",
              f"{period_start:02d}h/{d.day:02d}/{d.month:02d} ÷",
              f"{r.hour:02d}h/{d.day:02d}/{d.month:02d}/{d.year}",
              "(mm)"],
             (x[7]+x[8])/2, 412, "VNSerifBold", 7.6, 14)

    vals = [fmtday, f"{r.hour:02d}h00'",
            fmt(r.upstream), fmt(r.tailwater) + ("*" if r.tailwater_is_temporary else ""),
            fmt(r.mean_inflow), fmt(r.mean_turbine),
            fmt(r.mean_spillway), fmt(r.rain_total, 1)]
    for i, val in enumerate(vals):
        centered([val], (x[i]+x[i+1])/2, 322, "VNSerif", 9.0, 12,
                 red if i == 3 and r.tailwater_is_temporary else black)

    if True:  # POC luôn là bản thử nghiệm vì chưa có phê duyệt/chữ ký số.
        c.setFillColor(colors.HexColor("#FFF4F3"))
        c.setStrokeColor(colors.HexColor("#E9B4B0"))
        c.roundRect(left, 271, right-left, 27, 5, fill=1, stroke=1)
        c.setFont("VNSerifBold", 9.0)
        c.setFillColor(red)
        c.drawString(left+9, 281, "BẢN THỬ NGHIỆM - KHÔNG PHÁT HÀNH CHÍNH THỨC")
        c.setFont("VNSerif", 8.0)
        if r.tailwater_is_temporary:
            c.drawRightString(right-9, 281,
                              f"* Mực nước hạ lưu {fmt(r.tailwater).replace('.', ',')} m là số tạm tính, CHƯA đo.")
        else:
            c.drawRightString(right-9, 281, "Chưa ký, chưa phê duyệt.")
        if r.demo:
            c.setFont("VNSerifItalic", 8.1)
            c.drawString(left+9, 260, "Các số liệu khác minh họa từ PDF mẫu ngày 21/10/2026, không truy vấn Supabase.")
    else:
        c.setFont("VNSerifItalic", 8)
        c.setFillColor(quiet)
        c.drawString(left, 287, "Số liệu được trích xuất tự động; cần kiểm tra, phê duyệt trước khi phát hành.")

    centered(["PHÂN XƯỞNG VẬN HÀNH"], 635, 235, "VNSerifBold", 10.2)
    centered(["(Chưa ký, chưa phê duyệt)"], 635, 146, "VNSerifItalic", 8.3, color=quiet)
    c.setFont("VNSerif", 7.7)
    c.setFillColor(quiet)
    c.drawString(left, 44, f"Tạo tự động - {VERSION} | Giờ dữ liệu: Việt Nam (UTC+7) | Bản PDF thử nghiệm")
    c.showPage()
    c.save()
    return output


def report_meta(r: Report) -> dict[str, Any]:
    return {
        "report_version": VERSION, "report_date_vn": r.day.isoformat(),
        "report_hour_vn": r.hour, "source_time_mode": r.source_mode,
        "period_definition": "6 hourly readings ending at report hour: (T-6h, T]",
        "hourly_record_ids": r.hour_ids, "data_from_demo": r.demo,
        "data_quality": "PROVISIONAL_TAILWATER_60M" if r.tailwater_is_temporary else "TAILWATER_RECORDED",
        "values": {
            "water_level_m": fmt(r.upstream),
            "tailwater_level_m": fmt(r.tailwater),
            "mean_inflow_m3_s": fmt(r.mean_inflow),
            "mean_turbine_flow_m3_s": fmt(r.mean_turbine),
            "mean_spillway_flow_m3_s": fmt(r.mean_spillway),
            "rain_total_mm": fmt(r.rain_total, 1),
        }
    }


def clean_list(raw: str) -> list[str]:
    from email.utils import parseaddr
    import re
    result: list[str] = []
    for token in re.split(r"[,;\n]", raw):
        token = token.strip()
        if not token:
            continue
        address = parseaddr(token)[1]
        if not address or "@" not in address or address.count("@") != 1:
            raise ValueError(f"Địa chỉ email không hợp lệ: {token!r}")
        result.append(address)
    return sorted(set(result))


def mail_send_test(r: Report, pdf_path: Path) -> list[str]:
    host = env("SMTP_HOST")
    user = env("SMTP_USER")
    password = env("SMTP_PASSWORD")
    sender = env("SMTP_FROM", user)
    recipients = clean_list(env("REPORT_TEST_TO"))
    if not all([host, sender, recipients]):
        raise RuntimeError("Chưa cấu hình SMTP_HOST, SMTP_FROM và REPORT_TEST_TO (email thử nội bộ).")
    mode = env("SMTP_SECURITY", "ssl").lower()
    port = int(env("SMTP_PORT", "465" if mode == "ssl" else "587"))
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = (f"[BẢN THỬ NGHIỆM - HẠ LƯU TẠM TÍNH] "
                      f"Công ty CPTĐ A Vương - báo cáo số liệu vận hành lúc {r.hour:02d}h00 ngày "
                      f"{r.day.strftime('%d/%m/%Y')}")
    warning = (
        f"Mực nước hạ lưu nhà máy {fmt(r.tailwater).replace('.', ',')} m là GIẢ ĐỊNH TẠM THỜI, không phải số đo.\n"
        if r.tailwater_is_temporary else
        "Mực nước hạ lưu được lấy từ trường tailwater_level; cần đối soát nguồn.\n"
    )
    msg.set_content(
        "Kính gửi các anh/chị,\n\n"
        f"Đính kèm là BẢN THỬ NGHIỆM báo cáo số liệu vận hành hồ thủy điện A Vương "
        f"lúc {r.hour:02d}h00 ngày {r.day.strftime('%d/%m/%Y')}.\n"
        + warning +
        "Tài liệu chưa được ký hoặc phê duyệt; KHÔNG dùng để báo cáo chính thức.\n\n"
        "Trân trọng.\n"
    )
    msg.add_attachment(pdf_path.read_bytes(), maintype="application", subtype="pdf",
                       filename=pdf_path.name)
    context = ssl.create_default_context()
    if mode == "ssl":
        with smtplib.SMTP_SSL(host, port, timeout=30, context=context) as smtp:
            if user:
                if not password:
                    raise RuntimeError("SMTP_PASSWORD chưa được thiết lập.")
                smtp.login(user, password)
            failed = smtp.send_message(msg)
    elif mode == "starttls":
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            if user:
                if not password:
                    raise RuntimeError("SMTP_PASSWORD chưa được thiết lập.")
                smtp.login(user, password)
            failed = smtp.send_message(msg)
    else:
        raise ValueError("SMTP_SECURITY chỉ hỗ trợ ssl hoặc starttls. Không gửi email qua kết nối không mã hóa.")
    if failed:
        raise RuntimeError("SMTP từ chối một hoặc nhiều người nhận: " + repr(list(failed)))
    return recipients


def log_get(report_key: str) -> dict[str, Any] | None:
    rows = supabase_request("GET", "av_report_dispatch_log",
                            {"select": "*", "report_key": f"eq.{report_key}", "limit": "1"})
    return rows[0] if rows else None


def log_insert(log: dict[str, Any]) -> bool:
    result = supabase_request("POST", "av_report_dispatch_log", {"on_conflict": "report_key"},
                              [log], "resolution=ignore-duplicates,return=representation")
    return bool(result)


def log_update(report_key: str, updates: dict[str, Any]) -> None:
    supabase_request("PATCH", "av_report_dispatch_log",
                     {"report_key": f"eq.{report_key}"}, updates,
                     "return=minimal")


def sha256_path(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run() -> int:
    parser = argparse.ArgumentParser(description="Tạo PDF vận hành KTTV A Vương và gửi email thử nội bộ")
    parser.add_argument("--date", default="", help="Ngày VN YYYY-MM-DD; bỏ trống để lấy ngày hôm nay")
    parser.add_argument("--hour", type=int, choices=[7, 13, 19], default=19)
    parser.add_argument("--mode", choices=["preview", "test-email"], default="preview")
    parser.add_argument("--demo", action="store_true", help="PDF minh họa từ mẫu đính kèm, không kết nối DB")
    parser.add_argument("--retry-failed", action="store_true", help="Chỉ dùng khi SMTP đã lỗi (không dùng cho SENT)")
    parser.add_argument("--output-dir", default="reports/output")
    args = parser.parse_args()
    if args.demo and args.mode != "preview":
        raise ValueError("Demo không được phép gửi email.")
    report_day = parse_date(args.date) if args.date else vn_day()
    issue_vn = datetime(report_day.year, report_day.month, report_day.day,
                        args.hour, tzinfo=VN)
    if not args.demo and issue_vn > datetime.now(VN):
        raise RuntimeError("Chưa đến giờ kết thúc kỳ báo cáo. Không tạo báo cáo tương lai.")
    source_mode = env("SOURCE_TIME_MODE", "vn_label_stored_as_utc")
    fallback = decimal_value(env("TAILWATER_FALLBACK_M", "60.00"), "TAILWATER_FALLBACK_M")
    if args.demo:
        r = demo_report()
    else:
        rows = fetch_six_hours(report_day, args.hour, source_mode)
        r = aggregate_rows(report_day, args.hour, source_mode, rows, fallback)
        print("DATA QC PASS:", "6/6 hourly records;",
              "IDs", r.hour_ids, "; source time mode", source_mode)
    if r.tailwater_is_temporary:
        print(f"WARNING: tailwater_level NULL => {fmt(r.tailwater)} m TẠM TÍNH; chỉ báo cáo thử nghiệm.")
    base = f"{r.hour:02d}h00_{r.day.strftime('%d-%m-%Y')}_So_lieu_KTTV_DU_THAO"
    output_dir = Path(args.output_dir)
    output_pdf = draw_pdf(r, output_dir / (base + ".pdf"))
    meta = report_meta(r)
    meta["pdf_sha256"] = sha256_path(output_pdf)
    meta_path = output_dir / (base + ".json")
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print("PDF CREATED:", output_pdf.resolve())
    print("AUDIT CREATED:", meta_path.resolve())
    print("REPORT VALUES:", json.dumps(meta["values"], ensure_ascii=False))
    if args.mode == "preview":
        print("EMAIL: PREVIEW - KHÔNG gửi.")
        return 0

    # Luôn gửi test-only: không hỗ trợ gửi thư tự động chính thức khi có số đo giả định.
    recipients = clean_list(env("REPORT_TEST_TO"))
    if not recipients:
        raise RuntimeError("REPORT_TEST_TO chưa được khai báo.")
    report_key = f"test:{r.day.isoformat()}:{r.hour:02d}:{hashlib.sha256(','.join(recipients).encode()).hexdigest()[:12]}"
    existing = log_get(report_key)
    if existing and existing.get("status") == "SMTP_ACCEPTED":
        print("EMAIL SKIPPED (DUPLICATE): báo cáo đã được SMTP tiếp nhận; key=", report_key)
        return 0
    if existing and not (args.retry_failed and existing.get("status") == "FAILED"):
        raise RuntimeError(
            f"Report key={report_key} đã ở trạng thái {existing.get('status')}; "
            "không gửi lại tự động để tránh trùng. Với FAILED, dùng --retry-failed."
        )
    if existing:
        log_update(report_key, {"status": "SENDING", "error_text": None})
    else:
        claimed = log_insert({
            "report_key": report_key, "report_date": r.day.isoformat(),
            "report_hour": r.hour, "status": "SENDING",
            "is_provisional": r.provisional, "recipients": ",".join(recipients),
            "pdf_sha256": meta["pdf_sha256"],
        })
        if not claimed:
            raise RuntimeError("Có tiến trình khác đã giữ report_key; không gửi trùng.")
    try:
        sent_to = mail_send_test(r, output_pdf)
        log_update(report_key, {"status": "SMTP_ACCEPTED",
                                "sent_at": datetime.now(UTC).isoformat(),
                                "error_text": None})
        print("SMTP ACCEPTED (NOT INBOX CONFIRMATION):", ", ".join(sent_to))
    except Exception as e:
        log_update(report_key, {"status": "FAILED",
                                "error_text": str(e)[:900]})
        raise
    return 0


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Exception as exc:
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
