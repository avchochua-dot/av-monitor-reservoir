#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A Vuong DAILY07 V3.9: data validation and source-matched PDF layout.
Keeps the public interface expected by generate_daily07_bundle.py.
No credentials, recipients or fonts are bundled in this source file.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import smtplib
import ssl
import unicodedata
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from email.message import EmailMessage
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import Paragraph, Table, TableStyle

VERSION = "AV_DAILY07_V3_9_DATA_LAYOUT"
VN = ZoneInfo("Asia/Ho_Chi_Minh")
UTC = timezone.utc
FIELDS = ("water_level", "tailwater_level", "inflow", "turbine_flow",
          "spillway_flow", "rainfallreal")
FLOW_FIELDS = ("inflow", "turbine_flow", "spillway_flow")
PAGE_W, PAGE_H = A4
LEFT = 25 * mm
RIGHT = PAGE_W - 20 * mm
WIDTH = RIGHT - LEFT
CENTRE = (LEFT + RIGHT) / 2
# Header anchors also anchor the slogan's underline; never offset independently.
RIGHT_CENTRE = RIGHT - 132
LEFT_CENTRE = LEFT + 88


def env(name, default=""):
    return os.environ.get(name, default).strip()


def parse_day(value):
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("Ngay phai co dang YYYY-MM-DD")
    return date.fromisoformat(value)


def expected_times(d):
    return [datetime.combine(d - timedelta(days=1), datetime.min.time())
            + timedelta(hours=1 + i) for i in range(31)]


def hydro_times(d):
    """d is the historical row label: readings 08h d through 07h d+1."""
    start = datetime.combine(d, datetime.min.time()) + timedelta(hours=8)
    return [start + timedelta(hours=i) for i in range(24)]


def parse_time(raw):
    parsed = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("INVALID_TIME: timezone is required")
    mode = env("SOURCE_TIME_MODE", "vn_label_stored_as_utc")
    if mode == "vn_label_stored_as_utc":
        return parsed.astimezone(UTC).replace(tzinfo=None)
    if mode == "true_utc":
        return parsed.astimezone(VN).replace(tzinfo=None)
    raise ValueError("SOURCE_TIME_MODE is not supported")


def query_time(clock):
    mode = env("SOURCE_TIME_MODE", "vn_label_stored_as_utc")
    if mode == "vn_label_stored_as_utc":
        aware = clock.replace(tzinfo=UTC)
    elif mode == "true_utc":
        aware = clock.replace(tzinfo=VN).astimezone(UTC)
    else:
        raise ValueError("SOURCE_TIME_MODE is not supported")
    return aware.isoformat(timespec="seconds").replace("+00:00", "Z")


