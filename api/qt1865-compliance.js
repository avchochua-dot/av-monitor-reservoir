/**
 * Vercel API:
 *
 * 1) API QT1865 cũ - mặc định:
 *    /api/qt1865-compliance?year=2026&month=6
 *
 * 2) API QT1865 cũ - gọi rõ mode:
 *    /api/qt1865-compliance?mode=qt1865&year=2026&month=6
 *
 * 3) API báo cáo tháng / AI prompt:
 *    /api/qt1865-compliance?mode=monthly-report&year=2026&month=6
 *
 * 4) API PCTT Đà Nẵng:
 *    /api/qt1865-compliance?mode=pctt-hydro&year=2026&month=6&ids=1,2,3,4
 *    /api/qt1865-compliance?mode=pctt-hydro&start=2026-06-01T00:00:00+07:00&end=2026-06-30T23:59:59+07:00&ids=1,2,3,4
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  return res.status(status).json(data);
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = num(value);
  if (n === null) return null;
  return Number(n.toFixed(digits));
}

function sum(values) {
  return values.reduce((total, value) => total + (num(value) || 0), 0);
}

function avg(values) {
  const arr = values.map(num).filter(v => v !== null);
  if (!arr.length) return null;
  return sum(arr) / arr.length;
}

function monthRangeUtc(year, month) {
  const y = Number(year);
  const m = Number(month);

  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function monthRangeDate(year, month) {
  const y = Number(year);
  const m = Number(month);

  const start = `${y}-${String(m).padStart(2, "0")}-01`;

  const endDate = new Date(y, m, 0);
  const end = `${y}-${String(m).padStart(2, "0")}-${String(
    endDate.getDate()
  ).padStart(2, "0")}`;

  return { start, end };
}

function yearRangeDate(year) {
  const y = Number(year);
  return {
    start: `${y}-01-01`,
    end: `${y}-12-31`,
  };
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function monthOfDate(value) {
  const s = String(value || "");
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Number(match[2]);
}

function rowDateTime(row) {
  return row?.date || row?.time || null;
}

function pickNumber(row, keys) {
  for (const key of keys) {
    const v = num(row?.[key]);
    if (v !== null) return v;
  }
  return null;
}

function findExtreme(rows, key, type = "max") {
  const valid = rows
    .map(r => ({
      time: r.time,
      date: r.date || null,
      value: num(r[key]),
    }))
    .filter(x => x.value !== null);

  if (!valid.length) {
    return {
      value: null,
      time: null,
      date: null,
    };
  }

  return valid.reduce((best, cur) => {
    if (type === "min") return cur.value < best.value ? cur : best;
    return cur.value > best.value ? cur : best;
  }, valid[0]);
}

function extremeFromRows(rows, keys, type = "max") {
  const values = [];

  for (const row of rows || []) {
    const value = pickNumber(row, keys);
    if (value === null) continue;

    values.push({
      value,
      time: rowDateTime(row),
      date: row?.date || null,
    });
  }

  if (!values.length) {
    return {
      value: null,
      time: null,
      date: null,
    };
  }

  return values.reduce((best, cur) => {
    if (type === "min") return cur.value < best.value ? cur : best;
    return cur.value > best.value ? cur : best;
  }, values[0]);
}

function formatPercentLabel(value) {
  const n = num(value);
  if (n === null) return "-";

  const percent = n <= 1 ? n * 100 : n;
  const rounded = Number(percent.toFixed(2));

  if (Number.isInteger(rounded)) return `${rounded}%`;

  return `${String(rounded).replace(".", ",")}%`;
}

function classifyInflowFrequency(frequencyPercent) {
  const p = num(frequencyPercent);
  if (p === null) return "Chưa xác định";

  if (p <= 0.25) return "Nhóm nhiều nước";
  if (p <= 0.5) return "Nhóm trung bình đến khá";
  if (p <= 0.75) return "Nhóm ít nước";
  return "Nhóm rất ít nước / khô";
}

function classifyOverallRating(rate) {
  const r = num(rate) || 0;
  if (r >= 90) return "TỐT";
  if (r >= 80) return "KHÁ";
  if (r >= 70) return "TRUNG BÌNH";
  return "CẦN CẢI THIỆN";
}

/* =========================================================
   SUPABASE HELPERS
   ========================================================= */

function assertSupabaseEnv() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
}

