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

function truncate(str, max = 1200) {
  const s = text(str, "");
  return s.length > max ? `${s.slice(0, max).trim()}...` : s;
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

function formatAreasVi(areas = [], partial = false) {
  const arr = (areas || []).filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
  if (!arr.length) return "";
  const joined = arr.join(", ");
  return partial ? `một phần ${joined}` : joined;
}

function normalizeStationKey(code) {
  const raw = String(code || "").trim().toUpperCase();
  const s = raw.replace(/[^A-Z0-9]/g, "");
  if (s === "HOIKHACH") return "hoi_khach";
  if (s === "AINGHIA") return "ai_nghia";
  return raw.toLowerCase();
}

async function fetchJson(url, timeoutMs = 20000, method = "GET", body = null) {
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

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase REST SELECT ${response.status}: ${raw}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Supabase SELECT response is not JSON: ${raw.slice(0, 500)}`);
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

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase REST INSERT ${response.status}: ${raw}`);
  }

  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Supabase INSERT response is not JSON: ${raw.slice(0, 500)}`);
  }
}

/* ======================================================
   INPUT
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
  return { ok: missing.length === 0, missing };
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

function buildModelCurrentFromDashboardInput(dashboardInput) {
  const hkCm = num(dashboardInput?.Hoi_Khach_cm);
  const anCm = num(dashboardInput?.Ai_Nghia_cm);

  return {
    hoi_khach: {
      current_cm: hkCm,
      current_m: hkCm !== null ? round(hkCm / 100, 2) : null,
      source: "dashboard_input",
    },
    ai_nghia: {
      current_cm: anCm,
      current_m: anCm !== null ? round(anCm / 100, 2) : null,
      source: "dashboard_input",
    },
  };
}

function detectBriefContextMode(dashboardInput, observedLatest) {
  const hkInputM = num(dashboardInput?.Hoi_Khach_cm) !== null
    ? round(num(dashboardInput.Hoi_Khach_cm) / 100, 2)
    : null;
  const anInputM = num(dashboardInput?.Ai_Nghia_cm) !== null
    ? round(num(dashboardInput.Ai_Nghia_cm) / 100, 2)
    : null;

  const hkObsM = num(observedLatest?.hoi_khach?.current_m);
  const anObsM = num(observedLatest?.ai_nghia?.current_m);

  const hkGap = hkInputM !== null && hkObsM !== null ? Math.abs(hkInputM - hkObsM) : 0;
  const anGap = anInputM !== null && anObsM !== null ? Math.abs(anInputM - anObsM) : 0;

  if (hkGap >= 0.3 || anGap >= 0.3) return "scenario";
  return "live";
}

function getBriefCurrentContext(snapshot) {
  const mode = snapshot?.context_mode || "live";

  if (mode === "scenario") {
    return {
      mode,
      hoi_khach: snapshot?.model_current?.hoi_khach || snapshot?.observed?.hoi_khach || {},
      ai_nghia: snapshot?.model_current?.ai_nghia || snapshot?.observed?.ai_nghia || {},
      label: "input mô hình",
    };
  }

  return {
    mode: "live",
    hoi_khach: snapshot?.observed?.hoi_khach || {},
    ai_nghia: snapshot?.observed?.ai_nghia || {},
    label: "quan trắc",
  };
}

/* ======================================================
   CONFIG LOADERS
====================================================== */

async function loadStationImpacts() {
  const rows = await supabaseSelect(
    "downstream_station_impacts?select=station_code,station_name,impact_level,affected_areas,note,updated_at&order=station_code.asc"
  );

  const out = {
    hoi_khach: null,
    ai_nghia: null,
  };

  for (const row of rows || []) {
    const key = normalizeStationKey(row.station_code);

    const item = {
      station_code: row.station_code,
      station_name: row.station_name,
      impact_level: row.impact_level,
      affected_areas: Array.isArray(row.affected_areas) ? row.affected_areas : [],
      note: row.note || null,
      updated_at: row.updated_at || null,
    };

    if (key === "hoi_khach") out.hoi_khach = item;
    if (key === "ai_nghia") out.ai_nghia = item;
  }

  if (!out.hoi_khach) {
    const fallback = (rows || []).find((r) => {
      const s = String(r.station_code || "").toUpperCase();
      return s.includes("HOI") && s.includes("KHACH");
    });
    if (fallback) {
      out.hoi_khach = {
        station_code: fallback.station_code,
        station_name: fallback.station_name,
        impact_level: fallback.impact_level,
        affected_areas: Array.isArray(fallback.affected_areas) ? fallback.affected_areas : [],
        note: fallback.note || null,
        updated_at: fallback.updated_at || null,
      };
    }
  }

  if (!out.ai_nghia) {
    const fallback = (rows || []).find((r) => {
      const s = String(r.station_code || "").toUpperCase();
      return s.includes("AI") && s.includes("NGHIA");
    });
    if (fallback) {
      out.ai_nghia = {
        station_code: fallback.station_code,
        station_name: fallback.station_name,
        impact_level: fallback.impact_level,
        affected_areas: Array.isArray(fallback.affected_areas) ? fallback.affected_areas : [],
        note: fallback.note || null,
        updated_at: fallback.updated_at || null,
      };
    }
  }

  return out;
}

async function loadPeakReferences() {
  const rows = await supabaseSelect(
    "downstream_peak_references?select=station_code,station_name,peak_2025_m,peak_2025_time,bd1_m,bd2_m,bd3_m,note,updated_at&order=station_code.asc"
  );

  const out = {
    hoi_khach: null,
    ai_nghia: null,
  };

  for (const row of rows || []) {
    const key = normalizeStationKey(row.station_code);

    const item = {
      station_code: row.station_code,
      station_name: row.station_name,
      peak_2025_m: num(row.peak_2025_m),
      peak_2025_time: row.peak_2025_time || null,
      bd1_m: num(row.bd1_m),
      bd2_m: num(row.bd2_m),
      bd3_m: num(row.bd3_m),
      note: row.note || null,
      updated_at: row.updated_at || null,
    };

    if (key === "hoi_khach") out.hoi_khach = item;
    if (key === "ai_nghia") out.ai_nghia = item;
  }

  if (!out.hoi_khach) {
    const fallback = (rows || []).find((r) => {
      const s = String(r.station_code || "").toUpperCase();
      return s.includes("HOI") && s.includes("KHACH");
    });
    if (fallback) {
      out.hoi_khach = {
        station_code: fallback.station_code,
        station_name: fallback.station_name,
        peak_2025_m: num(fallback.peak_2025_m),
        peak_2025_time: fallback.peak_2025_time || null,
        bd1_m: num(fallback.bd1_m),
        bd2_m: num(fallback.bd2_m),
        bd3_m: num(fallback.bd3_m),
        note: fallback.note || null,
        updated_at: fallback.updated_at || null,
      };
    }
  }

  if (!out.ai_nghia) {
    const fallback = (rows || []).find((r) => {
      const s = String(r.station_code || "").toUpperCase();
      return s.includes("AI") && s.includes("NGHIA");
    });
    if (fallback) {
      out.ai_nghia = {
        station_code: fallback.station_code,
        station_name: fallback.station_name,
        peak_2025_m: num(fallback.peak_2025_m),
        peak_2025_time: fallback.peak_2025_time || null,
        bd1_m: num(fallback.bd1_m),
        bd2_m: num(fallback.bd2_m),
        bd3_m: num(fallback.bd3_m),
        note: fallback.note || null,
        updated_at: fallback.updated_at || null,
      };
    }
  }

  return out;
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

function shouldShowImpactZones(currentM, h4, h6, h12, ref) {
  const bd2 = num(ref?.bd2_m);
  if (bd2 === null) return false;
  return [currentM, h4, h6, h12].some((v) => num(v) !== null && num(v) >= bd2);
}

function shouldShow2025Reference(currentM, h4, h6, h12, ref) {
  const bd3 = num(ref?.bd3_m);
  if (bd3 === null) return false;
  return [currentM, h4, h6, h12].some((v) => num(v) !== null && num(v) >= bd3);
}

function deltaToPeak(peak, value) {
  if (num(peak) === null || num(value) === null) return null;
  return round(num(value) - num(peak), 2);
}

function evaluateRules(snapshot, dashboardInput) {
  const currentCtx = getBriefCurrentContext(snapshot);

  const hkCurrent = num(currentCtx.hoi_khach?.current_m);
  const anCurrent = num(currentCtx.ai_nghia?.current_m);

  const hk4 = snapshot.forecast.hoi_khach.h4_m;
  const hk6 = snapshot.forecast.hoi_khach.h6_m;
  const hk12 = snapshot.forecast.hoi_khach.h12_m;

  const an4 = snapshot.forecast.ai_nghia.h4_m;
  const an6 = snapshot.forecast.ai_nghia.h6_m;
  const an12 = snapshot.forecast.ai_nghia.h12_m;

  const hkRef = snapshot.references?.hoi_khach || null;
  const anRef = snapshot.references?.ai_nghia || null;

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

  const showImpactZonesHk = shouldShowImpactZones(hkCurrent, hk4, hk6, hk12, hkRef);
  const showImpactZonesAn = shouldShowImpactZones(anCurrent, an4, an6, an12, anRef);

  const show2025ReferenceHk = shouldShow2025Reference(hkCurrent, hk4, hk6, hk12, hkRef);
  const show2025ReferenceAn = shouldShow2025Reference(anCurrent, an4, an6, an12, anRef);

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
      show_impact_zones: showImpactZonesHk,
      show_2025_reference: show2025ReferenceHk,
      peak_2025_m: hkRef?.peak_2025_m ?? null,
      peak_2025_time: hkRef?.peak_2025_time ?? null,
      delta_current_to_peak_2025_m: deltaToPeak(hkRef?.peak_2025_m, hkCurrent),
      delta_h4_to_peak_2025_m: deltaToPeak(hkRef?.peak_2025_m, hk4),
      delta_h6_to_peak_2025_m: deltaToPeak(hkRef?.peak_2025_m, hk6),
      delta_h12_to_peak_2025_m: deltaToPeak(hkRef?.peak_2025_m, hk12),
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
      show_impact_zones: showImpactZonesAn,
      show_2025_reference: show2025ReferenceAn,
      peak_2025_m: anRef?.peak_2025_m ?? null,
      peak_2025_time: anRef?.peak_2025_time ?? null,
      delta_current_to_peak_2025_m: deltaToPeak(anRef?.peak_2025_m, anCurrent),
      delta_h4_to_peak_2025_m: deltaToPeak(anRef?.peak_2025_m, an4),
      delta_h6_to_peak_2025_m: deltaToPeak(anRef?.peak_2025_m, an6),
      delta_h12_to_peak_2025_m: deltaToPeak(anRef?.peak_2025_m, an12),
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
   SNAPSHOT
====================================================== */

async function buildSnapshot(req) {
  const dashboardInput = getDashboardInput(req);
  const valid = validateDashboardInput(dashboardInput);
  if (!valid.ok) {
    throw new Error(`Thiếu input dashboard: ${valid.missing.join(", ")}`);
  }

  const hours = Math.min(Math.max(num(req.query.hours, 72), 6), 168);

  const [observedLatest, observedHistory, forecast, impactZones, references] = await Promise.all([
    loadObservedLatest(req),
    loadObservedHistory(req, hours),
    loadForecastNow(req, dashboardInput),
    loadStationImpacts(),
    loadPeakReferences(),
  ]);

  const operations = buildPlantOperationsFromDashboardInput(dashboardInput);
  const modelCurrent = buildModelCurrentFromDashboardInput(dashboardInput);
  const contextMode = detectBriefContextMode(dashboardInput, observedLatest);

  const snapshot = {
    snapshot_time: dashboardInput.time || new Date().toISOString(),
    context_mode: contextMode,
    dashboard_input: dashboardInput,
    observed: {
      obs_hour: observedLatest.obs_hour,
      hoi_khach: observedLatest.hoi_khach,
      ai_nghia: observedLatest.ai_nghia,
      history_hours: hours,
      history_count: observedHistory.length,
    },
    model_current: modelCurrent,
    forecast,
    operations,
    impact_zones: impactZones,
    references,
  };

  const rules = evaluateRules(snapshot, dashboardInput);

  return {
    snapshot_time: snapshot.snapshot_time,
    context_mode: snapshot.context_mode,
    dashboard_input: snapshot.dashboard_input,
    observed: snapshot.observed,
    model_current: snapshot.model_current,
    forecast: snapshot.forecast,
    operations: snapshot.operations,
    impact_zones: snapshot.impact_zones,
    references: snapshot.references,
    rules,
  };
}

/* ======================================================
   RULE-BASED BRIEFS
====================================================== */

function stationAreaSentence(snapshot, stationKey) {
  const rule = snapshot.rules?.[stationKey];
  const impact = snapshot.impact_zones?.[stationKey];
  if (!rule?.show_impact_zones || !impact?.affected_areas?.length) return "";

  const partial = String(impact.impact_level || "").toLowerCase().includes("partial");
  const areasText = formatAreasVi(impact.affected_areas, partial);

  if (stationKey === "hoi_khach") {
    return `Diễn biến tại trạm Hội Khách cần lưu ý cho ${areasText}.`;
  }
  return `Diễn biến tại trạm Ái Nghĩa cần lưu ý cho ${areasText}.`;
}

function stationPeak2025Sentence(snapshot, stationKey) {
  const rule = snapshot.rules?.[stationKey];
  const ref = snapshot.references?.[stationKey];
  if (!rule?.show_2025_reference || num(ref?.peak_2025_m) === null) return "";

  const target =
    num(rule.delta_h4_to_peak_2025_m) !== null
      ? rule.delta_h4_to_peak_2025_m
      : rule.delta_current_to_peak_2025_m;

  if (target === null) return "";

  const absVal = Math.abs(target);
  const stationName = ref.station_name || (stationKey === "hoi_khach" ? "Hội Khách" : "Ái Nghĩa");

  if (target < 0) {
    return `${stationName} vẫn thấp hơn đỉnh lũ năm 2025 khoảng ${round(absVal, 2)} m.`;
  }
  if (target > 0) {
    return `${stationName} đã vượt mốc đỉnh lũ năm 2025 khoảng ${round(absVal, 2)} m.`;
  }
  return `${stationName} đang xấp xỉ mốc đỉnh lũ năm 2025.`;
}

function generateRuleBasedBrief(channel, snapshot) {
  const currentCtx = getBriefCurrentContext(snapshot);
  const isScenario = currentCtx.mode === "scenario";

  const hkObs = num(currentCtx.hoi_khach?.current_m);
  const anObs = num(currentCtx.ai_nghia?.current_m);

  const hk4 = snapshot?.forecast?.hoi_khach?.h4_m;
  const hk6 = snapshot?.forecast?.hoi_khach?.h6_m;
  const hk12 = snapshot?.forecast?.hoi_khach?.h12_m;
  const an4 = snapshot?.forecast?.ai_nghia?.h4_m;
  const an6 = snapshot?.forecast?.ai_nghia?.h6_m;
  const an12 = snapshot?.forecast?.ai_nghia?.h12_m;

  const overall = snapshot?.rules?.system?.overall_severity || "normal";
  const maxPlant = snapshot?.rules?.system?.max_discharge_plant;
  const maxQ = snapshot?.rules?.system?.max_discharge_m3s;

  const hkArea = stationAreaSentence(snapshot, "hoi_khach");
  const anArea = stationAreaSentence(snapshot, "ai_nghia");
  const hkPeak = stationPeak2025Sentence(snapshot, "hoi_khach");
  const anPeak = stationPeak2025Sentence(snapshot, "ai_nghia");

  if (channel === "dashboard") {
    const parts = isScenario
      ? [
          `Theo kịch bản hiện tại: HK ${hkObs ?? "-"} m → ${hk4 ?? "-"} m/4h, AN ${anObs ?? "-"} m → ${an4 ?? "-"} m/4h.`,
          `Rủi ro: ${overall}.`,
        ]
      : [
          `Quan trắc hiện tại: HK ${hkObs ?? "-"} m → ${hk4 ?? "-"} m/4h, AN ${anObs ?? "-"} m → ${an4 ?? "-"} m/4h.`,
          `Rủi ro: ${overall}.`,
        ];

    if (hkArea || anArea) parts.push([hkArea, anArea].filter(Boolean).join(" "));
    if (hkPeak || anPeak) parts.push([hkPeak, anPeak].filter(Boolean).join(" "));

    return {
      title: "Dashboard",
      message: parts.join(" "),
      severity: overall,
    };
  }

  if (channel === "internal") {
    const parts = isScenario
      ? [
          `Theo kịch bản đầu vào mô hình, Hội Khách ở mức ${hkObs ?? "-"} m và dự báo ${hk4 ?? "-"} m sau 4h, ${hk6 ?? "-"} m sau 6h, ${hk12 ?? "-"} m sau 12h.`,
          `Ái Nghĩa ở mức ${anObs ?? "-"} m và dự báo ${an4 ?? "-"} m sau 4h, ${an6 ?? "-"} m sau 6h, ${an12 ?? "-"} m sau 12h.`,
        ]
      : [
          `Hội Khách hiện quan trắc ${hkObs ?? "-"} m, dự báo ${hk4 ?? "-"} m sau 4h, ${hk6 ?? "-"} m sau 6h, ${hk12 ?? "-"} m sau 12h.`,
          `Ái Nghĩa hiện quan trắc ${anObs ?? "-"} m, dự báo ${an4 ?? "-"} m sau 4h, ${an6 ?? "-"} m sau 6h, ${an12 ?? "-"} m sau 12h.`,
        ];

    parts.push(
      `Nhà máy xả lớn nhất là ${maxPlant || "N/A"} khoảng ${maxQ ?? 0} m3/s.`,
      `Tổng Q xả 4 nhà máy khoảng ${snapshot?.rules?.system?.all4_qra_m3s ?? 0} m3/s.`,
      `Mức rủi ro tổng thể ${overall}.`
    );

    if (hkArea) parts.push(hkArea);
    if (anArea) parts.push(anArea);
    if (hkPeak) parts.push(hkPeak);
    if (anPeak) parts.push(anPeak);

    return {
      title: "Nội bộ vận hành",
      message: parts.join(" "),
      severity: overall,
    };
  }

  if (channel === "public") {
    const parts = isScenario
      ? [
          `Theo kịch bản mô phỏng hiện tại, mực nước đầu vào tại Hội Khách khoảng ${hkObs ?? "-"} m và Ái Nghĩa khoảng ${anObs ?? "-"} m.`,
          `Trong 4 giờ tới, mô hình dự báo Hội Khách khoảng ${hk4 ?? "-"} m và Ái Nghĩa khoảng ${an4 ?? "-"} m.`,
          `Một số hồ thủy điện trên lưu vực đang vận hành xả nước.`,
        ]
      : [
          `Cập nhật mực nước hạ du: Hội Khách hiện ${hkObs ?? "-"} m, Ái Nghĩa hiện ${anObs ?? "-"} m.`,
          `Trong 4 giờ tới, mực nước dự báo tại Hội Khách khoảng ${hk4 ?? "-"} m và Ái Nghĩa khoảng ${an4 ?? "-"} m.`,
          `Một số hồ thủy điện trên lưu vực đang vận hành xả nước.`,
        ];

    if (hkArea) parts.push(hkArea);
    if (anArea) parts.push(anArea);
    if (hkPeak) parts.push(hkPeak);
    if (anPeak) parts.push(anPeak);

    if (overall === "danger") {
      parts.push(`Người dân tại khu vực thấp trũng cần ưu tiên đưa người và tài sản thiết yếu lên cao, sẵn sàng phương án sơ tán khi có thông báo.`);
    } else {
      parts.push(`Người dân cần theo dõi thông báo tiếp theo để chủ động ứng phó.`);
    }

    return {
      title: "Công khai / cảnh báo",
      message: parts.join(" "),
      severity: overall,
    };
  }

  if (channel === "social") {
    const parts = isScenario
      ? [
          `🚨 Kịch bản hạ du hiện tại: Hội Khách ${hkObs ?? "-"} m, Ái Nghĩa ${anObs ?? "-"} m.`,
          `Mô hình dự báo 4h tới: HK ${hk4 ?? "-"} m, AN ${an4 ?? "-"} m.`,
          `Tổng lưu lượng xả các nhà máy khoảng ${snapshot?.rules?.system?.all4_qra_m3s ?? 0} m3/s.`,
        ]
      : [
          `🚨 Cập nhật hạ du: Hội Khách ${hkObs ?? "-"} m, Ái Nghĩa ${anObs ?? "-"} m.`,
          `Dự báo 4h tới: HK ${hk4 ?? "-"} m, AN ${an4 ?? "-"} m.`,
          `Tổng lưu lượng xả các nhà máy khoảng ${snapshot?.rules?.system?.all4_qra_m3s ?? 0} m3/s.`,
        ];

    if (hkArea) parts.push(hkArea);
    if (anArea) parts.push(anArea);
    if (hkPeak) parts.push(hkPeak);
    if (anPeak) parts.push(anPeak);

    if (overall === "danger") {
      parts.push(`🛑 Khu vực có nguy cơ ngập sâu cần ưu tiên an toàn tính mạng, đưa người và tài sản thiết yếu lên cao.`);
    } else {
      parts.push(`📢 Tiếp tục theo dõi thông báo cập nhật.`);
    }

    return {
      title: "Mạng xã hội",
      message: parts.join(" "),
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
  const contextMode = snapshot?.context_mode || "live";
  const modeGuide =
    contextMode === "scenario"
      ? `
