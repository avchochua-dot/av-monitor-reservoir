/**
 * Vercel API:
 * /api/qt1865-compliance?year=2026
 * /api/qt1865-compliance?year=2026&month=5
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
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

function monthRange(year, month) {
  if (month) {
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const endDate = new Date(Number(year), Number(month), 0);
    const end = `${year}-${String(month).padStart(2, "0")}-${String(
      endDate.getDate()
    ).padStart(2, "0")}`;
    return { start, end };
  }

  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
  };
}

function buildReasonSummary(rows) {
  const map = new Map();

  for (const r of rows) {
    const reason = r.reason || "Không xác định";
    if (!map.has(reason)) {
      map.set(reason, {
        reason,
        count: 0,
      });
    }
    map.get(reason).count += 1;
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function buildMonthSummary(rows) {
  const map = new Map();

  for (const r of rows) {
    const month = String(r.date || "").slice(0, 7);

    if (!map.has(month)) {
      map.set(month, {
        month,
        totalDays: 0,
        compliantDays: 0,
        nonCompliantDays: 0,
      });
    }

    const item = map.get(month);
    item.totalDays += 1;

    if (r.is_compliant) {
      item.compliantDays += 1;
    } else {
      item.nonCompliantDays += 1;
    }
  }

  return Array.from(map.values()).map(m => ({
    ...m,
    complianceRate: m.totalDays
      ? round((m.compliantDays / m.totalDays) * 100, 1)
      : null,
  }));
}

async function fetchComplianceRows(start, end) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE key");
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/reservoir_release_compliance_1865`);

  url.searchParams.set(
    "select",
    [
      "date",
      "mnh_min",
      "mnh_max",
      "q_min",
      "q_max",
      "note",
      "water_level_avg",
      "water_level_max",
      "water_level_min",
      "inflow_avg",
      "turbine_flow_avg",
      "spillway_flow_avg",
      "total_outflow_avg",
      "total_outflow_min",
      "total_outflow_max",
      "record_count",
      "diff_mnh_min",
      "diff_mnh_max",
      "diff_q_min",
      "diff_q_max",
      "mnh_status",
      "flow_status",
      "is_compliant",
      "reason"
    ].join(",")
  );

  url.searchParams.append("date", `gte.${start}`);
  url.searchParams.append("date", `lte.${end}`);
  url.searchParams.set("order", "date.asc");
  url.searchParams.set("limit", "1000");

  const response = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : [];
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
    const year = Number(req.query.year || new Date().getFullYear());
    const month = req.query.month ? Number(req.query.month) : null;

    if (!year || year < 2000 || year > 2100) {
      return json(res, 400, {
        ok: false,
        error: "Invalid year",
      });
    }

    if (month !== null && (month < 1 || month > 12)) {
      return json(res, 400, {
        ok: false,
        error: "Invalid month",
      });
    }

    const { start, end } = monthRange(year, month);
    const rows = await fetchComplianceRows(start, end);

    const totalDays = rows.length;
    const compliantDays = rows.filter(r => r.is_compliant).length;
    const nonCompliantDays = totalDays - compliantDays;

    const complianceRate = totalDays
      ? round((compliantDays / totalDays) * 100, 1)
      : null;

    const nonCompliantRows = rows.filter(r => !r.is_compliant);

    return json(res, 200, {
      ok: true,
      source: "supabase",
      year,
      month,
      period: {
        start,
        end,
      },

      summary: {
        totalDays,
        compliantDays,
        nonCompliantDays,
        complianceRate,
      },

      summaryByReason: buildReasonSummary(nonCompliantRows),
      monthlySummary: buildMonthSummary(rows),

      rows,
      nonCompliantRows,

      comment:
        totalDays === 0
          ? "Chưa có dữ liệu đánh giá tuân thủ QT1865 trong kỳ."
          : `Trong kỳ có ${compliantDays}/${totalDays} ngày đảm bảo QT1865, đạt tỷ lệ ${complianceRate}%. Có ${nonCompliantDays} ngày không đảm bảo.`,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message,
    });
  }
}
