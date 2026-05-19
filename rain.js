export default async function handler(req, res) {
  try {
    const endpoint = req.query.endpoint || 'summary';
    const allow = {
      summary: 'https://avuong.vrain.vn/api/private/v1/organizations/summary',
      stations: 'https://avuong.vrain.vn/api/private/v1/organizations/stations',
      forecastStations: 'https://avuong.vrain.vn/api/private/v1/weather/forecasts/stations'
    };

    const url = allow[endpoint] || allow.summary;

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'A-Vuong-Dashboard/1.0'
    };

    // Neu Vrain yeu cau xac thuc, cau hinh trong Vercel Project Settings > Environment Variables:
    // VRAIN_TOKEN = Bearer token
    // VRAIN_COOKIE = Cookie tu request hop le
    if (process.env.VRAIN_TOKEN) headers.Authorization = `Bearer ${process.env.VRAIN_TOKEN}`;
    if (process.env.VRAIN_COOKIE) headers.Cookie = process.env.VRAIN_COOKIE;

    const upstream = await fetch(url, { headers });
    const text = await upstream.text();

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(204).end();

    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Vrain API error ${upstream.status}`,
        data
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown error' });
  }
}
