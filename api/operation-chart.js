const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchAll(table, query, pageSize = 1000) {
  let from = 0;
  let all = [];

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;

    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
        Prefer: "count=exact",
      },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`${table}: ${text}`);

    const rows = JSON.parse(text);
    all = all.concat(rows);

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

async function fetchProcedureLimits(year) {
  const url = `${SUPABASE_URL}/rest/v1/rpc/av_operation_level_limits`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_year: year }),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function fetchJsonPath(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase ${response.status}`);
  return text ? JSON.parse(text) : null;
}

async function handleRulesMode(req, res) {
  const requested = String(req.query.date || "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested)
    ? requested
    : new Date().toISOString().slice(0, 10);
  const year = Number(date.slice(0, 4));
  const [limits, thresholds, orders] = await Promise.all([
    fetchProcedureLimits(year),
    fetchJsonPath("/rest/v1/av_qt2138_downstream_thresholds?select=*&order=station_code.asc"),
    fetchJsonPath(`/rest/v1/av_dispatch_orders?select=*&valid_from=lte.${encodeURIComponent(date + "T23:59:59+07:00")}&or=(valid_to.is.null,valid_to.gte.${encodeURIComponent(date + "T00:00:00+07:00")})&order=issued_at.desc&limit=1`),
  ]);
  const levelRule = (limits || []).find(row => row.date === date) || null;
  const activeOrder = orders?.[0] || null;
  return res.status(200).json({
    ok: true,
    mode: "rules",
    date,
    procedureCode: levelRule?.procedure_code || (date >= "2026-11-06" ? "QT2138" : "QT1865"),
    levelRule,
    downstreamThresholds: thresholds || [],
    activeOrder,
    warning: date >= "2026-11-06" && !activeOrder
      ? "Chua co lenh dieu hanh dang hieu luc; khong tu dong ket luan cat, giam lu chi tu gioi han tren Bang 3."
      : null,
  });
}

function applyLimitYear(row, year) {
  const s = String(row.date).slice(0, 10);
  const [, month, day] = s.split("-");

  return {
    ...row,
    date: `${year}-${month}-${day}`,
  };
}

export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing Supabase environment variables");
    }
    if (String(req.query.mode || "").toLowerCase() === "rules") {
      return await handleRulesMode(req, res);
    }
    const year = Number(req.query.year || new Date().getFullYear());

    const from = `${year}-01-01T00:00:00+00:00`;
    const to = `${year}-12-31T23:59:59+00:00`;

    const operationQuery =
      `select=time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal` +
      `&time=gte.${encodeURIComponent(from)}` +
      `&time=lte.${encodeURIComponent(to)}` +
      `&order=time.asc`;

    // NỀN CHUNG: KHÔNG lọc year
    const limitQuery =
      `select=date,mnghd,mnght,mndl,mntrl` +
      `&order=date.asc`;

    const operations = await fetchAll("reservoir_hourly_data", operationQuery);
    let rawLimits;
    let limits;
    let rulesSource = "QT2138_VERSIONED";
    try {
      limits = await fetchProcedureLimits(year);
      rawLimits = limits;
    } catch (migrationError) {
      console.warn("QT2138 migration not available; using legacy limits", migrationError.message);
      rawLimits = await fetchAll("reservoir_level_limits", limitQuery);
      limits = rawLimits.map(row => applyLimitYear(row, year));
      rulesSource = "LEGACY_RESERVOIR_LEVEL_LIMITS";
    }

    res.status(200).json({
      ok: true,
      year,
      rulesSource,
      operations,
      limits,
      counts: {
        operations: operations.length,
        rawLimits: rawLimits.length,
        limits: limits.length,
      },
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
