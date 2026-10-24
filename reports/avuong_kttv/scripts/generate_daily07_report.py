#!/usr/bin/env python3
"""A Vuong daily 07:00 operational report - preview PDF only.

Database convention: reservoir_hourly_data.time is timestamptz containing
the VN wall-clock label stored as UTC (+00), per SOURCE_TIME_MODE.
"""
import argparse
import json
import os
import hashlib
import smtplib
import ssl
from email.message import EmailMessage
from urllib.error import HTTPError
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import simpleSplit
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, KeepTogether, HRFlowable
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

FIELDS = ("water_level", "tailwater_level", "inflow", "turbine_flow", "spillway_flow", "rainfallreal")
TZ_LABEL = timezone.utc

def expected_times(d):
    start = datetime.combine(d - timedelta(days=1), datetime.min.time()) + timedelta(hours=1)
    return [start + timedelta(hours=i) for i in range(31)]

def fetch_rows(d):
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        raise RuntimeError("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY")
    times = expected_times(d)
    start, end = times[0], times[-1]
    params = urlencode({
        "select": "time,created_at,water_level,tailwater_level,inflow,turbine_flow,spillway_flow,rainfallreal",
        "time": f"gte.{start.strftime('%Y-%m-%dT%H:%M:%S')}+00:00",
        "order": "time.asc,created_at.desc",
        "limit": "1000",
    })
    # separate upper bound to avoid dict key collision
    url = f"{base}/rest/v1/reservoir_hourly_data?{params}&time=lte.{end.strftime('%Y-%m-%dT%H:%M:%S')}%2B00%3A00"
    req = Request(url, headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"})
    with urlopen(req, timeout=30) as resp:
        return json.load(resp)

def parse_time(raw):
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        raise ValueError("time must be timezone-aware")
    # Interpret the UTC components as the VN wall-clock label, NOT convert to +07
    return dt.astimezone(timezone.utc).replace(tzinfo=None)

def validate(raw_rows, d):
    wanted = expected_times(d)
    latest = {}
    # choose latest created_at if duplicate, independently of returned ordering
    for row in raw_rows:
        t = parse_time(row["time"])
        if t not in latest or (row.get("created_at") or "") > (latest[t].get("created_at") or ""):
            latest[t] = row
    missing_hours = [t.strftime("%Y-%m-%d %H:%M") for t in wanted if t not in latest]
    missing_values = []
    for t in wanted:
        row = latest.get(t)
        if row:
            for f in FIELDS:
                if row.get(f) is None:
                    missing_values.append(f"{t:%Y-%m-%d %H:%M}: {f}")
    if missing_hours or missing_values:
        raise ValueError("PENDING_DATA: " + json.dumps({
            "missing_hours": missing_hours, "missing_fields": missing_values
        }, ensure_ascii=False))
    return [(t, latest[t]) for t in wanted]

def set_font():
    """Require genuine Times New Roman files; do not silently substitute fonts."""
    import os
    base = Path(os.environ.get("AV_TNR_FONT_DIR", "reports/avuong_kttv/private_fonts"))
    regular = base / "times.ttf"
    bold = base / "timesbd.ttf"
    if not (regular.is_file() and bold.is_file()):
        raise RuntimeError(
            "TIMES_NEW_ROMAN_REQUIRED: supply times.ttf and timesbd.ttf "
            "in AV_TNR_FONT_DIR (private, licensed fonts). "
            "No font substitution is permitted for report release."
        )
    if "AV" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("AV", str(regular)))
    if "AV-Bold" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("AV-Bold", str(bold)))

def fmt(v):
    return f"{float(v):.2f}"

