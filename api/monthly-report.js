/**
 * Vercel API: /api/monthly-report?year=2026&month=5
 *
 * ENV required in Vercel:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 *
 * Main table:
 * - public.reservoir_hourly_data
 *   time, water_level, inflow, turbine_flow, spillway_flow, rainfallreal
 *
 * Optional table:
 * - public.reservoir_level_limits
 *   date, mnghd, mnght, mndl, mntrl
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 2) {
  const n = num(v);
  if (n === null) return null;
  return Number(n.toFixed(d));
}

function sum(values) {
  return values.reduce((s, v) => s + (num(v) || 0), 0);
}

function avg(values) {
  const arr = values.map(num).filter(v => v !== null);
  if (!arr.length) return null;
  return sum(arr) / arr.length;
}

function findExtreme(rows, key, type = "max") {
  const valid = rows
    .map(r => ({ time: r.time, value: num(r[key]) }))
    .filter(x => x.value !== null);

  if (!valid.length) return { value: null, time: null };

  return valid.reduce((best, cur) => {
    if (type === "min") return cur.value < best.value ? cur : best;
    return cur.value > best.value ? cur : best;
  }, valid[0]);
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

function dateKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
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

    if (num(r.water_level) !== null) item.waterLevels.push(num(r.water_level));
    if (num(r.inflow) !== null) item.inflows.push(num(r.inflow));
    if (num(r.turbine_flow) !== null) item.turbineFlows.push(num(r.turbine_flow));
    if (num(r.spillway_flow) !== null) item.spillwayFlows.push(num(r.spillway_flow));
    if (num(r.rainfallreal) !== null) item.rainfallValues.push(num(r.rainfallreal));
  }

  return Array.from(map.values()).map(d => ({
    date: d.date,
    waterLevelAvg: round(avg(d.waterLevels), 2),
    waterLevelMax: round(d.waterLevels.length ? Math.max(...d.waterLevels) : null, 2),
    waterLevelMin: round(d.waterLevels.length ? Math.min(...d.waterLevels) : null, 2),
    inflowAvg: round(avg(d.inflows), 2),
    inflowMax: round(d.inflows.length ? Math.max(...d.inflows) : null, 2),
    turbineFlowAvg: round(avg(d.turbineFlows), 2),
    spillwayFlowAvg: round(avg(d.spillwayFlows), 2),
    rainfallTotal: round(sum(d.rainfallValues), 2),
  }));
}

function detectEvents(rows, daily) {
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
    return (num(cur.rainfallTotal) || 0) > (num(best.rainfallTotal) || 0)
      ? cur
      : best;
  }, null);

  if (rainMaxDay && num(rainMaxDay.rainfallTotal) > 0) {
    events.push({
      type: "rain_max_day",
      level: rainMaxDay.rainfallTotal >= 50 ? "warning" : "info",
      time: rainMaxDay.date,
      title: "Ngày mưa lớn nhất tháng",
      description: `Lượng mưa ngày lớn nhất đạt ${round(rainMaxDay.rainfallTotal, 2)} mm.`,
    });
  }

  const spillMax = findExtreme(rows, "spillway_flow", "max");

  if (spillMax.value && spillMax.value > 0) {
    events.push({
      type: "spillway_flow",
      level: "warning",
      time: spillMax.time,
      title: "Có ghi nhận xả tràn",
      description: `Q xả lớn nhất đạt ${round(spillMax.value, 2)} m3/s.`,
    });
  }

  return events;
}

function makeAiPrompt(data) {
  return `
Bạn là trợ lý AI phân tích vận hành hồ chứa thủy điện A Vương.
Hãy viết nhận xét báo cáo tháng bằng văn phong kỹ thuật, ngắn gọn, rõ ràng.

Dữ liệu tháng ${data.month}/${data.year}:
- Mực nước hồ lớn nhất: ${data.summary.waterLevelMax?.value ?? "-"} m lúc ${data.summary.waterLevelMax?.time ?? "-"}
- Mực nước hồ nhỏ nhất: ${data.summary.waterLevelMin?.value ?? "-"} m lúc ${data.summary.waterLevelMin?.time ?? "-"}
- Mực nước đầu kỳ: ${data.summary.waterLevelStart ?? "-"} m
- Mực nước cuối kỳ: ${data.summary.waterLevelEnd ?? "-"} m
- Q về trung bình: ${data.summary.inflowAvg ?? "-"} m3/s
- Q về lớn nhất: ${data.summary.inflowMax?.value ?? "-"} m3/s lúc ${data.summary.inflowMax?.time ?? "-"}
- Q chạy máy trung bình: ${data.summary.turbineFlowAvg ?? "-"} m3/s
- Q xả trung bình: ${data.summary.spillwayFlowAvg ?? "-"} m3/s
- Tổng lượng mưa tháng: ${data.summary.rainfallTotal ?? "-"} mm
- Số ngày có mưa: ${data.summary.rainyDays ?? "-"} ngày
- Ngày mưa lớn nhất: ${data.summary.rainMaxDay?.date ?? "-"} với ${data.summary.rainMaxDay?.value ?? "-"} mm

Yêu cầu trả về:
1. Nhận xét chung
2. Thủy văn và dòng chảy
3. Mưa trong tháng
4. Vận hành hồ chứa
5. Kết luận và kiến nghị
`.trim();
}

async function fetchAllHourly(startIso, endIso) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const pageSize = 1000;
  let offset = 0;
  let all = [];

  while (true) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/reservoir_hourly_data`);

    url.searchParams.set(
      "select",
      "time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal"
    );

    url.searchParams.append("time", `gte.${startIso}`);
    url.searchParams.append("time", `lt.${endIso}`);

    url.searchParams.set("order", "time.asc");
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
      throw new Error(`Supabase ${response.status}: ${text}`);
    }

    const rows = text ? JSON.parse(text) : [];

    all = all.concat(rows);

    if (rows.length < pageSize) break;

    offset += pageSize;
  }

  return all;
}

async function fetchLevelLimits(year) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  try {
    const url = new URL(`${SUPABASE_URL}/rest/v1/reservoir_level_limits`);

    url.searchParams.set(
      "select",
      "date,mnghd,mnght,mndl,mntrl"
    );

    url.searchParams.append("date", `gte.${year}-01-01`);
    url.searchParams.append("date", `lte.${year}-12-31`);

    url.searchParams.set("order", "date.asc");
    url.searchParams.set("limit", "400");

    const response = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const text = await response.text();

    if (!response.ok) return [];

    return text ? JSON.parse(text) : [];
  } catch (_) {
    return [];
  }
}

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

  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, {
        ok: false,
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

      rainyDays: daily.filter(
        d => (num(d.rainfallTotal) || 0) > 0
      ).length,

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

    const result = {
      ok: true,
      source: "supabase",

      year,
      month,

      period: {
        start: startIso,
        endExclusive: endIso,
      },

      summary,

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

      events: detectEvents(rows, daily),

      aiPrompt: makeAiPrompt({
        year,
        month,
        summary,
      }),
    };

    return json(res, 200, result);

  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message,
    });
  }
}