CHẾ ĐỘ DỮ LIỆU HIỆN TẠI:
- Đây là chế độ SCENARIO / MÔ PHỎNG.
- "Hiện tại" trong bản tin phải hiểu là GIÁ TRỊ ĐẦU VÀO MÔ HÌNH từ snapshot.model_current hoặc dashboard_input.
- Không được gọi đây là "mực nước quan trắc thực đo hiện tại".
- Nên dùng cách diễn đạt như:
  - "Theo kịch bản hiện tại..."
  - "Theo kịch bản đầu vào mô hình..."
  - "Mực nước đầu vào mô hình tại Hội Khách..."
`
      : `
CHẾ ĐỘ DỮ LIỆU HIỆN TẠI:
- Đây là chế độ LIVE / QUAN TRẮC.
- "Hiện tại" trong bản tin phải hiểu là mực nước quan trắc thực đo từ snapshot.observed.
- Có thể dùng cách diễn đạt như:
  - "Hiện tại..."
  - "Quan trắc hiện tại..."
  - "Theo số liệu quan trắc..."
`;

  const system = `
Bạn là trợ lý AI cảnh báo hạ du thủy điện.

NGUYÊN TẮC BẮT BUỘC:
- Chỉ được dùng dữ liệu có trong SNAPSHOT JSON.
- Không bịa số liệu, không bịa ngưỡng, không bịa địa danh, không bịa mức ngập.
- Không gọi Hội Khách hoặc Ái Nghĩa là địa phương; đây là tên trạm quan trắc.
- Phải tách rõ: trạm quan trắc và khu vực/xã chịu ảnh hưởng.
- Chỉ được nhắc khu vực/xã ảnh hưởng khi:
  - snapshot.rules.hoi_khach.show_impact_zones = true
  - hoặc snapshot.rules.ai_nghia.show_impact_zones = true
