#!/usr/bin/env python3
"""KTTV 4 ky: PDF layout-only renderer. Safe: does not send email or write Supabase.
The existing production generate_kttv_report.py remains authoritative for SMTP,
dispatch logging and pending-data behaviour until explicitly integrated.
"""
import argparse
import json
from datetime import date,datetime,timedelta
from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.enums import TA_CENTER, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate,Table,TableStyle,Paragraph,Spacer,HRFlowable
import generate_daily07_report as daily

def render(report_date,report_hour,readings,out):
    if report_hour not in (1,7,13,19):
        raise ValueError("Only 01,07,13,19 supported")
    daily.set_font()
    end=datetime.combine(report_date,datetime.min.time())+timedelta(hours=report_hour)
    # Snapshot hours ending: H-5,H-4,...,H; six values, not seven.
    expected=[end-timedelta(hours=i) for i in range(5,-1,-1)]
    lookup={}
    for r in readings:
        key=daily.parse_time(r["time"])
        if key not in lookup or (r.get("created_at") or "")>(lookup[key].get("created_at") or ""):
            lookup[key]=r
    if any(t not in lookup for t in expected):
        raise ValueError("PENDING_DATA: missing required period hours")
    rows=[lookup[t] for t in expected]
    fields=("water_level","tailwater_level","inflow","turbine_flow","spillway_flow","rainfallreal")
    if any(any(r.get(f) is None for f in fields) for r in rows):
        raise ValueError("PENDING_DATA: required observation null")
    last=rows[-1]
    avg=lambda k:sum(float(r[k]) for r in rows)/6
    rain=sum(float(r["rainfallreal"]) for r in rows)
    n=ParagraphStyle("n",fontName="AV",fontSize=9,leading=12)
    c=ParagraphStyle("c",parent=n,alignment=TA_CENTER)
    b=ParagraphStyle("b",parent=c,fontName="AV-Bold",fontSize=10,leading=13)
    right=ParagraphStyle("right",parent=n,alignment=TA_RIGHT)
    tiny=ParagraphStyle("tiny",parent=c,fontSize=7.8,leading=11)
    P=lambda x,st=c:Paragraph(x,st)
    head=Table([[P("TỔNG CÔNG TY PHÁT ĐIỆN 2<br/>CÔNG TY CỔ PHẦN<br/>THỦY ĐIỆN A VƯƠNG",b),
                 [P("CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",b),
                  P("Độc lập - Tự do - Hạnh phúc",b),Spacer(1,4),
                  HRFlowable(width=160,thickness=.8,color=colors.black,hAlign="CENTER")]]],colWidths=[270,270])
    doc=SimpleDocTemplate(str(out),pagesize=A4,leftMargin=27,rightMargin=27,topMargin=28,bottomMargin=26)
    a=expected[0]-timedelta(hours=1)
    period=f"{a:%H}h/{a:%d/%m} đến {end:%H}h/{end:%d/%m/%Y}"
    story=[head,Spacer(1,12),
           P(f"Đà Nẵng, ngày {report_date.day:02d} tháng {report_date.month:02d} năm {report_date.year}",right),
           Spacer(1,12),P("BÁO CÁO SỐ LIỆU VẬN HÀNH HỒ THỦY ĐIỆN A VƯƠNG",b),Spacer(1,10),
           P("Công ty Cổ phần Thủy điện A Vương cung cấp số liệu vận hành hồ chứa như sau:",n),
           Spacer(1,15)]
    labels=["Ngày/tháng/năm","Giờ","Mực nước hồ<br/>thượng lưu<br/>(m)","Mực nước hạ lưu<br/>nhà máy<br/>(m)",
            "Q đến hồ TB<br/>(m³/s)","Q chạy máy TB<br/>(m³/s)","Q xả tràn TB<br/>(m³/s)",
            "Tổng mưa<br/>(mm)"]
    vals=[report_date.strftime("%d/%m/%Y"),f"{report_hour:02d}h00'",
          f'{float(last["water_level"]):.2f}',f'{float(last["tailwater_level"]):.2f}',
          f'{avg("inflow"):.2f}',f'{avg("turbine_flow"):.2f}',f'{avg("spillway_flow"):.2f}',f'{rain:.1f}']
    tab=Table([[P(x,tiny) for x in labels],[P(x,tiny) for x in vals]],
              colWidths=[83,48,76,75,66,70,67,55])
    tab.setStyle(TableStyle([("GRID",(0,0),(-1,-1),.6,colors.black),
                             ("VALIGN",(0,0),(-1,-1),"MIDDLE"),
                             ("TOPPADDING",(0,0),(-1,-1),13),
                             ("BOTTOMPADDING",(0,0),(-1,-1),13)]))
    sign=Table([["",P("PHÂN XƯỞNG VẬN HÀNH",b)]],colWidths=[280,260])
    story += [P("Thời kỳ tính lưu lượng bình quân và lượng mưa: "+period,n),
              Spacer(1,8),tab,Spacer(1,40),sign]
    doc.build(story)
    return vals

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--date",required=True)
    ap.add_argument("--hour",type=int,required=True,choices=(1,7,13,19))
    ap.add_argument("--input-json",required=True,help="JSON rows fetched and validated by existing 4ky program")
    ap.add_argument("--output-dir",default="reports/avuong_kttv/reports/output")
    a=ap.parse_args()
    d=date.fromisoformat(a.date)
    outdir=Path(a.output_dir);outdir.mkdir(parents=True,exist_ok=True)
    out=outdir/f"{a.hour:02d}h00_{d:%d-%m-%Y}_So_lieu_KTTV.pdf"
    render(d,a.hour,json.loads(Path(a.input_json).read_text(encoding="utf-8")),out)
    print("PDF_READY",out)

if __name__=="__main__": main()
