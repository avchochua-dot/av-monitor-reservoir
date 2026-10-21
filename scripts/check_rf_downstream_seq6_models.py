#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate the 12-model release before any live API access or Supabase write."""
import argparse
import json
from pathlib import Path
import joblib
import sklearn

RELEASE = "RF_DOWNSTREAM_V2_SEQ6_20261020_R1"
GAUGES = ["hoi_khach", "ai_nghia"]
HORIZONS = [1,2,3,4,5,6]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--model-dir", default="rf_downstream_v2_final_models")
    a=parser.parse_args()
    folder=Path(a.model_dir)
    manifest=json.loads((folder/"manifest.json").read_text(encoding="utf-8"))
    if manifest.get("release_version") != RELEASE:
        raise RuntimeError(f"manifest release mismatch: {manifest.get('release_version')!r}")
    if manifest.get("sklearn_version") != sklearn.__version__:
        raise RuntimeError(f"sklearn version mismatch: manifest {manifest.get('sklearn_version')} vs installed {sklearn.__version__}")
    if int(manifest.get("hyperparameters", {}).get("n_estimators", 0)) != 700:
        raise RuntimeError("Production sequence release must contain 700-tree RF models.")
    for g in GAUGES:
        for h in HORIZONS:
            path=folder/f"rf_v2_final_{g}_h{h:02d}.joblib"
            if not path.exists():
                raise FileNotFoundError(f"MISSING model: {path}")
            b=joblib.load(path)
            if (b["gauge"] != g or
                int(b["horizon_h"]) != h or
                b["target_type"] != "delta_h" or
                b["source_sha256"] != manifest["source_sha256"] or
                b.get("sklearn_version") != sklearn.__version__ or
                len(b["features"]) != 196 or
                b["model"].__class__.__name__ != "RandomForestRegressor" or
                int(b["model"].n_estimators) != 700):
                raise RuntimeError(f"INVALID bundle {path}")
            meta=manifest["candidates"][g][str(h)]
            if meta["model_file"] != path.name or meta["feature_count"] != 196:
                raise RuntimeError(f"INVALID manifest reference: {g} H+{h}")
            print(f"OK {g:<10} H+{h}: {path.stat().st_size / (1024**2):.2f} MiB [{meta['evaluation_status']}]")
    print(f"RELEASE PASS: {RELEASE}, 12/12 model bundles")

if __name__=="__main__":
    main()
