export default async function handler(req, res) {
  const API_KEY = process.env.IT_RAIN_API_KEY;
  const BASE_URL = "http://14.241.121.249:89/api/QuanTracRain";

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Missing IT_RAIN_API_KEY env"
    });
  }

  const mode = req.query.auth || "x-api-key";

  const url = new URL(BASE_URL);

  // Chuyển tiếp tham số test nếu có
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== "auth") url.searchParams.set(k, v);
  }

  const headers = {
    Accept: "application/json"
  };

  if (mode === "x-api-key") {
    headers["x-api-key"] = API_KEY;
  }

  if (mode === "bearer") {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  if (mode === "key") {
    url.searchParams.set("key", API_KEY);
  }

  if (mode === "api_key") {
    url.searchParams.set("api_key", API_KEY);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const started = Date.now();

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal
    });

    clearTimeout(timeout);

    const text = await response.text();

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return res.status(response.status).json({
      ok: response.ok,
      mode,
      status: response.status,
      statusText: response.statusText,
      elapsed_ms: Date.now() - started,
      source_url: BASE_URL,
      data: body
    });
  } catch (err) {
    clearTimeout(timeout);

    return res.status(500).json({
      ok: false,
      mode,
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
