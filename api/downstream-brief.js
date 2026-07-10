const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || ""; // ví dụ https://your-app.vercel.app

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

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "object") return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

async function supabaseSelect(path) {
  if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
  if (!SUPABASE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

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

async function supabaseInsert(path, payload, prefer = "return=representation") {
  if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
  if (!SUPABASE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase REST INSERT ${response.status}: ${body}`);
  }

  if (!body) return [];
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Supabase insert response is not JSON: ${body.slice(0, 300)}`);
  }
}

/* ======================================================
   INTERNAL FETCH HELPERS
====================================================== */

function getAppBaseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${proto}://${host}`;
}

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const textBody = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${textBody.slice(0, 500)}`);
    }

    try {
      return JSON.parse(textBody);
    } catch {
      throw new Error(`Response is not JSON: ${textBody.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function getNowIso() {
  return new Date().toISOString();
}

/* ======================================================
   DATA LOADERS
====================================================== */

async function loadObservedLatest(req) {
  const baseUrl = getAppBaseUrl(req);
  const url = `${baseUrl}/api/downstream-forecast?mode=observed-latest`;
  const data = await fetchJson(url);

  if (!data?.ok || !data?.data) {
    throw new Error("Không lấy được observed-latest");
  }

  const row = data.data;

  return {
    obs_hour: row.obs_hour,
    hoi_khach: {
      current_m: num(row.hoi_khach_m),
      current_cm: num(row.hoi_khach_cm),
      source: row.source || "unknown",
    },
    ai_nghia: {
      current_m: num(row.ai_nghia_m),
      current_cm: num(row.ai_nghia_cm),
      source: row.source || "unknown",
    },
  };
}

async function loadObservedHistory(req, hours = 72) {
  const baseUrl = getAppBaseUrl(req);
  const url = `${baseUrl}/api/downstream-forecast?mode=observed-history&hours=${encodeURIComponent(hours)}`;
  const data = await fetchJson(url);

  if (!data?.ok || !Array.isArray(data?.data)) {
    throw new Error("Không lấy được observed-history");
  }

  return data.data.map((row) => ({
    obs_hour: row.obs_hour,
    hoi_khach_m: num(row.hoi_khach_m),
    ai_nghia_m: num(row.ai_nghia_m),
    source: row.source || "unknown",
  }));
}

/**
 * TODO:
 * Hàm này cần ghép đúng với API forecast đang chạy thực tế của bạn.
 * Hiện skeleton giả định frontend/backend đã có cách truyền input forecast.
 *
 * Có 2 hướng:
 * 1. req query/body truyền sẵn input rồi gọi mode=forecast
 * 2. đọc input hiện tại từ bảng/endpoint nội bộ khác rồi tính forecast
 */
async function loadForecastNow(req) {
  const body = readBody(req);
  const baseUrl = getAppBaseUrl(req);

  // Cho phép gọi thẳng bằng body.forecast_input nếu có
  const forecastInput = body.forecast_input || null;

  if (!forecastInput) {
    throw new Error(
      "Thiếu forecast_input. Cần truyền input hiện tại để gọi downstream forecast."
    );
  }

  const qs = new URLSearchParams();
  qs.set("mode", "forecast");

  for (const [key, value] of Object.entries(forecastInput)) {
    if (value !== null && value !== undefined && value !== "") {
      qs.set(key, String(value));
    }
  }

  const url = `${baseUrl}/api/downstream-forecast?${qs.toString()}`;
  const data = await fetchJson(url);

  if (!data?.ok || !Array.isArray(data?.stations)) {
    throw new Error("Không lấy được forecast downstream");
  }

  const hk = data.stations.find((x) => x.station_code === "HOI_KHACH");
  const an = data.stations.find((x) => x.station_code === "AI_NGHIA");

  if (!hk || !an) {
    throw new Error("Thiếu forecast station HOI_KHACH/AI_NGHIA");
  }

  const findFc = (station, horizon) =>
    station.forecasts?.find((f) => Number(f.horizon_hours) === Number(horizon))
      ?.forecast_water_level_cm ?? null;

  const hk4 = findFc(hk, 4);
  const hk6 = findFc(hk, 6);
  const hk12 = findFc(hk, 12);

  const an4 = findFc(an, 4);
  const an6 = findFc(an, 6);
  const an12 = findFc(an, 12);

  return {
    hoi_khach: {
      h4_cm: num(hk4),
      h6_cm: num(hk6),
      h12_cm: num(hk12),
      h4_m: hk4 !== null ? round(hk4 / 100, 2) : null,
      h6_m: hk6 !== null ? round(hk6 / 100, 2) : null,
      h12_m: hk12 !== null ? round(hk12 / 100, 2) : null,
      alarm_level: hk.alarm_level || "unknown",
      alarm_message: hk.alarm_message || "",
      thresholds: hk.thresholds || null,
    },
    ai_nghia: {
      h4_cm: num(an4),
      h6_cm: num(an6),
      h12_cm: num(an12),
      h4_m: an4 !== null ? round(an4 / 100, 2) : null,
      h6_m: an6 !== null ? round(an6 / 100, 2) : null,
      h12_m: an12 !== null ? round(an12 / 100, 2) : null,
      alarm_level: an.alarm_level || "unknown",
      alarm_message: an.alarm_message || "",
      thresholds: an.thresholds || null,
    },
  };
}

/**
 * TODO:
 * Thay phần này bằng nguồn vận hành hồ thực tế của bạn.
 * Có thể đọc từ API hiện có / Supabase / PCTT / telemetry.
 */
async function loadPlantOperations(req) {
  const body = readBody(req);

  const plants = Array.isArray(body.plants) ? body.plants : [];

  const normalized = plants.map((p) => ({
    plant_code: text(p.plant_code).toUpperCase(),
    plant_name: text(p.plant_name),
    discharge_m3s: num(p.discharge_m3s, 0),
    spillway_m3s: num(p.spillway_m3s, 0),
    turbine_m3s: num(p.turbine_m3s, 0),
    status: text(p.status, "normal"),
  }));

  const vuGiaTotal = normalized
    .filter((p) => ["A_VUONG", "DAKMI4", "SONGBUNG4"].includes(p.plant_code))
    .reduce((s, p) => s + Number(p.discharge_m3s || 0), 0);

  const thuBonTotal = normalized
    .filter((p) => ["SONGTRANH2"].includes(p.plant_code))
    .reduce((s, p) => s + Number(p.discharge_m3s || 0), 0);

  return {
    plants: normalized,
    vu_gia_total_discharge_m3s: round(vuGiaTotal, 2),
    thu_bon_total_discharge_m3s: round(thuBonTotal, 2),
  };
}

/* ======================================================
   RULE ENGINE
====================================================== */

function getTrend(delta4h) {
  if (delta4h === null || delta4h === undefined) return "unknown";
  if (delta4h <= -0.05) return "falling";
  if (Math.abs(delta4h) < 0.05) return "stable";
  if (delta4h < 0.1) return "rising_light";
  if (delta4h < 0.2) return "rising";
  return "rising_fast";
}

function getSeverityByForecast({
  current_m,
  h4_m,
  h6_m,
  h12_m,
  thresholds,
  delta4h,
}) {
  const max46 = Math.max(
    h4_m ?? Number.NEGATIVE_INFINITY,
    h6_m ?? Number.NEGATIVE_INFINITY
  );

  const bd1 = thresholds?.bd1_cm != null ? Number(thresholds.bd1_cm) / 100 : null;
  const bd2 = thresholds?.bd2_cm != null ? Number(thresholds.bd2_cm) / 100 : null;

  if (bd2 !== null && max46 >= bd2) return "danger";
  if (bd1 !== null && max46 >= bd1) return "warning";
  if (delta4h !== null && delta4h >= 0.2) return "warning";
  if (delta4h !== null && delta4h >= 0.1) return "watch";
  return "normal";
}

function maxSeverity(a, b) {
  const order = { normal: 0, watch: 1, warning: 2, danger: 3 };
  return (order[a] ?? 0) >= (order[b] ?? 0) ? a : b;
}

function evaluateRules(snapshot) {
  const hkCurrent = snapshot.observed.hoi_khach.current_m;
  const anCurrent = snapshot.observed.ai_nghia.current_m;

  const hk4 = snapshot.forecast.hoi_khach.h4_m;
  const hk6 = snapshot.forecast.hoi_khach.h6_m;
  const hk12 = snapshot.forecast.hoi_khach.h12_m;

  const an4 = snapshot.forecast.ai_nghia.h4_m;
  const an6 = snapshot.forecast.ai_nghia.h6_m;
  const an12 = snapshot.forecast.ai_nghia.h12_m;

  const hkDelta4 = hkCurrent != null && hk4 != null ? round(hk4 - hkCurrent, 2) : null;
  const hkDelta6 = hkCurrent != null && hk6 != null ? round(hk6 - hkCurrent, 2) : null;
  const hkDelta12 = hkCurrent != null && hk12 != null ? round(hk12 - hkCurrent, 2) : null;

  const anDelta4 = anCurrent != null && an4 != null ? round(an4 - anCurrent, 2) : null;
  const anDelta6 = anCurrent != null && an6 != null ? round(an6 - anCurrent, 2) : null;
  const anDelta12 = anCurrent != null && an12 != null ? round(an12 - anCurrent, 2) : null;

  const hkSeverity = getSeverityByForecast({
    current_m: hkCurrent,
    h4_m: hk4,
    h6_m: hk6,
    h12_m: hk12,
    thresholds: snapshot.forecast.hoi_khach.thresholds,
    delta4h: hkDelta4,
  });

  const anSeverity = getSeverityByForecast({
    current_m: anCurrent,
    h4_m: an4,
    h6_m: an6,
    h12_m: an12,
    thresholds: snapshot.forecast.ai_nghia.thresholds,
    delta4h: anDelta4,
  });

  const plants = Array.isArray(snapshot.operations.plants)
    ? snapshot.operations.plants
    : [];

  const maxPlant = plants.reduce((best, p) => {
    if (!best) return p;
    return Number(p.discharge_m3s || 0) > Number(best.discharge_m3s || 0) ? p : best;
  }, null);

  const spillwayActiveCount = plants.filter(
    (p) => Number(p.spillway_m3s || 0) > 0 || p.status === "spill_active"
  ).length;

  let overall = maxSeverity(hkSeverity, anSeverity);
  if (spillwayActiveCount > 0 && overall === "normal") overall = "watch";

  return {
    hoi_khach: {
      delta_4h_m: hkDelta4,
      delta_6h_m: hkDelta6,
      delta_12h_m: hkDelta12,
      trend: getTrend(hkDelta4),
      severity: hkSeverity,
      reason_code:
        hkSeverity === "danger"
          ? "HK_FORECAST_BD2"
          : hkSeverity === "warning"
          ? "HK_FORECAST_BD1_OR_FAST_RISE"
          : hkSeverity === "watch"
          ? "HK_RISING"
          : "HK_NORMAL",
    },
    ai_nghia: {
      delta_4h_m: anDelta4,
      delta_6h_m: anDelta6,
      delta_12h_m: anDelta12,
      trend: getTrend(anDelta4),
      severity: anSeverity,
      reason_code:
        anSeverity === "danger"
          ? "AN_FORECAST_BD2"
          : anSeverity === "warning"
          ? "AN_FORECAST_BD1_OR_FAST_RISE"
          : anSeverity === "watch"
          ? "AN_RISING"
          : "AN_NORMAL",
    },
    system: {
      max_discharge_plant: maxPlant?.plant_code || null,
      max_discharge_m3s: num(maxPlant?.discharge_m3s, 0),
      spillway_active_count: spillwayActiveCount,
      overall_severity: overall,
    },
  };
}

/* ======================================================
   SNAPSHOT BUILD
====================================================== */

async function buildSnapshot(req) {
  const hours = Math.min(Math.max(num(req.query.hours, 72), 6), 168);

  const [observedLatest, observedHistory, forecast, operations] = await Promise.all([
    loadObservedLatest(req),
    loadObservedHistory(req, hours),
    loadForecastNow(req),
    loadPlantOperations(req),
  ]);

  const snapshot = {
    snapshot_time: getNowIso(),
    observed: {
      obs_hour: observedLatest.obs_hour,
      hoi_khach: observedLatest.hoi_khach,
      ai_nghia: observedLatest.ai_nghia,
      history_hours: hours,
      history_count: observedHistory.length,
    },
    forecast,
    operations,
  };

  const rules = evaluateRules(snapshot);

  return {
    snapshot_time: snapshot.snapshot_time,
    observed: snapshot.observed,
    forecast: snapshot.forecast,
    operations: snapshot.operations,
    rules,
  };
}

/* ======================================================
   TEMPLATE / AI BRIEF
====================================================== */

function generateRuleBasedBrief(channel, snapshot) {
  const hkObs = snapshot.observed.hoi_khach.current_m;
  const anObs = snapshot.observed.ai_nghia.current_m;

  const hk4 = snapshot.forecast.hoi_khach.h4_m;
  const hk6 = snapshot.forecast.hoi_khach.h6_m;
  const hk12 = snapshot.forecast.hoi_khach.h12_m;

  const an4 = snapshot.forecast.ai_nghia.h4_m;
  const an6 = snapshot.forecast.ai_nghia.h6_m;
  const an12 = snapshot.forecast.ai_nghia.h12_m;

  const hkDelta4 = snapshot.rules.hoi_khach.delta_4h_m;
  const overall = snapshot.rules.system.overall_severity;
  const maxPlant = snapshot.rules.system.max_discharge_plant;
  const maxQ = snapshot.rules.system.max_discharge_m3s;

  if (channel === "dashboard") {
    return {
      title: "Tóm tắt AI",
      message: `HK ${hkObs ?? "-"} m → ${hk4 ?? "-"} m/4h, AN ${anObs ?? "-"} m → ${an4 ?? "-"} m/4h. Mức rủi ro: ${overall}.`,
      severity: overall,
    };
  }

  if (channel === "internal") {
    return {
      title: "Bản tin nội bộ hạ du",
      message:
        `Cập nhật: Hội Khách hiện ${hkObs ?? "-"} m, dự báo ${hk4 ?? "-"} m sau 4h, ${hk6 ?? "-"} m sau 6h, ${hk12 ?? "-"} m sau 12h. ` +
        `Ái Nghĩa hiện ${anObs ?? "-"} m, dự báo ${an4 ?? "-"} m sau 4h, ${an6 ?? "-"} m sau 6h, ${an12 ?? "-"} m sau 12h. ` +
        `Nhà máy xả lớn nhất hiện tại là ${maxPlant || "N/A"} với khoảng ${maxQ ?? 0} m3/s. ` +
        `Xu hướng Hội Khách ${snapshot.rules.hoi_khach.trend}, mức rủi ro tổng thể ${overall}.`,
      severity: overall,
    };
  }

  if (channel === "public") {
    return {
      title: "Thông báo hạ du",
      message:
        `Cập nhật mực nước hạ du: Hội Khách hiện ${hkObs ?? "-"} m, Ái Nghĩa hiện ${anObs ?? "-"} m. ` +
        `Dự báo trong 4 giờ tới, mực nước có xu hướng ${hkDelta4 !== null && hkDelta4 > 0 ? "tăng" : "ổn định"} tại một số vị trí hạ du. ` +
        `Người dân ven sông cần theo dõi thông báo tiếp theo và hạn chế hoạt động gần sông suối khi không cần thiết.`,
      severity: overall,
    };
  }

  if (channel === "social") {
    return {
      title: "Bản tin MXH",
      message:
        `[Cập nhật hạ du] Hội Khách ${hkObs ?? "-"} m, Ái Nghĩa ${anObs ?? "-"} m. ` +
        `Dự báo 4h tới: HK ${hk4 ?? "-"} m, AN ${an4 ?? "-"} m. ` +
        `Một số hồ đang vận hành xả nước. Đề nghị người dân ven sông chú ý theo dõi thông báo tiếp theo.`,
      severity: overall,
    };
  }

  return {
    title: "Bản tin mặc định",
    message: "Không xác định channel.",
    severity: overall,
  };
}

/**
 * TODO:
 * Khi tích hợp AI thật, thay thế hàm này bằng:
 * - gửi snapshot + prompt JSON sang OpenAI/internal AI service
 * - nếu AI lỗi thì fallback sang rule-based
 */
async function generateBrief(channel, snapshot) {
  return generateRuleBasedBrief(channel, snapshot);
}

/* ======================================================
   SAVE HELPERS
====================================================== */

async function saveSnapshot(snapshot, note = null) {
  const inserted = await supabaseInsert("downstream_ai_snapshots", {
    snapshot_time: snapshot.snapshot_time,
    observed_payload: snapshot.observed,
    forecast_payload: snapshot.forecast,
    operations_payload: snapshot.operations,
    rules_payload: snapshot.rules,
    overall_severity: snapshot.rules.system.overall_severity,
    source: "system",
    note,
  });

  return inserted?.[0] || null;
}

async function saveBrief(snapshotId, channel, brief) {
  const inserted = await supabaseInsert("downstream_ai_briefs", {
    snapshot_id: snapshotId,
    channel,
    severity: brief.severity || "normal",
    title: brief.title || null,
    message: brief.message,
    model_name: "rule-based-v1",
    prompt_version: "v1",
    extra_payload: {},
  });

  return inserted?.[0] || null;
}

/* ======================================================
   HANDLERS
====================================================== */

async function handleSnapshot(req, res) {
  const snapshot = await buildSnapshot(req);

  return json(res, 200, {
    ok: true,
    mode: "snapshot",
    ...snapshot,
  });
}

async function handleGenerate(req, res) {
  const body = readBody(req);
  const channels = Array.isArray(body.channels) && body.channels.length
    ? body.channels
    : ["dashboard", "internal", "public", "social"];

  const snapshot = await buildSnapshot(req);
  const briefs = {};

  for (const channel of channels) {
    briefs[channel] = await generateBrief(channel, snapshot);
  }

  return json(res, 200, {
    ok: true,
    mode: "generate",
    snapshot,
    briefs,
  });
}

async function handleSave(req, res) {
  const body = readBody(req);
  const channels = Array.isArray(body.channels) && body.channels.length
    ? body.channels
    : ["dashboard", "internal", "public", "social"];

  const snapshot = await buildSnapshot(req);
  const savedSnapshot = await saveSnapshot(snapshot, text(body.note, ""));

  if (!savedSnapshot?.id) {
    throw new Error("Không lưu được snapshot");
  }

  const savedBriefs = [];
  for (const channel of channels) {
    const brief = await generateBrief(channel, snapshot);
    const saved = await saveBrief(savedSnapshot.id, channel, brief);
    savedBriefs.push(saved);
  }

  return json(res, 200, {
    ok: true,
    mode: "save",
    snapshot_id: savedSnapshot.id,
    briefs_saved: savedBriefs.length,
    briefs: savedBriefs,
  });
}

async function handleLatest(req, res) {
  const rows = await supabaseSelect(
    "downstream_ai_snapshots?select=*&order=snapshot_time.desc&limit=1"
  );

  const latest = rows?.[0] || null;
  if (!latest) {
    return json(res, 404, {
      ok: false,
      mode: "latest",
      error: "Chưa có snapshot AI",
    });
  }

  return json(res, 200, {
    ok: true,
    mode: "latest",
    data: latest,
  });
}

async function handleLatestBriefs(req, res) {
  const rows = await supabaseSelect(
    "downstream_ai_briefs_latest?select=*"
  );

  return json(res, 200, {
    ok: true,
    mode: "latest-briefs",
    data: rows || [],
  });
}

/* ======================================================
   ENTRY
====================================================== */

export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      return json(res, 200, { ok: true });
    }

    const mode = String(req.query.mode || "snapshot").toLowerCase();

    if (mode === "snapshot") {
      if (req.method !== "GET" && req.method !== "POST") {
        return json(res, 405, { ok: false, mode, error: "snapshot chỉ hỗ trợ GET/POST" });
      }
      return handleSnapshot(req, res);
    }

    if (mode === "generate") {
      if (req.method !== "POST") {
        return json(res, 405, { ok: false, mode, error: "generate chỉ hỗ trợ POST" });
      }
      return handleGenerate(req, res);
    }

    if (mode === "save") {
      if (req.method !== "POST") {
        return json(res, 405, { ok: false, mode, error: "save chỉ hỗ trợ POST" });
      }
      return handleSave(req, res);
    }

    if (mode === "latest") {
      if (req.method !== "GET") {
        return json(res, 405, { ok: false, mode, error: "latest chỉ hỗ trợ GET" });
      }
      return handleLatest(req, res);
    }

    if (mode === "latest-briefs") {
      if (req.method !== "GET") {
        return json(res, 405, { ok: false, mode, error: "latest-briefs chỉ hỗ trợ GET" });
      }
      return handleLatestBriefs(req, res);
    }

    return json(res, 400, {
      ok: false,
      error: "mode không hợp lệ",
      supported_modes: [
        "snapshot",
        "generate",
        "save",
        "latest",
        "latest-briefs",
      ],
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: req.query.mode || "snapshot",
      error: err.message,
      hint:
        "Kiểm tra forecast_input, plants, APP_BASE_URL và các API downstream-forecast liên quan",
    });
  }
}
