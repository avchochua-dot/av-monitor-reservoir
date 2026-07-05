const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, data, cache = "no-store") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", cache);
  return res.status(status).json(data);
}

function num(value, defaultValue = null) {
  if (value === null || value === undefined || value === "") return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function text(value, defaultValue = "") {
  if (value === null || value === undefined || value === "") return defaultValue;
  return String(value);
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toDateOnly(value) {
  if (!value) return null;

  const s = String(value);

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  const d = new Date(s);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString().slice(0, 10);
}

function readBody(req) {
  if (!req.body) return {};

  if (typeof req.body === "object") {
    return req.body;
  }

  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function pickValue(req, body, key, defaultValue = null) {
  if (body && body[key] !== undefined) return body[key];
  if (req.query && req.query[key] !== undefined) return req.query[key];
  return defaultValue;
}

function toIsoTime(value) {
  if (!value) return new Date().toISOString();

  const d = new Date(String(value));

  if (Number.isNaN(d.getTime())) {
    throw new Error("Thời gian không hợp lệ");
  }

  return d.toISOString();
}

function toIsoHour(value) {
  const d = value ? new Date(String(value)) : new Date();

  if (Number.isNaN(d.getTime())) {
    throw new Error("obs_hour không hợp lệ");
  }

  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function buildObsTimeFromDateHour(req, body) {
  const obsDate = pickValue(req, body, "obs_date", null);
  const obsHour = pickValue(req, body, "obs_hour_value", null);

  if (!obsDate || obsHour === null || obsHour === undefined || obsHour === "") {
    return null;
  }

  const h = Number(obsHour);

  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error("obs_hour_value phải là số nguyên từ 0 đến 23");
  }

  const hh = String(h).padStart(2, "0");

  // Theo vận hành Việt Nam: ngày + giờ local UTC+7.
  // Chuyển về UTC khi lưu timestamptz.
  return `${obsDate}T${hh}:00:00+07:00`;
}

async function supabaseSelect(path) {
  if (!SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL");
  }

  if (!SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase REST SELECT ${response.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Supabase response is not JSON: ${body.slice(0, 300)}`);
  }
}

async function supabaseInsert(path, payload) {
  if (!SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL");
  }

  if (!SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase REST INSERT ${response.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Supabase insert response is not JSON: ${body.slice(0, 300)}`);
  }
}

async function supabaseUpsert(path, payload, onConflict) {
  if (!SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL");
  }

  if (!SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  const url =
    `${SUPABASE_URL}/rest/v1/${path}` +
    `?on_conflict=${encodeURIComponent(onConflict)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase REST UPSERT ${response.status}: ${body}`);
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Supabase upsert response is not JSON: ${body.slice(0, 300)}`);
  }
}

/* ======================================================
   FORECAST REALTIME
====================================================== */

function getInputVariables(query) {
  return {
    Hoi_Khach_cm: num(query.Hoi_Khach_cm),
    Ai_Nghia_cm: num(query.Ai_Nghia_cm),

    A_Vuong_Qra: num(query.A_Vuong_Qra),
    DakMi4_Qra: num(query.DakMi4_Qra),
    SongBung4_Qra: num(query.SongBung4_Qra),
    SongTranh2_Qra: num(query.SongTranh2_Qra),

    VuGia_3ho_Qra: num(query.VuGia_3ho_Qra),
    All4_Qra: num(query.All4_Qra),

    PCTT_Qve_VuGia: num(query.PCTT_Qve_VuGia),
    PCTT_Qve_ThuBon: num(query.PCTT_Qve_ThuBon),

    HK_Delta_1h: num(query.HK_Delta_1h, 0),
    HK_Delta_3h: num(query.HK_Delta_3h, 0),

    AN_Delta_1h: num(query.AN_Delta_1h, 0),
    AN_Delta_3h: num(query.AN_Delta_3h, 0),

    Q_VuGia_Delta_1h: num(query.Q_VuGia_Delta_1h, 0),
    Q_VuGia_Delta_3h: num(query.Q_VuGia_Delta_3h, 0),
  };
}

function validateInput(input) {
  const required = [
    "Hoi_Khach_cm",
    "Ai_Nghia_cm",
    "A_Vuong_Qra",
    "DakMi4_Qra",
    "SongBung4_Qra",
    "SongTranh2_Qra",
    "VuGia_3ho_Qra",
    "All4_Qra",
    "PCTT_Qve_VuGia",
    "PCTT_Qve_ThuBon",
  ];

  const missing = required.filter((key) => input[key] === null);

  return {
    ok: missing.length === 0,
    missing,
  };
}

async function loadCoefficients() {
  return supabaseSelect(
    "downstream_active_model_coefficients?select=*&order=model_code.asc"
  );
}

async function loadThresholds() {
  const rows = await supabaseSelect("downstream_alarm_thresholds?select=*");

  const map = {};

  for (const row of rows || []) {
    map[row.station_code] = row;
  }

  return map;
}

async function loadMetrics() {
  const rows = await supabaseSelect(
    "downstream_forecast_model_metrics?select=model_code,station_code,horizon_hours,test_r2,test_mae_cm,test_rmse_cm"
  );

  const map = {};

  for (const row of rows || []) {
    map[row.model_code] = row;
  }

  return map;
}

function calculateForecast(modelCode, coefficients, input) {
  const rows = coefficients.filter((x) => x.model_code === modelCode);

  if (!rows.length) {
    throw new Error(`Không tìm thấy hệ số cho model ${modelCode}`);
  }

  let result = 0;

  for (const row of rows) {
    const variableName = row.variable_name;
    const coef = Number(row.coefficient);

    if (!Number.isFinite(coef)) {
      throw new Error(
        `Hệ số không hợp lệ: model=${modelCode}, variable=${variableName}`
      );
    }

    if (variableName === "intercept") {
      result += coef;
      continue;
    }

    const value = input[variableName];

    if (value === undefined || value === null) {
      throw new Error(
        `Thiếu biến đầu vào ${variableName} cho model ${modelCode}`
      );
    }

    result += coef * Number(value);
  }

  return result;
}

function getAlarmLevel(forecasts, threshold) {
  if (!threshold) {
    return {
      alarm_level: "unknown",
      alarm_message: "Chưa cấu hình ngưỡng báo động cho trạm",
    };
  }

  const bd1 = Number(threshold.bd1_cm);
  const bd2 = Number(threshold.bd2_cm);
  const bd3 = Number(threshold.bd3_cm);
  const watchRatio = Number(threshold.watch_ratio || 0.8);

  const fc4 = forecasts.find((x) => x.horizon_hours === 4)?.forecast_water_level_cm;
  const fc6 = forecasts.find((x) => x.horizon_hours === 6)?.forecast_water_level_cm;
  const fc12 = forecasts.find((x) => x.horizon_hours === 12)?.forecast_water_level_cm;

  const max4to6 = Math.max(fc4 ?? -Infinity, fc6 ?? -Infinity);
  const maxAll = Math.max(fc4 ?? -Infinity, fc6 ?? -Infinity, fc12 ?? -Infinity);

  if (max4to6 >= bd3) {
    return {
      alarm_level: "emergency",
      alarm_message: "Dự báo có khả năng vượt báo động III trong 4-6 giờ tới",
    };
  }

  if (max4to6 >= bd2) {
    return {
      alarm_level: "danger",
      alarm_message: "Dự báo có khả năng vượt báo động II trong 4-6 giờ tới",
    };
  }

  if (max4to6 >= bd1) {
    return {
      alarm_level: "warning",
      alarm_message: "Dự báo có khả năng vượt báo động I trong 4-6 giờ tới",
    };
  }

  if (maxAll >= bd1 * watchRatio) {
    return {
      alarm_level: "watch",
      alarm_message: "Mực nước dự báo tiệm cận báo động I, cần theo dõi",
    };
  }

  return {
    alarm_level: "normal",
    alarm_message: "Mực nước dự báo dưới ngưỡng cảnh báo",
  };
}

async function handleForecast(req, res) {
  const forecastTime = req.query.time
    ? new Date(String(req.query.time))
    : new Date();

  if (Number.isNaN(forecastTime.getTime())) {
    return json(res, 400, {
      ok: false,
      error: "Tham số time không hợp lệ",
    });
  }

  const input = getInputVariables(req.query);
  const valid = validateInput(input);

  if (!valid.ok) {
    return json(res, 400, {
      ok: false,
      error: "Thiếu biến đầu vào",
      missing: valid.missing,
      example:
        "/api/downstream-forecast?Hoi_Khach_cm=870&Ai_Nghia_cm=270&A_Vuong_Qra=0&DakMi4_Qra=29.23&SongBung4_Qra=27&SongTranh2_Qra=94.25&VuGia_3ho_Qra=56.23&All4_Qra=150.48&PCTT_Qve_VuGia=56.23&PCTT_Qve_ThuBon=117.13",
    });
  }

  const [coefficients, thresholds, metrics] = await Promise.all([
    loadCoefficients(),
    loadThresholds(),
    loadMetrics(),
  ]);

  if (!coefficients.length) {
    throw new Error(
      "Không có hệ số mô hình trong downstream_active_model_coefficients"
    );
  }

  const modelGroups = [
    {
      station_code: "HOI_KHACH",
      station_name: "Hội Khách",
      current_water_level_cm: input.Hoi_Khach_cm,
      models: [
        { model_code: "HK_4H", horizon_hours: 4 },
        { model_code: "HK_6H", horizon_hours: 6 },
        { model_code: "HK_12H", horizon_hours: 12 },
      ],
    },
    {
      station_code: "AI_NGHIA",
      station_name: "Ái Nghĩa",
      current_water_level_cm: input.Ai_Nghia_cm,
      models: [
        { model_code: "AN_4H", horizon_hours: 4 },
        { model_code: "AN_6H", horizon_hours: 6 },
        { model_code: "AN_12H", horizon_hours: 12 },
      ],
    },
  ];

  const stations = [];

  for (const station of modelGroups) {
    const forecasts = station.models.map((m) => {
      const forecastValue = calculateForecast(
        m.model_code,
        coefficients,
        input
      );

      const metric = metrics[m.model_code] || null;

      return {
        model_code: m.model_code,
        horizon_hours: m.horizon_hours,
        target_time: addHours(forecastTime, m.horizon_hours).toISOString(),
        forecast_water_level_cm: round(forecastValue, 2),
        model_quality: metric
          ? {
              test_r2: round(metric.test_r2, 3),
              test_mae_cm: round(metric.test_mae_cm, 2),
              test_rmse_cm: round(metric.test_rmse_cm, 2),
            }
          : null,
      };
    });

    const alarm = getAlarmLevel(forecasts, thresholds[station.station_code]);

    stations.push({
      station_code: station.station_code,
      station_name: station.station_name,
      current_water_level_cm: station.current_water_level_cm,
      forecasts,
      alarm_level: alarm.alarm_level,
      alarm_message: alarm.alarm_message,
      thresholds: thresholds[station.station_code] || null,
    });
  }

  return json(res, 200, {
    ok: true,
    mode: "forecast",
    forecast_time: forecastTime.toISOString(),
    input,
    stations,
  });
}

/* ======================================================
   MANUAL DOWNSTREAM OBSERVATION
====================================================== */

async function handleSaveManual(req, res) {
  const body = readBody(req);

  const obsTimeRaw =
    pickValue(req, body, "obs_time", null) ||
    pickValue(req, body, "obs_hour", null) ||
    pickValue(req, body, "time", null) ||
    buildObsTimeFromDateHour(req, body);

  const obsTime = toIsoTime(obsTimeRaw);
  const obsHour = toIsoHour(obsTimeRaw);

  const hoiKhachM = num(
    pickValue(req, body, "hoi_khach_m", null)
  );

  const aiNghiaM = num(
    pickValue(req, body, "ai_nghia_m", null)
  );

  const note = text(
    pickValue(req, body, "note", "")
  );

  const createdBy = text(
    pickValue(req, body, "created_by", "operator")
  );

  if (hoiKhachM === null && aiNghiaM === null) {
    return json(res, 400, {
      ok: false,
      mode: "save-manual",
      error: "Cần nhập ít nhất hoi_khach_m hoặc ai_nghia_m",
    });
  }

  if (hoiKhachM !== null && (hoiKhachM < 0 || hoiKhachM > 30)) {
    return json(res, 400, {
      ok: false,
      mode: "save-manual",
      error: "hoi_khach_m ngoài khoảng hợp lý 0-30 m",
    });
  }

  if (aiNghiaM !== null && (aiNghiaM < 0 || aiNghiaM > 20)) {
    return json(res, 400, {
      ok: false,
      mode: "save-manual",
      error: "ai_nghia_m ngoài khoảng hợp lý 0-20 m",
    });
  }

  const nowIso = new Date().toISOString();

  const payload = {
    obs_time: obsTime,
    obs_hour: obsHour,
    hoi_khach_m: hoiKhachM,
    ai_nghia_m: aiNghiaM,
    source: "manual",
    note,
    created_by: createdBy,
    updated_at: nowIso,
  };

  const upserted = await supabaseUpsert(
    "downstream_manual_observations",
    payload,
    "obs_hour"
  );

  return json(res, 200, {
    ok: true,
    mode: "save-manual",
    action: "upsert_by_obs_hour",
    message: "Đã lưu/ghi đè số liệu hạ du theo giờ",
    obs_hour: obsHour,
    data: upserted?.[0] || null,
  });
}

async function handleLatestInput(req, res) {
  const rows = await supabaseSelect(
    "downstream_latest_manual_with_delta?select=*&limit=1"
  );

  const latest = rows?.[0] || null;

  if (!latest) {
    return json(res, 404, {
      ok: false,
      mode: "latest-input",
      error: "Chưa có số liệu hạ du nhập tay",
    });
  }

  return json(res, 200, {
    ok: true,
    mode: "latest-input",
    source: {
      downstream: "manual_supabase",
      reservoir: "pctt_or_frontend_current_state",
    },
    downstream: {
      id: latest.id,
      obs_hour: latest.obs_hour || null,
      obs_time: latest.obs_time || latest.obs_hour || null,

      Hoi_Khach_m: round(latest.hoi_khach_m, 2),
      Ai_Nghia_m: round(latest.ai_nghia_m, 2),

      Hoi_Khach_cm: round(latest.hoi_khach_cm, 2),
      Ai_Nghia_cm: round(latest.ai_nghia_cm, 2),

      HK_Delta_1h_cm: round(latest.hk_delta_1h_cm, 2),
      HK_Delta_3h_cm: round(latest.hk_delta_3h_cm, 2),

      AN_Delta_1h_cm: round(latest.an_delta_1h_cm, 2),
      AN_Delta_3h_cm: round(latest.an_delta_3h_cm, 2),

      HK_Delta_1h_m: round(Number(latest.hk_delta_1h_cm || 0) / 100, 2),
      HK_Delta_3h_m: round(Number(latest.hk_delta_3h_cm || 0) / 100, 2),

      AN_Delta_1h_m: round(Number(latest.an_delta_1h_cm || 0) / 100, 2),
      AN_Delta_3h_m: round(Number(latest.an_delta_3h_cm || 0) / 100, 2),

      source: latest.source || "manual",
      note: latest.note || "",
      created_by: latest.created_by || "",
      created_at: latest.created_at || null,
      updated_at: latest.updated_at || null,
    },
  });
}

async function handleManualHistory(req, res) {
  const limit = Math.min(num(req.query.limit, 50), 500);

  const rows = await supabaseSelect(
    `downstream_manual_observations?select=id,obs_hour,obs_time,hoi_khach_m,ai_nghia_m,hoi_khach_cm,ai_nghia_cm,source,note,created_by,created_at,updated_at&order=obs_hour.desc&limit=${limit}`
  );

  return json(res, 200, {
    ok: true,
    mode: "manual-history",
    limit,
    data: rows || [],
  });
}

/* ======================================================
   BACKTEST
====================================================== */

function getStationConfig(station) {
  const s = String(station || "").toUpperCase();

  if (s === "HK" || s === "HOI_KHACH") {
    return {
      station_code: "HOI_KHACH",
      station_name: "Hội Khách",
      model_prefix: "HK",
    };
  }

  if (s === "AN" || s === "AI_NGHIA") {
    return {
      station_code: "AI_NGHIA",
      station_name: "Ái Nghĩa",
      model_prefix: "AN",
    };
  }

  return null;
}

function buildBacktestPath({
  station_code,
  horizon,
  startDate,
  endDate,
  split,
  limit,
}) {
  const params = new URLSearchParams();

  params.set(
    "select",
    [
      "model_code",
      "station_code",
      "horizon_hours",
      "split",
      "forecast_time",
      "target_time",
      "current_water_level_cm",
      "forecast_water_level_cm",
      "actual_water_level_cm",
      "error_cm",
      "abs_error_cm",
    ].join(",")
  );

  params.set("station_code", `eq.${station_code}`);

  if (horizon) {
    params.set("horizon_hours", `eq.${horizon}`);
  }

  if (split) {
    params.set("split", `eq.${String(split).toUpperCase()}`);
  }

  if (startDate) {
    params.append("forecast_time", `gte.${startDate}T00:00:00+00:00`);
  }

  if (endDate) {
    params.append("forecast_time", `lte.${endDate}T23:59:59+00:00`);
  }

  params.set("order", "forecast_time.asc");
  params.set("limit", String(limit));

  return `downstream_forecast_backtest?${params.toString()}`;
}

function buildSummaryPath({ station_code, horizon }) {
  const params = new URLSearchParams();

  params.set(
    "select",
    [
      "model_code",
      "station_code",
      "horizon_hours",
      "split",
      "n_rows",
      "bias_cm",
      "mae_cm",
      "rmse_cm",
      "max_abs_error_cm",
      "from_time",
      "to_time",
    ].join(",")
  );

  params.set("station_code", `eq.${station_code}`);

  if (horizon) {
    params.set("horizon_hours", `eq.${horizon}`);
  }

  params.set("order", "horizon_hours.asc,split.asc");

  return `downstream_forecast_backtest_summary?${params.toString()}`;
}

function buildMetricsPath({ station_code, horizon }) {
  const params = new URLSearchParams();

  params.set(
    "select",
    [
      "model_code",
      "station_code",
      "horizon_hours",
      "sample_count",
      "train_count",
      "test_count",
      "test_r2",
      "test_mae_cm",
      "test_rmse_cm",
      "test_max_abs_error_cm",
      "test_bias_cm",
      "all_r2",
      "all_mae_cm",
      "all_rmse_cm",
      "all_max_abs_error_cm",
      "all_bias_cm",
    ].join(",")
  );

  params.set("station_code", `eq.${station_code}`);

  if (horizon) {
    params.set("horizon_hours", `eq.${horizon}`);
  }

  params.set("order", "horizon_hours.asc");

  return `downstream_forecast_model_metrics?${params.toString()}`;
}

function summarizeRows(rows) {
  if (!rows.length) {
    return {
      n_rows: 0,
      bias_cm: null,
      mae_cm: null,
      rmse_cm: null,
      max_abs_error_cm: null,
      min_forecast_time: null,
      max_forecast_time: null,
    };
  }

  const errors = rows
    .map((x) => Number(x.error_cm))
    .filter((x) => Number.isFinite(x));

  const absErrors = rows
    .map((x) => Number(x.abs_error_cm))
    .filter((x) => Number.isFinite(x));

  const bias =
    errors.length > 0
      ? errors.reduce((a, b) => a + b, 0) / errors.length
      : null;

  const mae =
    absErrors.length > 0
      ? absErrors.reduce((a, b) => a + b, 0) / absErrors.length
      : null;

  const rmse =
    errors.length > 0
      ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length)
      : null;

  const maxAbs =
    absErrors.length > 0
      ? Math.max(...absErrors)
      : null;

  return {
    n_rows: rows.length,
    bias_cm: round(bias, 2),
    mae_cm: round(mae, 2),
    rmse_cm: round(rmse, 2),
    max_abs_error_cm: round(maxAbs, 2),
    min_forecast_time: rows[0]?.forecast_time || null,
    max_forecast_time: rows[rows.length - 1]?.forecast_time || null,
  };
}

async function handleBacktest(req, res) {
  const stationInput = text(
    req.query.station || req.query.station_code || "HOI_KHACH"
  );

  const station = getStationConfig(stationInput);

  if (!station) {
    return json(res, 400, {
      ok: false,
      error: "station không hợp lệ",
      supported_station: ["HOI_KHACH", "AI_NGHIA"],
      examples: [
        "/api/downstream-forecast?mode=backtest&station=HOI_KHACH&horizon=6",
        "/api/downstream-forecast?mode=backtest&station=AI_NGHIA&horizon=12",
      ],
    });
  }

  const horizon = num(req.query.horizon || req.query.horizon_hours, null);

  if (horizon !== null && ![4, 6, 12].includes(horizon)) {
    return json(res, 400, {
      ok: false,
      error: "horizon không hợp lệ, chỉ hỗ trợ 4, 6, 12",
    });
  }

  const startDate = toDateOnly(req.query.start || "2025-09-01");
  const endDate = toDateOnly(req.query.end || "2025-12-31");
  const split = req.query.split ? String(req.query.split).toUpperCase() : "";
  const limit = Math.min(num(req.query.limit, 5000), 20000);

  const rows = await supabaseSelect(
    buildBacktestPath({
      station_code: station.station_code,
      horizon,
      startDate,
      endDate,
      split,
      limit,
    })
  );

  const normalized = rows.map((x) => ({
    model_code: x.model_code,
    station_code: x.station_code,
    horizon_hours: x.horizon_hours,
    split: x.split,
    forecast_time: x.forecast_time,
    target_time: x.target_time,
    current_water_level_cm: round(x.current_water_level_cm, 2),
    forecast_water_level_cm: round(x.forecast_water_level_cm, 2),
    actual_water_level_cm: round(x.actual_water_level_cm, 2),
    error_cm: round(x.error_cm, 2),
    abs_error_cm: round(x.abs_error_cm, 2),
  }));

  return json(
    res,
    200,
    {
      ok: true,
      mode: "backtest",
      station_code: station.station_code,
      station_name: station.station_name,
      horizon_hours: horizon,
      start: startDate,
      end: endDate,
      split: split || "ALL",
      limit,
      summary: summarizeRows(normalized),
      data: normalized,
    },
    "s-maxage=300, stale-while-revalidate=600"
  );
}

async function handleSummary(req, res) {
  const stationInput = text(
    req.query.station || req.query.station_code || "HOI_KHACH"
  );

  const station = getStationConfig(stationInput);

  if (!station) {
    return json(res, 400, {
      ok: false,
      error: "station không hợp lệ",
      supported_station: ["HOI_KHACH", "AI_NGHIA"],
    });
  }

  const horizon = num(req.query.horizon || req.query.horizon_hours, null);

  if (horizon !== null && ![4, 6, 12].includes(horizon)) {
    return json(res, 400, {
      ok: false,
      error: "horizon không hợp lệ, chỉ hỗ trợ 4, 6, 12",
    });
  }

  const [summaryRows, metricsRows] = await Promise.all([
    supabaseSelect(
      buildSummaryPath({
        station_code: station.station_code,
        horizon,
      })
    ),
    supabaseSelect(
      buildMetricsPath({
        station_code: station.station_code,
        horizon,
      })
    ),
  ]);

  return json(
    res,
    200,
    {
      ok: true,
      mode: "summary",
      station_code: station.station_code,
      station_name: station.station_name,
      horizon_hours: horizon,
      summary: summaryRows,
      metrics: metricsRows,
    },
    "s-maxage=300, stale-while-revalidate=600"
  );
}

/* ======================================================
   API ENTRY
====================================================== */

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      return json(res, 200, { ok: true });
    }

    if (req.query.debug === "env") {
      return json(res, 200, {
        ok: true,
        has_SUPABASE_URL: !!SUPABASE_URL,
        has_SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_KEY,
      });
    }

    const mode = String(req.query.mode || "forecast").toLowerCase();

    if (mode === "save-manual") {
      if (req.method !== "POST" && req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,
          error: "save-manual chỉ hỗ trợ POST hoặc GET test nhanh",
        });
      }

      return handleSaveManual(req, res);
    }

    if (mode === "latest-input" || mode === "current-input") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,
          error: "latest-input chỉ hỗ trợ GET",
        });
      }

      return handleLatestInput(req, res);
    }

    if (mode === "manual-history") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,
          error: "manual-history chỉ hỗ trợ GET",
        });
      }

      return handleManualHistory(req, res);
    }

    if (req.method !== "GET") {
      return json(res, 405, {
        ok: false,
        error: "Method not allowed",
      });
    }

    if (mode === "forecast" || mode === "predict") {
      return handleForecast(req, res);
    }

    if (mode === "backtest" || mode === "history") {
      return handleBacktest(req, res);
    }

    if (mode === "summary" || mode === "metrics") {
      return handleSummary(req, res);
    }

    return json(res, 400, {
      ok: false,
      error: "mode không hợp lệ",
      supported_modes: [
        "forecast",
        "backtest",
        "summary",
        "save-manual",
        "latest-input",
        "current-input",
        "manual-history",
      ],
      examples: [
        "/api/downstream-forecast?mode=latest-input",
        "/api/downstream-forecast?mode=manual-history&limit=20",
        "/api/downstream-forecast?mode=save-manual&obs_time=2026-07-05T22:00:00+07:00&hoi_khach_m=14.35&ai_nghia_m=7.72&note=test-api&created_by=operator",
        "/api/downstream-forecast?mode=save-manual&obs_date=2026-07-05&obs_hour_value=22&hoi_khach_m=14.35&ai_nghia_m=7.72&note=test-api&created_by=operator",
        "/api/downstream-forecast?mode=forecast&Hoi_Khach_cm=870&Ai_Nghia_cm=270&A_Vuong_Qra=0&DakMi4_Qra=29.23&SongBung4_Qra=27&SongTranh2_Qra=94.25&VuGia_3ho_Qra=56.23&All4_Qra=150.48&PCTT_Qve_VuGia=56.23&PCTT_Qve_ThuBon=117.13",
        "/api/downstream-forecast?mode=backtest&station=HOI_KHACH&horizon=6&start=2025-09-01&end=2025-12-31",
        "/api/downstream-forecast?mode=summary&station=AI_NGHIA&horizon=12",
      ],
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: req.query.mode || "forecast",
      error: err.message,
      hint:
        "Kiểm tra SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, unique index obs_hour, bảng/view downstream forecast trong Supabase",
    });
  }
}
