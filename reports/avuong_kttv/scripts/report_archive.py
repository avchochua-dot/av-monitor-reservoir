#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A Vuong archive V1.0.

Standalone wrapper around the existing report scripts. Does NOT edit layouts,
hour windows, SMTP dispatch keys or report cron schedules.
Storage/REST use standard HTTPS, with the existing server-only service_role key.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
import zipfile
from collections import deque
from datetime import date, datetime, timedelta, timezone
from email.utils import parseaddr
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

VERSION = "AV_ARCHIVE_V1_1_FORCE_RESEND"
BUCKET = "avuong-reports"
MAX_BYTES = 20 * 1024 * 1024
try:
    VN = ZoneInfo("Asia/Ho_Chi_Minh")
except ZoneInfoNotFoundError:
    # Windows backup host may not have an IANA database. Vietnam currently uses UTC+7.
    VN = timezone(timedelta(hours=7))
UTC = timezone.utc
RUNS = "av_report_archive_runs"
FILES = "av_report_archive_files"
POLICY = "av_report_archive_policy"
CLEANUPS = "av_report_archive_cleanup_runs"
NAMESPACE = uuid.UUID("a3f8833f-8b9e-4078-9a36-e6ec83f414a9")
PDF_MIME = "application/pdf"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
BASE = Path(__file__).resolve().parent

def utcnow() -> str:
    return datetime.now(UTC).isoformat()

def safe_error(exc: object) -> str:
    text = str(exc)
    for name in ("SUPABASE_SERVICE_ROLE_KEY", "SMTP_PASSWORD",
                 "AVUONG_FONTS_DEPLOY_KEY", "GITHUB_TOKEN"):
        secret = os.getenv(name, "")
        if secret and len(secret) > 4:
            text = text.replace(secret, "[REDACTED]")
    return text[:1000]

def annotation(message: str, level: str = "warning") -> None:
    msg = safe_error(message).replace("%","%25").replace("\r","%0D").replace("\n","%0A")
    print(f"::{level} title=A Vuong Archive::{msg}", flush=True)

class APIError(RuntimeError):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(f"HTTP {status}: {message}")

