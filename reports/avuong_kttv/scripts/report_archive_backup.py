#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Download immutable report copies to a durable local/organisational disk.
Uses a private server key entered interactively. NEVER emails or deletes a file.
SHA256 must match before a backup confirmation is written to Supabase.
"""
from __future__ import annotations
import argparse
import getpass
import hashlib
import json
import os
import sys
from pathlib import Path
from report_archive import Client, FILES, safe_error, utcnow

def backup(args: argparse.Namespace) -> int:
    if not args.confirm_durable_location:
        raise ValueError("Add --confirm-durable-location only for a durable backup disk, NOT a GitHub runner.")
    url=os.getenv("SUPABASE_URL","").strip() or input("Supabase project URL (https://...supabase.co): ").strip()
    key=os.getenv("SUPABASE_SERVICE_ROLE_KEY","").strip() or getpass.getpass("Service role key (hidden; do not share): ").strip()
    client=Client(url,key)
    root=Path(args.destination).expanduser().resolve()
    root.mkdir(parents=True,exist_ok=True)
    cursor=None;done=0;failures=0
    while True:
        filters={"select":"*","archive_status":"in.(STORED,DELETE_FAILED)",
                 "order":"id.asc","limit":"100"}
        if cursor: filters["id"]="gt."+cursor
        rows=client.rest("GET",FILES,filters=filters) or []
        if not rows: break
        for row in rows:
            cursor=row["id"]
            if Path(row["file_name"]).name!=row["file_name"] or "/" in row["file_name"] or "\\" in row["file_name"]:
                raise ValueError("Invalid stored file name")
            target=root/row["report_date"]/row["report_type"]/row["id"]/row["file_name"]
            target.parent.mkdir(parents=True,exist_ok=True)
            if not target.resolve().is_relative_to(root):
                raise ValueError("Backup target leaves destination folder")
            try:
                if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==row["sha256"]:
                    data=None
                else:
                    data=client.download(row["bucket"],row["object_path"])
                    if hashlib.sha256(data).hexdigest()!=row["sha256"]:
                        raise RuntimeError("Backup SHA256 mismatch")
                    temp=target.with_name(target.name+".partial")
                    with temp.open("wb") as f:
                        f.write(data);f.flush();os.fsync(f.fileno())
                    temp.replace(target)
                if hashlib.sha256(target.read_bytes()).hexdigest()!=row["sha256"]:
                    raise RuntimeError("On-disk backup verification failed")
                # Do not mark arbitrary locations from SQL; this confirms an actual verified file.
                client.rpc("av_report_archive_confirm_backup",
                    {"p_id":row["id"],"p_sha256":row["sha256"],"p_location":str(target)})
                meta={"file_id":row["id"],"sha256":row["sha256"],"verified_at":utcnow(),
                      "original_object_path":row["object_path"],"report_date":row["report_date"]}
                target.with_suffix(target.suffix+".backup.json").write_text(
                    json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8")
                done+=1
                print("BACKUP_VERIFIED",row["id"],target.name)
            except Exception as exc:
                failures+=1;print("BACKUP_FAILED",row["id"],safe_error(exc),file=sys.stderr)
    print(f"BACKUP_RESULT verified={done} failed={failures}")
    return 1 if failures else 0

def main() -> int:
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--destination",required=True)
    ap.add_argument("--confirm-durable-location",action="store_true")
    return backup(ap.parse_args())

if __name__=="__main__":
    try: sys.exit(main())
    except Exception as exc:
        print("ERROR:",safe_error(exc),file=sys.stderr);sys.exit(1)