async function fetchSupabasePaged(table, paramsBuilder) {
  assertSupabaseEnv();

  const pageSize = 1000;
  let offset = 0;
  let all = [];

  while (true) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);

    paramsBuilder(url.searchParams);

    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "count=exact",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Supabase ${table} ${response.status}: ${text}`);
    }

    const rows = text ? JSON.parse(text) : [];

    all = all.concat(rows);

    if (rows.length < pageSize) break;

    offset += pageSize;
  }

  return all;
}

/* =========================================================
   QT1865 LEGACY MODE
   Mặc định dùng cho:
   /api/qt1865-compliance?year=2026&month=6
   ========================================================= */

async function fetchQt1865Rows(start, end) {
  return fetchSupabasePaged("reservoir_release_compliance_1865", params => {
    params.set("select", "*");
    params.append("date", `gte.${start}`);
    params.append("date", `lte.${end}`);
    params.set("order", "date.asc");
  });
}

function summarizeReasonsQt1865(rows) {
  const reasonMap = new Map();

  for (const row of rows || []) {
    const reason = String(row.reason || "").trim();

    if (row.is_compliant && !reason.includes("Cảnh báo")) {
      continue;
    }

    const key = reason || "Không xác định";
    reasonMap.set(key, (reasonMap.get(key) || 0) + 1);
  }

  return Array.from(reasonMap.entries())
    .map(([reason, count]) => ({
      reason,
      count,
      days: count,
    }))
    .sort((a, b) => b.count - a.count);
}

function summarizeQt1865Rows(rows) {
  const totalDays = rows.length;

  const compliantDays = rows.filter(r => Boolean(r.is_compliant)).length;
  const nonCompliantDays = totalDays - compliantDays;

  const warningDays = rows.filter(r =>
    String(r.reason || "").includes("Cảnh báo")
  ).length;

  const turbine12hCompliantDays = rows.filter(r =>
    Boolean(r.is_turbine_12h_compliant)
  ).length;

  const turbine12hNonCompliantDays =
    totalDays - turbine12hCompliantDays;

  const waterLevelAvgValues = rows.map(r =>
    pickNumber(r, [
      "water_level_avg",
      "mnh_avg",
      "mnh",
      "waterLevelAvg",
    ])
  );

  const totalOutflowValues = rows.map(r =>
    pickNumber(r, [
      "total_outflow_avg",
      "outflow_avg",
      "q_out_avg",
      "qxa_avg",
    ])
  );

  const inflowValues = rows.map(r =>
    pickNumber(r, [
      "inflow_avg",
      "q_in_avg",
      "inflow",
      "qve_avg",
    ])
  );

  const turbineFlowValues = rows.map(r =>
    pickNumber(r, [
      "turbine_flow_avg",
      "q_turbine_avg",
      "qcm_avg",
      "turbine_avg",
    ])
  );

  const spillwayFlowValues = rows.map(r =>
    pickNumber(r, [
      "spillway_flow_avg",
      "q_spillway_avg",
      "qxa_avg",
      "spillway_avg",
    ])
  );

  const rainfallValues = rows.map(r =>
    pickNumber(r, [
      "rainfall_total",
      "rainfall",
      "rainfallreal",
      "rain_total",
    ])
  );

  const waterLevelMax = extremeFromRows(
    rows,
    [
      "mnh_max",
      "water_level_max",
      "water_level_avg",
      "mnh_avg",
      "mnh",
    ],
    "max"
  );

  const waterLevelMin = extremeFromRows(
    rows,
    [
      "mnh_min",
      "water_level_min",
      "water_level_avg",
      "mnh_avg",
      "mnh",
    ],
    "min"
  );

  const inflowMax = extremeFromRows(
    rows,
    [
      "inflow_max",
      "inflow_avg",
      "q_in_avg",
      "inflow",
      "qve_avg",
    ],
    "max"
  );

  const totalOutflowMax = extremeFromRows(
    rows,
    [
      "total_outflow_max",
      "total_outflow_avg",
      "outflow_avg",
      "q_out_avg",
      "qxa_avg",
    ],
    "max"
  );

  const rainMax = extremeFromRows(
    rows,
    [
      "rainfall_total",
      "rainfall",
      "rainfallreal",
      "rain_total",
    ],
    "max"
  );

  const summary = {
    totalDays,
    compliantDays,
    nonCompliantDays,
    warningDays,
    complianceRate: totalDays
      ? Number(((compliantDays / totalDays) * 100).toFixed(1))
      : 0,

    turbine12hCompliantDays,
    turbine12hNonCompliantDays,
    turbine12hRate: totalDays
      ? Number(((turbine12hCompliantDays / totalDays) * 100).toFixed(1))
      : 0,

    waterLevelAvg: round(avg(waterLevelAvgValues), 2),
    waterLevelMax: {
      value: round(waterLevelMax.value, 2),
      time: waterLevelMax.time,
      date: waterLevelMax.date,
    },
    waterLevelMin: {
      value: round(waterLevelMin.value, 2),
      time: waterLevelMin.time,
      date: waterLevelMin.date,
    },

    inflowAvg: round(avg(inflowValues), 2),
    inflowMax: {
      value: round(inflowMax.value, 2),
      time: inflowMax.time,
      date: inflowMax.date,
    },

    totalOutflowAvg: round(avg(totalOutflowValues), 2),
    totalOutflowMax: {
      value: round(totalOutflowMax.value, 2),
      time: totalOutflowMax.time,
      date: totalOutflowMax.date,
    },

    turbineFlowAvg: round(avg(turbineFlowValues), 2),
    spillwayFlowAvg: round(avg(spillwayFlowValues), 2),

    rainfallTotal: round(sum(rainfallValues), 2),
    rainyDays: rows.filter(r => {
      const rain = pickNumber(r, [
        "rainfall_total",
        "rainfall",
        "rainfallreal",
        "rain_total",
      ]);
      return rain !== null && rain > 0;
    }).length,

    rainMaxDay: {
      date: rainMax.date,
      value: round(rainMax.value, 2),
    },

    comment:
      totalDays === 0
        ? "Chưa có dữ liệu QT1865 trong kỳ."
        : `Tỷ lệ đảm bảo QT1865 đạt ${
            totalDays
              ? Number(((compliantDays / totalDays) * 100).toFixed(1))
              : 0
          }%, số ngày không đảm bảo ${nonCompliantDays}, số ngày cảnh báo ${warningDays}.`,
  };

  // Alias snake_case để tương thích với frontend cũ hoặc Excel cũ nếu có.
  summary.total_days = summary.totalDays;
  summary.compliant_days = summary.compliantDays;
  summary.non_compliant_days = summary.nonCompliantDays;
  summary.warning_days = summary.warningDays;
  summary.compliance_rate = summary.complianceRate;
  summary.turbine_12h_compliant_days = summary.turbine12hCompliantDays;
  summary.turbine_12h_non_compliant_days = summary.turbine12hNonCompliantDays;
  summary.turbine_12h_rate = summary.turbine12hRate;

  return summary;
}

function buildMonthlyQt1865Summary(rows, year) {
  const result = [];

  for (let m = 1; m <= 12; m++) {
    const monthRows = (rows || []).filter(r => monthOfDate(r.date) === m);
    const s = summarizeQt1865Rows(monthRows);

    result.push({
      year: Number(year),
      month: m,

      totalDays: s.totalDays,
      compliantDays: s.compliantDays,
      nonCompliantDays: s.nonCompliantDays,
      warningDays: s.warningDays,
      complianceRate: s.complianceRate,

      turbine12hCompliantDays: s.turbine12hCompliantDays,
      turbine12hNonCompliantDays: s.turbine12hNonCompliantDays,
      turbine12hRate: s.turbine12hRate,

      total_days: s.totalDays,
      compliant_days: s.compliantDays,
      non_compliant_days: s.nonCompliantDays,
      warning_days: s.warningDays,
      compliance_rate: s.complianceRate,
    });
  }

  return result;
}

async function fetchInflowFrequency(month, inflowAvg) {
  const q = num(inflowAvg);

  if (!SUPABASE_URL || !SUPABASE_KEY || !month || q === null) {
    return null;
  }

  try {
    const rows = await fetchSupabasePaged("monthly_inflow_frequency", params => {
      params.set("select", "frequency_percent,month,inflow_value");
      params.set("month", `eq.${month}`);
      params.set("order", "frequency_percent.asc");
    });

    if (!rows.length) return null;

    let nearest = rows[0];

    for (const row of rows) {
      const d1 = Math.abs(Number(row.inflow_value) - q);
      const d2 = Math.abs(Number(nearest.inflow_value) - q);

      if (d1 < d2) nearest = row;
    }

    const frequencyPercent = Number(nearest.frequency_percent);
    const frequencyLabel = formatPercentLabel(frequencyPercent);
    const inflowFrequencyValue = round(nearest.inflow_value, 2);
    const classification = classifyInflowFrequency(frequencyPercent);

    return {
      month,
      inflowAvg: round(q, 2),
      frequencyPercent,
      frequencyLabel,
      inflowFrequencyValue,
      classification,
      nearest,
      rows,
      comment: `Q về trung bình tháng ${month} là ${round(
        q,
        2
      )} m3/s, gần với tần suất P=${frequencyLabel}, tương ứng Q=${inflowFrequencyValue} m3/s.`,
    };
  } catch (_) {
    return null;
  }
}

async function handleQt1865Compliance(req, res) {
  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());

    const hasMonth =
      req.query.month !== undefined &&
      req.query.month !== null &&
      String(req.query.month).trim() !== "";

    const month = hasMonth ? Number(req.query.month) : null;

    if (!year || (hasMonth && (!month || month < 1 || month > 12))) {
      return json(res, 400, {
        ok: false,
        mode: "qt1865",
        error: "Invalid year/month",
      });
    }

    const range = hasMonth
      ? monthRangeDate(year, month)
      : yearRangeDate(year);

    const rows = await fetchQt1865Rows(range.start, range.end);

    const summary = summarizeQt1865Rows(rows);
    const summaryByReason = summarizeReasonsQt1865(rows);
    const monthlySummary = buildMonthlyQt1865Summary(rows, year);

    let inflowFrequency = null;

    if (hasMonth) {
      inflowFrequency = await fetchInflowFrequency(
        month,
        summary.inflowAvg
      );

      if (inflowFrequency) {
        summary.inflowFrequency = inflowFrequency;
      }
    }

    return json(res, 200, {
      ok: true,
      mode: "qt1865",
      source: "supabase",

      year,
      month: hasMonth ? month : null,

      period: {
        start: range.start,
        end: range.end,
      },

      // Schema QT1865 cũ
      summary,
      rows,
      summaryByReason,
      monthlySummary,

      // Field phụ để không làm hỏng code cũ nếu có kiểm tra
      inflowFrequency,
      frequencyTable: inflowFrequency?.rows || [],
      count: rows.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "qt1865",
      error: err.message,
    });
  }
}

/* =========================================================
   MONTHLY REPORT MODE
   /api/qt1865-compliance?mode=monthly-report&year=2026&month=6
   ========================================================= */

async function fetchAllHourly(startIso, endIso) {
  return fetchSupabasePaged("reservoir_hourly_data", params => {
    params.set(
      "select",
      "time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal"
    );
    params.append("time", `gte.${startIso}`);
    params.append("time", `lt.${endIso}`);
    params.set("order", "time.asc");
  });
}

async function fetchLevelLimits(year) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  try {
    return await fetchSupabasePaged("reservoir_level_limits", params => {
      params.set("select", "date,mnghd,mnght,mndl,mntrl");
      params.append("date", `gte.${year}-01-01`);
      params.append("date", `lte.${year}-12-31`);
      params.set("order", "date.asc");
    });
  } catch (_) {
    return [];
  }
}

async function fetchQt1865Summary(year, month) {
  try {
    const { start, end } = monthRangeDate(year, month);
    const rows = await fetchQt1865Rows(start, end);
    const summary = summarizeQt1865Rows(rows);
    const reasons = summarizeReasonsQt1865(rows).map(r => ({
      reason: r.reason,
      days: r.days,
    }));

    return {
      totalDays: summary.totalDays,
      compliantDays: summary.compliantDays,
      nonCompliantDays: summary.nonCompliantDays,
      warningDays: summary.warningDays,
      complianceRate: summary.complianceRate,
      turbine12hCompliantDays: summary.turbine12hCompliantDays,
      turbine12hNonCompliantDays: summary.turbine12hNonCompliantDays,
      turbine12hRate: summary.turbine12hRate,
      reasons,
    };
  } catch (_) {
    return null;
  }
}

function groupDaily(rows) {
  const map = new Map();

  for (const r of rows) {
    const d = dateKey(r.time);

    if (!map.has(d)) {
      map.set(d, {
        date: d,
        waterLevels: [],
        inflows: [],
        turbineFlows: [],
        spillwayFlows: [],
        rainfallValues: [],
      });
    }

    const item = map.get(d);

    if (num(r.water_level) !== null) {
      item.waterLevels.push(num(r.water_level));
    }

    if (num(r.inflow) !== null) {
      item.inflows.push(num(r.inflow));
    }

    if (num(r.turbine_flow) !== null) {
      item.turbineFlows.push(num(r.turbine_flow));
    }

    if (num(r.spillway_flow) !== null) {
      item.spillwayFlows.push(num(r.spillway_flow));
    }

    if (num(r.rainfallreal) !== null) {
      item.rainfallValues.push(num(r.rainfallreal));
    }
  }

  return Array.from(map.values()).map(d => ({
    date: d.date,
    waterLevelAvg: round(avg(d.waterLevels), 2),
    waterLevelMax: round(
      d.waterLevels.length ? Math.max(...d.waterLevels) : null,
      2
    ),
    waterLevelMin: round(
      d.waterLevels.length ? Math.min(...d.waterLevels) : null,
      2
    ),
    inflowAvg: round(avg(d.inflows), 2),
    inflowMax: round(
      d.inflows.length ? Math.max(...d.inflows) : null,
      2
    ),
    turbineFlowAvg: round(avg(d.turbineFlows), 2),
    spillwayFlowAvg: round(avg(d.spillwayFlows), 2),
    rainfallTotal: round(sum(d.rainfallValues), 2),
  }));
}

function detectEvents(rows, daily, inflowFrequency = null) {
  const events = [];

  const inflowMax = findExtreme(rows, "inflow", "max");

  if (inflowMax.value !== null) {
    events.push({
      type: "inflow_max",
      level: inflowMax.value >= 500 ? "warning" : "info",
      time: inflowMax.time,
      title: "Lưu lượng về lớn nhất tháng",
      description: `Q về lớn nhất đạt ${round(inflowMax.value, 2)} m3/s.`,
    });
  }

  const wlMax = findExtreme(rows, "water_level", "max");

  if (wlMax.value !== null) {
    events.push({
      type: "water_level_max",
      level: "info",
      time: wlMax.time,
      title: "Mực nước hồ lớn nhất tháng",
      description: `MNH lớn nhất đạt ${round(wlMax.value, 2)} m.`,
    });
  }

  const rainMaxDay = daily.reduce((best, cur) => {
    if (!best) return cur;

    return (num(cur.rainfallTotal) || 0) >
      (num(best.rainfallTotal) || 0)
      ? cur
      : best;
  }, null);

  if (rainMaxDay && num(rainMaxDay.rainfallTotal) > 0) {
    events.push({
      type: "rain_max_day",
      level: rainMaxDay.rainfallTotal >= 50 ? "warning" : "info",
      time: rainMaxDay.date,
      title: "Ngày mưa lớn nhất tháng",
      description: `Lượng mưa ngày lớn nhất đạt ${round(
        rainMaxDay.rainfallTotal,
        2
      )} mm.`,
    });
  }

  const spillMax = findExtreme(rows, "spillway_flow", "max");

  if (spillMax.value && spillMax.value > 0) {
    events.push({
      type: "spillway_flow",
      level: "warning",
      time: spillMax.time,
      title: "Có ghi nhận xả tràn",
      description: `Q xả lớn nhất đạt ${round(
        spillMax.value,
        2
      )} m3/s.`,
    });
  }

  if (inflowFrequency) {
    events.push({
      type: "inflow_frequency",
      level: inflowFrequency.frequencyPercent >= 0.75 ? "warning" : "info",
      time: null,
      title: "Tần suất nước về tháng",
      description: `Q về trung bình tháng ${inflowFrequency.month} đạt ${inflowFrequency.inflowAvg} m3/s, gần tần suất P=${inflowFrequency.frequencyLabel}, thuộc ${inflowFrequency.classification.toLowerCase()}.`,
    });
  }

  return events;
}

function formatReasonSummary(qt1865Summary) {
  if (!qt1865Summary || !Array.isArray(qt1865Summary.reasons)) {
    return "- Chưa có dữ liệu nguyên nhân QT1865.";
  }

  if (!qt1865Summary.reasons.length) {
    return "- Không ghi nhận nguyên nhân không đảm bảo/cảnh báo nổi bật.";
  }

  return qt1865Summary.reasons
    .map(r => `- ${r.reason}: ${r.days} ngày`)
    .join("\n");
}

function makeAiPrompt(data) {
  const f = data.inflowFrequency;
  const q = data.qt1865Summary;

  const waterLevelChange = data.summary.waterLevelChange;
  const overallRating = classifyOverallRating(q?.complianceRate);

  return `