class Client:
    def __init__(self, url: str | None = None, key: str | None = None):
        self.url = (url if url is not None else os.getenv("SUPABASE_URL","")).rstrip("/")
        self.key = key if key is not None else os.getenv("SUPABASE_SERVICE_ROLE_KEY","")
        parsed = urlsplit(self.url)
        if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment or parsed.path:
            raise ValueError("SUPABASE_URL must be the HTTPS project origin")
        if not self.key.strip():
            raise ValueError("SUPABASE_SERVICE_ROLE_KEY is missing")
    def request(self, method: str, path: str, payload: Any = None, *,
                raw: bytes | None = None, headers: dict[str,str] | None = None,
                binary: bool = False, retries: int = 1) -> Any:
        if not path.startswith("/"):
            raise ValueError("Relative API path required")
        h = {"apikey":self.key, "Authorization":"Bearer "+self.key,
             "Accept":"application/json", "User-Agent":"AVuong-Archive/1.0"}
        if headers: h.update(headers)
        data = raw
        if payload is not None:
            data = json.dumps(payload,ensure_ascii=False).encode("utf-8")
            h["Content-Type"] = "application/json"
        for attempt in range(retries+1):
            try:
                req = Request(self.url+path, data=data, headers=h, method=method)
                with urlopen(req, timeout=20) as response:
                    # Bound download size. Storage reports are limited to 20 MB.
                    body = response.read(MAX_BYTES+1 if binary else 5*1024*1024)
                if binary:
                    if len(body) > MAX_BYTES: raise ValueError("Downloaded file exceeds 20 MB")
                    return body
                return json.loads(body.decode("utf-8")) if body.strip() else None
            except HTTPError as exc:
                detail = exc.read(1200).decode("utf-8",errors="replace")
                if exc.code in (429,500,502,503,504) and attempt < retries:
                    time.sleep(2**attempt); continue
                raise APIError(exc.code,safe_error(detail)) from None
            except (URLError, TimeoutError, OSError) as exc:
                if attempt < retries:
                    time.sleep(2**attempt); continue
                raise RuntimeError("Network request failed: "+safe_error(exc)) from None
        raise RuntimeError("Unreachable retry state")
    def rest(self, method: str, table: str, payload: Any = None,
             filters: dict[str,str] | None = None, prefer: str = "") -> Any:
        path = "/rest/v1/"+table
        if filters:
            path += "?"+urlencode(filters,safe="(),.*")
        headers = {"Prefer":prefer} if prefer else {}
        return self.request(method,path,payload,headers=headers)
    def rpc(self,name: str,payload: dict[str,Any]) -> Any:
        # Mutating RPCs are not automatically retried after ambiguous network failures.
        return self.request("POST","/rest/v1/rpc/"+name,payload,retries=0)
    def download(self,bucket: str,path: str) -> bytes:
        assert_storage_path(bucket,path)
        return self.request("GET","/storage/v1/object/authenticated/"
                            +quote(bucket,safe="")+"/"+quote(path,safe="/"),binary=True)
    def upload_verified(self,path: str,data: bytes,mime: str) -> None:
        assert_storage_path(BUCKET,path)
        try:
            self.request("POST","/storage/v1/object/"+BUCKET+"/"+quote(path,safe="/"),
                         raw=data,headers={"Content-Type":mime,"x-upsert":"false",
                                           "Cache-Control":"max-age=0"})
        except APIError as exc:
            # Upload can finish server-side before a network retry. Verify, never overwrite.
            duplicate = exc.status in (400,409) and (
                "duplicate" in str(exc).lower() or "already exists" in str(exc).lower()
                or exc.status == 409)
            if not duplicate: raise
        actual = self.download(BUCKET,path)
        if hashlib.sha256(actual).digest() != hashlib.sha256(data).digest():
            raise RuntimeError("STORAGE_INTEGRITY_MISMATCH")
    def delete_verified(self,row: dict[str,Any]) -> None:
        bucket,path = row["bucket"],row["object_path"]
        assert_storage_path(bucket,path)
        self.request("DELETE","/storage/v1/object/"+bucket,{"prefixes":[path]})
        try:
            self.download(bucket,path)
        except APIError as exc:
            if exc.status == 404:
                return
            # Some Storage API versions return HTTP 400 with a JSON statusCode 404.
            if exc.status == 400 and (
                '"statusCode":"404"' in str(exc).replace(" ","")
                or '"statusCode":404' in str(exc).replace(" ","")):
                return
            raise
        raise RuntimeError("DELETE_NOT_VERIFIED: object is still readable")

def assert_storage_path(bucket: str,path: str) -> None:
    parts = PurePosixPath(path).parts
    if bucket != BUCKET or not path.startswith("AVUONG/") or "\\" in path or ".." in parts:
        raise ValueError("Refusing an object outside avuong-reports/AVUONG/")
    if not path.endswith((".pdf",".xlsx")):
        raise ValueError("Only report PDF/XLSX objects are handled")

def parse_day(raw: str) -> date:
    result = date.fromisoformat(raw)
    if result.isoformat() != raw:
        raise ValueError("Date must be YYYY-MM-DD")
    return result

