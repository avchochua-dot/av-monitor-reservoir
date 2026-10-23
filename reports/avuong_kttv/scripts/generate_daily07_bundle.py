#!/usr/bin/env python3
"""A Vuong daily 07h bundle: 31-hour KTTV PDF, 12-row reservoir PDF, original XLSX.
No SMTP or database writes unless --send-test-email is explicitly supplied.
The time column stores Vietnam wall-clock labels as UTC (legacy convention).
"""
import argparse
import hashlib
import io
import json
import os
import smtplib
import ssl
import sys
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import openpyxl
from openpyxl import load_workbook
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer

sys.path.insert(0, str(Path(__file__).parent))
import generate_daily07_report as daily


BASE = Path(__file__).resolve().parents[1]
TEMPLATE = BASE / "templates" / "A_VUONG_BM_BC_SO_LIEU_HANG_NGAY.xlsx"
METRICS = ("water_level", "tailwater_level", "inflow", "turbine_flow",
           "spillway_flow", "rainfallreal")
DISPATCH_TABLE = "av_daily07_bundle_dispatch"
REPORTS = {
    "KTTV_31H": ("REPORT_KTTV31_TO", "pdf"),
    "RESERVOIR_12H": ("REPORT_RESERVOIR_TO", "pdf"),
    "HYDRO_EXCEL": ("REPORT_HYDRO_EXCEL_TO", "xlsx"),
}

def load_data(d, fixture=None):
    raw = json.loads(Path(fixture).read_text(encoding="utf-8")) if fixture else daily.fetch_rows(d)
    rows = daily.validate(raw, d)
    assert len(rows) == 31
    return rows

def daily_rows(rows):
    """24 snapshots represent periods ending 01:00..24:00 of previous day."""
    return rows[:24]

def check_consistency(rows):
    bad = []
    for t, r in rows:
        if float(r["water_level"]) < 0 or float(r["tailwater_level"]) < 0:
            bad.append(str(t) + ": negative level")
        if any(float(r[k]) < 0 for k in ("inflow","turbine_flow","spillway_flow","rainfallreal")):
            bad.append(str(t) + ": negative flow/rainfall")
    if bad:
        raise ValueError("INVALID_DATA: " + "; ".join(bad))

def render_reservoir_pdf(rows, report_date, path, generation_hours=None):
    """12 odd hours, previous day. Production release requires approved TB rule."""
    from reportlab.pdfbase import pdfmetrics
    daily.set_font()
    prev = report_date - timedelta(days=1)
    day = daily_rows(rows)
    selected = day[::2]
    assert len(selected) == 12
    hours = sum(float(r["turbine_flow"]) > 0 for _,r in day)
    if generation_hours is not None and hours != generation_hours:
        raise AssertionError(f"Expected {generation_hours} generation hours, got {hours}")
    avg = lambda key: sum(float(r[key]) for _,r in day)/24.0
    style = ParagraphStyle("normalBundle",fontName="AV",fontSize=8,leading=11)
    cent = ParagraphStyle("centerBundle",parent=style,alignment=TA_CENTER)
    heading = ParagraphStyle("headingBundle",parent=cent,fontName="AV-Bold",fontSize=11,leading=14)
    small = ParagraphStyle("smallBundle",parent=cent,fontSize=6.7,leading=8.8)
    p = lambda s,sty=cent: Paragraph(s,sty)
    doc = SimpleDocTemplate(str(path), pagesize=A4,
                            leftMargin=26,rightMargin=26,topMargin=27,bottomMargin=25)
    story = [
        Table([[p("TỔNG CÔNG TY PHÁT ĐIỆN 2<br/>CÔNG TY CỔ PHẦN<br/>THỦY ĐIỆN A VƯƠNG",heading),
                p("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM<br/>Độc lập - Tự do - Hạnh phúc",heading)]],
              colWidths=[270,270]),
        Spacer(1,8),p(f"Đà Nẵng, 07h ngày {report_date.day:02d} tháng {report_date.month:02d} năm {report_date.year}"),
        Spacer(1,7),p("BÁO CÁO",heading),
        p("Số liệu vận hành Nhà máy thủy điện A Vương",cent),
        Spacer(1,5),p("Kính gửi: Cục Quản lý tài nguyên nước."),
        Spacer(1,9),p(f"Bảng số liệu vận hành ngày {prev.day:02d} tháng {prev.month:02d} năm {prev.year}",heading),
        Spacer(1,8)
    ]
    h = ["Ngày", "Giờ", "Mực nước<br/>hồ (m)", "Q đến hồ<br/>(m³/s)",
         "Tổng Q xả<br/>(m³/s)", "Q qua máy<br/>(m³/s)",
         "Q qua tràn<br/>(m³/s)", "Giờ phát<br/>điện/ngày"]
    table_data = [[p(x,small) for x in h]]
    for idx,(t,r) in enumerate(selected):
        q_machine = float(r["turbine_flow"])
        q_spill = float(r["spillway_flow"])
        table_data.append([
            prev.strftime("%d/%m/%Y") if idx==0 else "",
            str(t.hour),f'{float(r["water_level"]):.2f}',
            f'{float(r["inflow"]):.2f}', f"{q_machine+q_spill:.2f}",
            f"{q_machine:.2f}",f"{q_spill:.2f}",
            str(hours) if idx==0 else ""
        ])
    table_data.append([
        "", "TB ngày", "",f'{avg("inflow"):.2f}',
        f'{avg("turbine_flow")+avg("spillway_flow"):.2f}',
        f'{avg("turbine_flow"):.2f}',f'{avg("spillway_flow"):.2f}',str(hours)
    ])
    tab=Table(table_data,colWidths=[76,46,72,72,80,72,74,48],repeatRows=1)
    tab.setStyle(TableStyle([
        ("GRID",(0,0),(-1,-1),0.5,colors.black),
        ("FONTNAME",(0,1),(-1,-1),"AV"),
        ("FONTSIZE",(0,1),(-1,-1),8),
        ("ALIGN",(0,0),(-1,-1),"CENTER"),
        ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
        ("TOPPADDING",(0,0),(-1,-1),6),
        ("BOTTOMPADDING",(0,0),(-1,-1),6),
        ("BACKGROUND",(0,-1),(-1,-1),colors.whitesmoke)
    ]))
    story += [tab, Spacer(1,10),
              p("TB ngày tính trung bình 24 giá trị giờ 01h–24h; cần đối chiếu quy tắc được duyệt.",small),
              Spacer(1,17),p("PHÂN XƯỞNG VẬN HÀNH",heading),
              Spacer(1,25),p("BẢN THỬ NGHIỆM – CHƯA KÝ, CHƯA PHÊ DUYỆT",small),
              Spacer(1,8),p("Nơi nhận: Theo danh sách được phê duyệt; Lưu VH, KTAT.",style)]
    doc.build(story)
    return hours

