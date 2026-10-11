name: A Vuong Shadow Forecast Evaluator V4

on:
  workflow_dispatch:
  schedule:
    # Main forecast pipeline runs at :05 and retry at :10.
    # Evaluate after both have had time to finish.
    - cron: "20 * * * *"

permissions:
  contents: read

concurrency:
  group: avuong-shadow-evaluator
  cancel-in-progress: false

jobs:
  evaluate:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    env:
      SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
      SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
      BASIN_ID: "AVUONG"
      SHADOW_OBS_LIMIT: "2000"

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Python 3.12
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Install dependencies
        shell: bash
        run: |
          set -euo pipefail
          python -m pip install --upgrade pip
          pip install pandas requests

      - name: Run A Vuong four-model fair shadow evaluator
        shell: bash
        run: |
          set -euo pipefail
          python scripts/evaluate_forecast_shadow.py