def expected_files(pipeline: str, day: date, hour: int, directory: Path) -> dict[str,Path]:
    stamp = day.strftime("%d-%m-%Y")
    if pipeline == "DAILY07_BUNDLE":
        if hour != 7: raise ValueError("DAILY07_BUNDLE hour must be 07")
        return {
            "KTTV_31H":directory/f"07h00_{stamp}_So_lieu_KTTV_tong_hop.pdf",
            "RESERVOIR_12H":directory/f"07h00_{stamp}_Bao_cao_van_hanh_ho.pdf",
            "HYDRO_EXCEL":directory/f"07h00_{stamp}_Bang_so_lieu_thuy_van.xlsx",
        }
    if pipeline == "KTTV_6H" and hour in (1,7,13,19):
        return {"KTTV_6H":directory/f"{hour:02d}h00_{stamp}_So_lieu_KTTV.pdf"}
    raise ValueError("Invalid report pipeline/hour")

def read_report(path: Path) -> tuple[bytes,str,str]:
    if path.is_symlink() or not path.is_file():
        raise ValueError("Report must be a regular file: "+path.name)
    size = path.stat().st_size
    if size <= 0 or size > MAX_BYTES:
        raise ValueError("Empty report or file larger than 20 MB: "+path.name)
    data = path.read_bytes()
    if path.suffix.lower() == ".pdf":
        if not data.startswith(b"%PDF-"): raise ValueError("Not a PDF: "+path.name)
        mime = PDF_MIME
    elif path.suffix.lower() == ".xlsx":
        with zipfile.ZipFile(path) as book:
            if "[Content_Types].xml" not in book.namelist() or "xl/workbook.xml" not in book.namelist():
                raise ValueError("Not an XLSX workbook")
        mime = XLSX_MIME
    else:
        raise ValueError("Refusing non-report extension")
    return data,mime,hashlib.sha256(data).hexdigest()

def run_identity(pipeline: str) -> dict[str,Any]:
    repository = os.getenv("GITHUB_REPOSITORY","avchochua-dot/av-monitor-reservoir")
    github_id = os.getenv("GITHUB_RUN_ID","local-"+uuid.uuid4().hex)
    attempt = int(os.getenv("GITHUB_RUN_ATTEMPT","1"))
    if attempt < 1: raise ValueError("Invalid run attempt")
    identity = f"{repository}:{github_id}:{attempt}:{pipeline}"
    return {
        "id":str(uuid.uuid5(NAMESPACE,identity)), "pipeline":pipeline,
        "repository":repository, "github_run_id":github_id,
        "github_run_attempt":attempt,
        "github_run_url":f"https://github.com/{repository}/actions/runs/{github_id}",
        "commit_sha":os.getenv("GITHUB_SHA") or None,
    }

def recipient_key(raw: str) -> list[str]:
    # Match legacy clean_list() exactly; do not silently change email dedup keys.
    return sorted(set(parseaddr(x.strip())[1] for x in re.split(r"[,;\n]",raw) if x.strip()))