Bạn là **Chuyên gia vận hành hồ chứa thủy điện A Vương**, am hiểu thủy văn, điều tiết hồ chứa, vận hành phát điện và yêu cầu tuân thủ Quy trình liên hồ chứa 1865.

Nhiệm vụ của bạn là viết **nhận xét báo cáo tháng phục vụ lãnh đạo**, không chỉ mô tả số liệu mà phải:
- Đánh giá trạng thái hồ chứa.
- Phân tích xu thế nguồn nước.
- Nhận diện rủi ro vận hành.
- Đánh giá mức độ tuân thủ QT1865.
- Đưa ra kiến nghị cụ thể, có thể hành động.

Văn phong:
- Kỹ thuật, rõ ràng, ngắn gọn.
- Giống văn phong báo cáo nội bộ ngành điện/thủy điện.
- Không viết chung chung.
- Không phóng đại, không suy diễn vượt dữ liệu.
- Nếu dữ liệu chưa đủ để kết luận, ghi rõ là “cần tiếp tục theo dõi”.

Dữ liệu tháng ${data.month}/${data.year}:

I. Dữ liệu mực nước hồ
- Mực nước hồ lớn nhất: ${data.summary.waterLevelMax?.value ?? "-"} m lúc ${data.summary.waterLevelMax?.time ?? "-"}
- Mực nước hồ nhỏ nhất: ${data.summary.waterLevelMin?.value ?? "-"} m lúc ${data.summary.waterLevelMin?.time ?? "-"}
- Mực nước đầu kỳ: ${data.summary.waterLevelStart ?? "-"} m
- Mực nước cuối kỳ: ${data.summary.waterLevelEnd ?? "-"} m
- Biến đổi mực nước trong kỳ: ${waterLevelChange ?? "-"} m