def api_base():
    base = env("SUPABASE_URL").rstrip("/")
    key = env("SUPABASE_SERVICE_ROLE_KEY")
    if not base.startswith("https://") or not key:
        raise RuntimeError("Missing/invalid SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
    return base, key


def rest_request(method, endpoint, payload=None, prefer=None):
    base, key = api_base()
    headers = {"apikey": key, "Authorization": "Bearer " + key,
               "Accept": "application/json", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = Request(base + "/rest/v1/" + endpoint, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            body = response.read()
            return json.loads(body) if body else None
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            error = json.loads(text)
        except ValueError:
            error = {}
        # Only a uniqueness conflict is an already-claimed report.
        if exc.code == 409 and error.get("code") == "23505":
            return {"_conflict": True}
        raise RuntimeError(f"Supabase REST {exc.code}: {text[:600]}") from None
    except URLError as exc:
        raise RuntimeError("Cannot connect to Supabase: " + str(exc.reason)) from None


def fetch_range(start, end):
    """Paginate all records in an exact inclusive wall-clock interval.
    Pagination advances by returned rows, including when server cap is < limit.
    """
    if start > end:
        return []
    records, offset = [], 0
    reservoir = env("RESERVOIR_ID", "is.null")
    if reservoir != "is.null":
        import uuid
        uuid.UUID(reservoir)
    for _ in range(20000):
        params = {
            "select": "id,reservoir_id,time,created_at," + ",".join(FIELDS),
            "and": f"(time.gte.{query_time(start)},time.lte.{query_time(end)})",
            "order": "time.asc,created_at.asc,id.asc",
            "limit": "500", "offset": str(offset),
            "reservoir_id": "is.null" if reservoir == "is.null" else f"eq.{reservoir}",
        }
        page = rest_request("GET", "reservoir_hourly_data?" + urlencode(params))
        if not isinstance(page, list):
            raise RuntimeError("Invalid reservoir_hourly_data API response")
        if not page:
            return records
        records.extend(page)
        offset += len(page)
    raise RuntimeError("Pagination safety limit exceeded; no report was sent")


def fetch_rows(d):
    times = expected_times(d)
    return fetch_range(times[0], times[-1])


def number(value, label):
    if value is None or value == "":
        raise ValueError("PENDING_DATA: " + label)
    try:
        result = Decimal(str(value))
    except Exception:
        raise ValueError("INVALID_DATA: " + label) from None
    if not result.is_finite():
        raise ValueError("INVALID_DATA non-finite: " + label)
    return result


def latest_rows(raw_rows):
    """Newest created_at then stable ID. Never round or forward-fill timestamps."""
    selected = {}
    ranks = {}
    for row in raw_rows:
        t = parse_time(row["time"])
        raw_created = row.get("created_at")
        created = (datetime.fromisoformat(str(raw_created).replace("Z", "+00:00"))
                   if raw_created else datetime.min.replace(tzinfo=UTC))
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        rid = row.get("id")
        id_key = str(rid).zfill(24) if str(rid).isdigit() else str(rid or "")
        rank = (created.astimezone(UTC), id_key)
        if t not in ranks or rank > ranks[t]:
            selected[t], ranks[t] = row, rank
    return selected


def select_exact(raw_rows, wanted, fields=FIELDS):
    selected = latest_rows(raw_rows)
    missing = [t.isoformat(" ") for t in wanted if t not in selected]
    if missing:
        raise ValueError("PENDING_DATA missing timestamps: " + ", ".join(missing[:30]))
    result = []
    for t in wanted:
        row = selected[t]
        for field in fields:
            val = number(row.get(field), f"{t} {field}")
            if field in (*FLOW_FIELDS, "rainfallreal") and val < 0:
                raise ValueError(f"INVALID_DATA: {t} negative {field}")
        result.append((t, row))
    return result


def validate(raw_rows, d):
    return select_exact(raw_rows, expected_times(d))


def mean(rows, field):
    if not rows:
        raise ValueError("PENDING_DATA: cannot average an empty period")
    return sum((number(r[field], field) for _, r in rows), Decimal(0)) / Decimal(len(rows))


def fmt(value, places=2):
    return format(number(value, "display").quantize(
        Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP), f".{places}f")


def set_font():
    """Only the licensed private Times New Roman directory is accepted."""
    base = Path(env("AV_TNR_FONT_DIR", ".private-fonts"))
    for name, filename in (("AV", "times.ttf"), ("AV-Bold", "timesbd.ttf")):
        font_file = base / filename
        if not font_file.is_file():
            raise RuntimeError(f"TIMES_NEW_ROMAN_REQUIRED: missing {filename} in AV_TNR_FONT_DIR")
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(font_file)))
    for name, filename in (("AV-Italic", "timesi.ttf"), ("AV-BoldItalic", "timesbi.ttf")):
        p = base / filename
        if p.is_file() and name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(p)))


def draw_text(canvas, text, x, y, size=12, bold=False, italic=False, align="left"):
    """True italic when available, else oblique transform of the same TNR face."""
    text = unicodedata.normalize("NFC", str(text))
    regular = "AV-Bold" if bold else "AV"
    desired = "AV-BoldItalic" if bold else "AV-Italic"
    face = desired if italic and desired in pdfmetrics.getRegisteredFontNames() else regular
    if align not in ("left", "center", "right"):
        raise ValueError("Invalid text alignment")
    width = pdfmetrics.stringWidth(text, face, size)
    xx = x - (width / 2 if align == "center" else width if align == "right" else 0)
    canvas.saveState()
    canvas.setFillColor(colors.black)
    canvas.setFont(face, size)
    if italic and face == regular:
        # Keep the visible slanted ink inside the right margin, not just its advance width.
        overhang = 0.18 * max(0, pdfmetrics.getAscent(face)) * size / 1000
        if align == "right":
            xx -= overhang
        elif align == "center":
            xx -= overhang / 2
        canvas.translate(xx, y)
        canvas.transform(1, 0, 0.18, 1, 0, 0)
        canvas.drawString(0, 0, text)
    else:
        canvas.drawString(xx, y, text)
    canvas.restoreState()
    return width


