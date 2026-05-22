const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchAll(table, query, pageSize = 1000) {
  let from = 0;
  let rows = [];

  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;

    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
      },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(text);

    const batch = JSON.parse(text);
    rows = rows.concat(batch);

    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

function applyLimitYear(row, year) {
  const d = new Date(row.date);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return {
    ...row,
    date: `${year}-${month}-${day}`,
  };
}

export default async function handler(req, res) {
  try {
    const year = Number(req.query.year || new Date().getFullYear());

    const from = `${year}-01-01T00:00:00+00:00`;
    const to = `${year}-12-31T23:59:59+00:00`;

    const operationQuery =
      `select=time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal` +
      `&time=gte.${encodeURIComponent(from)}` +
      `&time=lte.${encodeURIComponent(to)}` +
      `&order=time.asc`;

    const limitQuery =
      `select=date,mnghd,mnght,mndl,mntrl` +
      `&order=date.asc`;

    const [operations, rawLimits] = await Promise.all([
      fetchAll("reservoir_hourly_data", operationQuery),
      fetchAll("reservoir_level_limits", limitQuery),
    ]);

    const limits = rawLimits.map(row => applyLimitYear(row, year));

    res.status(200).json({
      ok: true,
      year,
      operations,
      limits,
      counts: {
        operations: operations.length,
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
