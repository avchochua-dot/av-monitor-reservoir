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

function getHourlyRain(row) {
  return Number(row?.rain?.["1h"] || row?.rain || 0);
}

function sumHours(hourly = [], hours = 24) {
  return hourly.slice(0, hours).reduce((sum, row) => {
    return sum + getHourlyRain(row);
  }, 0);
}

async function getStationForecast(station) {
  const key = process.env.OPENWEATHER_API_KEY;

  if (!key) {
    throw new Error("Missing OPENWEATHER_API_KEY");
  }

  const url =
    `https://api.openweathermap.org/data/3.0/onecall` +
    `?lat=${station.lat}` +
    `&lon=${station.lon}` +
    `&appid=${key}` +
    `&units=metric` +
    `&lang=vi` +
    `&exclude=minutely,current,alerts`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`OpenWeather ${res.status}: ${text}`);
  }

  const data = JSON.parse(text);
  const hourly = Array.isArray(data.hourly) ? data.hourly : [];

  const rain24h = keepSmallNumber(sumHours(hourly, 24));
  const rain48h = keepSmallNumber(sumHours(hourly, 48));

  // One Call hourly chỉ có 48h. 72h lấy thêm daily[0..2].rain nếu có.
  const daily = Array.isArray(data.daily) ? data.daily : [];
  const rain72hDaily = daily.slice(0, 3).reduce((s, d) => s + Number(d?.rain || 0), 0);
  const rain72h = keepSmallNumber(rain72hDaily || rain48h);

  return {
    code: station.code,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    source: "OpenWeather",
    rain24h,
    rain48h,
    rain72h,
    level24h: levelRain(rain24h),
    timezone: data.timezone || "",
    updatedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  try {
    const rows = [];

    for (const station of STATIONS) {
      rows.push(await getStationForecast(station));
      await new Promise((r) => setTimeout(r, 160));
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");

    res.status(200).json({
      ok: true,
      source: "openweather",
      stations: rows,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