def draw_header(canvas, d, include_hour=False, document_number=None):
    y = PAGE_H - 55
    draw_text(canvas, "TỔNG CÔNG TY PHÁT ĐIỆN 2", LEFT_CENTRE, y, 11.5, align="center")
    draw_text(canvas, "CÔNG TY CỔ PHẦN", LEFT_CENTRE, y-14, 12, bold=True, align="center")
    unit = "THỦY ĐIỆN A VƯƠNG"
    unit_width = draw_text(canvas, unit, LEFT_CENTRE, y-28, 12, bold=True, align="center")
    # Unit underline matches the supplied daily-report specimen.
    canvas.setLineWidth(0.45)
    canvas.line(LEFT_CENTRE-unit_width*0.34, y-32,
                LEFT_CENTRE+unit_width*0.34, y-32)

    draw_text(canvas, "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
              RIGHT_CENTRE, y, 12, bold=True, align="center")
    slogan = "Độc lập - Tự do - Hạnh phúc"
    sw = draw_text(canvas, slogan, RIGHT_CENTRE, y-14, 12, bold=True, align="center")
    # Exactly the same center used for both text and rule.
    rule_width = sw * 0.90
    canvas.setLineWidth(0.55)
    canvas.line(RIGHT_CENTRE-rule_width/2, y-18.5,
                RIGHT_CENTRE+rule_width/2, y-18.5)
    hour = "07h " if include_hour else ""
    draw_text(canvas, f"Đà Nẵng, {hour}ngày {d.day:02d} tháng {d.month:02d} năm {d.year}",
              RIGHT, y-49, 12, italic=True, align="right")
    if document_number is not None:
        value = document_number or "       /BC-TĐAV"
        draw_text(canvas, "Số: " + value, LEFT_CENTRE, y-49, 11.5, align="center")


def p(text, size=11, bold=False, leading=None):
    return Paragraph(str(text).replace("³", "<super>3</super>"), ParagraphStyle(
        "_cell", fontName="AV-Bold" if bold else "AV",
        fontSize=size, leading=leading or size+1.7,
        alignment=TA_CENTER, spaceBefore=0, spaceAfter=0))


def place_table(canvas, table, top):
    width, height = table.wrap(WIDTH, PAGE_H)
    if width > WIDTH + 0.2:
        raise RuntimeError("LAYOUT_ERROR: table exceeds the content width")
    if top - height < 35 * mm:
        raise RuntimeError("LAYOUT_ERROR: table leaves insufficient bottom margin")
    table.drawOn(canvas, LEFT, top - height)
    return top - height


def draw_sign_and_recipients(canvas, bottom, recipients):
    sign_y = bottom - 28
    draw_text(canvas, "PHÂN XƯỞNG VẬN HÀNH", RIGHT_CENTRE, sign_y,
              12.5, bold=True, align="center")
    y = sign_y - 13
    draw_text(canvas, "Nơi nhận:", LEFT+3, y, 11.5, bold=True, italic=True)
    for line in recipients:
        y -= 14
        draw_text(canvas, "- " + line, LEFT+8, y, 11.5)