- Chỉ được nhắc đỉnh lũ 2025 khi:
  - snapshot.rules.hoi_khach.show_2025_reference = true
  - hoặc snapshot.rules.ai_nghia.show_2025_reference = true
- Nếu show_impact_zones = false thì không được tự thêm tên xã.
- Nếu show_2025_reference = false thì không được tự thêm so sánh với đỉnh lũ 2025.
- Trong tình huống nghiêm trọng, không dùng câu quá nhẹ như:
  - "hạn chế gần sông suối"
  - "chú ý đi lại"
  nếu dữ liệu cho thấy nguy cơ ngập sâu, vượt BĐ III hoặc gần đỉnh lũ 2025.
- Nếu tình huống vượt BĐ III hoặc gần đỉnh lũ 2025, phải dùng ngôn ngữ phù hợp thực tế:
  - "cảnh báo ngập sâu"
  - "nguy hiểm"
  - "ưu tiên an toàn tính mạng"
  - "đưa người và tài sản thiết yếu lên cao"
  - "sẵn sàng sơ tán"
- Không đưa tọa độ, số điện thoại, mã mốc AVC vào bản tin.
- Có thể dùng icon phù hợp như: 🚨 ⚠️ 📍 📊 🏘️ 💧 🛑
- Nếu có RULE_BASED_DRAFT thì dùng làm nền, nhưng viết lại tự nhiên hơn, đúng nghiệp vụ hơn.