II. Dữ liệu dòng chảy và vận hành
- Q về trung bình: ${data.summary.inflowAvg ?? "-"} m³/s
- Q về lớn nhất: ${data.summary.inflowMax?.value ?? "-"} m³/s lúc ${data.summary.inflowMax?.time ?? "-"}
- Q chạy máy trung bình: ${data.summary.turbineFlowAvg ?? "-"} m³/s
- Q xả trung bình: ${data.summary.spillwayFlowAvg ?? "-"} m³/s

III. Dữ liệu mưa
- Tổng lượng mưa tháng: ${data.summary.rainfallTotal ?? "-"} mm
- Số ngày có mưa: ${data.summary.rainyDays ?? "-"} ngày
- Ngày mưa lớn nhất: ${data.summary.rainMaxDay?.date ?? "-"} với ${data.summary.rainMaxDay?.value ?? "-"} mm

IV. Đánh giá tần suất nước về
${f ? `- Q về trung bình tháng: ${f.inflowAvg} m³/s
- Gần với tần suất P=${f.frequencyLabel}
- Giá trị tra bảng tại tần suất gần nhất: ${f.inflowFrequencyValue} m³/s
- Phân loại thủy văn: ${f.classification}
- Nhận xét tần suất: ${f.comment}` : `- Chưa có dữ liệu tần suất nước về hoặc chưa tra được bảng tần suất.`}