def _kttv_table(rows, include_header=True):
    headers = ["Ngày/tháng<br/>/năm", "Giờ", "Mực nước<br/>hồ thượng<br/>lưu (m)",
               "Mực nước<br/>hạ lưu nhà<br/>máy (m)", "Q đến hồ<br/>(m³/s)",
               "Q chạy máy<br/>(m³/s)", "Q xả tràn<br/>(m³/s)", "Lượng mưa<br/>(mm)"]
    data = [[p(h, 11.5, True) for h in headers]] if include_header else []
    startrow = len(data)
    labels = []
    for t, r in rows:
        shown_day = t.date() if t.hour else t.date() - timedelta(days=1)
        labels.append(shown_day)
        data.append([shown_day.strftime("%d/%m/%Y"), f"{t.hour or 24}h00'",
                     *(fmt(r[f]) for f in FIELDS)])
    widths = [69, 42, 61, 68, 55, 57, 53, WIDTH-405]
    table = Table(data, colWidths=widths,
                  minRowHeights=([62] if include_header else []) + [19] * len(rows))
    style = [
        ("GRID", (0,0), (-1,-1), 0.45, colors.black),
        ("FONTNAME", (0,startrow), (-1,-1), "AV"),
        ("FONTSIZE", (0,startrow), (-1,-1), 12.5),
        ("LEADING", (0,startrow), (-1,-1), 13.5),
        ("ALIGN", (0,0), (-1,-1), "CENTER"),
        ("VALIGN", (0,0), (-1,-1), "MIDDLE"),
        ("LEFTPADDING", (0,0), (-1,-1), 2),
        ("RIGHTPADDING", (0,0), (-1,-1), 2),
        ("TOPPADDING", (0,0), (-1,-1), 2.5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 2.5),
    ]
    group_start = 0
    for i in range(1, len(labels)+1):
        if i == len(labels) or labels[i] != labels[group_start]:
            a,b = startrow+group_start, startrow+i-1
            if a < b:
                style.append(("SPAN",(0,a),(0,b)))
                for rowno in range(a+1,b+1):
                    data[rowno][0] = ""
            group_start = i
    table.setStyle(TableStyle(style))
    return table


def build_pdf(rows, d, output):
    if len(rows) != 31 or [t for t,_ in rows] != expected_times(d):
        raise ValueError("PENDING_DATA: expected 31 consecutive hourly readings")
    set_font()
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas = Canvas(str(output), pagesize=A4, pageCompression=1)
    canvas.setTitle(f"Báo cáo KTTV tổng hợp 07h ngày {d:%d/%m/%Y}")
    canvas.setAuthor("Công ty Cổ phần Thủy điện A Vương")
    draw_header(canvas, d)
    draw_text(canvas, "BÁO CÁO SỐ LIỆU VẬN HÀNH HỒ THỦY ĐIỆN A VƯƠNG",
              CENTRE, PAGE_H-139, 12.5, bold=True, align="center")
    # Same pagination as the specimen: 24 previous-day rows + 3 current rows.
    place_table(canvas, _kttv_table(rows[:27]), PAGE_H-162)
    canvas.showPage()
    # Continuation table keeps the date group and uses the same physical widths.
    bottom = place_table(canvas, _kttv_table(rows[27:], include_header=False), PAGE_H-60)
    draw_sign_and_recipients(canvas, bottom,
                            ["Ban chỉ huy PTDS TP Đà Nẵng;", "Lưu VH."])
    canvas.showPage()
    canvas.save()
    return output


def document_number(d):
    direct = env("REPORT_DOCUMENT_NUMBER")
    if direct:
        return direct
    config = Path(__file__).resolve().parents[1] / "config" / "report_numbers.json"
    if config.is_file():
        return str(json.loads(config.read_text(encoding="utf-8")).get(d.isoformat(), ""))
    return ""


