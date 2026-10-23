#!/usr/bin/env python3
"""A Vuong daily 07:00 operational report - preview PDF only.

Database convention: reservoir_hourly_data.time is timestamptz containing
the VN wall-clock label stored as UTC (+00), per SOURCE_TIME_MODE.
"""
import argparse
import json
import os
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import simpleSplit
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, KeepTogether
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
    paths = [
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
         "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"),
    ]
    for regular, bold in paths:
        if Path(regular).exists() and Path(bold).exists():
            pdfmetrics.registerFont(TTFont("AV", regular))
            pdfmetrics.registerFont(TTFont("AV-Bold", bold))
            return
    raise RuntimeError("Install fonts-dejavu-core")

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
         P("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM<br/>Độc lập - Tự do - Hạnh phúc",bold)]
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
              P("PHÂN XƯỞNG VẬN HÀNH",bold),
              Spacer(1,40),
              P("BẢN THỬ NGHIỆM – CHƯA KÝ, CHƯA PHÊ DUYỆT",tiny),
              Spacer(1,9),
              P("Nơi nhận: Theo danh sách được phê duyệt; Lưu vận hành.",normal)]
    doc.build(story)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--date",required=True,help="YYYY-MM-DD in Vietnam")
    ap.add_argument("--output-dir",default="reports/avuong_kttv/reports/output")
    ap.add_argument("--fixture",help="Offline JSON test rows, no Supabase call")
    args=ap.parse_args()
    d=date.fromisoformat(args.date)
    raw=json.loads(Path(args.fixture).read_text(encoding="utf-8")) if args.fixture else fetch_rows(d)
    rows=validate(raw,d)
    out=Path(args.output_dir)
    out.mkdir(parents=True,exist_ok=True)
    pdf=out / f"KTTV_DAILY07_{d:%Y%m%d}_PREVIEW.pdf"
    build_pdf(rows,d,pdf)
    print(f"PDF_READY {pdf} rows={len(rows)} | PREVIEW_ONLY NO_EMAIL")

if __name__ == "__main__":
    main()
