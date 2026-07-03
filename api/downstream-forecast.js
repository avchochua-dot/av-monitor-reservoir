import { createClient } from "@supabase/supabase-js";

function getSupabaseClient() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error(
      "Missing SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL in Vercel Environment Variables"
    );
  }

  if (!key) {
    throw new Error(
      "Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY in Vercel Environment Variables"
    );
  }

  return createClient(url, key);
}

function toNumber(value, defaultValue = null) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null;
  }

  const p = Math.pow(10, digits);
  return Math.round(Number(value) * p) / p;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function getInputVariables(query) {
  return {
    Hoi_Khach_cm: toNumber(query.Hoi_Khach_cm),
    Ai_Nghia_cm: toNumber(query.Ai_Nghia_cm),

    A_Vuong_Qra: toNumber(query.A_Vuong_Qra),
    DakMi4_Qra: toNumber(query.DakMi4_Qra),
    SongBung4_Qra: toNumber(query.SongBung4_Qra),
    SongTranh2_Qra: toNumber(query.SongTranh2_Qra),

    VuGia_3ho_Qra: toNumber(query.VuGia_3ho_Qra),
    All4_Qra: toNumber(query.All4_Qra),

    PCTT_Qve_VuGia: toNumber(query.PCTT_Qve_VuGia),
    PCTT_Qve_ThuBon: toNumber(query.PCTT_Qve_ThuBon),

    HK_Delta_1h: toNumber(query.HK_Delta_1h, 0),
    HK_Delta_3h: toNumber(query.HK_Delta_3h, 0),

    AN_Delta_1h: toNumber(query.AN_Delta_1h, 0),
    AN_Delta_3h: toNumber(query.AN_Delta_3h, 0),

    Q_VuGia_Delta_1h: toNumber(query.Q_VuGia_Delta_1h, 0),
    Q_VuGia_Delta_3h: toNumber(query.Q_VuGia_Delta_3h, 0),
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

async function loadCoefficients(supabase) {
  const { data, error } = await supabase
    .from("downstream_active_model_coefficients")
    .select("*")
    .order("model_code", { ascending: true });

  if (error) {
    throw new Error(`Lỗi đọc hệ số mô hình: ${error.message}`);
  }

  return data || [];
}

async function loadThresholds(supabase) {
  const { data, error } = await supabase
    .from("downstream_alarm_thresholds")
    .select("*");

  if (error) {
    throw new Error(`Lỗi đọc ngưỡng báo động: ${error.message}`);
  }

  const map = {};

  for (const row of data || []) {
    map[row.station_code] = row;
  }

  return map;
}

async function loadMetrics(supabase) {
  const { data, error } = await supabase
    .from("downstream_forecast_model_metrics")
    .select(
      "model_code, station_code, horizon_hours, test_r2, test_mae_cm, test_rmse_cm"
    );

  if (error) {
    throw new Error(`Lỗi đọc metrics mô hình: ${error.message}`);
  }

  const map = {};

  for (const row of data || []) {
    map[row.model_code] = row;
  }

  return map;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");

    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    const supabase = getSupabaseClient();

    const forecastTime = req.query.time
      ? new Date(String(req.query.time))
      : new Date();

    if (Number.isNaN(forecastTime.getTime())) {
      return res.status(400).json({
        ok: false,
        error: "Tham số time không hợp lệ",
      });
    }

    const input = getInputVariables(req.query);
    const valid = validateInput(input);

    if (!valid.ok) {
      return res.status(400).json({
        ok: false,
        error: "Thiếu biến đầu vào",
        missing: valid.missing,
        example:
          "/api/downstream-forecast?Hoi_Khach_cm=870&Ai_Nghia_cm=270&A_Vuong_Qra=0&DakMi4_Qra=29.23&SongBung4_Qra=27&SongTranh2_Qra=94.25&VuGia_3ho_Qra=56.23&All4_Qra=150.48&PCTT_Qve_VuGia=56.23&PCTT_Qve_ThuBon=117.13",
      });
    }

    const [coefficients, thresholds, metrics] = await Promise.all([
      loadCoefficients(supabase),
      loadThresholds(supabase),
      loadMetrics(supabase),
    ]);

    if (!coefficients.length) {
      throw new Error("Không có hệ số mô hình trong downstream_active_model_coefficients");
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

    return res.status(200).json({
      ok: true,
      mode: "downstream-forecast",
      forecast_time: forecastTime.toISOString(),
      input,
      stations,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      mode: "downstream-forecast",
      error: err.message,
      hint:
        "Kiểm tra Vercel Environment Variables, package @supabase/supabase-js, view downstream_active_model_coefficients và bảng downstream_alarm_thresholds",
    });
  }
}
