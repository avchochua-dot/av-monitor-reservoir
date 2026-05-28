const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

function json(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

export default async function handler(req, res) {
  try {
    const month = Number(req.query.month);
    const inflow = Number(req.query.inflow);

    if (!month || Number.isNaN(inflow)) {
      return json(res, 400, {
        ok: false,
        error: "Missing month or inflow",
        query: req.query,
      });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return json(res, 500, {
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE key",
      });
    }

    const url = new URL(`${SUPABASE_URL}/rest/v1/monthly_inflow_frequency`);
    url.searchParams.set("select", "id,frequency_percent,month,inflow_value");
    url.searchParams.set("month", `eq.${month}`);
    url.searchParams.set("order", "frequency_percent.asc");

    const response = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const text = await response.text();

    let rows;
    try {
      rows = text ? JSON.parse(text) : [];
    } catch {
      rows = [];
    }

    if (!response.ok) {
      return json(res, response.status, {
        ok: false,
        error: rows || text,
        url: url.toString(),
      });
    }

    if (!rows.length) {
      return json(res, 404, {
        ok: false,
        error: "No frequency data found",
        month,
        inflow,
        hint: "Kiểm tra RLS policy hoặc SUPABASE_URL trên Vercel có đúng project đã import dữ liệu không.",
      });
    }

    let nearest = rows[0];

    for (const row of rows) {
      const d1 = Math.abs(Number(row.inflow_value) - inflow);
      const d2 = Math.abs(Number(nearest.inflow_value) - inflow);
      if (d1 < d2) nearest = row;
    }

    return json(res, 200, {
      ok: true,
      month,
      inflow,
      nearest,
      rows,
      comment: `Q về trung bình tháng ${month} là ${inflow} m³/s, gần với tần suất P=${nearest.frequency_percent} có Q=${nearest.inflow_value} m³/s.`,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message,
    });
  }
}
