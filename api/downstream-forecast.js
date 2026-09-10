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
  if (value === null || value === undefined || value === "") {
    return defaultValue;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : defaultValue;
}

function text(value, defaultValue = "") {
  if (value === null || value === undefined || value === "") {
    return defaultValue;
  }

  return String(value);
}

function round(value, digits = 2) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toDateOnly(value) {
  if (!value) {
    return null;
  }

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
  if (!req.body) {
    return {};
  }

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
  if (body && body[key] !== undefined) {
    return body[key];
  }

  if (req.query && req.query[key] !== undefined) {
    return req.query[key];
  }

  return defaultValue;
}

function toIsoTime(value) {
  if (!value) {
    return new Date().toISOString();
  }

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

function normalizeObsHourKey(value) {
  const d = new Date(String(value || ""));

  if (Number.isNaN(d.getTime())) {
    return String(value || "");
  }

  d.setUTCMinutes(0, 0, 0);

  return d.toISOString();
}

function buildObsTimeFromDateHour(req, body) {
  const obsDate = pickValue(req, body, "obs_date", null);
  const obsHour = pickValue(req, body, "obs_hour_value", null);

  if (
    !obsDate ||
    obsHour === null ||
    obsHour === undefined ||
    obsHour === ""
  ) {
    return null;
  }

  const h = Number(obsHour);

  if (!Number.isInteger(h) || h < 0 || h > 23) {
    throw new Error("obs_hour_value phải là số nguyên từ 0 đến 23");
  }

  const hh = String(h).padStart(2, "0");

  return `${obsDate}T${hh}:00:00+07:00`;
}

/* ======================================================
   SUPABASE REST HELPERS
====================================================== */

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
    throw new Error(
      `Supabase REST SELECT ${response.status}: ${body}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `Supabase response is not JSON: ${body.slice(0, 300)}`
    );
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
    throw new Error(
      `Supabase REST UPSERT ${response.status}: ${body}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `Supabase upsert response is not JSON: ${body.slice(0, 300)}`
    );
  }
}

