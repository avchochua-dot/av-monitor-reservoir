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

function sumHours(values = [], hours = 24) {
  return values.slice(0, hours).reduce((s, v) => s + Number(v || 0), 0);
}

async function getStationForecast(station) {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${station.lat}` +
    `&longitude=${station.lon}` +
    `&hourly=precipitation` +
    `&forecast_days=7` +
    `&timezone=Asia%2FHo_Chi_Minh`;

  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Open-Meteo ${res.status}: ${text}`);
  }

  const data = JSON.parse(text);
  const values = data?.hourly?.precipitation || [];
  const times = data?.hourly?.time || [];

  const rain24h = keepSmallNumber(sumHours(values, 24));
  const rain48h = keepSmallNumber(sumHours(values, 48));
  const rain72h = keepSmallNumber(sumHours(values, 72));

  return {
    code: station.code,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    source: "Open-Meteo",
    rain24h,
    rain48h,
    rain72h,
    level24h: levelRain(rain24h),
    startTime: times[0] || "",
    endTime: times[Math.min(71, times.length - 1)] || "",
    updatedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  try {
    const rows = [];

    for (const station of STATIONS) {
      rows.push(await getStationForecast(station));
      await new Promise((r) => setTimeout(r, 120));
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");

    res.status(200).json({
      ok: true,
      source: "open-meteo",
      stations: rows,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
