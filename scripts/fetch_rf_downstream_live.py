#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import argparse
from pathlib import Path
import pandas as pd
from rf_downstream_common import build_live_base

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=72)
    ap.add_argument("--output", default="rf_downstream_live_input.csv")
    a = ap.parse_args()

    df = build_live_base(hours=a.hours)
    Path(a.output).parent.mkdir(parents=True, exist_ok=True)
    df.reset_index().to_csv(a.output, index=False, encoding="utf-8-sig")

    print("Rows:", len(df))
    print("Time:", df.index.min(), "->", df.index.max())
    print(df.tail(10).to_string())
    print("Saved:", a.output)

if __name__ == "__main__":
    main()
