export default async function handler(req, res) {
  try {
    const API_KEY = process.env.IT_RAIN_API_KEY;
    const BASE_URL = "http://14.241.121.249:89/api/QuanTracRain";

    if (!API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing IT_RAIN_API_KEY env"
      });
    }

    const url = new URL(BASE_URL);

    // Cho phép truyền thời gian nếu API IT có hỗ trợ
    const { from, to, station } = req.query;

    if (from) url.searchParams.set("from", from);
    if (to) url.searchParams.set("to", to);
    if (station) url.searchParams.set("station", station);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-api-key": API_KEY,
        "Accept": "application/json"
      }
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        status: response.status,
        source: "IT QuanTracRain",
        error: data
      });
    }

    return res.status(200).json({
      ok: true,
      source: "IT QuanTracRain",
      data
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
