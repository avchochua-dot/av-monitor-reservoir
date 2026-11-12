const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, options = {}) {
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

export default async function handler(req, res) {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing Supabase environment variables");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ""))
      ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    const year = Number(date.slice(0, 4));
    const [limits, thresholds, orders] = await Promise.all([
      sb(`/rest/v1/rpc/av_operation_level_limits`, { method: "POST", body: JSON.stringify({ p_year: year }) }),
      sb(`/rest/v1/av_qt2138_downstream_thresholds?select=*&order=station_code.asc`),
      sb(`/rest/v1/av_dispatch_orders?select=*&valid_from=lte.${encodeURIComponent(date + "T23:59:59+07:00")}&or=(valid_to.is.null,valid_to.gte.${encodeURIComponent(date + "T00:00:00+07:00")})&order=issued_at.desc&limit=1`),
    ]);
    const today = (limits || []).find(row => row.date === date) || null;
    const activeOrder = orders?.[0] || null;
    res.status(200).json({
      ok: true, date, procedureCode: today?.procedure_code || (date >= "2026-11-06" ? "QT2138" : "QT1865"),
      levelRule: today, downstreamThresholds: thresholds || [], activeOrder,
      warning: date >= "2026-11-06" && !activeOrder
        ? "Chua co lenh dieu hanh dang hieu luc; khong tu dong ket luan cat, giam lu chi tu gioi han tren Bang 3."
        : null,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}
