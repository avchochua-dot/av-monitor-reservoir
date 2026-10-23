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
              
              Spacer(1,17),p("PHÂN XƯỞNG VẬN HÀNH",heading),
              Spacer(1,25),
              Spacer(1,8),p("Nơi nhận: Như kính gửi; Ban GĐ; Lưu VH, KTAT.",style)]
    doc.build(story)
    return hours

def update_excel(rows, report_date, target):
    """Update 24 hourly rows, daily summary and the 7-day weekly view.
    Maintain the original formatted workbook, including its three sheets.
    """
    from copy import copy
    w = load_workbook(TEMPLATE)
    sh = w["Solieuhangngay_gio"]
    prev = report_date - timedelta(days=1)
    day = daily_rows(rows)
    if len(day) != 24:
        raise ValueError("PENDING_DATA: missing hours for previous day")
    # Clear template's two date groups (B6:B22 and B23:B29).
    for merged in list(sh.merged_cells.ranges):
        if merged.min_col == 2 and merged.max_col == 2 and merged.min_row <= 29 and merged.max_row >= 6:
            sh.unmerge_cells(str(merged))
    sh.merge_cells("B6:B29")
    sh["B6"] = datetime.combine(prev, datetime.min.time())
    sh["B6"].number_format = "dd/mm/yyyy"
    from openpyxl.styles import Alignment
    sh["B6"].alignment = Alignment(horizontal="center", vertical="center")
    for i, (t, r) in enumerate(day, start=6):
        # Every hourly row belongs to previous operational day; 00:00 is 24h00.
        sh.cell(i, 3, 24 if t.hour == 0 else t.hour)
        for col, key in ((4, "water_level"), (5, "inflow"),
                         (6, "turbine_flow"), (7, "spillway_flow")):
            sh.cell(i, col, float(r[key]))
    sh["B1"] = report_date.year
    # Excel compatibility: avoid _xlfn.CONCAT dependency.
    sh["B3"] = '="Số liệu thủy văn theo giờ từng ngày năm "&B1'

    avgsh = w["SolieuQtbngay"]
    avgsh["B3"] = f"Số liệu thủy văn theo ngày năm {report_date.year}"
    index = {}
    duplicates = {}
    for rnum in range(6, avgsh.max_row + 1):
        val = avgsh.cell(rnum, 2).value
        if isinstance(val, datetime):
            key = val.date()
            if key in index: duplicates.setdefault(key, [index[key]]).append(rnum)
            else: index[key] = rnum
        elif isinstance(val, date):
            if val in index: duplicates.setdefault(val, [index[val]]).append(rnum)
            else: index[val] = rnum
    week_dates = {prev - timedelta(days=n) for n in range(7)}
    ambiguous = {d: positions for d, positions in duplicates.items() if d in week_dates}
    if ambiguous:
        raise ValueError("DUPLICATE_DAILY_DATES_IN_WEEK: " +
                         "; ".join(f"{d}: rows {positions}" for d, positions in sorted(ambiguous.items())))
    dest = index.get(prev)
    if dest is None:
        # Append after last dated record, not after formatted/empty rows.
        dest = max(index.values(), default=5) + 1
        if dest > 6:
            for col in range(2, 6):
                source = avgsh.cell(dest-1, col)
                target_cell = avgsh.cell(dest, col)
                if source.has_style:
                    target_cell._style = copy(source._style)
    avgsh.cell(dest, 2, datetime.combine(prev, datetime.min.time()))
    avgsh.cell(dest, 2).number_format = "dd/mm/yyyy"
    for col, key in ((3, "inflow"), (4, "turbine_flow"), (5, "spillway_flow")):
        # Decimal displayed by cell format, retain full precision in workbook.
        cell = avgsh.cell(dest, col,
                          sum(float(r[key]) for _, r in day) / 24)
        cell.number_format = '0.00'

    # Weekly sheet: 7 dates ending at previous operational day.
    week = w["Tuan"]
    week["A2"] = report_date.year
    week["B1"] = datetime(report_date.year, 1, 1)
    week["B1"].number_format = "dd/mm/yyyy"
    week["B3"] = '="Số liệu thủy văn tuần thứ "&A3&" năm "&A2'
    # Explicit dates and exact-match lookups prevent silent nearest-date values.
    last = max(avgsh.max_row, dest) + 2000
    for rnum in range(6, 13):
        d = prev - timedelta(days=12-rnum)
        week.cell(rnum, 3, datetime.combine(d, datetime.min.time()))
        week.cell(rnum, 3).number_format = "dd/mm/yyyy"
        week.cell(rnum, 2,
                  f'=CHOOSE(WEEKDAY(C{rnum},2),"Thứ hai","Thứ ba",'
                  '"Thứ tư","Thứ năm","Thứ sáu","Thứ bảy","Chủ nhật")')
        for col, n in ((4, 2), (5, 3), (6, 4)):
            week.cell(rnum, col,
                      f'=IF(COUNTIF(SolieuQtbngay!$B$6:$B${last},$C{rnum})>1,'
                      f'"DUPLICATE",IFERROR(VLOOKUP($C{rnum},'
                      f'SolieuQtbngay!$B$6:$E${last},{n},FALSE),""))')
    week["A3"] = '=ISOWEEKNUM(C12)'
    w.calculation = openpyxl.workbook.properties.CalcProperties(
        calcMode="auto", fullCalcOnLoad=True, forceFullCalc=True)
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
    msg.set_content(
        "Kính gửi anh/chị,\\n\\n"
        "Đính kèm báo cáo số liệu vận hành A Vương theo mẫu trình bày sử dụng thực tế.\\n"
        "Email hiện được gửi trong phạm vi kiểm thử nội bộ; tài liệu chưa có chữ ký xác nhận.\\n"
        "Trân trọng."
    )
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
      "KTTV_31H":out/f"KTTV_DAILY07_{report_date:%Y%m%d}.pdf",
      "RESERVOIR_12H":out/f"RESERVOIR_{report_date:%Y%m%d}.pdf",
      "HYDRO_EXCEL":out/f"HYDRO_{report_date:%Y%m%d}.xlsx"
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