async function supabaseUpsertMinimal(path, payload, onConflict) {
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
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase REST UPSERT ${response.status}: ${body}`
    );
  }

  return true;
}

/* ======================================================
   TTB SYNC HELPERS
====================================================== */

function formatVnApiDateTime(date) {
  const d = new Date(date);

  if (Number.isNaN(d.getTime())) {
    throw new Error("Ngày giờ không hợp lệ");
  }

  const vn = new Date(d.getTime() + 7 * 60 * 60 * 1000);

  const yyyy = vn.getUTCFullYear();
  const mm = String(vn.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(vn.getUTCDate()).padStart(2, "0");
  const hh = String(vn.getUTCHours()).padStart(2, "0");
  const mi = String(vn.getUTCMinutes()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function toIsoHourFromVnString(value) {
  const s = String(value || "").trim();
  const normalized = s.replace(" ", "T");

  const iso = normalized.includes("+")
    ? normalized
    : `${normalized}+07:00`;

  const d = new Date(iso);

  if (Number.isNaN(d.getTime())) {
    return null;
  }

  d.setUTCMinutes(0, 0, 0);

  return d.toISOString();
}

function stripHtml(str) {
  return String(str || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function parseTtbHtmlTable(html) {
  const rowMatches =
    String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];

  const rows = [];

  for (let i = 1; i < rowMatches.length; i++) {
    const cols = [
      ...rowMatches[i].matchAll(
        /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
      ),
    ].map((m) => stripHtml(m[1]));

    if (cols.length < 3) {
      continue;
    }

    const stationId = cols[0];
    const rawTime = cols[1];
    const value = num(cols[2], null);
    const obsHour = toIsoHourFromVnString(rawTime);

    if (!obsHour || value === null) {
      continue;
    }

    rows.push({
      station_id: stationId,
      raw_time: rawTime,
      obs_hour: obsHour,
      value_m: round(value, 2),
    });
  }

  return rows;
}

async function fetchTtbStationSeries({
  stationId,
  startTime,
  endTime,
  tableName = "mucnuoc_oday",
  stepMinutes = 60,
  aggregate = 0,
  timeoutMs = 12000,
}) {
  const startText = formatVnApiDateTime(startTime);
  const endText = formatVnApiDateTime(endTime);

  const url =
    "http://203.209.181.170:2018/API_TTB/XUAT/solieu.php" +
    `?matram=${encodeURIComponent(stationId)}` +
    `&ten_table=${encodeURIComponent(tableName)}` +
    `&sophut=${encodeURIComponent(stepMinutes)}` +
    `&tinhtong=${encodeURIComponent(aggregate)}` +
    `&thoigianbd=${encodeURIComponent(`'${startText}'`)}` +
    `&thoigiankt=${encodeURIComponent(`'${endText}'`)}`;

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "User-Agent": "av-downstream-sync/1.0",
      },
      signal: controller.signal,
    });

    const textBody = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        stationId,
        url,
        count: 0,
        data: [],
        error:
          `TTB API ${stationId} lỗi HTTP ` +
          `${response.status}: ${textBody.slice(0, 300)}`,
      };
    }

    const rows = parseTtbHtmlTable(textBody);

    return {
      ok: true,
      stationId,
      url,
      count: rows.length,
      data: rows,
      sample: textBody.slice(0, 200),
    };
  } catch (err) {
    return {
      ok: false,
      stationId,
      url,
      count: 0,
      data: [],
      error:
        err?.name === "AbortError"
          ? `Timeout sau ${timeoutMs}ms`
          : err?.message || "Unknown fetch error",
    };
  } finally {
    clearTimeout(timer);
  }
}

function mergeObservedStations(hkRows, anRows) {
  const map = new Map();

  for (const row of hkRows || []) {
    const key = row.obs_hour;

    if (!map.has(key)) {
      map.set(key, {
        obs_time: key,
        obs_hour: key,
        hoi_khach_m: null,
        ai_nghia_m: null,
        source: "api_ttb",
        note: "sync-72h-ttb",
        created_by: "system",
      });
    }

    const item = map.get(key);
    item.hoi_khach_m = row.value_m;
  }

  for (const row of anRows || []) {
    const key = row.obs_hour;

    if (!map.has(key)) {
      map.set(key, {
        obs_time: key,
        obs_hour: key,
        hoi_khach_m: null,
        ai_nghia_m: null,
        source: "api_ttb",
        note: "sync-72h-ttb",
        created_by: "system",
      });
    }

    const item = map.get(key);
    item.ai_nghia_m = row.value_m;
  }

  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(a.obs_hour).getTime() -
      new Date(b.obs_hour).getTime()
  );
}

async function fetchExistingObservedRows(startIso, endIso) {
  const path =
    "downstream_manual_observations" +
    "?select=id,obs_hour,obs_time,hoi_khach_m,ai_nghia_m," +
    "source,note,created_by,updated_at" +
    `&obs_hour=gte.${encodeURIComponent(startIso)}` +
    `&obs_hour=lte.${encodeURIComponent(endIso)}` +
    "&order=obs_hour.asc";

  return supabaseSelect(path);
}

/*
  Tạo kế hoạch đồng bộ dữ liệu.

  Quan trọng:
  - Không đưa trường id vào payload upsert.
  - Supabase cập nhật dựa trên on_conflict=obs_hour.
  - Tất cả object trong toUpsert có cùng một tập key.
*/
function buildSyncPlan(mergedRows, existingRows) {
  const existingMap = new Map(
    (existingRows || []).map((row) => [
      normalizeObsHourKey(row.obs_hour),
      row,
    ])
  );

  const toUpsert = [];
  const skippedManual = [];
  const overwrittenApi = [];
  const inserted = [];

  for (const row of mergedRows || []) {
    const rowKey = normalizeObsHourKey(row.obs_hour);
    const existed = existingMap.get(rowKey);

    const payload = {
      obs_time: row.obs_time || row.obs_hour,
      obs_hour: row.obs_hour,

      hoi_khach_m:
        row.hoi_khach_m === null ||
        row.hoi_khach_m === undefined
          ? null
          : Number(row.hoi_khach_m),

      ai_nghia_m:
        row.ai_nghia_m === null ||
        row.ai_nghia_m === undefined
          ? null
          : Number(row.ai_nghia_m),

      source: "api_ttb",
      note: "sync-72h-ttb",
      created_by: "system",
      updated_at: new Date().toISOString(),
    };

    if (!existed) {
      inserted.push(row.obs_hour);
      toUpsert.push(payload);
      continue;
    }

    /*
      Không ghi đè dữ liệu do người vận hành nhập tay.
    */
    if (
      String(existed.source || "").toLowerCase() === "manual"
    ) {
      skippedManual.push({
        obs_hour: row.obs_hour,
        source: existed.source,
      });

      continue;
    }

    overwrittenApi.push({
      obs_hour: row.obs_hour,
      old_source: existed.source || "unknown",
    });

    /*
      Không truyền id tại đây.

      Supabase xác định bản ghi cần cập nhật bằng:
      on_conflict=obs_hour
    */
    toUpsert.push(payload);
  }

  return {
    toUpsert,
    skippedManual,
    overwrittenApi,
    inserted,
  };
}

/*
  Chuẩn hóa tất cả dòng thành cùng một cấu trúc.
  Điều này ngăn lỗi PGRST102:
  All object keys must match.
*/
function normalizeObservedUpsertRow(row) {
  if (!row || !row.obs_hour) {
    throw new Error("Payload sync thiếu obs_hour");
  }

  const obsHour = normalizeObsHourKey(row.obs_hour);

  if (!obsHour) {
    throw new Error(
      `obs_hour không hợp lệ: ${row.obs_hour}`
    );
  }

  const hoiKhachM =
    row.hoi_khach_m === null ||
    row.hoi_khach_m === undefined
      ? null
      : num(row.hoi_khach_m, null);

  const aiNghiaM =
    row.ai_nghia_m === null ||
    row.ai_nghia_m === undefined
      ? null
      : num(row.ai_nghia_m, null);

  return {
    obs_time: row.obs_time || obsHour,
    obs_hour: obsHour,
    hoi_khach_m: hoiKhachM,
    ai_nghia_m: aiNghiaM,
    source: text(row.source, "api_ttb"),
    note: text(row.note, "sync-72h-ttb"),
    created_by: text(row.created_by, "system"),
    updated_at:
      row.updated_at || new Date().toISOString(),
  };
}

/*
  Kiểm tra trước khi gửi Supabase để nếu có lỗi key
  thì backend báo rõ vị trí thay vì PostgREST trả PGRST102.
*/
function validateSameObjectKeys(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("Payload upsert phải là một mảng");
  }

  if (!rows.length) {
    return true;
  }

  const expectedKeys = Object.keys(rows[0]).sort();
  const expectedText = expectedKeys.join("|");

  rows.forEach((row, index) => {
    const actualKeys = Object.keys(row).sort();
    const actualText = actualKeys.join("|");

    if (actualText !== expectedText) {
      throw new Error(
        `Payload không đồng nhất key tại dòng ${index}. ` +
        `Expected=[${expectedKeys.join(", ")}], ` +
        `Actual=[${actualKeys.join(", ")}]`
      );
    }
  });

  return true;
}

async function upsertObservedRowsInBatches(
  rows,
  batchSize = 3
) {
  if (!Array.isArray(rows)) {
    throw new Error("rows phải là một mảng");
  }

  if (!rows.length) {
    return 0;
  }

  const normalizedRows =
    rows.map(normalizeObservedUpsertRow);

  validateSameObjectKeys(normalizedRows);

  const safeBatchSize = Math.max(
    1,
    Number(batchSize) || 3
  );

  for (
    let i = 0;
    i < normalizedRows.length;
    i += safeBatchSize
  ) {
    const batch = normalizedRows.slice(
      i,
      i + safeBatchSize
    );

    await supabaseUpsertMinimal(
      "downstream_manual_observations",
      batch,
      "obs_hour"
    );
  }

  return normalizedRows.length;
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

    Q_VuGia_Delta_1h: num(
      query.Q_VuGia_Delta_1h,
      0
    ),

    Q_VuGia_Delta_3h: num(
      query.Q_VuGia_Delta_3h,
      0
    ),
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

  const missing = required.filter(
    (key) => input[key] === null
  );

  return {
    ok: missing.length === 0,
    missing,
  };
}

async function loadCoefficients() {
  return supabaseSelect(
    "downstream_active_model_coefficients" +
    "?select=*&order=model_code.asc"
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
    "downstream_forecast_model_metrics" +
    "?select=model_code,station_code,horizon_hours," +
    "test_r2,test_mae_cm,test_rmse_cm"
  );

  const map = {};

  for (const row of rows || []) {
    map[row.model_code] = row;
  }

  return map;
}

function calculateForecast(
  modelCode,
  coefficients,
  input
) {
  const rows = coefficients.filter(
    (x) => x.model_code === modelCode
  );

  if (!rows.length) {
    throw new Error(
      `Không tìm thấy hệ số cho model ${modelCode}`
    );
  }

  let result = 0;

  for (const row of rows) {
    const variableName = row.variable_name;
    const coef = Number(row.coefficient);

    if (!Number.isFinite(coef)) {
      throw new Error(
        `Hệ số không hợp lệ: ` +
        `model=${modelCode}, ` +
        `variable=${variableName}`
      );
    }

    if (variableName === "intercept") {
      result += coef;
      continue;
    }

    const value = input[variableName];

    if (value === undefined || value === null) {
      throw new Error(
        `Thiếu biến đầu vào ${variableName} ` +
        `cho model ${modelCode}`
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
      alarm_message:
        "Chưa cấu hình ngưỡng báo động cho trạm",
    };
  }

  const bd1 = Number(threshold.bd1_cm);
  const bd2 = Number(threshold.bd2_cm);
  const bd3 = Number(threshold.bd3_cm);

  const watchRatio = Number(
    threshold.watch_ratio || 0.8
  );

  const fc4 = forecasts.find(
    (x) => x.horizon_hours === 4
  )?.forecast_water_level_cm;

  const fc6 = forecasts.find(
    (x) => x.horizon_hours === 6
  )?.forecast_water_level_cm;

  const fc12 = forecasts.find(
    (x) => x.horizon_hours === 12
  )?.forecast_water_level_cm;

  const max4to6 = Math.max(
    fc4 ?? -Infinity,
    fc6 ?? -Infinity
  );

  const maxAll = Math.max(
    fc4 ?? -Infinity,
    fc6 ?? -Infinity,
    fc12 ?? -Infinity
  );

  if (max4to6 >= bd3) {
    return {
      alarm_level: "emergency",
      alarm_message:
        "Dự báo có khả năng vượt báo động III " +
        "trong 4-6 giờ tới",
    };
  }

  if (max4to6 >= bd2) {
    return {
      alarm_level: "danger",
      alarm_message:
        "Dự báo có khả năng vượt báo động II " +
        "trong 4-6 giờ tới",
    };
  }

  if (max4to6 >= bd1) {
    return {
      alarm_level: "warning",
      alarm_message:
        "Dự báo có khả năng vượt báo động I " +
        "trong 4-6 giờ tới",
    };
  }

  if (maxAll >= bd1 * watchRatio) {
    return {
      alarm_level: "watch",
      alarm_message:
        "Mực nước dự báo tiệm cận báo động I, " +
        "cần theo dõi",
    };
  }

  return {
    alarm_level: "normal",
    alarm_message:
      "Mực nước dự báo dưới ngưỡng cảnh báo",
  };
}

async function calculateDownstreamForecastData(query) {
  const forecastTime = query.time
    ? new Date(String(query.time))
    : new Date();

  if (Number.isNaN(forecastTime.getTime())) {
    const err = new Error("Tham số time không hợp lệ");
    err.statusCode = 400;
    throw err;
  }

  const input = getInputVariables(query);
  const valid = validateInput(input);

  if (!valid.ok) {
    const err = new Error("Thiếu biến đầu vào");
    err.statusCode = 400;
    err.missing = valid.missing;
    throw err;
  }

  const [
    coefficients,
    thresholds,
    metrics,
  ] = await Promise.all([
    loadCoefficients(),
    loadThresholds(),
    loadMetrics(),
  ]);

  if (!coefficients.length) {
    throw new Error(
      "Không có hệ số mô hình trong " +
      "downstream_active_model_coefficients"
    );
  }

  const modelGroups = [
    {
      station_code: "HOI_KHACH",
      station_name: "Hội Khách",
      current_water_level_cm:
        input.Hoi_Khach_cm,
      models: [
        {
          model_code: "HK_4H",
          horizon_hours: 4,
        },
        {
          model_code: "HK_6H",
          horizon_hours: 6,
        },
        {
          model_code: "HK_12H",
          horizon_hours: 12,
        },
      ],
    },
    {
      station_code: "AI_NGHIA",
      station_name: "Ái Nghĩa",
      current_water_level_cm:
        input.Ai_Nghia_cm,
      models: [
        {
          model_code: "AN_4H",
          horizon_hours: 4,
        },
        {
          model_code: "AN_6H",
          horizon_hours: 6,
        },
        {
          model_code: "AN_12H",
          horizon_hours: 12,
        },
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

      const metric =
        metrics[m.model_code] || null;

      return {
        model_code: m.model_code,
        horizon_hours: m.horizon_hours,

        target_time: addHours(
          forecastTime,
          m.horizon_hours
        ).toISOString(),

        forecast_water_level_cm:
          round(forecastValue, 2),

        model_quality: metric
          ? {
              test_r2:
                round(metric.test_r2, 3),

              test_mae_cm:
                round(metric.test_mae_cm, 2),

              test_rmse_cm:
                round(metric.test_rmse_cm, 2),
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

      current_water_level_cm:
        station.current_water_level_cm,

      forecasts,

      alarm_level: alarm.alarm_level,
      alarm_message: alarm.alarm_message,

      thresholds:
        thresholds[station.station_code] || null,
    });
  }

  return {
    forecast_time: forecastTime.toISOString(),
    input,
    stations,
  };
}

async function handleForecast(req, res) {
  try {
    const result =
      await calculateDownstreamForecastData(req.query);

    return json(res, 200, {
      ok: true,
      mode: "forecast",
      ...result,
    });
  } catch (err) {
    if (err?.statusCode === 400) {
      return json(res, 400, {
        ok: false,
        mode: "forecast",
        error: err.message,
        missing: err.missing || undefined,
      });
    }

    throw err;
  }
}

/* ======================================================
   PUBLIC FLOOD-MARK LOOKUP
   UX: Xã -> Mốc AVC -> So sánh với đỉnh lũ 2025
====================================================== */

const PUBLIC_COMMUNE_ORDER = [
  "Thượng Đức",
  "Hà Nha",
  "Đại Lộc",
  "Vu Gia",
  "Phú Thuận",
];

const PUBLIC_MARK_VIEW =
  "v_downstream_flood_mark_reference";

const PUBLIC_MARK_SELECT = [
  "mark_code",
  "commune",
  "village",
  "location_desc",
  "latitude",
  "longitude",
  "reference_station",
  "reference_station_name",
  "reference_flood_2025_level_m",
  "comparison_mode",
  "active",
].join(",");

async function loadPublicFloodMarks({
  commune = null,
  markCode = null,
} = {}) {
  const params = new URLSearchParams();

  params.set("select", PUBLIC_MARK_SELECT);
  params.set("active", "eq.true");

  if (commune) {
    params.set(
      "commune",
      `eq.${String(commune)}`
    );
  }

  if (markCode) {
    params.set(
      "mark_code",
      `eq.${String(markCode).toUpperCase()}`
    );
  }

  params.set("order", "mark_code.asc");

  return supabaseSelect(
    `${PUBLIC_MARK_VIEW}?${params.toString()}`
  );
}

function normalizePublicMark(row) {
  if (!row) {
    return null;
  }

  return {
    mark_code: row.mark_code || null,
    commune: row.commune || null,
    village: row.village || null,
    location_desc: row.location_desc || null,
    latitude: num(row.latitude, null),
    longitude: num(row.longitude, null),
    reference_station:
      row.reference_station || null,
    reference_station_name:
      row.reference_station_name || null,
    reference_flood_2025_level_m:
      round(
        row.reference_flood_2025_level_m,
        3
      ),
    comparison_mode:
      row.comparison_mode ||
      "REFERENCE_STATION_2025",
  };
}

function compareWithFlood2025(
  waterLevelCm,
  flood2025LevelM
) {
  const waterCm = num(waterLevelCm, null);
  const refM = num(flood2025LevelM, null);

  if (waterCm === null || refM === null) {
    return {
      difference_2025_cm: null,
      comparison: "UNKNOWN",
      comparison_text:
        "Chưa đủ dữ liệu để so sánh với lũ năm 2025",
    };
  }

  const referenceCm = refM * 100;
  const deltaCm = round(
    waterCm - referenceCm,
    1
  );

  let comparison = "EQUAL_2025";
  let comparisonText =
    "xấp xỉ mức lũ năm 2025";

  if (deltaCm > 0) {
    comparison = "ABOVE_2025";
    comparisonText =
      `cao hơn mức lũ năm 2025 khoảng ` +
      `${round(Math.abs(deltaCm), 1)} cm`;
  } else if (deltaCm < 0) {
    comparison = "BELOW_2025";
    comparisonText =
      `thấp hơn mức lũ năm 2025 khoảng ` +
      `${round(Math.abs(deltaCm), 1)} cm`;
  }

  return {
    difference_2025_cm:
      deltaCm,

    comparison,

    comparison_text:
      comparisonText,
  };
}

function buildPublicStationForecast(
  station,
  flood2025LevelM
) {
  if (!station) {
    return {
      available: false,
      reason: "STATION_FORECAST_NOT_FOUND",
    };
  }

  const current = {
    current_level_m:
      round(
        num(
          station.current_water_level_cm,
          null
        ) / 100,
        2
      ),

    ...compareWithFlood2025(
      station.current_water_level_cm,
      flood2025LevelM
    ),
  };

  const forecasts = (
    station.forecasts || []
  ).map((item) => ({
    horizon_hours:
      item.horizon_hours,

    target_time:
      item.target_time,

    forecast_level_m:
      round(
        num(
          item.forecast_water_level_cm,
          null
        ) / 100,
        2
      ),

    ...compareWithFlood2025(
      item.forecast_water_level_cm,
      flood2025LevelM
    ),

    model_quality:
      item.model_quality || null,
  }));

  return {
    available: true,

    station_code:
      station.station_code,

    station_name:
      station.station_name,

    flood_2025_level_m:
      round(flood2025LevelM, 3),

    current,

    forecasts,

    alarm_level:
      station.alarm_level,

    alarm_message:
      station.alarm_message,
  };
}

/*
  Public mode có thể nhận cùng bộ biến đầu vào với mode=forecast.

  Nếu thiếu các biến đầu vào, endpoint vẫn trả danh mục xã/mốc
  và forecast.available=false, để frontend vẫn tra cứu được vị trí.

  Có thể truyền:
  include_forecast=0
  nếu chỉ muốn lấy danh mục mà không tính mô hình.
*/
async function tryBuildPublicForecast(
  req,
  referenceStation,
  flood2025LevelM
) {
  const includeForecast =
    String(
      req.query.include_forecast ?? "1"
    ) !== "0";

  if (!includeForecast) {
    return {
      available: false,
      reason: "FORECAST_DISABLED",
    };
  }

  const input = getInputVariables(req.query);
  const valid = validateInput(input);

  if (!valid.ok) {
    return {
      available: false,
      reason: "MISSING_FORECAST_INPUTS",
      missing_inputs: valid.missing,
      hint:
        "Truyền cùng bộ biến đầu vào của mode=forecast " +
        "để API tính +4h/+6h/+12h cho khu vực.",
    };
  }

  const result =
    await calculateDownstreamForecastData(
      req.query
    );

  const station =
    result.stations.find(
      (x) =>
        x.station_code ===
        referenceStation
    ) || null;

  return {
    forecast_time:
      result.forecast_time,

    ...buildPublicStationForecast(
      station,
      flood2025LevelM
    ),
  };
}

async function handlePublicCommunes(req, res) {
  const rows = await loadPublicFloodMarks();

  const map = new Map();

  for (const raw of rows || []) {
    const row = normalizePublicMark(raw);

    if (!row?.commune) {
      continue;
    }

    if (!map.has(row.commune)) {
      map.set(row.commune, {
        commune: row.commune,
        total_marks: 0,

        reference_station:
          row.reference_station,

        reference_station_name:
          row.reference_station_name,

        reference_flood_2025_level_m:
          row.reference_flood_2025_level_m,
      });
    }

    map.get(row.commune).total_marks += 1;
  }

  const order = new Map(
    PUBLIC_COMMUNE_ORDER.map(
      (name, index) => [name, index]
    )
  );

  const data =
    Array.from(map.values()).sort(
      (a, b) => {
        const ai =
          order.has(a.commune)
            ? order.get(a.commune)
            : 999;

        const bi =
          order.has(b.commune)
            ? order.get(b.commune)
            : 999;

        if (ai !== bi) {
          return ai - bi;
        }

        return String(a.commune)
          .localeCompare(
            String(b.commune),
            "vi"
          );
      }
    );

  return json(
    res,
    200,
    {
      ok: true,
      mode: "public-communes",
      total_communes: data.length,
      total_marks:
        data.reduce(
          (sum, x) =>
            sum + x.total_marks,
          0
        ),
      data,
    },
    "s-maxage=300, stale-while-revalidate=600"
  );
}

async function handlePublicCommune(req, res) {
  const commune = text(
    req.query.commune,
    ""
  ).trim();

  if (!commune) {
    return json(res, 400, {
      ok: false,
      mode: "public-commune",
      error: "Thiếu tham số commune",
    });
  }

  const rows =
    await loadPublicFloodMarks({
      commune,
    });

  if (!rows.length) {
    return json(res, 404, {
      ok: false,
      mode: "public-commune",
      error:
        `Không tìm thấy mốc lũ của xã ${commune}`,
    });
  }

  const marks =
    rows.map(normalizePublicMark);

  const referenceStations =
    [
      ...new Set(
        marks
          .map(
            (x) =>
              x.reference_station
          )
          .filter(Boolean)
      ),
    ];

  if (referenceStations.length !== 1) {
    return json(res, 409, {
      ok: false,
      mode: "public-commune",
      error:
        "Một xã đang được gán nhiều trạm tham chiếu",
      commune,
      reference_stations:
        referenceStations,
    });
  }

  const first = marks[0];

  const forecast =
    await tryBuildPublicForecast(
      req,
      first.reference_station,
      first.reference_flood_2025_level_m
    );

  return json(res, 200, {
    ok: true,
    mode: "public-commune",

    commune: {
      name: commune,
      total_marks: marks.length,
    },

    reference: {
      station_code:
        first.reference_station,

      station_name:
        first.reference_station_name,

      flood_2025_level_m:
        first.reference_flood_2025_level_m,

      comparison_mode:
        first.comparison_mode,
    },

    forecast,

    marks: marks.map((x) => ({
      mark_code: x.mark_code,
      village: x.village,
      location_desc:
        x.location_desc,
      latitude: x.latitude,
      longitude: x.longitude,
    })),

    disclaimer:
      "Kết quả mốc AVC được tham chiếu theo dự báo " +
      "mực nước của trạm Hội Khách hoặc Ái Nghĩa; " +
      "không phải số đo mực nước riêng tại từng mốc AVC.",
  });
}

async function handlePublicMark(req, res) {
  const markCode = text(
    req.query.mark ||
    req.query.mark_code,
    ""
  )
    .trim()
    .toUpperCase();

  if (!markCode) {
    return json(res, 400, {
      ok: false,
      mode: "public-mark",
      error:
        "Thiếu tham số mark hoặc mark_code",
    });
  }

  const rows =
    await loadPublicFloodMarks({
      markCode,
    });

  const mark =
    normalizePublicMark(
      rows?.[0] || null
    );

  if (!mark) {
    return json(res, 404, {
      ok: false,
      mode: "public-mark",
      error:
        `Không tìm thấy mốc ${markCode}`,
    });
  }

  const forecast =
    await tryBuildPublicForecast(
      req,
      mark.reference_station,
      mark.reference_flood_2025_level_m
    );

  return json(res, 200, {
    ok: true,
    mode: "public-mark",

    mark: {
      mark_code:
        mark.mark_code,
      commune:
        mark.commune,
      village:
        mark.village,
      location_desc:
        mark.location_desc,
      latitude:
        mark.latitude,
      longitude:
        mark.longitude,
    },

    reference: {
      station_code:
        mark.reference_station,

      station_name:
        mark.reference_station_name,

      flood_2025_level_m:
        mark.reference_flood_2025_level_m,

      comparison_mode:
        mark.comparison_mode,
    },

    forecast,

    disclaimer:
      "Thông tin tại mốc được tham chiếu theo trạm dự báo; " +
      "không phải mực nước đo trực tiếp tại mốc AVC.",
  });
}

function haversineDistanceKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const toRad =
    (value) =>
      value * Math.PI / 180;

  const R = 6371;

  const dLat =
    toRad(lat2 - lat1);

  const dLon =
    toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

async function handlePublicNearest(req, res) {
  const lat = num(
    req.query.lat,
    null
  );

  const lon = num(
    req.query.lon ??
    req.query.lng ??
    req.query.longitude,
    null
  );

  if (
    lat === null ||
    lon === null
  ) {
    return json(res, 400, {
      ok: false,
      mode: "public-nearest",
      error:
        "Thiếu hoặc sai tham số lat/lon",
    });
  }

  if (
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return json(res, 400, {
      ok: false,
      mode: "public-nearest",
      error:
        "Tọa độ lat/lon ngoài phạm vi hợp lệ",
    });
  }

  const rows =
    await loadPublicFloodMarks();

  const candidates =
    rows
      .map(normalizePublicMark)
      .filter(
        (x) =>
          Number.isFinite(x?.latitude) &&
          Number.isFinite(x?.longitude)
      )
      .map((mark) => ({
        mark,
        distance_km:
          haversineDistanceKm(
            lat,
            lon,
            mark.latitude,
            mark.longitude
          ),
      }))
      .sort(
        (a, b) =>
          a.distance_km -
          b.distance_km
      );

  const nearest =
    candidates[0] || null;

  if (!nearest) {
    return json(res, 404, {
      ok: false,
      mode: "public-nearest",
      error:
        "Không có mốc AVC có tọa độ hợp lệ",
    });
  }

  const maxDistanceKm =
    num(
      req.query.max_distance_km,
      null
    );

  if (
    maxDistanceKm !== null &&
    nearest.distance_km >
      maxDistanceKm
  ) {
    return json(res, 404, {
      ok: false,
      mode: "public-nearest",
      error:
        "Không có mốc AVC trong bán kính yêu cầu",
      nearest_distance_km:
        round(
          nearest.distance_km,
          3
        ),
      max_distance_km:
        maxDistanceKm,
    });
  }

  const mark =
    nearest.mark;

  const forecast =
    await tryBuildPublicForecast(
      req,
      mark.reference_station,
      mark.reference_flood_2025_level_m
    );

  return json(res, 200, {
    ok: true,
    mode: "public-nearest",

    query_location: {
      latitude: lat,
      longitude: lon,
    },

    nearest: {
      distance_m:
        Math.round(
          nearest.distance_km * 1000
        ),

      mark: {
        mark_code:
          mark.mark_code,
        commune:
          mark.commune,
        village:
          mark.village,
        location_desc:
          mark.location_desc,
        latitude:
          mark.latitude,
        longitude:
          mark.longitude,
      },
    },

    reference: {
      station_code:
        mark.reference_station,

      station_name:
        mark.reference_station_name,

      flood_2025_level_m:
        mark.reference_flood_2025_level_m,

      comparison_mode:
        mark.comparison_mode,
    },

    forecast,

    disclaimer:
      "Mốc gần nhất được xác định theo khoảng cách tọa độ. " +
      "Kết quả dự báo vẫn tham chiếu theo trạm Hội Khách/Ái Nghĩa.",
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
    pickValue(
      req,
      body,
      "created_by",
      "operator"
    )
  );

  if (hoiKhachM === null && aiNghiaM === null) {
    return json(res, 400, {
      ok: false,
      mode: "save-manual",
      error:
        "Cần nhập ít nhất hoi_khach_m " +
        "hoặc ai_nghia_m",
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
    obs_hour: obsHour,
    data: upserted?.[0] || null,
  });
}

async function handleLatestInput(req, res) {
  const rows = await supabaseSelect(
    "downstream_latest_manual_with_delta" +
    "?select=*&limit=1"
  );

  const latest = rows?.[0] || null;

  if (!latest) {
    return json(res, 404, {
      ok: false,
      mode: "latest-input",
      error:
        "Chưa có số liệu hạ du nhập tay",
    });
  }

  return json(res, 200, {
    ok: true,
    mode: "latest-input",

    downstream: {
      id: latest.id,

      obs_hour:
        latest.obs_hour || null,

      obs_time:
        latest.obs_time ||
        latest.obs_hour ||
        null,

      Hoi_Khach_m:
        round(latest.hoi_khach_m, 2),

      Ai_Nghia_m:
        round(latest.ai_nghia_m, 2),

      Hoi_Khach_cm:
        round(latest.hoi_khach_cm, 2),

      Ai_Nghia_cm:
        round(latest.ai_nghia_cm, 2),

      HK_Delta_1h_cm:
        round(latest.hk_delta_1h_cm, 2),

      HK_Delta_3h_cm:
        round(latest.hk_delta_3h_cm, 2),

      AN_Delta_1h_cm:
        round(latest.an_delta_1h_cm, 2),

      AN_Delta_3h_cm:
        round(latest.an_delta_3h_cm, 2),

      source:
        latest.source || "manual",

      note:
        latest.note || "",

      created_by:
        latest.created_by || "",

      created_at:
        latest.created_at || null,

      updated_at:
        latest.updated_at || null,
    },
  });
}

async function handleManualHistory(req, res) {
  const limit = Math.min(
    num(req.query.limit, 50),
    500
  );

  const rows = await supabaseSelect(
    "downstream_manual_observations" +
    "?select=id,obs_hour,obs_time," +
    "hoi_khach_m,ai_nghia_m," +
    "hoi_khach_cm,ai_nghia_cm," +
    "source,note,created_by," +
    "created_at,updated_at" +
    "&source=eq.manual" +
    "&order=obs_hour.desc" +
    `&limit=${limit}`
  );

  return json(res, 200, {
    ok: true,
    mode: "manual-history",
    limit,
    data: rows || [],
  });
}

/* ======================================================
   OBSERVED / TTB SYNC
====================================================== */

async function handleDebugTtb(req, res) {
  const stationId = String(
    req.query.station_id || "553100"
  );

  const hours = Math.min(
    Math.max(num(req.query.hours, 24), 1),
    168
  );

  const endTime = new Date();

  const startTime = new Date(
    endTime.getTime() -
    hours * 60 * 60 * 1000
  );

  const result = await fetchTtbStationSeries({
    stationId,
    startTime,
    endTime,
    tableName: "mucnuoc_oday",
    stepMinutes: 60,
    aggregate: 0,
    timeoutMs: 12000,
  });

  return json(
    res,
    result.ok ? 200 : 502,
    {
      ok: result.ok,
      mode: "debug-ttb",
      station_id: stationId,
      hours,
      result,
    }
  );
}

async function handleSyncTtb(req, res) {
  const hours = Math.min(
    Math.max(num(req.query.hours, 72), 1),
    168
  );

  const dryRun =
    String(req.query.dry_run || "0") === "1";

  const endTime = new Date();

  const startTime = new Date(
    endTime.getTime() -
    hours * 60 * 60 * 1000
  );

  let hoiKhach = null;
  let aiNghia = null;
  let mergedRows = [];
  let existingRows = [];
  let plan = null;
  let upsertedCount = 0;

  try {
    [hoiKhach, aiNghia] =
      await Promise.all([
        fetchTtbStationSeries({
          stationId: "553100",
          startTime,
          endTime,
          tableName: "mucnuoc_oday",
          stepMinutes: 60,
          aggregate: 0,
          timeoutMs: 12000,
        }),

        fetchTtbStationSeries({
          stationId: "553300",
          startTime,
          endTime,
          tableName: "mucnuoc_oday",
          stepMinutes: 60,
          aggregate: 0,
          timeoutMs: 12000,
        }),
      ]);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "sync-ttb",
      stage: "fetch-ttb",
      error: err.message,
    });
  }

  if (!hoiKhach?.ok && !aiNghia?.ok) {
    return json(res, 502, {
      ok: false,
      mode: "sync-ttb",
      stage: "fetch-ttb",

      error:
        "Không lấy được dữ liệu từ " +
        "cả 2 trạm TTB",

      diagnostics: {
        hoi_khach: hoiKhach,
        ai_nghia: aiNghia,
      },
    });
  }

  try {
    mergedRows = mergeObservedStations(
      hoiKhach?.ok
        ? hoiKhach.data
        : [],

      aiNghia?.ok
        ? aiNghia.data
        : []
    );
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "sync-ttb",
      stage: "merge",
      error: err.message,

      diagnostics: {
        hoi_khach_count:
          hoiKhach?.count || 0,

        ai_nghia_count:
          aiNghia?.count || 0,
      },
    });
  }

  if (!mergedRows.length) {
    return json(res, 200, {
      ok: true,
      mode: "sync-ttb",
      stage: "merge",

      message:
        "Không có dữ liệu mới để đồng bộ",

      mergedCount: 0,
    });
  }

  const startIso =
    mergedRows[0]?.obs_hour ||
    startTime.toISOString();

  const endIso =
    mergedRows[
      mergedRows.length - 1
    ]?.obs_hour ||
    endTime.toISOString();

  try {
    existingRows =
      await fetchExistingObservedRows(
        startIso,
        endIso
      );
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "sync-ttb",
      stage: "db-select",
      error: err.message,

      period: {
        start: startIso,
        end: endIso,
      },

      mergedCount:
        mergedRows.length,
    });
  }

  try {
    plan = buildSyncPlan(
      mergedRows,
      existingRows
    );
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "sync-ttb",
      stage: "build-plan",
      error: err.message,

      existingCount:
        existingRows.length,

      mergedCount:
        mergedRows.length,
    });
  }

  if (dryRun) {
    return json(res, 200, {
      ok: true,
      mode: "sync-ttb",
      stage: "dry-run",
      hours,

      period: {
        start: startIso,
        end: endIso,
      },

      sourceStations: {
        hoi_khach: {
          ok: hoiKhach.ok,
          station_id: "553100",
          count: hoiKhach.count,
          error:
            hoiKhach.error || null,
        },

        ai_nghia: {
          ok: aiNghia.ok,
          station_id: "553300",
          count: aiNghia.count,
          error:
            aiNghia.error || null,
        },
      },

      mergedCount:
        mergedRows.length,

      existingCount:
        existingRows.length,

      toUpsertCount:
        plan.toUpsert.length,

      insertedCount:
        plan.inserted.length,

      overwrittenApiCount:
        plan.overwrittenApi.length,

      skippedManualCount:
        plan.skippedManual.length,

      sampleRows:
        mergedRows.slice(0, 3),

      sampleUpsertRows:
        plan.toUpsert
          .slice(0, 3)
          .map(normalizeObservedUpsertRow),

      sampleUpsertKeys:
        plan.toUpsert[0]
          ? Object.keys(
              normalizeObservedUpsertRow(
                plan.toUpsert[0]
              )
            ).sort()
          : [],
    });
  }

  try {
    if (plan.toUpsert.length) {
      upsertedCount =
        await upsertObservedRowsInBatches(
          plan.toUpsert,
          3
        );
    }
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "sync-ttb",
      stage: "db-upsert",
      error: err.message,

      period: {
        start: startIso,
        end: endIso,
      },

      mergedCount:
        mergedRows.length,

      existingCount:
        existingRows.length,

      toUpsertCount:
        plan.toUpsert.length,

      firstUpsertRow:
        plan.toUpsert[0]
          ? normalizeObservedUpsertRow(
              plan.toUpsert[0]
            )
          : null,

      firstUpsertRowKeys:
        plan.toUpsert[0]
          ? Object.keys(
              normalizeObservedUpsertRow(
                plan.toUpsert[0]
              )
            ).sort()
          : [],
    });
  }

  return json(res, 200, {
    ok: true,
    mode: "sync-ttb",
    stage: "done",
    hours,

    period: {
      start: startIso,
      end: endIso,
    },

    sourceStations: {
      hoi_khach: {
        ok: hoiKhach.ok,
        station_id: "553100",
        count: hoiKhach.count,
        error:
          hoiKhach.error || null,
      },

      ai_nghia: {
        ok: aiNghia.ok,
        station_id: "553300",
        count: aiNghia.count,
        error:
          aiNghia.error || null,
      },
    },

    mergedCount:
      mergedRows.length,

    existingCount:
      existingRows.length,

    insertedCount:
      plan.inserted.length,

    overwrittenApiCount:
      plan.overwrittenApi.length,

    skippedManualCount:
      plan.skippedManual.length,

    upsertedCount,

    skippedManual:
      plan.skippedManual,
  });
}

async function handleObservedLatest(req, res) {
  const rows = await supabaseSelect(
    "downstream_manual_observations" +
    "?select=id,obs_hour,obs_time," +
    "hoi_khach_m,ai_nghia_m," +
    "hoi_khach_cm,ai_nghia_cm," +
    "source,note,created_by," +
    "created_at,updated_at" +
    "&order=obs_hour.desc" +
    "&limit=1"
  );

  const latest = rows?.[0] || null;

  if (!latest) {
    return json(res, 404, {
      ok: false,
      mode: "observed-latest",
      error:
        "Chưa có dữ liệu observed",
    });
  }

  return json(
    res,
    200,
    {
      ok: true,
      mode: "observed-latest",
      data: latest,
    },
    "s-maxage=120, stale-while-revalidate=300"
  );
}

async function handleObservedHistory(req, res) {
  const hours = Math.min(
    Math.max(num(req.query.hours, 72), 1),
    168
  );

  const endTime = new Date();

  const startTime = new Date(
    endTime.getTime() -
    hours * 60 * 60 * 1000
  );

  const rows = await supabaseSelect(
    "downstream_manual_observations" +
    "?select=id,obs_hour,obs_time," +
    "hoi_khach_m,ai_nghia_m," +
    "hoi_khach_cm,ai_nghia_cm," +
    "source,note,created_by," +
    "created_at,updated_at" +
    `&obs_hour=gte.${encodeURIComponent(
      startTime.toISOString()
    )}` +
    `&obs_hour=lte.${encodeURIComponent(
      endTime.toISOString()
    )}` +
    "&order=obs_hour.asc"
  );

  return json(
    res,
    200,
    {
      ok: true,
      mode: "observed-history",
      hours,
      count: rows.length,
      data: rows,
    },
    "s-maxage=120, stale-while-revalidate=300"
  );
}

/* ======================================================
   BACKTEST
====================================================== */

function getStationConfig(station) {
  const s = String(
    station || ""
  ).toUpperCase();

  if (
    s === "HK" ||
    s === "HOI_KHACH"
  ) {
    return {
      station_code: "HOI_KHACH",
      station_name: "Hội Khách",
      model_prefix: "HK",
    };
  }

  if (
    s === "AN" ||
    s === "AI_NGHIA"
  ) {
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

  params.set(
    "station_code",
    `eq.${station_code}`
  );

  if (horizon) {
    params.set(
      "horizon_hours",
      `eq.${horizon}`
    );
  }

  if (split) {
    params.set(
      "split",
      `eq.${String(split).toUpperCase()}`
    );
  }

  if (startDate) {
    params.append(
      "forecast_time",
      `gte.${startDate}T00:00:00+00:00`
    );
  }

  if (endDate) {
    params.append(
      "forecast_time",
      `lte.${endDate}T23:59:59+00:00`
    );
  }

  params.set(
    "order",
    "forecast_time.asc"
  );

  params.set(
    "limit",
    String(limit)
  );

  return (
    "downstream_forecast_backtest?" +
    params.toString()
  );
}

function buildSummaryPath({
  station_code,
  horizon,
}) {
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

  params.set(
    "station_code",
    `eq.${station_code}`
  );

  if (horizon) {
    params.set(
      "horizon_hours",
      `eq.${horizon}`
    );
  }

  params.set(
    "order",
    "horizon_hours.asc,split.asc"
  );

  return (
    "downstream_forecast_backtest_summary?" +
    params.toString()
  );
}

function buildMetricsPath({
  station_code,
  horizon,
}) {
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

  params.set(
    "station_code",
    `eq.${station_code}`
  );

  if (horizon) {
    params.set(
      "horizon_hours",
      `eq.${horizon}`
    );
  }

  params.set(
    "order",
    "horizon_hours.asc"
  );

  return (
    "downstream_forecast_model_metrics?" +
    params.toString()
  );
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
    .filter(Number.isFinite);

  const absErrors = rows
    .map((x) => Number(x.abs_error_cm))
    .filter(Number.isFinite);

  const bias = errors.length
    ? errors.reduce(
        (a, b) => a + b,
        0
      ) / errors.length
    : null;

  const mae = absErrors.length
    ? absErrors.reduce(
        (a, b) => a + b,
        0
      ) / absErrors.length
    : null;

  const rmse = errors.length
    ? Math.sqrt(
        errors.reduce(
          (a, b) => a + b * b,
          0
        ) / errors.length
      )
    : null;

  const maxAbs = absErrors.length
    ? Math.max(...absErrors)
    : null;

  return {
    n_rows: rows.length,
    bias_cm: round(bias, 2),
    mae_cm: round(mae, 2),
    rmse_cm: round(rmse, 2),
    max_abs_error_cm:
      round(maxAbs, 2),

    min_forecast_time:
      rows[0]?.forecast_time || null,

    max_forecast_time:
      rows[
        rows.length - 1
      ]?.forecast_time || null,
  };
}

async function handleBacktest(req, res) {
  const stationInput = text(
    req.query.station ||
    req.query.station_code ||
    "HOI_KHACH"
  );

  const station =
    getStationConfig(stationInput);

  if (!station) {
    return json(res, 400, {
      ok: false,
      error: "station không hợp lệ",

      supported_station: [
        "HOI_KHACH",
        "AI_NGHIA",
      ],
    });
  }

  const horizon = num(
    req.query.horizon ||
    req.query.horizon_hours,
    null
  );

  if (
    horizon !== null &&
    ![4, 6, 12].includes(horizon)
  ) {
    return json(res, 400, {
      ok: false,
      error:
        "horizon không hợp lệ, " +
        "chỉ hỗ trợ 4, 6, 12",
    });
  }

  const startDate = toDateOnly(
    req.query.start || "2025-09-01"
  );

  const endDate = toDateOnly(
    req.query.end || "2025-12-31"
  );

  const split = req.query.split
    ? String(
        req.query.split
      ).toUpperCase()
    : "";

  const limit = Math.min(
    num(req.query.limit, 5000),
    20000
  );

  const rows = await supabaseSelect(
    buildBacktestPath({
      station_code:
        station.station_code,

      horizon,
      startDate,
      endDate,
      split,
      limit,
    })
  );

  const normalized = rows.map((x) => ({
    model_code:
      x.model_code,

    station_code:
      x.station_code,

    horizon_hours:
      x.horizon_hours,

    split:
      x.split,

    forecast_time:
      x.forecast_time,

    target_time:
      x.target_time,

    current_water_level_cm:
      round(
        x.current_water_level_cm,
        2
      ),

    forecast_water_level_cm:
      round(
        x.forecast_water_level_cm,
        2
      ),

    actual_water_level_cm:
      round(
        x.actual_water_level_cm,
        2
      ),

    error_cm:
      round(x.error_cm, 2),

    abs_error_cm:
      round(x.abs_error_cm, 2),
  }));

  return json(
    res,
    200,
    {
      ok: true,
      mode: "backtest",

      station_code:
        station.station_code,

      station_name:
        station.station_name,

      horizon_hours:
        horizon,

      start:
        startDate,

      end:
        endDate,

      split:
        split || "ALL",

      limit,

      summary:
        summarizeRows(normalized),

      data:
        normalized,
    },
    "s-maxage=300, stale-while-revalidate=600"
  );
}

async function handleSummary(req, res) {
  const stationInput = text(
    req.query.station ||
    req.query.station_code ||
    "HOI_KHACH"
  );

  const station =
    getStationConfig(stationInput);

  if (!station) {
    return json(res, 400, {
      ok: false,
      error: "station không hợp lệ",

      supported_station: [
        "HOI_KHACH",
        "AI_NGHIA",
      ],
    });
  }

  const horizon = num(
    req.query.horizon ||
    req.query.horizon_hours,
    null
  );

  if (
    horizon !== null &&
    ![4, 6, 12].includes(horizon)
  ) {
    return json(res, 400, {
      ok: false,
      error:
        "horizon không hợp lệ, " +
        "chỉ hỗ trợ 4, 6, 12",
    });
  }

  const [
    summaryRows,
    metricsRows,
  ] = await Promise.all([
    supabaseSelect(
      buildSummaryPath({
        station_code:
          station.station_code,

        horizon,
      })
    ),

    supabaseSelect(
      buildMetricsPath({
        station_code:
          station.station_code,

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

      station_code:
        station.station_code,

      station_name:
        station.station_name,

      horizon_hours:
        horizon,

      summary:
        summaryRows,

      metrics:
        metricsRows,
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
      return json(res, 200, {
        ok: true,
      });
    }

    /*
      Chỉ trả boolean kiểm tra biến môi trường.
      Không trả service role key ra frontend.
    */
    if (req.query.debug === "env") {
      return json(res, 200, {
        ok: true,

        has_SUPABASE_URL:
          !!SUPABASE_URL,

        has_SUPABASE_SERVICE_ROLE_KEY:
          !!SUPABASE_KEY,
      });
    }

    const mode = String(
      req.query.mode || "forecast"
    ).toLowerCase();

    if (mode === "save-manual") {
      if (
        req.method !== "POST" &&
        req.method !== "GET"
      ) {
        return json(res, 405, {
          ok: false,
          mode,

          error:
            "save-manual chỉ hỗ trợ " +
            "POST hoặc GET",
        });
      }

      return handleSaveManual(req, res);
    }

    if (
      mode === "latest-input" ||
      mode === "current-input"
    ) {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,

          error:
            "latest-input chỉ hỗ trợ GET",
        });
      }

      return handleLatestInput(req, res);
    }

    if (mode === "manual-history") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,

          error:
            "manual-history chỉ hỗ trợ GET",
        });
      }

      return handleManualHistory(req, res);
    }

    if (mode === "debug-ttb") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,

          error:
            "debug-ttb chỉ hỗ trợ GET",
        });
      }

      return handleDebugTtb(req, res);
    }

    if (mode === "sync-ttb") {
      if (
        req.method !== "GET" &&
        req.method !== "POST"
      ) {
        return json(res, 405, {
          ok: false,
          mode,

          error:
            "sync-ttb chỉ hỗ trợ " +
            "GET hoặc POST",
        });
      }

      return handleSyncTtb(req, res);
    }

    if (mode === "observed-latest") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,

          error:
            "observed-latest chỉ hỗ trợ GET",
        });
      }

      return handleObservedLatest(req, res);
    }

    if (mode === "observed-history") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,

          error:
            "observed-history chỉ hỗ trợ GET",
        });
      }

      return handleObservedHistory(req, res);
    }


    if (mode === "public-communes") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,
          error:
            "public-communes chỉ hỗ trợ GET",
        });
      }

      return handlePublicCommunes(req, res);
    }

    if (mode === "public-commune") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,
          error:
            "public-commune chỉ hỗ trợ GET",
        });
      }

      return handlePublicCommune(req, res);
    }

    if (mode === "public-mark") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,
          error:
            "public-mark chỉ hỗ trợ GET",
        });
      }

      return handlePublicMark(req, res);
    }

    if (mode === "public-nearest") {
      if (req.method !== "GET") {
        return json(res, 405, {
          ok: false,
          mode,
          error:
            "public-nearest chỉ hỗ trợ GET",
        });
      }

      return handlePublicNearest(req, res);
    }

    if (req.method !== "GET") {
      return json(res, 405, {
        ok: false,
        error: "Method not allowed",
      });
    }

    if (
      mode === "forecast" ||
      mode === "predict"
    ) {
      return handleForecast(req, res);
    }

    if (
      mode === "backtest" ||
      mode === "history"
    ) {
      return handleBacktest(req, res);
    }

    if (
      mode === "summary" ||
      mode === "metrics"
    ) {
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
        "debug-ttb",
        "sync-ttb",
        "observed-latest",
        "observed-history",
        "public-communes",
        "public-commune",
        "public-mark",
        "public-nearest",
      ],
    });
  } catch (err) {
    const statusCode =
      Number.isInteger(err?.statusCode)
        ? err.statusCode
        : 500;

    return json(res, statusCode, {
      ok: false,

      mode:
        req.query.mode || "forecast",

      error:
        err?.message ||
        "Lỗi máy chủ không xác định",

      missing:
        err?.missing || undefined,

      hint:
        statusCode >= 500
          ? (
              "Kiểm tra biến môi trường Supabase, " +
              "schema dữ liệu và log backend"
            )
          : undefined,
    });
  }
}
