export default async function handler(req, res) {
  const API_KEY = process.env.IT_RAIN_API_KEY;
  const BASE_URL = "http://14.241.121.249:89/api/QuanTracRain";

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Missing IT_RAIN_API_KEY"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const started = Date.now();

    const r = await fetch(BASE_URL, {
      method: "GET",
      headers: {
        "X-API-KEY": API_KEY,
        "Accept": "application/json",
        "User-Agent": "VDV-DamSafety-Dashboard/1.0"
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    const text = await r.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return res.status(r.status).json({
      ok: r.ok,
      status: r.status,
      elapsed_ms: Date.now() - started,
      source_url: BASE_URL,
      data
    });
  } catch (err) {
    clearTimeout(timeout);

    return res.status(500).json({
      ok: false,
      source_url: BASE_URL,
      error_name: err.name,
      error_message: err.message,
      error_cause: err.cause
        ? {
            code: err.cause.code,
            errno: err.cause.errno,
            syscall: err.cause.syscall,
            address: err.cause.address,
            port: err.cause.port
          }
        : null
    });
  }
}