def build_pdf(rows, d, output):
    set_font()
    W,H=A4
    doc = SimpleDocTemplate(str(output), pagesize=A4, rightMargin=28,
                            leftMargin=28, topMargin=30, bottomMargin=32,
                            title=f"A Vuong KTTV daily 07h {d:%d-%m-%Y}")
    normal=ParagraphStyle("n",fontName="AV",fontSize=8.0,leading=11)
    center=ParagraphStyle("c",parent=normal,alignment=TA_CENTER)
    bold=ParagraphStyle("b",parent=center,fontName="AV-Bold",fontSize=8.5,leading=11)
    head=ParagraphStyle("h",parent=center,fontName="AV-Bold",fontSize=10,leading=14)
    italic=ParagraphStyle("i",parent=normal,fontSize=8,alignment=TA_RIGHT)
    tiny=ParagraphStyle("tiny",parent=center,fontSize=7,leading=9)
    P=lambda s,sty=center:Paragraph(s,sty)
    top=Table([
        [P("TỔNG CÔNG TY PHÁT ĐIỆN 2<br/>CÔNG TY CỔ PHẦN<br/>THỦY ĐIỆN A VƯƠNG",bold),
         [P("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",bold),
          P("Độc lập - Tự do - Hạnh phúc",bold),
          Spacer(1,4),HRFlowable(width=165,thickness=0.8,color=colors.black,hAlign="CENTER")]]
    ],colWidths=[263,263])
    top.setStyle(TableStyle([("VALIGN",(0,0),(-1,-1),"TOP"),
                             ("LEFTPADDING",(0,0),(-1,-1),0),("RIGHTPADDING",(0,0),(-1,-1),0)]))
    story=[top, Spacer(1,11),
           P(f"Đà Nẵng, ngày {d.day:02d} tháng {d.month:02d} năm {d.year}",italic),
           Spacer(1,10),
           P("BÁO CÁO SỐ LIỆU VẬN HÀNH HỒ THỦY ĐIỆN A VƯƠNG",head),
           Spacer(1,12)]
    headers=[
        "Ngày/tháng<br/>/năm","Giờ","Mực nước hồ<br/>thượng lưu<br/>(m)",
        "Mực nước hạ<br/>lưu nhà máy<br/>(m)",
        "Q đến hồ<br/>(m³/s)","Q chạy máy<br/>(m³/s)",
        "Q xả tràn<br/>(m³/s)","Lượng mưa<br/>(mm)"
    ]
    data=[[P(x,tiny) for x in headers]]
    for t,r in rows:
        shown_date = t.date()
        hour=t.hour
        if hour==0:
            shown_date=t.date()-timedelta(days=1)
            hour=24
        data.append([
            shown_date.strftime("%d/%m/%Y"),
            f"{hour:02d}h00'",
            fmt(r["water_level"]),fmt(r["tailwater_level"]),
            fmt(r["inflow"]),fmt(r["turbine_flow"]),fmt(r["spillway_flow"]),
            fmt(r["rainfallreal"])
        ])
    widths=[85,46,72,73,66,68,61,55]
    tab=Table(data,colWidths=widths,repeatRows=1,hAlign="CENTER")
    tab.setStyle(TableStyle([
        ("FONTNAME",(0,1),(-1,-1),"AV"),("FONTSIZE",(0,1),(-1,-1),7.5),
        ("ALIGN",(0,0),(-1,-1),"CENTER"),("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("GRID",(0,0),(-1,-1),0.45,colors.black),
        ("TOPPADDING",(0,0),(-1,0),8),("BOTTOMPADDING",(0,0),(-1,0),8),
        ("TOPPADDING",(0,1),(-1,-1),5),("BOTTOMPADDING",(0,1),(-1,-1),5),
        ("LEFTPADDING",(0,0),(-1,-1),2),("RIGHTPADDING",(0,0),(-1,-1),2),
    ]))
    story += [tab,Spacer(1,18),
              Table([["",P("PHÂN XƯỞNG VẬN HÀNH",bold)]],
                    colWidths=[270,256]),
              Spacer(1,40),
              
              Spacer(1,9),
              P("Nơi nhận: Theo danh sách được phê duyệt; Lưu vận hành.",normal)]
    doc.build(story)


def rest_request(method, endpoint, payload=None, prefer=None):
    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    headers = {
        "apikey": key, "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(f"{base}/rest/v1/{endpoint}", data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except HTTPError as e:
        if e.code == 409:
            return {"_conflict": True}
        raise RuntimeError(f"Supabase REST {e.code}: {e.read().decode('utf-8', errors='replace')[:400]}") from e

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
    ap.add_argument("--date",required=True,help="YYYY-MM-DD in Vietnam")
    ap.add_argument("--output-dir",default="reports/avuong_kttv/reports/output")
    ap.add_argument("--fixture",help="Offline JSON test rows, no Supabase call")
    ap.add_argument("--send-test-email", action="store_true",
                    help="Send only to REPORT_TEST_TO using SMTP; requires dispatch log table")
    args=ap.parse_args()
    d=date.fromisoformat(args.date)
    raw=json.loads(Path(args.fixture).read_text(encoding="utf-8")) if args.fixture else fetch_rows(d)
    rows=validate(raw,d)
    out=Path(args.output_dir)
    out.mkdir(parents=True,exist_ok=True)
    pdf=out / f"KTTV_DAILY07_{d:%Y%m%d}_PREVIEW.pdf"
    build_pdf(rows,d,pdf)
    print(f"PDF_READY {pdf} rows={len(rows)}")
    if args.send_test_email:
        send_email_once(pdf, d)
    else:
        print("PREVIEW_ONLY NO_EMAIL")

if __name__ == "__main__":
    main()