V. Đánh giá tuân thủ QT1865
- Tổng số ngày có dữ liệu: ${q?.totalDays ?? "-"} ngày
- Số ngày đảm bảo quy trình: ${q?.compliantDays ?? "-"} ngày
- Số ngày không đảm bảo: ${q?.nonCompliantDays ?? "-"} ngày
- Số ngày cảnh báo Q cao hơn quy định nhưng vẫn tính đảm bảo: ${q?.warningDays ?? "-"} ngày
- Tỷ lệ đảm bảo quy trình: ${q?.complianceRate ?? "-"}%
- Số ngày đạt yêu cầu chạy máy liên tục tối thiểu 12 giờ: ${q?.turbine12hCompliantDays ?? "-"} ngày
- Số ngày không đạt yêu cầu chạy máy 12 giờ: ${q?.turbine12hNonCompliantDays ?? "-"} ngày
- Tỷ lệ đạt yêu cầu chạy máy 12 giờ: ${q?.turbine12hRate ?? "-"}%
- Các nguyên nhân không đảm bảo/cảnh báo chính:
${formatReasonSummary(q)}

Yêu cầu trả về đúng 6 mục sau:

1. Nhận xét chung
2. Thủy văn và dòng chảy
3. Đánh giá tần suất nước về hồ
4. Mưa trong tháng
5. Vận hành hồ chứa và tuân thủ QT1865
6. Kết luận và kiến nghị