def render_reservoir_pdf(rows, d, output, generation_hours=None):
    """12 display rows; all daily statistics use 24 exact hourly observations."""
    set_font()
    if [t for t,_ in rows[:24]] != expected_times(d)[:24]:
        raise ValueError("PENDING_DATA: daily 01h..24h readings are not complete")
    day = rows[:24]
    hours = sum(number(r["turbine_flow"], "turbine_flow") > 0 for _,r in day)
    if generation_hours is not None and generation_hours != hours:
        raise AssertionError("Generation-hour mismatch")
    selected = day[::2]
    prev = d - timedelta(days=1)
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    canvas=Canvas(str(output),pagesize=A4,pageCompression=1)
    canvas.setTitle(f"Số liệu vận hành Nhà máy thủy điện A Vương ngày {prev:%d/%m/%Y}")
    canvas.setAuthor("Công ty Cổ phần Thủy điện A Vương")
    draw_header(canvas,d,include_hour=True,document_number=document_number(d))
    draw_text(canvas,"BÁO CÁO",CENTRE,PAGE_H-137,14,bold=True,align="center")
    draw_text(canvas,"Số liệu vận hành Nhà máy thủy điện A Vương",
              CENTRE,PAGE_H-153,12,align="center")
    draw_text(canvas,"Kính gửi: Cục Quản lý tài nguyên nước.",
              CENTRE,PAGE_H-179,12,align="center")
    draw_text(canvas,f"Bảng số liệu vận hành ngày {prev.day:02d} tháng {prev.month:02d} năm {prev.year}",
              CENTRE,PAGE_H-208,12.5,bold=True,align="center")
    top = [
        p("Thời gian",11), "", p("Mực nước<br/>hồ",11), p("Lưu lượng<br/>đến hồ",11),
        p("Tổng lưu lượng nước xả",11), "", "",
        p("Số giờ<br/>phát điện<br/>trong ngày<br/>(giờ)",10.5), p("Ghi<br/>chú",11)]
    sub = [p("Ngày",11),p("Giờ",11),p("m",11),p("m³/s",11),
           p("Tổng Qxả<br/>(m³/s)",10.5),
           p("Qxả qua<br/>nhà máy<br/>(m³/s)",10.5),
           p("Qxả qua<br/>tràn<br/>(m³/s)",10.5),"",""]
    data=[top,sub]
    for i,(t,r) in enumerate(selected):
        qm=number(r["turbine_flow"],"turbine_flow")
        qs=number(r["spillway_flow"],"spillway_flow")
        data.append([prev.strftime("%d/%m/%Y") if not i else "",str(t.hour),
                     fmt(r["water_level"]),fmt(r["inflow"]),fmt(qm+qs),
                     fmt(qm),fmt(qs),str(hours) if not i else "",""])
    data.append(["",p("TB<br/>ngày",11,True),"",fmt(mean(day,"inflow")),
                 fmt(mean(day,"turbine_flow")+mean(day,"spillway_flow")),
                 fmt(mean(day,"turbine_flow")),fmt(mean(day,"spillway_flow")),"",""])
    widths=[64,30,57,60,64,62,59,45,WIDTH-441]
    table=Table(data,colWidths=widths,minRowHeights=[55,46]+[20]*12+[31])
    style=[
        ("GRID",(0,0),(-1,-1),0.45,colors.black),
        ("SPAN",(0,0),(1,0)), ("SPAN",(4,0),(6,0)),
        ("SPAN",(7,0),(7,1)), ("SPAN",(8,0),(8,1)),
        ("SPAN",(0,2),(0,14)),   # day cell includes TB row, as in the specimen
        ("SPAN",(7,2),(7,14)),   # one generation-hours cell, not repeated
        ("FONTNAME",(0,2),(-1,-1),"AV"),
        ("FONTSIZE",(0,2),(-1,-1),11),
        ("LEADING",(0,2),(-1,-1),12.5),
        ("ALIGN",(0,0),(-1,-1),"CENTER"),
        ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("LEFTPADDING",(0,0),(-1,-1),2),
        ("RIGHTPADDING",(0,0),(-1,-1),2),
        ("TOPPADDING",(0,0),(-1,-1),2.5),
        ("BOTTOMPADDING",(0,0),(-1,-1),2.5),
    ]
    # Specimen has an unruled dividing line within main label + its unit.
    # Grid hierarchy is deliberately explicit, not a flattened one-row header.
    table.setStyle(TableStyle(style))
    bottom=place_table(canvas,table,PAGE_H-226)
    draw_sign_and_recipients(canvas,bottom,["Như kính gửi;","Ban GĐ;","Lưu VH, KTAT."])
    canvas.showPage();canvas.save()
    return hours