${modeGuide}

TRẢ VỀ:
Trả về đúng JSON object:
{
  "title": "string",
  "message": "string",
  "severity": "normal|watch|warning|danger"
}
`.trim();

  const channelInstructions = {
    dashboard: `
Bạn đang viết cho kênh DASHBOARD.
- Viết 2 đến 4 câu.
- Tóm tắt nhanh, rõ ràng.
- Phải nêu:
  1. mức rủi ro,
  2. current theo đúng context mode,
  3. dự báo +4h,
  4. khu vực ảnh hưởng nếu đủ điều kiện,
  5. đỉnh lũ 2025 nếu đủ điều kiện.
`.trim(),

    internal: `
Bạn đang viết cho kênh NỘI BỘ VẬN HÀNH.
- Viết 1 tiêu đề + 1 đoạn 5 đến 9 câu.
- Phải nêu:
  1. current theo đúng context mode,
  2. dự báo 4h / 6h / 12h,
  3. mức báo động,
  4. so với đỉnh lũ 2025 nếu đủ điều kiện,
  5. lưu lượng xả,
  6. khu vực ảnh hưởng,
  7. nhận định rủi ro và khuyến nghị.
`.trim(),

    public: `
Bạn đang viết cho kênh CÔNG KHAI / CẢNH BÁO.
- Viết 1 đoạn 4 đến 8 câu.
- Dễ hiểu cho người dân.
- Nếu context mode là scenario, phải nói rõ đây là kịch bản mô phỏng hoặc kịch bản đầu vào mô hình.
- Nếu context mode là live, có thể nói là số liệu hiện tại / quan trắc hiện tại.
`.trim(),

    social: `