Cuối báo cáo thêm dòng:
Đánh giá chung: ${overallRating}

Không dùng markdown bảng.
Không dùng gạch đầu dòng quá dài.
Không viết quá 900 từ.
`.trim();
}

async function handleMonthlyReport(req, res) {
  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, {
        ok: false,
        mode: "monthly-report",
        error: "Invalid year/month",
      });
    }

    const { startIso, endIso } = monthRangeUtc(year, month);

    const rows = await fetchAllHourly(startIso, endIso);
    const daily = groupDaily(rows);
    const limits = await fetchLevelLimits(year);

    const first = rows[0] || null;
    const last = rows[rows.length - 1] || null;

    const rainMaxDay = daily.reduce((best, cur) => {
      if (!best) return cur;

      return (num(cur.rainfallTotal) || 0) >
        (num(best.rainfallTotal) || 0)
        ? cur
        : best;
    }, null);

    const summary = {
      recordCount: rows.length,
      dayCount: daily.length,

      waterLevelStart: first ? round(first.water_level, 2) : null,
      waterLevelEnd: last ? round(last.water_level, 2) : null,

      waterLevelChange:
        first && last
          ? round(num(last.water_level) - num(first.water_level), 2)
          : null,

      waterLevelAvg: round(avg(rows.map(r => r.water_level)), 2),

      waterLevelMax: (() => {
        const x = findExtreme(rows, "water_level", "max");
        return {
          value: round(x.value, 2),
          time: x.time,
        };
      })(),

      waterLevelMin: (() => {
        const x = findExtreme(rows, "water_level", "min");
        return {
          value: round(x.value, 2),
          time: x.time,
        };
      })(),

      inflowAvg: round(avg(rows.map(r => r.inflow)), 2),

      inflowMax: (() => {
        const x = findExtreme(rows, "inflow", "max");
        return {
          value: round(x.value, 2),
          time: x.time,
        };
      })(),

      turbineFlowAvg: round(avg(rows.map(r => r.turbine_flow)), 2),

      spillwayFlowAvg: round(avg(rows.map(r => r.spillway_flow)), 2),

      rainfallTotal: round(sum(rows.map(r => r.rainfallreal)), 2),

      rainyDays: daily.filter(d => (num(d.rainfallTotal) || 0) > 0).length,

      rainMaxDay: rainMaxDay
        ? {
            date: rainMaxDay.date,
            value: round(rainMaxDay.rainfallTotal, 2),
          }
        : {
            date: null,
            value: null,
          },
    };

    const inflowFrequency = await fetchInflowFrequency(
      month,
      summary.inflowAvg
    );

    const qt1865Summary = await fetchQt1865Summary(year, month);

    const events = detectEvents(rows, daily, inflowFrequency);

    const result = {
      ok: true,
      mode: "monthly-report",
      source: "supabase",

      year,
      month,

      period: {
        start: startIso,
        endExclusive: endIso,
      },

      summary,
      inflowFrequency,
      qt1865Summary,
      daily,

      chartData: daily.map(d => ({
        date: d.date,
        waterLevelAvg: d.waterLevelAvg,
        inflowAvg: d.inflowAvg,
        turbineFlowAvg: d.turbineFlowAvg,
        spillwayFlowAvg: d.spillwayFlowAvg,
        rainfallTotal: d.rainfallTotal,
      })),

      levelLimits: limits,
      events,

      aiPrompt: makeAiPrompt({
        year,
        month,
        summary,
        inflowFrequency,
        qt1865Summary,
      }),
    };

    return json(res, 200, result);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "monthly-report",
      error: err.message,
    });
  }
}

/* =========================================================
   PCTT ĐÀ NẴNG HYDRO MODE
   /api/qt1865-compliance?mode=pctt-hydro
   ========================================================= */

function getVietnamMonthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const ym = `${y}-${String(m).padStart(2, "0")}`;

  const endDate = new Date(y, m, 0);
  const endDay = String(endDate.getDate()).padStart(2, "0");

  return {
    start: `${ym}-01T00:00:00+07:00`,
    end: `${ym}-${endDay}T23:59:59+07:00`,
  };
}

async function handlePcttHydro(req, res) {
  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, {
        ok: false,
        mode: "pctt-hydro",
        error: "Invalid year/month",
      });
    }

    const vnRange = getVietnamMonthRange(year, month);

    const start = req.query.start || vnRange.start;
    const end = req.query.end || vnRange.end;
    const ids = String(req.query.ids || "1,2,3,4");

    const url =
      "https://pctt.danang.gov.vn/DesktopModules/PCTT/api/PCTTApi/baocaothuydiens_thongke" +
      `?ngaybatdau=${encodeURIComponent(start)}` +
      `&ngayketthuc=${encodeURIComponent(end)}` +
      `&lst_thuydien_id=${encodeURIComponent(ids)}`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/xml,text/xml,*/*",
        "User-Agent": "av-monitor-reservoir/1.0",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      return json(res, response.status, {
        ok: false,
        mode: "pctt-hydro",
        source: "pctt.danang.gov.vn",
        error: `PCTT API HTTP ${response.status}`,
        detail: text.slice(0, 1000),
        url,
      });
    }

    const rowsRaw = parsePcttXml(text)
      .map(normalizePcttRow)
      .filter(r => r.time);

    const rows = dedupePcttRowsByTime(rowsRaw);
    const latest = rows[0] || null;

    return json(res, 200, {
      ok: true,
      mode: "pctt-hydro",
      source: "pctt.danang.gov.vn",

      year,
      month,
      ids,

      period: {
        start,
        endInclusive: end,
      },

      countRaw: rowsRaw.length,
      count: rows.length,
      duplicateCount: rowsRaw.length - rows.length,

      latest,
      data: rows,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "pctt-hydro",
      error: err.message,
    });
  }
}

function parsePcttXml(xml) {
  const tables = String(xml || "").match(/<Table[\s\S]*?<\/Table>/g) || [];

  return tables.map(block => {
    const row = {};
    const re = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let match;

    while ((match = re.exec(block)) !== null) {
      const key = match[1];
      const raw = decodePcttXml(match[2] || "").trim();

      if (raw === "") {
        row[key] = null;
      } else if (
        key !== "thoigianxa" &&
        key !== "ngay" &&
        key !== "gio" &&
        Number.isFinite(Number(raw))
      ) {
        row[key] = Number(raw);
      } else {
        row[key] = raw;
      }
    }

    return row;
  });
}

function decodePcttXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function normalizePcttRow(row) {
  return {
    time: row.thoigianxa || null,
    date: row.ngay || null,
    hour: row.gio || null,

    reservoirs: [
      {
        id: 1,
        name: "Hồ thủy điện A Vương",
        shortName: "A Vương",
        waterLevel: numPctt(row.htl1),
        inflow: numPctt(row.qvao1),
        turbineFlow: numPctt(row.luuluongnhamay1),
        spillwayFlow: numPctt(row.qxaquacua1),
      },
      {
        id: 2,
        name: "Hồ thủy điện Đăk Mi 4",
        shortName: "Đăk Mi 4",
        waterLevel: numPctt(row.htl2),
        inflow: numPctt(row.qvao2),
        turbineFlow: numPctt(row.luuluongnhamay2),
        spillwayFlow: numPctt(row.qxaquacua2),
      },
      {
        id: 3,
        name: "Hồ thủy điện Sông Bung 4",
        shortName: "Sông Bung 4",
        waterLevel: numPctt(row.htl3),
        inflow: numPctt(row.qvao3),
        turbineFlow: numPctt(row.luuluongnhamay3),
        spillwayFlow: numPctt(row.qxaquacua3),
      },
      {
        id: 4,
        name: "Hồ thủy điện Sông Tranh 2",
        shortName: "Sông Tranh 2",
        waterLevel: numPctt(row.htl4),
        inflow: numPctt(row.qvao4),
        turbineFlow: numPctt(row.luuluongnhamay4),
        spillwayFlow: numPctt(row.qxaquacua4),
      },
    ],

    basin: {
      qVeVuGia: numPctt(row.qvevugia),
      qVeThuBon: numPctt(row.qvethubon),
    },

    raw: row,
  };
}

function numPctt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dedupePcttRowsByTime(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = row.time;

    if (!map.has(key)) {
      map.set(key, row);
      continue;
    }

    const oldRow = map.get(key);

    if (scorePcttRow(row) > scorePcttRow(oldRow)) {
      map.set(key, row);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });
}

function scorePcttRow(row) {
  let score = 0;

  for (const r of row.reservoirs || []) {
    if (r.waterLevel !== null) score++;
    if (r.inflow !== null) score++;
    if (r.turbineFlow !== null) score++;
    if (r.spillwayFlow !== null) score++;
  }

  if (row.basin?.qVeVuGia !== null) score++;
  if (row.basin?.qVeThuBon !== null) score++;

  return score;
}

/* =========================================================
   MAIN HANDLER
   ========================================================= */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "GET") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed",
    });
  }

  const mode = String(req.query.mode || "qt1865").trim();

  if (mode === "pctt-hydro") {
    return handlePcttHydro(req, res);
  }

  if (mode === "monthly-report") {
    return handleMonthlyReport(req, res);
  }

  // Mặc định trả schema API QT1865 cũ.
  return handleQt1865Compliance(req, res);
}
