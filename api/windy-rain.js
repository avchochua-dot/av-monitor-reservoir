const WINDY_URL = "https://api.windy.com/api/point-forecast/v2";

const STATIONS = [
  { code: "MR01", name: "Đập tràn", lat: 15.799722, lon: 107.61667 },
  { code: "MR02", name: "Tr.Tiểu học & TH b.trú Dang", lat: 15.828689, lon: 107.559727 },
  { code: "MR03", name: "UBND xã Tây Giang", lat: 15.885485, lon: 107.49253 },
  { code: "MR04", name: "Đồn biên phòng A Nông", lat: 15.961613, lon: 107.46756 },
  { code: "MR05", name: "Kiểm lâm A Tép", lat: 15.995892, lon: 107.510803 },
  { code: "MR06", name: "UBND xã A Vương", lat: 15.928032, lon: 107.532143 },
  { code: "MR07", name: "Tr.Tiểu học b.trú A Vương", lat: 15.943821, lon: 107.566262 },
  { code: "MR08", name: "Tr.Tiểu học A Rooih", lat: 15.867412, lon: 107.61396 },
];

const ALLOWED_MODELS = new Set(["gfs", "icon", "iconEu", "nam", "wavewatch"]);

function levelRain(v) {
  const x = Number(v || 0);
  if (x <= 0) return "Không mưa";
  if (x < 10) return "Mưa nhỏ";
  if (x < 25) return "Mưa vừa";
  if (x < 50) return "Mưa to";
  return "Mưa rất to";
}

function findPrecipArray(data) {
  const candidates = [
    "precip-surface",
    "past3hprecip-surface",
    "rain-surface",
    "convPrecip-surface",
    "snowPrecip-surface",
    "precip",
    "rain",
  ];

  for (const key of candidates) {
    if (Array.isArray(data?.[key])) {
      return { key, values: data[key] };
    }
  }

  const foundKey = Object.keys(data || {}).find(
    (k) => k.toLowerCase().includes("precip") && Array.isArray(data[k])
  );

  if (foundKey) {
    return { key: foundKey, values: data[foundKey] };
  }

  return { key: null, values: [] };
}

function sumForecast(ts = [], values = [], hours = 24) {
  if (!Array.isArray(ts) || !Array.isArray(values) || !ts.length || !values.length) {
    return 0;
  }

  const first = Number(ts[0]);
  const limit = first + hours * 60 * 60 * 1000;

  let sum = 0;

  for (let i = 0; i < ts.length && i < values.length; i++) {
    const t = Number(ts[i]);
    if (!Number.isFinite(t)) continue;
    if (t <= limit) {
      sum += Number(values[i] || 0);
    }
  }

  return sum;
}

function keepSmallNumber(v) {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(3));
}

async function getPointRain(station, model = "gfs", debug = false) {
  const key = process.env.WINDY_POINT_API_KEY;

  if (!key) {
    throw new Error("Missing WINDY_POINT_API_KEY");
  }

  const response = await fetch(WINDY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
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

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Windy API returned non-JSON: ${text.slice(0, 200)}`);
  }

  const ts = Array.isArray(data.ts) ? data.ts : [];
  const precip = findPrecipArray(data);

  const rain24hRaw = sumForecast(ts, precip.values, 24);
  const rain48hRaw = sumForecast(ts, precip.values, 48);
  const rain72hRaw = sumForecast(ts, precip.values, 72);

  const rain24h = keepSmallNumber(rain24hRaw);
  const rain48h = keepSmallNumber(rain48hRaw);
  const rain72h = keepSmallNumber(rain72hRaw);

  const result = {
    code: station.code,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    model,
    rain24h,
    rain48h,
    rain72h,
    level24h: levelRain(rain24h),
    updatedAt: new Date().toISOString(),
  };

  if (debug) {
    result.debug = {
      precipKey: precip.key,
      keys: Object.keys(data || {}),
      points: ts.length,
      firstTime: ts[0] ? new Date(Number(ts[0])).toISOString() : null,
      lastTime: ts.length ? new Date(Number(ts[ts.length - 1])).toISOString() : null,
      samplePrecip: precip.values.slice(0, 10),
      rawSums: {
        rain24hRaw,
        rain48hRaw,
        rain72hRaw,
      },
    };
  }

  return result;
}

export default async function handler(req, res) {
  try {
    let model = String(req.query.model || "gfs");

    if (!ALLOWED_MODELS.has(model)) {
      model = "gfs";
    }

    const debug = String(req.query.debug || "") === "1";

    const rows = [];

    for (const station of STATIONS) {
      rows.push(await getPointRain(station, model, debug));
      await new Promise((r) => setTimeout(r, 250));
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");

    res.status(200).json({
      ok: true,
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