def email_observation(client: Client,report: str,day: date,hour: int,
                      digest: str,requested: bool,started: str,logs: str) -> dict[str,Any]:
    result = {"email_observation":"NOT_REQUESTED" if not requested else "UNKNOWN"}
    if not requested: return result
    force_marker = (
        ("SMTP FORCE RESEND ACCEPTED" in logs) if report == "KTTV_6H"
        else (f"EMAIL_FORCE_RESEND_SMTP_ACCEPTED {report}" in logs)
    )
    if report == "KTTV_6H":
        recipients = recipient_key(os.getenv("REPORT_TEST_TO",""))
        if not recipients: return {"email_observation":"NOT_CONFIGURED"}
        token = hashlib.sha256(",".join(recipients).encode()).hexdigest()[:12]
        key = f"test:{day.isoformat()}:{hour:02d}:{token}"
        table = "av_report_dispatch_log"
    else:
        envname = {"KTTV_31H":"REPORT_KTTV31_TO","RESERVOIR_12H":"REPORT_RESERVOIR_TO",
                   "HYDRO_EXCEL":"REPORT_HYDRO_EXCEL_TO"}[report]
        if not os.getenv(envname,"").strip(): return {"email_observation":"NOT_CONFIGURED"}
        key = f"test:daily07:{report}:{day.isoformat()}"
        table = "av_daily07_bundle_dispatch"
    result.update(dispatch_table=table,dispatch_key=key)
    try:
        rows = client.rest("GET",table,filters={"select":"*","report_key":"eq."+key,"limit":"1"})
    except Exception:
        return result
    if not rows: return result
    row=rows[0]
    mail_hash=row.get("file_sha256") or row.get("pdf_sha256")
    result.update(observed_mail_status=row.get("status"),observed_sent_at=row.get("sent_at"),
                  observed_mail_file_sha256=mail_hash)
    if row.get("status") == "SMTP_ACCEPTED":
        if force_marker:
            result["email_observation"]="FORCE_RESEND_ACCEPTED_THIS_RUN"
        elif mail_hash != digest:
            result["email_observation"]="PREVIOUS_VERSION_ACCEPTED"
        else:
            sent=datetime.fromisoformat(row["sent_at"].replace("Z","+00:00")) if row.get("sent_at") else None
            begin=datetime.fromisoformat(started)
            marker=("SMTP ACCEPTED (NOT INBOX CONFIRMATION):" in logs if report=="KTTV_6H"
                    else f"EMAIL_SMTP_ACCEPTED {report}" in logs)
            current=bool(sent and sent>=begin and marker)
            result["email_observation"]="ACCEPTED_THIS_RUN" if current else "ACCEPTED_EARLIER_SAME_FILE"
    elif row.get("status") in ("FAILED","NEEDS_REVIEW","SENDING"):
        result["email_observation"]=row["status"]
    return result

def archive_one(client: Client,run: dict[str,Any],report: str,path: Path,
                policy: dict[str,Any],requested: bool,logs: str) -> dict[str,Any]:
    data,mime,digest = read_report(path)
    file_id=str(uuid.uuid5(uuid.UUID(run["id"]),report))
    day=parse_day(run["report_date"])
    filename=path.name
    # Keep filenames for download. Paths remain stable for the same run/attempt/content.
    object_path=(f"AVUONG/{day:%Y/%m/%d}/{run['pipeline']}/{run['id']}/"
                 f"{report}/{digest[:16]}-{filename}")
    existing=client.rest("GET",FILES,filters={"id":"eq."+file_id,"select":"*","limit":"1"})
    if existing:
        old=existing[0]
        if old["sha256"]!=digest: raise RuntimeError("Same run/report has different bytes; start a new run")
        if old["archive_status"] in ("STORED","DELETE_FAILED"):
            # Idempotent retry: no extending retention or overwriting backup evidence.
            return old
        if old["archive_status"] in ("DELETING","DELETED"):
            raise RuntimeError("Archived file has expired; cannot resurrect the same record")
    row={
        "id":file_id,"run_id":run["id"],"report_type":report,
        "report_date":run["report_date"],"report_hour":run["report_hour"],
        "file_name":filename,"mime_type":mime,"size_bytes":len(data),"sha256":digest,
        "bucket":BUCKET,"object_path":object_path,"archive_status":"UPLOADING",
        "retention_class":policy["retention_class"],"retention_days":policy["retention_days"],
        "require_backup":policy["require_backup"],
    }
    row.update(email_observation(client,report,day,run["report_hour"],digest,requested,
                                 run["started_at"],logs))
    if existing:
        client.rest("PATCH",FILES,{"archive_status":"UPLOADING","error_text":None},
                    {"id":"eq."+file_id})
    else:
        client.rest("POST",FILES,row,{"on_conflict":"id"},
                    prefer="resolution=ignore-duplicates,return=minimal")
    try:
        client.upload_verified(object_path,data,mime)
        # Timestamp and expiry are set atomically using database time.
        saved=client.rpc("av_report_archive_mark_stored",{"p_id":file_id,"p_sha256":digest})
        if not saved: raise RuntimeError("Storage registration returned no file")
        print("ARCHIVE_STORED",report,file_id,flush=True)
        return saved[0] if isinstance(saved,list) else saved
    except Exception as exc:
        # On ambiguous final RPC failure, preserve a successful stored row if already committed.
        try:
            client.rest("PATCH",FILES,{"archive_status":"UPLOAD_FAILED","error_text":safe_error(exc)},
                        {"id":"eq."+file_id,"archive_status":"eq.UPLOADING"})
        except Exception:
            pass
        raise

