const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

function num(value, defaultValue = null) {
  if (value === null || value === undefined || value === "") return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
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

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase REST ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Supabase response is not JSON: ${text.slice(0, 300)}`);
  }
}

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
  const rows = await supabaseSelect(
    "downstream_alarm_thresholds?select=*"
  );

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

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      return json(res, 200, { ok: true });
    }

    if (req.method !== "GET") {
      return json(res, 405, {
        ok: false,
        error: "Method not allowed",
      });
    }

    if (req.query.debug === "env") {
      return json(res, 200, {
        ok: true,
        has_SUPABASE_URL: !!SUPABASE_URL,
        has_SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_KEY,
      });
    }

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

      const alarm = getAlarmLevel(
        forecasts,
        thresholds[station.station_code]
      );

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
      mode: "downstream-forecast",
      forecast_time: forecastTime.toISOString(),
      input,
      stations,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "downstream-forecast",
      error: err.message,
      hint:
        "Kiểm tra SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, view downstream_active_model_coefficients và bảng downstream_alarm_thresholds",
    });
  }
}
