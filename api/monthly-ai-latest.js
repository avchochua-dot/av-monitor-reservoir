const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  return res.status(status).json(data);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const year = Number(req.query.year);
    const month = Number(req.query.month);
    const reportType = String(req.query.reportType || "reservoir_operation");

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, { ok: false, error: "Invalid year/month" });
    }

    const url = new URL(`${SUPABASE_URL}/rest/v1/monthly_ai_reports`);
    url.searchParams.set("select", "*");
    url.searchParams.set("year", `eq.${year}`);
    url.searchParams.set("month", `eq.${month}`);
    url.searchParams.set("report_type", `eq.${reportType}`);
    url.searchParams.set("order", "created_at.desc");
    url.searchParams.set("limit", "1");

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

    const rows = text ? JSON.parse(text) : [];

    return json(res, 200, {
      ok: true,
      latest: rows[0] || null,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message,
    });
  }
}
