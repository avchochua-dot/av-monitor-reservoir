const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function fetchSupabase(url) {
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return JSON.parse(text);
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

    const operationUrl =
      `${SUPABASE_URL}/rest/v1/reservoir_hourly_data` +
      `?select=time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal` +
      `&time=gte.${encodeURIComponent(from)}` +
      `&time=lte.${encodeURIComponent(to)}` +
      `&order=time.asc`;

    const limitUrl =
      `${SUPABASE_URL}/rest/v1/reservoir_level_limits` +
      `?select=date,mnghd,mnght,mndl,mntrl` +
      `&order=date.asc`;

    const [operations, rawLimits] = await Promise.all([
      fetchSupabase(operationUrl),
      fetchSupabase(limitUrl),
    ]);

    const limits = rawLimits.map(row => applyLimitYear(row, year));

    res.status(200).json({
      ok: true,
      year,
      operations,
      limits,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