def update_excel(rows, report_date, target):
    """Preserve original 3 worksheets and formulas; update day and append its daily averages.
    Weekly sheet is left intact because template's approximate VLOOKUP needs owner review.
    """
    w = load_workbook(TEMPLATE)
    sh = w["Solieuhangngay_gio"]
    prev=report_date-timedelta(days=1)
    day=daily_rows(rows)
    # Template 30 rows: rows 6..29 contain 24 hours. Make 24 observations explicit.
    for i,(t,r) in enumerate(day, start=6):
        sh.cell(i,2,prev if i==6 else None)
        sh.cell(i,3,24 if t.hour==0 else t.hour)
        for col,key in ((4,"water_level"),(5,"inflow"),(6,"turbine_flow"),(7,"spillway_flow")):
            sh.cell(i,col,float(r[key]))
    sh["B1"]=report_date.year
    sh["B6"].number_format="dd/mm/yyyy"
    avgsh=w["SolieuQtbngay"]
    index={}
    for row in range(6,avgsh.max_row+1):
        v=avgsh.cell(row,2).value
        if isinstance(v,datetime): index[v.date()]=row
        elif isinstance(v,date): index[v]=row
    dest=index.get(prev,avgsh.max_row+1)
    avgsh.cell(dest,2,datetime.combine(prev,datetime.min.time()))
    for c,key in ((3,"inflow"),(4,"turbine_flow"),(5,"spillway_flow")):
        avgsh.cell(dest,c,round(sum(float(r[key]) for _,r in day)/24,4))
    avgsh.cell(dest,2).number_format="dd/mm/yyyy"
    # WEEKLY formulas deliberately not reauthored; source has VLOOKUP approximate matches.
    # This template must be inspected before official weekly publication.
    w.calculation=openpyxl.workbook.properties.CalcProperties(calcMode="auto",fullCalcOnLoad=True)
    w.save(target)

def recipients_for(report):
    env,_=REPORTS[report]
    raw=os.getenv(env,"")
    return sorted({x.strip().lower() for x in raw.replace(";",",").split(",") if x.strip()})

