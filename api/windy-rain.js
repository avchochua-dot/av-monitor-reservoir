const WINDY_URL = "https://api.windy.com/api/point-forecast/v2";

const STATIONS = [
  { code: "NMAV", name: "NM A Vương", lat: 15.779525, lon: 107.682545 },
  { code: "MR01", name: "Đập tràn", lat: 15.799722, lon: 107.61667 },
  { code: "MR02", name: "Tr.Tiểu học & TH b.trú Dang", lat: 15.828689, lon: 107.559727 },
  { code: "MR03", name: "UBND xã Tây Giang", lat: 15.885485, lon: 107.49253 },
  { code: "MR04", name: "Đồn biên phòng A Nông", lat: 15.961613, lon: 107.46756 },
  { code: "MR05", name: "Kiểm lâm A Tép", lat: 15.995892, lon: 107.510803 },
  { code: "MR06", name: "UBND xã A Vương", lat: 15.928032, lon: 107.532143 },
  { code: "MR07", name: "Tr.Tiểu học b.trú A Vương", lat: 15.943821, lon: 107.566262 },
  { code: "MR08", name: "Tr.Tiểu học A Rooih", lat: 15.867412, lon: 107.61396 },
];


function levelRain(v) {
  const x = Number(v || 0);
  if (x <= 0) return "Không mưa";
  if (x < 10) return "Mưa nhỏ";
  if (x < 25) return "Mưa vừa";
  if (x < 50) return "Mưa to";
  return "Mưa rất to";
}

function keepSmallNumber(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(3));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function sumUntil(ts = [], values = [], hours = 24) {
  if (!Array.isArray(ts) || !Array.isArray(values) || !ts.length || !values.length) return 0;

  const first = Number(ts[0]);
  const limit = first + hours * 60 * 60 * 1000;

  return values.reduce((sum, v, i) => {
    const t = Number(ts[i]);
    if (Number.isFinite(t) && t <= limit) return sum + Number(v || 0);
    return sum;
  }, 0);
}

async function getPointRain(station, model = "gfs") {
  const key = process.env.WINDY_POINT_API_KEY;
  if (!key) throw new Error("Missing WINDY_POINT_API_KEY");

  const response = await fetch(WINDY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: station.lat,
      lon: station.lon,
      model,
      parameters: ["precip"],
      levels: ["surface"],
      key,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Windy API ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);

  const precip =
    data["precip-surface"] ||
    data["past3hprecip-surface"] ||
    data.precip ||
    [];

  const rain24h = keepSmallNumber(sumUntil(data.ts, precip, 24));
  const rain48h = keepSmallNumber(sumUntil(data.ts, precip, 48));
  const rain72h = keepSmallNumber(sumUntil(data.ts, precip, 72));

  return {
    code: station.code,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    model,
    source: "Windy",
    rain24h,
    rain48h,
    rain72h,
    level24h: levelRain(rain24h),
    updatedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  try {
    const model = String(req.query.model || "gfs").toLowerCase();

    const rows = [];
    for (const station of STATIONS) {
      rows.push(await getPointRain(station, model));
      await sleep(250);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");

    res.status(200).json({
      ok: true,
      source: "windy",
      model,
      stations: rows,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
