#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Báo cáo KTTV 4 kỳ A Vương, bố cục biểu mẫu vận hành.
QUY TẮC AN TOÀN:
 - Tailwater phải đọc từ reservoir_hourly_data.tailwater_level tại đúng giờ báo cáo.
 - Nếu thiếu tailwater thì ghi PENDING_DATA, KHÔNG dùng số 60.00 m và KHÔNG gửi email.
 - Chỉ gửi email đến danh sách kiểm thử đã cấu hình; chưa tự phê duyệt báo cáo.
 - Khóa đọc dữ liệu / SMTP nằm trong GitHub Secrets, không đưa lên website.
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
VERSION = "AVUONG_KTTV_4KY_V3_7"


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
                   rows: list[dict[str, Any]]) -> Report:
    if len(rows) != DEFAULT_PERIOD_HOURS:
        raise ValueError("Phải có đúng 6 bản ghi giờ.")
    # Mực nước tại đúng thời điểm báo cáo nằm ở bản ghi giờ cuối.
    w = decimal_value(rows[-1].get("water_level"), "water_level tại giờ phát hành")
    if not (Decimal("300") <= w <= Decimal("400")):
        raise ValueError(f"Mực nước thượng lưu ngoài phạm vi QC A Vương: {w}")
    # Chỉ chấp nhận SỐ ĐO THỰC tại đúng giờ báo cáo.
    # Giờ T phải có giá trị; KHÔNG dùng giá trị giờ T-1 và KHÔNG dự phòng 60 m.
    tail = decimal_value(rows[-1].get("tailwater_level"),
                         "tailwater_level tại đúng giờ báo cáo")
    if not (Decimal("0") < tail <= Decimal("100")):
        raise ValueError(f"DATA_QC_FAIL: mực nước hạ lưu ngoài phạm vi QC: {tail}")

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
        upstream=w, tailwater=tail, tailwater_is_temporary=False,
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
    """Require licensed Times New Roman from private-font checkout."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    folder = Path(env("AV_TNR_FONT_DIR", ".private-fonts")).expanduser()
    normal, bold = folder / "times.ttf", folder / "timesbd.ttf"
    if not normal.is_file() or not bold.is_file():
        raise RuntimeError(
            f"TIMES_NEW_ROMAN_REQUIRED: missing times.ttf/timesbd.ttf in {folder}; "
            "use authorized private font repository, do not substitute fonts."
        )
    if "AVTimes" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("AVTimes", str(normal)))
    if "AVTimesBold" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("AVTimesBold", str(bold)))
    # Italic may be supplied; otherwise use regular without falsely claiming italic.
    italic = folder / "timesi.ttf"
    if italic.is_file() and "AVTimesItalic" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("AVTimesItalic", str(italic)))


def draw_pdf(r: Report, output: Path) -> Path:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.pdfgen.canvas import Canvas
    from reportlab.pdfbase import pdfmetrics
    setup_font()
    output.parent.mkdir(parents=True, exist_ok=True)
    width, height = landscape(A4)
    c = Canvas(str(output), pagesize=(width, height), pageCompression=1)
    c.setTitle(f"Báo cáo số liệu vận hành hồ thủy điện A Vương {r.hour:02d}h00 {r.day:%d/%m/%Y}")
    black = colors.black
    d = r.day
    fmtday = d.strftime("%d/%m/%Y")
    end_clock = datetime(d.year, d.month, d.day, r.hour)
    start_clock = end_clock - timedelta(hours=DEFAULT_PERIOD_HOURS)
    # Date format is deliberately unambiguous for crossing midnight at 01h.
    period_from = start_clock.strftime("%Hh/%d/%m")
    period_to = end_clock.strftime("%Hh/%d/%m/%Y")

    # A4 landscape, left 25 mm / right 20 mm.
    left, right = 25 * 72 / 25.4, width - 20 * 72 / 25.4
    content_width = right - left
    left_block_center = left + 165
    right_block_center = right - 155
    page_center = (left + right) / 2

    def center(text, x, y, font="AVTimes", size=10):
        c.setFont(font, size)
        c.setFillColor(black)
        c.drawCentredString(x, y, text)

    for j, text in enumerate((
        "TỔNG CÔNG TY PHÁT ĐIỆN 2",
        "CÔNG TY CỔ PHẦN",
        "THỦY ĐIỆN A VƯƠNG",
    )):
        center(text, left_block_center, height - 51 - 15*j, "AVTimesBold", 11)
    center("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
           right_block_center, height - 51, "AVTimesBold", 11)
    slogan = "Độc lập - Tự do - Hạnh phúc"
    center(slogan, right_block_center, height - 68, "AVTimesBold", 11)
    # Center underline exactly below the slogan, not the entire right header.
    underline_width = min(170, pdfmetrics.stringWidth(slogan, "AVTimesBold", 11) * .83)
    c.setLineWidth(.65)
    c.line(right_block_center - underline_width/2, height - 76,
           right_block_center + underline_width/2, height - 76)

    c.setFont("AVTimes", 11)
    c.drawRightString(right, height - 108,
                      f"Đà Nẵng, ngày {d.day:02d} tháng {d.month:02d} năm {d.year}")
    center("BÁO CÁO SỐ LIỆU VẬN HÀNH HỒ THỦY ĐIỆN A VƯƠNG",
           page_center, height - 137, "AVTimesBold", 14)
    c.setFont("AVTimes", 10.1)
    c.drawString(left, height - 162,
        "Thực hiện theo quy định tại Khoản 5, Điều 40 Nghị định số 62/2025/NĐ-CP ngày 04/3/2025,")
    c.drawString(left, height - 175,
        "Công ty Cổ phần Thủy điện A Vương cung cấp số liệu vận hành hồ chứa như sau:")

    # Eight columns, total exactly equal to content width (approx 714 pt).
    units = [102, 58, 88, 90, 77, 77, 77, 145]
    factor = content_width / sum(units)
    x = [left]
    for unit in units:
        x.append(x[-1] + unit*factor)
    y_top, y_group, y_data, y_bottom = height-199, height-237, height-277, height-311

    c.setLineWidth(.7)
    c.rect(left, y_bottom, content_width, y_top-y_bottom, stroke=1, fill=0)
    for j, xi in enumerate(x[1:-1], start=1):
        c.line(xi, y_group if j in (5,6) else y_top, xi, y_bottom)
    c.line(x[4], y_group, x[7], y_group)
    c.line(left, y_data, right, y_data)

    def cell(col, lines, top, bottom, size=8.6, bold=True, line_height=11):
        font = "AVTimesBold" if bold else "AVTimes"
        baseline = (top + bottom)/2 + (len(lines)-1)*line_height/2 - size/3
        for i, text in enumerate(lines):
            center(text, (x[col]+x[col+1])/2,
                   baseline-i*line_height, font, size)

    cell(0, ["Ngày/tháng/năm"], y_top, y_data, 9)
    cell(1, ["Giờ"], y_top, y_data, 9)
    cell(2, ["Mực nước hồ", "thượng lưu", "(m)"], y_top, y_data)
    cell(3, ["Mực nước hạ", "lưu nhà máy", "(m)"], y_top, y_data)
    mid = (x[4]+x[7])/2
    center("Số liệu trung bình từ", mid, y_top-15, "AVTimesBold", 9.3)
    center(f"{period_from} ÷ {period_to}", mid, y_top-30, "AVTimesBold", 8.8)
    cell(4, ["Q đến hồ", "(m³/s)"], y_group, y_data)
    cell(5, ["Q chạy máy", "(m³/s)"], y_group, y_data)
    cell(6, ["Q xả tràn", "(m³/s)"], y_group, y_data)
    cell(7, ["Tổng lượng mưa từ", period_from + " ÷", period_to, "(mm)"],
         y_top, y_data, size=8.5, line_height=12)

    vals = [fmtday, f"{r.hour:02d}h00'",
            fmt(r.upstream), fmt(r.tailwater),
            fmt(r.mean_inflow), fmt(r.mean_turbine),
            fmt(r.mean_spillway), fmt(r.rain_total, 1)]
    for j, val in enumerate(vals):
        cell(j, [val], y_data, y_bottom, size=10, bold=False)

    # The PDF is an unsigned report-ready document. No false signature or
    # POC/test banner; test designation stays in email for internal recipients.
    center("PHÂN XƯỞNG VẬN HÀNH", right_block_center, height - 358,
           "AVTimesBold", 12)
    if r.demo:
        center("SỐ LIỆU MINH HỌA - KHÔNG SỬ DỤNG PHÁT HÀNH",
               page_center, 86, "AVTimesBold", 11)
    c.showPage()
    c.save()
    return output


def report_meta(r: Report) -> dict[str, Any]:
    return {
        "report_version": VERSION, "report_date_vn": r.day.isoformat(),
        "report_hour_vn": r.hour, "source_time_mode": r.source_mode,
        "period_definition": "6 hourly readings ending at report hour: (T-6h, T]",
        "hourly_record_ids": r.hour_ids,
        "tailwater_source": ("DEMO_ONLY" if r.demo else
                             "public.reservoir_hourly_data.tailwater_level"),
        "tailwater_record_id": (r.hour_ids[-1] if r.hour_ids else None),
        "data_from_demo": r.demo,
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
    # Google App Passwords are sometimes copied with visual group spaces.
    # Only for Gmail SMTP, remove spaces and tabs in the app password.
    if env("SMTP_HOST").lower() == "smtp.gmail.com":
        password = password.replace(" ", "").replace("\t", "")
    sender = env("SMTP_FROM", user)
    recipients = clean_list(env("REPORT_TEST_TO"))
    if not all([host, sender, recipients]):
        raise RuntimeError("Chưa cấu hình SMTP_HOST, SMTP_FROM và REPORT_TEST_TO (email thử nội bộ).")
    mode = env("SMTP_SECURITY", "ssl").lower()
    port = int(env("SMTP_PORT", "465" if mode == "ssl" else "587"))
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    tag = "[KIỂM TRA NỘI BỘ]"
    msg["Subject"] = (f"{tag} "
                      f"Công ty CPTĐ A Vương - báo cáo số liệu vận hành lúc {r.hour:02d}h00 ngày "
                      f"{r.day.strftime('%d/%m/%Y')}")
    warning = (
        f"Mực nước hạ lưu nhà máy {fmt(r.tailwater).replace('.', ',')} m là GIẢ ĐỊNH TẠM THỜI, không phải số đo.\n"
        if r.tailwater_is_temporary else
        f"Mực nước hạ lưu nhà máy {fmt(r.tailwater).replace('.', ',')} m được đọc "
        "từ dữ liệu quan trắc tại đúng giờ báo cáo; cần đối soát trước khi phê duyệt.\n"
    )
    msg.set_content(
        "Kính gửi các anh/chị,\n\n"
        f"Đính kèm báo cáo số liệu vận hành hồ thủy điện A Vương "
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
    parser.add_argument("--hour", type=int, choices=[1, 7, 13, 19], default=19)
    parser.add_argument("--mode", choices=["preview", "test-email"], default="preview")
    parser.add_argument("--demo", action="store_true", help="PDF minh họa từ mẫu đính kèm, không kết nối DB")
    parser.add_argument("--retry-failed", action="store_true", help="Chỉ dùng khi SMTP đã lỗi (không dùng cho SENT)")
    parser.add_argument("--allow-pending-data", action="store_true",
                        help="Lich tu dong: neu thieu gio/chi tieu thi ghi PENDING, khong gui, exit 0")
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
    if args.demo:
        r = demo_report()
    else:
        try:
            rows = fetch_six_hours(report_day, args.hour, source_mode)
            r = aggregate_rows(report_day, args.hour, source_mode, rows)
        except ValueError as error:
            description = str(error)
            # Chi nhung loi THIEU du lieu duoc thu lai vao phut 10.
            # Loi QC bat thuong, dang sai, loi API/DB van bao loi de van hanh kiem tra.
            is_missing = (
                description.startswith("DATA_INCOMPLETE:")
                or description.startswith("Thiếu số liệu bắt buộc:")
            )
            if not args.allow_pending_data or not is_missing:
                raise
            output_dir = Path(args.output_dir)
            output_dir.mkdir(parents=True, exist_ok=True)
            pending = {
                "status": "PENDING_DATA",
                "report_date_vn": report_day.isoformat(),
                "report_hour_vn": args.hour,
                "reason": description,
                "email_sent": False,
                "checked_at_vn": datetime.now(VN).isoformat(),
            }
            status_path = output_dir / (
                f"{args.hour:02d}h00_{report_day.strftime('%d-%m-%Y')}_PENDING_DATA.json"
            )
            status_path.write_text(
                json.dumps(pending, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print("REPORT_PENDING_DATA:", description)
            print("EMAIL: NOT SENT (waiting for full data).")
            # GitHub annotation: thieu du lieu la cho du lieu, khong phai gui thanh cong.
            safe_reason = description.replace("%", "%25").replace("\r", " ").replace("\n", " ")
            print(f"::warning title=BAO CAO {args.hour:02d}H DANG CHO DU LIEU::{safe_reason}")
            return 0
        print("DATA QC PASS:", "6/6 hourly records;",
              "IDs", r.hour_ids, "; source time mode", source_mode)
    if r.tailwater_is_temporary:
        print(f"WARNING: tailwater_level NULL => {fmt(r.tailwater)} m TẠM TÍNH; chỉ báo cáo thử nghiệm.")
    base = f"{r.hour:02d}h00_{r.day.strftime('%d-%m-%Y')}_So_lieu_KTTV"
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