def generation_state(expected: dict[str,Path],returncode: int,logs: str) -> tuple[str,int]:
    valid=0
    for path in expected.values():
        try: read_report(path); valid+=1
        except Exception: pass
    if valid == len(expected): return "READY",valid
    if "PENDING_DATA" in logs or "DATA_INCOMPLETE:" in logs:
        return "PENDING_DATA",valid
    return ("PARTIAL" if valid else "FAILED"),valid

def run_reports(args: argparse.Namespace) -> int:
    day=parse_day(args.date) if args.date else datetime.now(VN).date()
    hour=7 if args.pipeline=="DAILY07_BUNDLE" else args.hour
    if args.force_resend and not args.send_email:
        raise RuntimeError("--force-resend requires --send-email")
    output=Path(args.output_dir).resolve()
    output.mkdir(parents=True,exist_ok=True)
    if any(output.iterdir()):
        raise RuntimeError("Output directory is not empty. Use a new run directory to avoid stale reports.")
    expected=expected_files(args.pipeline,day,hour,output)
    started=utcnow()
    run={**run_identity(args.pipeline),"report_date":day.isoformat(),"report_hour":hour,
         "started_at":started,"expected_files":len(expected),"email_requested":args.send_email}
    client=None;policy=None;registration_error=None
    try:
        client=Client()
        policies=client.rest("GET",POLICY,filters={"retention_class":"eq."+args.retention_class,"select":"*"})
        if len(policies)!=1: raise RuntimeError("Archive policy not installed; run SQL 01")
        policy=policies[0]
        client.rest("POST",RUNS,run,{"on_conflict":"id"},
                    prefer="resolution=ignore-duplicates,return=minimal")
    except Exception as exc:
        registration_error=safe_error(exc)
        annotation("Archive setup/log unavailable. Existing report/email processing will still run. "+registration_error)
    script = "generate_daily07_bundle.py" if args.pipeline=="DAILY07_BUNDLE" else "generate_kttv_report.py"
    command=[sys.executable,str(BASE/script),"--date",day.isoformat(),"--output-dir",str(output)]
    if args.pipeline=="DAILY07_BUNDLE":
        if args.send_email: command.append("--send-test-email")
        if args.force_resend: command.append("--force-resend")
    else:
        command += ["--hour",str(hour),"--mode","test-email" if args.send_email else "preview",
                    "--allow-pending-data"]
        if args.retry_failed: command.append("--retry-failed")
        if args.force_resend: command.append("--force-resend")
    print("ARCHIVE_RUN",run["id"],"CLASS",args.retention_class,flush=True)
    lines=deque(maxlen=1500)
    returncode=1
    try:
        child=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                               text=True,encoding="utf-8",errors="replace",
                               env={**os.environ,"PYTHONUNBUFFERED":"1"})
        assert child.stdout is not None
        for line in child.stdout:
            print(line,end="",flush=True)
            lines.append(line)
        returncode=child.wait()
    except Exception as exc:
        lines.append(safe_error(exc))
        annotation(exc,"error")
    logs="".join(lines)
    generated,count=generation_state(expected,returncode,logs)
    files=[];errors=[]
    if registration_error: errors.append(registration_error)
    if client and policy and not registration_error:
        for label,path in expected.items():
            if not path.exists(): continue
            try:
                files.append(archive_one(client,run,label,path,policy,args.send_email,logs))
            except Exception as exc:
                errors.append(f"{label}: {safe_error(exc)}")
                annotation("Archive failed for "+label+": "+safe_error(exc),"error")
    archive_status=("STORED" if len(files)==len(expected) else
                    "PARTIAL" if files else "FAILED" if count or errors else "NO_FILES")
    process_status=("PENDING_DATA" if generated=="PENDING_DATA" else
                    "SUCCEEDED" if returncode==0 and generated=="READY" else "FAILED")
    # Truncated program error is for diagnostics; never credentials/full email body.
    program_error=None
    if process_status in ("FAILED","PENDING_DATA"):
        program_error=safe_error("".join(list(lines)[-8:]))
    update={
        "finished_at":utcnow(),"generation_status":generated,"generated_files":count,
        "archived_files":len(files),"archive_status":archive_status,
        "process_status":process_status,"exit_code":returncode,
        "error_text":safe_error("; ".join(errors+[program_error or ""])) or None,
    }
    if client and not registration_error:
        try:
            client.rest("PATCH",RUNS,update,{"id":"eq."+run["id"]})
        except Exception as exc:
            errors.append("Cannot finalize run log: "+safe_error(exc))
            annotation(errors[-1],"error")
    manifest={"version":VERSION,"retention_class":args.retention_class,
              "run":{**run,**update},"files":files,"archive_errors":errors}
    (output/"archive_manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
    print("ARCHIVE_RESULT",archive_status, f"{len(files)}/{len(expected)}",flush=True)
    if returncode: return returncode if returncode>0 else 1
    # PENDING_DATA can have exit 0 in the legacy script, but metadata does not claim success.
    if errors or generated not in ("READY","PENDING_DATA") or (generated=="READY" and archive_status!="STORED"): return 2
    return 0

def cleanup_files(args: argparse.Namespace, client: Client | None = None) -> int:
    client=client or Client()
    cleanup_id=str(uuid.uuid4())
    info={"id":cleanup_id,"dry_run":args.dry_run,
          "github_run_url":run_identity("KTTV_6H")["github_run_url"]}
    client.rest("POST",CLEANUPS,info)
    outcomes=[];deleted=0;failed=0;candidate_count=0
    try:
        rows=client.rpc("av_report_archive_due" if args.dry_run else
                        "av_report_archive_claim_delete",{"p_limit":args.max_files}) or []
        candidate_count=len(rows)
        for row in rows:
            if args.dry_run:
                outcomes.append({"id":row["id"],"result":"WOULD_DELETE","expires_at":row["expires_at"]})
                print("WOULD_DELETE",row["id"],flush=True)
                continue
            try:
                client.delete_verified(row)
                client.rpc("av_report_archive_finish_delete",
                    {"p_id":row["id"],"p_token":row["delete_token"],"p_success":True,"p_error":None})
                deleted+=1
                outcomes.append({"id":row["id"],"result":"DELETED"})
                print("ARCHIVE_DELETED",row["id"],flush=True)
            except Exception as exc:
                failed+=1
                outcomes.append({"id":row["id"],"result":"ERROR","error":safe_error(exc)})
                # If deletion succeeded but confirmation failed, the lease permits recovery.
                try:
                    client.rpc("av_report_archive_finish_delete",
                        {"p_id":row["id"],"p_token":row["delete_token"],
                         "p_success":False,"p_error":safe_error(exc)})
                except Exception: pass
        result={"finished_at":utcnow(),"candidate_count":candidate_count,
                "deleted_count":deleted,"failed_count":failed,
                "status":"FAILED" if failed else "DRY_RUN" if args.dry_run else "SUCCEEDED",
                "detail":outcomes}
    except Exception as exc:
        result={"finished_at":utcnow(),"status":"FAILED","error_text":safe_error(exc),
                "candidate_count":candidate_count,"deleted_count":deleted,
                "failed_count":failed+1,"detail":outcomes}
        failed+=1
    client.rest("PATCH",CLEANUPS,result,{"id":"eq."+cleanup_id})
    print("CLEANUP_RESULT",result["status"],"deleted",deleted,"failed",failed,flush=True)
    return 1 if failed else 0

def link_artifact(args: argparse.Namespace) -> int:
    path=Path(args.manifest)
    if not path.exists():
        print("No archive manifest; nothing to link.")
        return 0
    doc=json.loads(path.read_text(encoding="utf-8"))
    url=os.getenv("AV_ARTIFACT_URL","")
    aid=os.getenv("AV_ARTIFACT_ID","")
    if not url or not aid:
        print("No GitHub artifact output to link.")
        return 0
    client=Client()
    client.rest("PATCH",RUNS,{"github_artifact_url":url,"github_artifact_id":aid},
                {"id":"eq."+doc["run"]["id"]})
    return 0


def resume_archive(args: argparse.Namespace) -> int:
    """Recover archive from a downloaded GitHub Artifact. NEVER executes SMTP."""
    directory=Path(args.directory).resolve()
    doc=json.loads((directory/"archive_manifest.json").read_text(encoding="utf-8"))
    run=doc["run"]
    expected=expected_files(run["pipeline"],parse_day(run["report_date"]),run["report_hour"],directory)
    client=Client()
    policy=client.rest("GET",POLICY,filters={
        "retention_class":"eq."+doc["retention_class"],"select":"*"})[0]
    # The original registration can have failed while report generation still succeeded.
    client.rest("POST",RUNS,run,{"on_conflict":"id"},
                prefer="resolution=ignore-duplicates,return=minimal")
    archived=[]; errors=[]
    for report,path in expected.items():
        if not path.exists():
            errors.append("Missing local report: "+path.name); continue
        try:
            archived.append(archive_one(client,run,report,path,policy,run["email_requested"],""))
        except Exception as exc:
            errors.append(report+": "+safe_error(exc))
    update={"archived_files":len(archived),
            "archive_status":"STORED" if len(archived)==len(expected) else "PARTIAL" if archived else "FAILED"}
    update["error_text"]=safe_error("; ".join(errors)) if errors else (
        run.get("error_text") if run["process_status"]!="SUCCEEDED" else None)
    client.rest("PATCH",RUNS,update,{"id":"eq."+run["id"]})
    print("RECOVERY_NO_EMAIL",update["archive_status"],len(archived),len(expected))
    for e in errors: annotation(e,"error")
    return 1 if errors else 0

def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__)
    sub=ap.add_subparsers(dest="action",required=True)
    rp=sub.add_parser("run")
    rp.add_argument("--pipeline",choices=["DAILY07_BUNDLE","KTTV_6H"],required=True)
    rp.add_argument("--date",default="")
    rp.add_argument("--hour",type=int,choices=[1,7,13,19],default=7)
    rp.add_argument("--send-email",action="store_true")
    rp.add_argument("--retry-failed",action="store_true")
    rp.add_argument("--force-resend",action="store_true",
                    help="Manual only: resend only when a previous SMTP_ACCEPTED exists")
    rp.add_argument("--retention-class",choices=["REPORT","TEST"],default="REPORT")
    rp.add_argument("--output-dir",required=True)
    cp=sub.add_parser("cleanup")
    cp.add_argument("--dry-run",action="store_true")
    cp.add_argument("--max-files",type=int,default=20,choices=range(1,101))
    lp=sub.add_parser("link-artifact")
    lp.add_argument("--manifest",required=True)
    rs=sub.add_parser("resume-archive")
    rs.add_argument("--directory",required=True)
    args=ap.parse_args()
    if args.action=="resume-archive": return resume_archive(args)
    if args.action=="run": return run_reports(args)
    if args.action=="cleanup": return cleanup_files(args)
    return link_artifact(args)

if __name__=="__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        annotation(safe_error(exc),"error")
        sys.exit(1)