def dispatch_email_once(report, report_date, file, recipients):
    """Atomic DB INSERT claim, no automatic SMTP retry on ambiguous failure."""
    if not recipients:
        print(f"EMAIL_NOT_CONFIGURED {report}; skipped")
        return
    for k in ("SMTP_HOST","SMTP_USER","SMTP_PASSWORD","SMTP_FROM"):
        if not os.getenv(k): raise ValueError("Missing " + k)
    # One deterministic claim for each report type and date.
    # Recipient changes must NOT trigger a second automatic send.
    report_key = f"test:daily07:{report}:{report_date.isoformat()}"
    claim={
        "report_key": report_key,
        "report_type": report,
        "report_date": report_date.isoformat(),
        "status": "SENDING",
        "recipients": ",".join(recipients),
        "file_sha256": hashlib.sha256(file.read_bytes()).hexdigest()
    }
    # The database must enforce UNIQUE(report_type, report_date).
    result=daily.rest_request("POST",DISPATCH_TABLE,claim,"return=representation")
    if isinstance(result,dict) and result.get("_conflict"):
        print("EMAIL_SKIPPED_ALREADY_CLAIMED",report,report_date)
        return
    msg=EmailMessage()
    msg["Subject"]=f"[BẢN THỬ NGHIỆM] A Vương - {report} - {report_date:%d/%m/%Y}"
    msg["From"]=os.environ["SMTP_FROM"]
    msg["To"]=", ".join(recipients)
    msg.set_content("Kính gửi anh/chị,\n\nĐính kèm bản thử nghiệm; chưa ký, chưa phê duyệt, không dùng để phát hành chính thức.\n")
    ispdf=file.suffix==".pdf"
    msg.add_attachment(file.read_bytes(),
      maintype="application",
      subtype="pdf" if ispdf else "vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename=file.name)
    try:
        security=os.getenv("SMTP_SECURITY","ssl").lower()
        port=int(os.getenv("SMTP_PORT","465"))
        ctx=ssl.create_default_context()
        if security=="ssl":
            conn=smtplib.SMTP_SSL(os.environ["SMTP_HOST"],port,timeout=35,context=ctx)
        elif security=="starttls":
            conn=smtplib.SMTP(os.environ["SMTP_HOST"],port,timeout=35)
        else: raise ValueError("SMTP_SECURITY must be ssl or starttls")
        with conn as s:
            if security=="starttls": s.starttls(context=ctx)
            s.login(os.environ["SMTP_USER"],os.environ["SMTP_PASSWORD"])
            refusal=s.send_message(msg)
            if refusal: raise RuntimeError("Some recipients refused by SMTP")
    except Exception as e:
        # SMTP may have accepted before a transport failure; manual review only.
        try:
            daily.rest_request("PATCH",
                f"{DISPATCH_TABLE}?report_key=eq.{report_key}",
                {"status":"NEEDS_REVIEW","error_text":str(e)[:500]})
        finally: raise
    daily.rest_request("PATCH",
      f"{DISPATCH_TABLE}?report_key=eq.{report_key}",
      {"status":"SMTP_ACCEPTED","sent_at":datetime.now(timezone.utc).isoformat()})
    print(f"EMAIL_SMTP_ACCEPTED {report} recipients={len(recipients)}")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--date",required=True)
    ap.add_argument("--fixture")
    ap.add_argument("--output-dir",default="reports/avuong_kttv/reports/output")
    ap.add_argument("--send-test-email",action="store_true")
    args=ap.parse_args()
    report_date=date.fromisoformat(args.date)
    rows=load_data(report_date,args.fixture)
    check_consistency(rows)
    out=Path(args.output_dir);out.mkdir(parents=True,exist_ok=True)
    files={
      "KTTV_31H":out/f"KTTV_DAILY07_{report_date:%Y%m%d}_PREVIEW.pdf",
      "RESERVOIR_12H":out/f"RESERVOIR_{report_date:%Y%m%d}_PREVIEW.pdf",
      "HYDRO_EXCEL":out/f"HYDRO_{report_date:%Y%m%d}_PREVIEW.xlsx"
    }
    daily.build_pdf(rows,report_date,files["KTTV_31H"])
    hours=render_reservoir_pdf(rows,report_date,files["RESERVOIR_12H"])
    update_excel(rows,report_date,files["HYDRO_EXCEL"])
    print(f"BUNDLE_READY report_date={report_date} rows=31 generation_hours={hours}")
    for label,file in files.items():print("FILE_READY",label,file)
    if args.send_test_email:
        if args.fixture: raise ValueError("Do not send email with fixture data")
        for label,file in files.items():
            dispatch_email_once(label,report_date,file,recipients_for(label))
    else: print("PREVIEW_ONLY_NO_EMAIL")

if __name__=="__main__":
    main()