Bạn đang viết cho kênh MẠNG XÃ HỘI.
- Viết 3 đến 5 câu.
- Rõ, mạnh, dễ đọc, đủ ý.
- Nếu context mode là scenario, phải dùng ngôn ngữ kiểu:
  - "Theo kịch bản hiện tại..."
  - "Mô hình dự báo..."
- Nếu context mode là live, có thể dùng:
  - "Cập nhật hạ du..."
  - "Theo số liệu hiện tại..."
- Nếu severity = danger, phải thể hiện rõ mức nguy hiểm và hành động nên làm ngay.
`.trim(),
  };

  const channelInstruction = channelInstructions[channel] || channelInstructions.dashboard;

  const user = `
KÊNH:
${channel}

YÊU CẦU KÊNH:
${channelInstruction}

RULE_BASED_DRAFT:
${ruleBrief?.message || ""}

SNAPSHOT JSON:
${JSON.stringify(snapshot)}

HÃY TRẢ VỀ DUY NHẤT 1 JSON OBJECT HỢP LỆ:
{
  "title": "string",
  "message": "string",
  "severity": "normal|watch|warning|danger"
}
`.trim();

  return { system, user };
}

async function callOpenAiJson({ system, user, timeoutMs = 30000 }) {
  if (!OPENAI_API_KEY) throw new Error("Thiếu OPENAI_API_KEY");

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

    const rawBody = await response.text();

    if (!response.ok) {
      throw new Error(`OpenAI HTTP ${response.status}: ${rawBody.slice(0, 1000)}`);
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch {
      throw new Error(`OpenAI response không phải JSON: ${rawBody.slice(0, 1000)}`);
    }

    let rawText = "";
    if (typeof data.output_text === "string" && data.output_text.trim()) {
      rawText = data.output_text.trim();
    } else if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (!Array.isArray(item.content)) continue;
        for (const c of item.content) {
          if (typeof c.text === "string" && c.text.trim()) {
            rawText += c.text;
          }
        }
      }
      rawText = rawText.trim();
    }

    if (!rawText) {
      throw new Error("OpenAI không trả về output_text hợp lệ");
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new Error(`Không parse được JSON từ OpenAI: ${rawText.slice(0, 1000)}`);
    }

    return {
      title: text(parsed.title, null),
      message: truncate(text(parsed.message, ""), 1200),
      severity: text(parsed.severity, "normal"),
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
        prompt_version: "v4-context-live-scenario",
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
        prompt_version: "v4-context-live-scenario",
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
   DB SAVE
====================================================== */

async function saveSnapshot(snapshot, note = null) {
  const payload = {
    snapshot_time: snapshot.snapshot_time,
    observed_payload: snapshot.observed,
    forecast_payload: snapshot.forecast,
    operations_payload: snapshot.operations,
    rules_payload: {
      ...snapshot.rules,
      context_mode: snapshot.context_mode,
      model_current: snapshot.model_current,
      dashboard_input: snapshot.dashboard_input,
      references: snapshot.references,
      impact_zones: snapshot.impact_zones,
    },
    overall_severity: snapshot.rules.system.overall_severity,
    source: "downstream-brief",
    note,
  };

  const inserted = await supabaseInsert("downstream_ai_snapshots", payload);
  return inserted?.[0] || null;
}

async function saveBriefV2(snapshotId, channel, mergedBrief, extraPayload = {}) {
  const payload = {
    snapshot_id: snapshotId,
    channel,
    severity: mergedBrief.severity || "normal",

    title: mergedBrief.final_title || mergedBrief.rule_based_title || null,
    message: mergedBrief.final_message || mergedBrief.rule_based_message || "",

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

/* ======================================================
   HANDLERS
====================================================== */

async function handleSnapshot(req, res) {
  try {
    const snapshot = await buildSnapshot(req);
    return json(res, 200, {
      ok: true,
      mode: "snapshot",
      code_version: "downstream-brief-live-scenario-v1",
      ...snapshot,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "snapshot",
      error: err.message,
    });
  }
}

async function handleGenerate(req, res) {
  const body = readBody(req);
  const channels = Array.isArray(body.channels) && body.channels.length
    ? body.channels
    : ["dashboard", "internal", "public", "social"];
  const useAi = String(req.query.use_ai || body.use_ai || "0") === "1";

  try {
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
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "generate",
      error: err.message,
    });
  }
}

async function handleSave(req, res) {
  const body = readBody(req);
  const channels = Array.isArray(body.channels) && body.channels.length
    ? body.channels
    : ["dashboard", "internal", "public", "social"];
  const useAi = String(req.query.use_ai || body.use_ai || "0") === "1";

  const debug = [];
  let snapshot = null;
  let savedSnapshot = null;

  try {
    snapshot = await buildSnapshot(req);
    debug.push({ stage: "buildSnapshot", ok: true, context_mode: snapshot.context_mode });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "save",
      stage: "buildSnapshot",
      error: err.message,
      debug,
    });
  }

  try {
    savedSnapshot = await saveSnapshot(snapshot, text(body.note, ""));
    debug.push({
      stage: "saveSnapshot",
      ok: true,
      snapshot_id: savedSnapshot?.id || null,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "save",
      stage: "saveSnapshot",
      error: err.message,
      debug,
    });
  }

  if (!savedSnapshot?.id) {
    return json(res, 500, {
      ok: false,
      mode: "save",
      stage: "saveSnapshot",
      error: "Không nhận được snapshot_id sau khi insert",
      debug,
    });
  }

  const savedBriefs = [];

  for (const channel of channels) {
    let ruleBrief = null;
    let aiBrief = null;
    let aiMeta = {};
    let merged = null;

    try {
      ruleBrief = generateRuleBasedBrief(channel, snapshot);
      debug.push({ stage: `ruleBrief:${channel}`, ok: true });
    } catch (err) {
      return json(res, 500, {
        ok: false,
        mode: "save",
        stage: `ruleBrief:${channel}`,
        error: err.message,
        debug,
      });
    }

    if (useAi) {
      try {
        const aiResult = await generateAiEnhancedBrief(channel, snapshot, ruleBrief);
        aiBrief = {
          title: aiResult?.title || null,
          message: aiResult?.message || null,
          severity: aiResult?.severity || ruleBrief.severity,
        };
        aiMeta = aiResult?.meta || {};
        debug.push({
          stage: `ai:${channel}`,
          ok: !aiMeta.error,
          is_ai_success: !aiMeta.error && !!aiBrief?.message,
          ai_error: aiMeta.error || null,
        });
      } catch (err) {
        aiBrief = null;
        aiMeta = { error: err.message };
        debug.push({
          stage: `ai:${channel}`,
          ok: false,
          ai_error: err.message,
        });
      }
    }

    try {
      merged = chooseFinalBrief(ruleBrief, aiBrief, aiMeta);
      debug.push({
        stage: `merge:${channel}`,
        ok: true,
        generation_mode: merged.generation_mode,
      });
    } catch (err) {
      return json(res, 500, {
        ok: false,
        mode: "save",
        stage: `merge:${channel}`,
        error: err.message,
        debug,
      });
    }

    try {
      const saved = await saveBriefV2(savedSnapshot.id, channel, merged, {
        channel,
        snapshot_time: snapshot.snapshot_time,
        context_mode: snapshot.context_mode,
        use_ai: useAi,
      });

      savedBriefs.push(saved);
      debug.push({
        stage: `saveBrief:${channel}`,
        ok: true,
        brief_id: saved?.id || null,
      });
    } catch (err) {
      return json(res, 500, {
        ok: false,
        mode: "save",
        stage: `saveBrief:${channel}`,
        error: err.message,
        merged_preview: {
          channel,
          final_title: merged?.final_title || null,
          final_message: merged?.final_message || null,
          generation_mode: merged?.generation_mode || null,
        },
        debug,
      });
    }
  }

  return json(res, 200, {
    ok: true,
    mode: "save",
    use_ai: useAi,
    snapshot_id: savedSnapshot.id,
    briefs_saved: savedBriefs.length,
    briefs: savedBriefs,
    debug,
  });
}

async function handleLatest(req, res) {
  try {
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
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "latest",
      error: err.message,
    });
  }
}

async function handleLatestBriefs(req, res) {
  try {
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
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "latest-briefs",
      error: err.message,
    });
  }
}

async function handleDebugConfig(req, res) {
  try {
    const impactsRaw = await supabaseSelect(
      "downstream_station_impacts?select=station_code,station_name,impact_level,affected_areas,note,updated_at&order=station_code.asc"
    );

    const peaksRaw = await supabaseSelect(
      "downstream_peak_references?select=station_code,station_name,peak_2025_m,peak_2025_time,bd1_m,bd2_m,bd3_m,note,updated_at&order=station_code.asc"
    );

    const impactsMapped = await loadStationImpacts();
    const peaksMapped = await loadPeakReferences();

    return json(res, 200, {
      ok: true,
      mode: "debug-config",
      code_version: "downstream-brief-live-scenario-v1",
      supabase_url: SUPABASE_URL,
      impacts_raw_count: Array.isArray(impactsRaw) ? impactsRaw.length : null,
      peaks_raw_count: Array.isArray(peaksRaw) ? peaksRaw.length : null,
      impacts_raw: impactsRaw,
      peaks_raw: peaksRaw,
      impacts_mapped: impactsMapped,
      peaks_mapped: peaksMapped
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "debug-config",
      code_version: "downstream-brief-live-scenario-v1",
      error: err.message,
      supabase_url: SUPABASE_URL
    });
  }
}

/* ======================================================
   ENTRY
====================================================== */

export default async function handler(req, res) {
  const safeMode = String(req?.query?.mode || "snapshot").toLowerCase();

  try {
    if (req.method === "OPTIONS") {
      return json(res, 200, { ok: true });
    }

    const mode = safeMode;

    if (mode === "debug-config") {
      if (req.method !== "GET") {
        return json(res, 405, { ok: false, mode, error: "debug-config chỉ hỗ trợ GET" });
      }
      return handleDebugConfig(req, res);
    }

    if (mode === "snapshot") {
      if (req.method !== "GET" && req.method !== "POST") {
        return json(res, 405, { ok: false, mode, error: "snapshot chỉ hỗ trợ GET/POST" });
      }
      return handleSnapshot(req, res);
    }

    if (mode === "generate") {
      if (req.method !== "GET" && req.method !== "POST") {
        return json(res, 405, { ok: false, mode, error: "generate chỉ hỗ trợ GET/POST" });
      }
      return handleGenerate(req, res);
    }

    if (mode === "save") {
      if (req.method !== "GET" && req.method !== "POST") {
        return json(res, 405, { ok: false, mode, error: "save chỉ hỗ trợ GET/POST" });
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
      mode,
      error: "mode không hợp lệ",
      supported_modes: ["snapshot", "generate", "save", "latest", "latest-briefs", "debug-config"],
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: safeMode,
      error: err.message,
      hint: "Kiểm tra OPENAI_API_KEY, APP_BASE_URL, downstream-forecast API, Supabase schema",
    });
  }
}