def send_email_once(pdf, report_date):
    """
    One claim per report_date across all recipient configurations.
    Do not retry uncertain SMTP acceptance automatically.
    """
    to_raw = os.environ.get("REPORT_TEST_TO", "")
    recipients = sorted(set(
        x.strip().lower() for x in to_raw.replace(";", ",").split(",") if x.strip()
    ))
    if not recipients:
        raise ValueError("REPORT_TEST_TO is empty")
    needed = ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM")
    missing = [k for k in needed if not os.environ.get(k)]
    if missing:
        raise ValueError("Missing SMTP config: " + ", ".join(missing))
    if os.environ.get("SMTP_SECURITY", "ssl").lower() not in ("ssl", "starttls"):
        raise ValueError("SMTP_SECURITY must be ssl or starttls")
    report_key = f"daily07:test:{report_date.isoformat()}"
    sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    claim = {
        "report_date": report_date.isoformat(),
        "status": "SENDING",
        "recipients": ",".join(recipients),
        "pdf_sha256": sha,
    }
    # Table uses PRIMARY KEY report_date; atomic INSERT rejects duplicate requests.
    result = rest_request("POST", "av_daily07_dispatch_log", claim,
                          "return=representation")
    if isinstance(result, dict) and result.get("_conflict"):
        print(f"EMAIL_SKIPPED_ALREADY_CLAIMED {report_key}")
        return
    print(f"EMAIL_CLAIMED {report_key}", flush=True)
    msg = EmailMessage()
    msg["Subject"] = (
        f"[BAN THU NGHIEM] A Vuong - Bao cao KTTV tong hop 07h "
        f"ngay {report_date:%d/%m/%Y}"
    )
    msg["From"] = os.environ["SMTP_FROM"]
    msg["To"] = ", ".join(recipients)
    msg.set_content(
        "Kinh gui cac anh/chi,\n\n"
        f"Dinh kem ban THU NGHIEM bao cao KTTV tong hop 07h ngay "
        f"{report_date:%d/%m/%Y} (31 moc gio).\n"
        "Bao cao chua duoc ky, phe duyet; KHONG dung de phat hanh chinh thuc.\n\n"
        "Tran trong."
    )
    msg.add_attachment(
        pdf.read_bytes(), maintype="application", subtype="pdf",
        filename=pdf.name
    )
    port = int(os.environ.get("SMTP_PORT", "465"))
    security = os.environ.get("SMTP_SECURITY", "ssl").lower()
    ctx = ssl.create_default_context()
    try:
        if security == "ssl":
            server = smtplib.SMTP_SSL(os.environ["SMTP_HOST"], port,
                                       timeout=35, context=ctx)
        else:
            server = smtplib.SMTP(os.environ["SMTP_HOST"], port, timeout=35)
        with server as smtp:
            if security == "starttls":
                smtp.starttls(context=ctx)
            smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])
            refused = smtp.send_message(msg)
            if refused:
                raise RuntimeError(f"SMTP refused recipients: {list(refused)}")
    except Exception as exc:
        # FAILED_UNCERTAIN is intentionally terminal: SMTP acceptance may
        # have occurred before a network error. Never blindly retry.
        try:
            rest_request("PATCH",
                f"av_daily07_dispatch_log?report_date=eq.{report_date.isoformat()}",
                {"status": "NEEDS_REVIEW", "error_text": str(exc)[:1000]})
        except Exception as log_exc:
            print(f"LOG_UPDATE_ERROR {log_exc}", flush=True)
        raise
    rest_request("PATCH",
        f"av_daily07_dispatch_log?report_date=eq.{report_date.isoformat()}",
        {"status": "SMTP_ACCEPTED", "sent_at": datetime.now(timezone.utc).isoformat()})
    print(f"EMAIL_SMTP_ACCEPTED {report_key} recipients={len(recipients)}")



def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--date",required=True)
    ap.add_argument("--output-dir",default="reports/avuong_kttv/reports/output")
    ap.add_argument("--fixture")
    ap.add_argument("--send-test-email",action="store_true")
    args=ap.parse_args()
    if args.fixture and args.send_test_email:
        raise ValueError("Offline fixtures must never be emailed")
    d=parse_day(args.date)
    raw=json.loads(Path(args.fixture).read_text(encoding="utf-8")) if args.fixture else fetch_rows(d)
    if isinstance(raw,dict):
        raw=raw["rows"]
    rows=validate(raw,d)
    out=Path(args.output_dir);out.mkdir(parents=True,exist_ok=True)
    pdf=out/f"07h00_{d:%d-%m-%Y}_So_lieu_KTTV_tong_hop.pdf"
    build_pdf(rows,d,pdf)
    print("PDF_READY",pdf,"rows=31")
    if args.send_test_email:
        send_email_once(pdf,d)
    else:
        print("PREVIEW_ONLY_NO_EMAIL")


if __name__=="__main__":
    main()
