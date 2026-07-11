const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_BASE_URL = process.env.APP_BASE_URL || "";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_API_BASE = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

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

function getAppBaseUrl(req) {
  if (APP_BASE_URL) return APP_BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;
  return `${proto}://${host}`;
}

function truncate(str, max = 900) {
  const s = text(str, "");
  return s.length > max ? `${s.slice(0, max).trim()}...` : s;
}

async function fetchJson(url, timeoutMs = 15000, method = "GET", body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${raw.slice(0, 800)}`);
    }

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Response is not JSON: ${raw.slice(0, 800)}`);
    }
  } finally {
    clearTimeout(timer);
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
   DASHBOARD INPUT
====================================================== */

function getDashboardInput(req) {
  const body = readBody(req);
  const query = req.query || {};

  const get = (key, def = null) =>
    body[key] !== undefined ? body[key] : query[key] !== undefined ? query[key] : def;

  return {
    time: get("time", null),

    Hoi_Khach_cm: num(get("Hoi_Khach_cm")),
    Ai_Nghia_cm: num(get("Ai_Nghia_cm")),

    A_Vuong_Qra: num(get("A_Vuong_Qra"), 0),
    DakMi4_Qra: num(get("DakMi4_Qra"), 0),
    SongBung4_Qra: num(get("SongBung4_Qra"), 0),
    SongTranh2_Qra: num(get("SongTranh2_Qra"), 0),

    VuGia_3ho_Qra: num(get("VuGia_3ho_Qra"), 0),
    All4_Qra: num(get("All4_Qra"), 0),

    PCTT_Qve_VuGia: num(get("PCTT_Qve_VuGia"), 0),
    PCTT_Qve_ThuBon: num(get("PCTT_Qve_ThuBon"), 0),

    HK_Delta_1h: num(get("HK_Delta_1h"), 0),
    HK_Delta_3h: num(get("HK_Delta_3h"), 0),

    AN_Delta_1h: num(get("AN_Delta_1h"), 0),
    AN_Delta_3h: num(get("AN_Delta_3h"), 0),

    Q_VuGia_Delta_1h: num(get("Q_VuGia_Delta_1h"), 0),
    Q_VuGia_Delta_3h: num(get("Q_VuGia_Delta_3h"), 0),
  };
}

function validateDashboardInput(input) {
  const missing = [];
  if (input.Hoi_Khach_cm === null) missing.push("Hoi_Khach_cm");
  if (input.Ai_Nghia_cm === null) missing.push("Ai_Nghia_cm");

  return {
    ok: missing.length === 0,
    missing,
  };
}

function buildPlantOperationsFromDashboardInput(input) {
  const plants = [
    {
      plant_code: "A_VUONG",
      plant_name: "A Vương",
      discharge_m3s: num(input.A_Vuong_Qra, 0),
      spillway_m3s: 0,
      turbine_m3s: num(input.A_Vuong_Qra, 0),
      status: num(input.A_Vuong_Qra, 0) > 0 ? "normal" : "idle",
    },
    {
      plant_code: "DAKMI4",
      plant_name: "Đắk Mi 4",
      discharge_m3s: num(input.DakMi4_Qra, 0),
      spillway_m3s: 0,
      turbine_m3s: num(input.DakMi4_Qra, 0),
      status: num(input.DakMi4_Qra, 0) > 0 ? "normal" : "idle",
    },
    {
      plant_code: "SONGBUNG4",
      plant_name: "Sông Bung 4",
      discharge_m3s: num(input.SongBung4_Qra, 0),
      spillway_m3s: 0,
      turbine_m3s: num(input.SongBung4_Qra, 0),
      status: num(input.SongBung4_Qra, 0) > 0 ? "normal" : "idle",
    },
    {
      plant_code: "SONGTRANH2",
      plant_name: "Sông Tranh 2",
      discharge_m3s: num(input.SongTranh2_Qra, 0),
      spillway_m3s: 0,
      turbine_m3s: num(input.SongTranh2_Qra, 0),
      status: num(input.SongTranh2_Qra, 0) > 0 ? "normal" : "idle",
    },
  ];

  return {
    plants,
    vu_gia_total_discharge_m3s: num(input.VuGia_3ho_Qra, 0),
    thu_bon_total_discharge_m3s: num(input.PCTT_Qve_ThuBon, 0),
    all4_total_discharge_m3s: num(input.All4_Qra, 0),
    pctt_qve_vugia_m3s: num(input.PCTT_Qve_VuGia, 0),
    pctt_qve_thubon_m3s: num(input.PCTT_Qve_ThuBon, 0),
  };
}

/* ======================================================
   LOADERS
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

async function loadForecastNow(req, dashboardInput) {
  const baseUrl = getAppBaseUrl(req);
  const qs = new URLSearchParams();

  qs.set("mode", "forecast");

  for (const [key, value] of Object.entries(dashboardInput)) {
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

function getSeverityByForecast({ h4_m, h6_m, thresholds, delta4h }) {
  const max46 = Math.max(h4_m ?? Number.NEGATIVE_INFINITY, h6_m ?? Number.NEGATIVE_INFINITY);
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

function evaluateRules(snapshot, dashboardInput) {
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
    h4_m: hk4,
    h6_m: hk6,
    thresholds: snapshot.forecast.hoi_khach.thresholds,
    delta4h: hkDelta4,
  });

  const anSeverity = getSeverityByForecast({
    h4_m: an4,
    h6_m: an6,
    thresholds: snapshot.forecast.ai_nghia.thresholds,
    delta4h: anDelta4,
  });

  const plants = snapshot.operations.plants || [];
  const maxPlant = plants.reduce((best, p) => {
    if (!best) return p;
    return Number(p.discharge_m3s || 0) > Number(best.discharge_m3s || 0) ? p : best;
  }, null);

  let overall = maxSeverity(hkSeverity, anSeverity);
  if (num(dashboardInput.All4_Qra, 0) >= 1000 && overall === "normal") overall = "watch";

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
      spillway_active_count: 0,
      overall_severity: overall,
      all4_qra_m3s: num(dashboardInput.All4_Qra, 0),
      vugia_3ho_qra_m3s: num(dashboardInput.VuGia_3ho_Qra, 0),
      q_vugia_delta_1h: num(dashboardInput.Q_VuGia_Delta_1h, 0),
      q_vugia_delta_3h: num(dashboardInput.Q_VuGia_Delta_3h, 0),
    },
  };
}

/* ======================================================
   SNAPSHOT BUILD
====================================================== */

async function buildSnapshot(req) {
  const dashboardInput = getDashboardInput(req);
  const valid = validateDashboardInput(dashboardInput);
  if (!valid.ok) {
    throw new Error(`Thiếu input dashboard: ${valid.missing.join(", ")}`);
  }

  const hours = Math.min(Math.max(num(req.query.hours, 72), 6), 168);

  const [observedLatest, observedHistory, forecast] = await Promise.all([
    loadObservedLatest(req),
    loadObservedHistory(req, hours),
    loadForecastNow(req, dashboardInput),
  ]);

  const operations = buildPlantOperationsFromDashboardInput(dashboardInput);

  const snapshot = {
    snapshot_time: dashboardInput.time || new Date().toISOString(),
    dashboard_input: dashboardInput,
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

  const rules = evaluateRules(snapshot, dashboardInput);

  return {
    snapshot_time: snapshot.snapshot_time,
    dashboard_input: snapshot.dashboard_input,
    observed: snapshot.observed,
    forecast: snapshot.forecast,
    operations: snapshot.operations,
    rules,
  };
}

/* ======================================================
   RULE-BASED BRIEF
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
  const overall = snapshot.rules.system.overall_severity;
  const maxPlant = snapshot.rules.system.max_discharge_plant;
  const maxQ = snapshot.rules.system.max_discharge_m3s;

  if (channel === "dashboard") {
    return {
      title: "Dashboard",
      message: `HK ${hkObs ?? "-"} m → ${hk4 ?? "-"} m/4h, AN ${anObs ?? "-"} m → ${an4 ?? "-"} m/4h. Rủi ro: ${overall}.`,
      severity: overall,
    };
  }

  if (channel === "internal") {
    return {
      title: "Nội bộ vận hành",
      message:
        `Hội Khách hiện ${hkObs ?? "-"} m, dự báo ${hk4 ?? "-"} m sau 4h, ${hk6 ?? "-"} m sau 6h, ${hk12 ?? "-"} m sau 12h. ` +
        `Ái Nghĩa hiện ${anObs ?? "-"} m, dự báo ${an4 ?? "-"} m sau 4h, ${an6 ?? "-"} m sau 6h, ${an12 ?? "-"} m sau 12h. ` +
        `Nhà máy xả lớn nhất là ${maxPlant || "N/A"} khoảng ${maxQ ?? 0} m3/s. ` +
        `Tổng Q xả 4 nhà máy khoảng ${snapshot.rules.system.all4_qra_m3s ?? 0} m3/s. Mức rủi ro tổng thể ${overall}.`,
      severity: overall,
    };
  }

  if (channel === "public") {
    return {
      title: "Công khai / cảnh báo",
      message:
        `Cập nhật mực nước hạ du: Hội Khách hiện ${hkObs ?? "-"} m, Ái Nghĩa hiện ${anObs ?? "-"} m. ` +
        `Trong 4 giờ tới, mực nước dự báo tại Hội Khách khoảng ${hk4 ?? "-"} m và Ái Nghĩa khoảng ${an4 ?? "-"} m. ` +
        `Một số hồ thủy điện trên lưu vực đang vận hành xả nước. Người dân ven sông cần theo dõi thông báo tiếp theo và hạn chế hoạt động gần sông suối khi không cần thiết.`,
      severity: overall,
    };
  }

  if (channel === "social") {
    return {
      title: "Mạng xã hội",
      message:
        `[Cập nhật hạ du] Hội Khách ${hkObs ?? "-"} m, Ái Nghĩa ${anObs ?? "-"} m. ` +
        `Dự báo 4h tới: HK ${hk4 ?? "-"} m, AN ${an4 ?? "-"} m. ` +
        `Tổng lưu lượng xả các nhà máy khoảng ${snapshot.rules.system.all4_qra_m3s ?? 0} m3/s. Đề nghị người dân ven sông chú ý theo dõi thông báo tiếp theo.`,
      severity: overall,
    };
  }

  return {
    title: "Mặc định",
    message: "Không xác định channel.",
    severity: overall,
  };
}

/* ======================================================
   OPENAI
====================================================== */

function buildOpenAiPrompt(channel, snapshot, ruleBrief) {
  const channelConfig = {
    dashboard: {
      style: "Viết 2-3 câu cực ngắn cho dashboard. Không quá 300 ký tự. Rõ số liệu, rõ xu hướng, rõ mức rủi ro.",
    },
    internal: {
      style: "Viết bản tin nội bộ kỹ thuật cho vận hành/lãnh đạo. Nêu hiện trạng, dự báo 4h/6h/12h, nhà máy xả lớn nhất, và khuyến nghị ngắn.",
    },
    public: {
      style: "Viết thông báo công khai dễ hiểu cho người dân. Không dùng thuật ngữ quá kỹ thuật. Không gây hoảng loạn.",
    },
    social: {
      style: "Viết bài đăng mạng xã hội ngắn gọn, dễ chia sẻ, có thời gian, có khuyến nghị rõ ràng.",
    },
  };

  const cfg = channelConfig[channel] || channelConfig.dashboard;

  const system = [
    "Bạn là trợ lý cảnh báo hạ du thủy điện.",
    "Chỉ được dùng dữ liệu có trong snapshot.",
    "Không bịa số liệu, không bịa ngưỡng, không suy diễn vượt ngoài dữ liệu.",
    "Không dùng ngôn từ gây hoảng loạn.",
    "Nếu mức severity là danger hoặc warning thì phải nhấn mạnh theo dõi/cảnh giác phù hợp.",
    "Nếu có rule_based_message thì dùng nó làm nền, nhưng viết lại cho tự nhiên, mạch lạc hơn.",
  ].join(" ");

  const user = `
KÊNH: ${channel}

YÊU CẦU:
${cfg.style}

RULE-BASED DRAFT:
${ruleBrief?.message || ""}

SNAPSHOT JSON:
${JSON.stringify(snapshot, null, 2)}

Trả về đúng JSON object với format:
{
  "title": "string",
  "message": "string",
  "severity": "normal|watch|warning|danger"
}

Chỉ trả JSON, không thêm markdown, không thêm giải thích.
  `.trim();

  return { system, user };
}

async function callOpenAiJson({ system, user, timeoutMs = 25000 }) {
  if (!OPENAI_API_KEY) {
    throw new Error("Thiếu OPENAI_API_KEY");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${OPENAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [
          { role: "system", content: [{ type: "input_text", text: system }] },
          { role: "user", content: [{ type: "input_text", text: user }] },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "downstream_brief",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                message: { type: "string" },
                severity: {
                  type: "string",
                  enum: ["normal", "watch", "warning", "danger"],
                },
              },
              required: ["title", "message", "severity"],
            },
          },
        },
      }),
    });

    const bodyText = await response.text();

    if (!response.ok) {
      throw new Error(`OpenAI HTTP ${response.status}: ${bodyText.slice(0, 800)}`);
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      throw new Error(`OpenAI response không phải JSON: ${bodyText.slice(0, 800)}`);
    }

    let raw = "";
    if (typeof data.output_text === "string" && data.output_text.trim()) {
      raw = data.output_text.trim();
    } else if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (Array.isArray(item.content)) {
          for (const c of item.content) {
            if (typeof c.text === "string" && c.text.trim()) {
              raw += c.text;
            }
          }
        }
      }
      raw = raw.trim();
    }

    if (!raw) {
      throw new Error("OpenAI không trả về output_text hợp lệ");
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Không parse được JSON từ OpenAI: ${raw.slice(0, 800)}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("JSON từ OpenAI không hợp lệ");
    }

    if (!parsed.message || !parsed.severity) {
      throw new Error("OpenAI JSON thiếu message hoặc severity");
    }

    return {
      title: text(parsed.title, null),
      message: truncate(text(parsed.message, ""), 1200),
      severity: text(parsed.severity, "normal"),
      raw_response: data,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function generateAiEnhancedBrief(channel, snapshot, ruleBrief) {
  try {
    const prompt = buildOpenAiPrompt(channel, snapshot, ruleBrief);
    const ai = await callOpenAiJson(prompt);

    return {
      title: ai.title || ruleBrief.title || null,
      message: ai.message || null,
      severity: ai.severity || ruleBrief.severity,
      meta: {
        model_name: OPENAI_MODEL,
        prompt_version: "v2-openai-json",
      },
    };
  } catch (err) {
    return {
      title: null,
      message: null,
      severity: ruleBrief.severity,
      meta: {
        error: err.message,
        model_name: OPENAI_MODEL,
        prompt_version: "v2-openai-json",
      },
    };
  }
}

function chooseFinalBrief(ruleBrief, aiBrief, aiMeta = {}) {
  const aiOk = !!(aiBrief && aiBrief.message && !aiMeta.error);

  return {
    severity: aiBrief?.severity || ruleBrief?.severity || "normal",

    rule_based_title: ruleBrief?.title || null,
    rule_based_message: ruleBrief?.message || "",

    ai_title: aiBrief?.title || null,
    ai_message: aiBrief?.message || null,

    final_title: aiOk
      ? (aiBrief?.title || ruleBrief?.title || null)
      : (ruleBrief?.title || null),

    final_message: aiOk
      ? aiBrief.message
      : (ruleBrief?.message || ""),

    generation_mode: aiOk ? "ai_enhanced" : "rule_based",
    is_ai_success: aiOk,
    ai_error: aiMeta.error || null,
    model_name: aiMeta.model_name || null,
    prompt_version: aiMeta.prompt_version || "v1",
  };
}

/* ======================================================
   SAVE HELPERS
====================================================== */

async function saveBriefV2(snapshotId, channel, mergedBrief, extraPayload = {}) {
  const inserted = await supabaseInsert("downstream_ai_briefs", {
    snapshot_id: snapshotId,
    channel,
    severity: mergedBrief.severity || "normal",

    // tương thích schema cũ
    title: mergedBrief.final_title || mergedBrief.rule_based_title || null,
    message: mergedBrief.final_message || mergedBrief.rule_based_message || "",

    // schema mới
    rule_based_title: mergedBrief.rule_based_title || null,
    rule_based_message: mergedBrief.rule_based_message || "",

    ai_title: mergedBrief.ai_title || null,
    ai_message: mergedBrief.ai_message || null,

    final_title: mergedBrief.final_title || null,
    final_message: mergedBrief.final_message || "",

    generation_mode: mergedBrief.generation_mode || "rule_based",
    is_ai_success: !!mergedBrief.is_ai_success,
    ai_error: mergedBrief.ai_error || null,

    model_name: mergedBrief.model_name || null,
    prompt_version: mergedBrief.prompt_version || "v1",
    extra_payload: extraPayload || {},
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

  const useAi = String(req.query.use_ai || body.use_ai || "0") === "1";

  const snapshot = await buildSnapshot(req);
  const briefs = {};

  for (const channel of channels) {
    const ruleBrief = generateRuleBasedBrief(channel, snapshot);

    let aiBrief = null;
    let aiMeta = {};

    if (useAi) {
      const aiResult = await generateAiEnhancedBrief(channel, snapshot, ruleBrief);
      aiBrief = {
        title: aiResult?.title || null,
        message: aiResult?.message || null,
        severity: aiResult?.severity || ruleBrief.severity,
      };
      aiMeta = aiResult?.meta || {};
    }

    const merged = chooseFinalBrief(ruleBrief, aiBrief, aiMeta);

    briefs[channel] = {
      severity: merged.severity,
      rule_based: {
        title: merged.rule_based_title,
        message: merged.rule_based_message,
      },
      ai: {
        title: merged.ai_title,
        message: merged.ai_message,
      },
      final: {
        title: merged.final_title,
        message: merged.final_message,
      },
      generation_mode: merged.generation_mode,
      is_ai_success: merged.is_ai_success,
      ai_error: merged.ai_error,
      model_name: merged.model_name,
      prompt_version: merged.prompt_version,
    };
  }

  return json(res, 200, {
    ok: true,
    mode: "generate",
    use_ai: useAi,
    snapshot,
    briefs,
  });
}

async function saveBriefV2(snapshotId, channel, mergedBrief, extraPayload = {}) {
  const payload = {
    snapshot_id: snapshotId,
    channel,
    severity: mergedBrief.severity || "normal",

    // tương thích schema cũ
    title: mergedBrief.final_title || mergedBrief.rule_based_title || null,
    message: mergedBrief.final_message || mergedBrief.rule_based_message || "",

    // schema mới
    rule_based_title: mergedBrief.rule_based_title || null,
    rule_based_message: mergedBrief.rule_based_message || "",
    ai_title: mergedBrief.ai_title || null,
    ai_message: mergedBrief.ai_message || null,
    final_title: mergedBrief.final_title || null,
    final_message: mergedBrief.final_message || "",
    generation_mode: mergedBrief.generation_mode || "rule_based",
    is_ai_success: !!mergedBrief.is_ai_success,
    ai_error: mergedBrief.ai_error || null,
    model_name: mergedBrief.model_name || null,
    prompt_version: mergedBrief.prompt_version || "v1",
    extra_payload: extraPayload || {},
  };

  const inserted = await supabaseInsert("downstream_ai_briefs", payload);
  return inserted?.[0] || null;
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
  const rows = await supabaseSelect("downstream_ai_briefs_latest?select=*");

  return json(res, 200, {
    ok: true,
    mode: "latest-briefs",
    data: (rows || []).map((row) => ({
      id: row.id,
      snapshot_id: row.snapshot_id,
      channel: row.channel,
      severity: row.severity,
      title: row.final_title,
      message: row.final_message,
      rule_based_title: row.rule_based_title,
      rule_based_message: row.rule_based_message,
      ai_title: row.ai_title,
      ai_message: row.ai_message,
      final_title: row.final_title,
      final_message: row.final_message,
      generation_mode: row.generation_mode,
      is_ai_success: row.is_ai_success,
      ai_error: row.ai_error,
      model_name: row.model_name,
      prompt_version: row.prompt_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
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
      if (req.method !== "POST" && req.method !== "GET") {
        return json(res, 405, { ok: false, mode, error: "generate chỉ hỗ trợ POST/GET" });
      }
      return handleGenerate(req, res);
    }

    if (mode === "save") {
      if (req.method !== "POST" && req.method !== "GET") {
        return json(res, 405, { ok: false, mode, error: "save chỉ hỗ trợ POST/GET" });
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
      supported_modes: ["snapshot", "generate", "save", "latest", "latest-briefs"],
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: req.query.mode || "snapshot",
      error: err.message,
      hint: "Kiểm tra OPENAI_API_KEY, APP_BASE_URL, downstream-forecast API, observed-latest/history và schema DB mới",
    });
  }
}
