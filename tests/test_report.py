import importlib.util
import json
import os
import tempfile
import unittest
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "generate_kttv_report.py"
spec = importlib.util.spec_from_file_location("report_kttv", SCRIPT)
mod = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

class KttvReportTests(unittest.TestCase):
    def test_mislabelled_utc_corresponds_to_19_vn(self):
        d = date(2026, 10, 21)
        x = mod.build_hourly_instants(d, 19, "vn_label_stored_as_utc")
        self.assertEqual([v.hour for v in x], [14,15,16,17,18,19])
        self.assertEqual(mod.iso_z(x[-1]), "2026-10-21T19:00:00Z")
    def test_correct_utc_would_be_12(self):
        x=mod.build_hourly_instants(date(2026,10,21),19,"true_utc")
        self.assertEqual(mod.iso_z(x[-1]),"2026-10-21T12:00:00Z")
    def fake_rows(self):
        times=mod.build_hourly_instants(date(2026,10,21),19,"vn_label_stored_as_utc")
        rows=[]
        for i,t in enumerate(times):
            rows.append({
                "id":i+1, "time":mod.iso_z(t), "water_level":"355.13",
                "tailwater_level":None, "inflow":"42.44",
                "turbine_flow":"57.05", "spillway_flow":"0",
                "rainfallreal":str([0,0,1,1,2,0][i]),
                "created_at":"2026-10-21T19:08:00Z"
            })
        return rows
    def test_report_6_hour_means_and_sum(self):
        r=mod.aggregate_rows(date(2026,10,21),19,"vn_label_stored_as_utc",
                             self.fake_rows(),Decimal("60"))
        self.assertEqual(mod.fmt(r.upstream),"355.13")
        self.assertEqual(mod.fmt(r.mean_inflow),"42.44")
        self.assertEqual(mod.fmt(r.mean_turbine),"57.05")
        self.assertEqual(mod.fmt(r.mean_spillway),"0.00")
        self.assertEqual(mod.fmt(r.rain_total,1),"4.0")
        self.assertEqual(r.tailwater,Decimal("60"))
        self.assertTrue(r.tailwater_is_temporary)
    def test_missing_measurement_is_not_zero(self):
        rows=self.fake_rows()
        rows[3]["rainfallreal"]=None
        with self.assertRaisesRegex(ValueError,"Thiếu số liệu"):
            mod.aggregate_rows(date(2026,10,21),19,
                               "vn_label_stored_as_utc",rows,Decimal("60"))
    def test_negative_flow_is_rejected(self):
        rows=self.fake_rows()
        rows[2]["inflow"]=-100
        with self.assertRaisesRegex(ValueError,"âm"):
            mod.aggregate_rows(date(2026,10,21),19,
                               "vn_label_stored_as_utc",rows,Decimal("60"))
    def test_missing_hour_is_rejected(self):
        rows=self.fake_rows()[1:]
        instants=mod.build_hourly_instants(date(2026,10,21),19,
                                          "vn_label_stored_as_utc")
        with self.assertRaisesRegex(ValueError,"DATA_INCOMPLETE"):
            mod.choose_rows(rows,instants)
    def test_duplicate_latest_created_at(self):
        rows=self.fake_rows()
        extra=dict(rows[0])
        extra["id"]=100
        extra["created_at"]="2026-10-21T19:09:00Z"
        extra["inflow"]="40"
        instants=mod.build_hourly_instants(date(2026,10,21),19,
                                          "vn_label_stored_as_utc")
        got=mod.choose_rows(rows+[extra],instants)
        self.assertEqual(got[0]["id"],100)
    def test_preview_pdf_is_single_page_with_warning(self):
        import fitz
        with tempfile.TemporaryDirectory() as temp:
            p=mod.draw_pdf(mod.demo_report(),Path(temp)/"test.pdf")
            txt=fitz.open(p)[0].get_text()
            self.assertIn("60.00*",txt)
            self.assertIn("BẢN THỬ NGHIỆM",txt)
            self.assertIn("KHÔNG PHÁT HÀNH CHÍNH THỨC",txt)
            self.assertIn("42.44",txt)
    def test_no_mail_if_mode_preview(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(sys,"argv",["report","--demo","--output-dir",temp]):
                with patch.object(mod,"mail_send_test") as sm:
                    self.assertEqual(mod.run(),0)
                    sm.assert_not_called()

    def test_smtp_send_message_contains_pdf_and_provisional_subject(self):
        import types
        calls=[]
        class SMTPFake:
            def __init__(self,*args,**kwargs):
                calls.append(("connect",args))
            def __enter__(self):
                return self
            def __exit__(self,*exc):
                pass
            def login(self,*args):
                calls.append(("login",))
            def send_message(self,msg):
                calls.append(("send",msg))
                return {}
        with tempfile.TemporaryDirectory() as tmp:
            pdf=mod.draw_pdf(mod.demo_report(),Path(tmp)/"draft.pdf")
            settings={
                "SMTP_HOST":"smtp.example.org","SMTP_PORT":"465",
                "SMTP_SECURITY":"ssl","SMTP_USER":"sender@example.org",
                "SMTP_PASSWORD":"example_password","SMTP_FROM":"sender@example.org",
                "REPORT_TEST_TO":"test1@example.org,test2@example.org"
            }
            with patch.dict(os.environ,settings), patch.object(mod.smtplib,"SMTP_SSL",SMTPFake):
                result=mod.mail_send_test(mod.demo_report(),pdf)
            self.assertEqual(result,["test1@example.org","test2@example.org"])
            msg=[v[1] for v in calls if v[0]=="send"][0]
            self.assertIn("THỬ NGHIỆM",str(msg["Subject"]))
            self.assertIn("GIẢ ĐỊNH",msg.get_body(preferencelist=("plain",)).get_content())
            self.assertEqual(len(list(msg.iter_attachments())),1)
            self.assertEqual(list(msg.iter_attachments())[0].get_content_type(),"application/pdf")

if __name__ == "__main__":
    unittest.main()
