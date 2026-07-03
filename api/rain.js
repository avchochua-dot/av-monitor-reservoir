const VRAIN_API_BASE = "https://kttv-open.vrain.vn";
const WINDY_URL = "https://api.windy.com/api/point-forecast/v2";

const WINDY_STATIONS = [
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

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTimeVN(d) {
  const vn = new Date(d.getTime() + 7 * 60 * 60 * 1000);

  const y = vn.getUTCFullYear();
  const m = pad(vn.getUTCMonth() + 1);
  const day = pad(vn.getUTCDate());
  const h = pad(vn.getUTCHours());
  const min = pad(vn.getUTCMinutes());

  return `${y}-${m}-${day} ${h}:${min}:00`;
}

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

function jsonOk(res, payload, cache = "s-maxage=300, stale-while-revalidate=600") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", cache);
  return res.status(200).json(payload);
}

function jsonError(res, err, source = "rain") {
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(500).json({
    ok: false,
    source,
    error: err?.message || String(err),
  });
}

function getSourceFromRequest(req) {
  const q = String(req.query.source || req.query.mode || "").toLowerCase();

  if (q) return q;

  const url = String(req.url || "").toLowerCase();

  if (url.includes("/api/rain-30m")) return "vrain-30m";
  if (url.includes("/api/rain-avc")) return "avc";
  if (url.includes("/api/windy-rain")) return "windy";

  return "vrain-1h";
}

/* =========================
   VRAIN
========================= */

async function callVrain(path) {
  const apiKey = process.env.VRAIN_API_KEY;

  if (!apiKey) {
    throw new Error("Missing VRAIN_API_KEY");
  }

  const res = await fetch(`${VRAIN_API_BASE}${path}`, {
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Vrain API ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function fetchVrain1h() {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);

  const [stations, stats] = await Promise.all([
    callVrain("/v1/stations"),
    callVrain(
      `/v1/stations/stats?start_time=${encodeURIComponent(
        formatTimeVN(start)
      )}&end_time=${encodeURIComponent(formatTimeVN(end))}&format=10m`
    ),
  ]);

  const statRows = stats?.Data || stats?.data || [];

  return stations.map((s) => {
    const row = statRows.find(
      (x) =>
        x.station_id === s.code ||
        x.station_id === s.uuid ||
        x.station_id === String(s.code)
    );

    const values = row?.value || [];
    const rain = values.reduce((sum, v) => sum + Number(v.depth || 0), 0);
    const last = values[values.length - 1];

    return {
      level: levelRain(rain),
      sumDepth: keepSmallNumber(rain),
      to: last?.time_point || "",
      station: {
        id: s.uuid,
        uuid: s.uuid,
        code: s.code,
        name: s.name,
        address: s.address,
        area: s.area,
        cityName: s.city,
        lat: s.latitude,
        lng: s.longitude,
        location: s.area,
      },
    };
  });
}

async function fetchVrain30m(hours = 23) {
  const requestedHours = Number(hours || 23);
  const safeHours = Math.min(Math.max(requestedHours, 0.5), 23.5);

  const end = new Date();
  const start = new Date(end.getTime() - safeHours * 60 * 60 * 1000);

  const [stations, stats] = await Promise.all([
    callVrain("/v1/stations"),
    callVrain(
      `/v1/stations/stats?start_time=${encodeURIComponent(
        formatTimeVN(start)
      )}&end_time=${encodeURIComponent(formatTimeVN(end))}&format=10m`
    ),
  ]);

  const statRows = stats?.Data || stats?.data || [];

  return stations.map((s) => {
    const row = statRows.find(
      (x) =>
        x.station_id === s.code ||
        x.station_id === s.uuid ||
        x.station_id === String(s.code)
    );

    const values = row?.value || [];

    const by30m = [];

    for (let i = 0; i < values.length; i += 3) {
      const group = values.slice(i, i + 3);

      const rain30m = group.reduce(
        (sum, v) => sum + Number(v.depth || 0),
        0
      );

      if (group.length) {
        by30m.push({
          time_point: group[group.length - 1].time_point,
          rain_30m: Number(rain30m.toFixed(2)),
        });
      }
    }

    return {
      station: {
        id: s.uuid,
        code: s.code,
        name: s.name,
        lat: s.latitude,
        lng: s.longitude,
        location: s.area,
        address: s.address,
      },
      data: by30m,
    };
  });
}

/* =========================
   WINDY
========================= */

function sumUntil(ts = [], values = [], hours = 24) {
  if (!Array.isArray(ts) || !Array.isArray(values) || !ts.length || !values.length) {
    return 0;
  }

  const first = Number(ts[0]);
  const limit = first + hours * 60 * 60 * 1000;

  return values.reduce((sum, v, i) => {
    const t = Number(ts[i]);

    if (Number.isFinite(t) && t <= limit) {
      return sum + Number(v || 0);
    }

    return sum;
  }, 0);
}

async function getWindyPointRain(station, model = "gfs") {
  const key = process.env.WINDY_POINT_API_KEY;

  if (!key) {
    throw new Error("Missing WINDY_POINT_API_KEY");
  }

  const response = await fetch(WINDY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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

async function fetchWindy(model = "gfs") {
  const rows = [];

  for (const station of WINDY_STATIONS) {
    rows.push(await getWindyPointRain(station, model));
    await sleep(250);
  }

  return {
    ok: true,
    source: "windy",
    model,
    stations: rows,
  };
}

/* =========================
   AVC KTTV nội bộ
========================= */

async function fetchAvcRain() {
  const USER = process.env.AVC_KTTV_USER;
  const PASS = process.env.AVC_KTTV_PASS;

  if (!USER || !PASS) {
    throw new Error("Missing AVC_KTTV_USER or AVC_KTTV_PASS");
  }

  const loginPage = await fetch("http://kttv.avuong.com:84/Login.aspx");
  const html = await loginPage.text();

  const viewState = html.match(/id="__VIEWSTATE" value="(.*?)"/)?.[1];
  const eventValidation = html.match(/id="__EVENTVALIDATION" value="(.*?)"/)?.[1];
  const viewStateGen = html.match(/id="__VIEWSTATEGENERATOR" value="(.*?)"/)?.[1];

  if (!viewState) {
    throw new Error("Không lấy được VIEWSTATE");
  }

  const cookie = loginPage.headers.get("set-cookie");

  const loginRes = await fetch("http://kttv.avuong.com:84/Login.aspx", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie || "",
    },
    body: new URLSearchParams({
      __VIEWSTATE: viewState,
      __EVENTVALIDATION: eventValidation || "",
      __VIEWSTATEGENERATOR: viewStateGen || "",
      "ctl00$ContentPlaceHolder1$txtUserName": USER,
      "ctl00$ContentPlaceHolder1$txtPassword": PASS,
      "ctl00$ContentPlaceHolder1$btnLogin": "Đăng nhập",
    }),
  });

  const cookie2 = loginRes.headers.get("set-cookie") || cookie || "";

  const dataRes = await fetch("http://kttv.avuong.com:84/TramDoMua.aspx", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie2,
    },
    body: new URLSearchParams({
      __EVENTTARGET: "RefreshData",
    }),
  });

  const dataHtml = await dataRes.text();

  const stations = [];
  const regex = /AV\d+_[^<]+[\s\S]*?(\d+(\.\d+)?)\s*mm/g;
  let match;

  while ((match = regex.exec(dataHtml)) !== null) {
    stations.push({
      name: match[0].split(" ")[0],
      rain: parseFloat(match[1]),
    });
  }

  return {
    ok: true,
    source: "avc",
    stations,
  };
}

/* =========================
   API ENTRY
========================= */

export default async function handler(req, res) {
  const source = getSourceFromRequest(req);

  try {
    if (req.method !== "GET") {
      return res.status(405).json({
        ok: false,
        error: "Method not allowed",
      });
    }

    if (source === "vrain-1h" || source === "1h" || source === "rain") {
      const output = await fetchVrain1h();
      return jsonOk(res, output, "s-maxage=300, stale-while-revalidate=600");
    }

    if (source === "vrain-30m" || source === "30m") {
      const output = await fetchVrain30m(req.query.hours || 23);
      return jsonOk(res, output, "s-maxage=300, stale-while-revalidate=600");
    }

    if (source === "windy") {
      const model = String(req.query.model || "gfs").toLowerCase();
      const output = await fetchWindy(model);
      return jsonOk(res, output, "s-maxage=1800, stale-while-revalidate=3600");
    }

    if (source === "avc") {
      const output = await fetchAvcRain();
      return jsonOk(res, output, "s-maxage=300, stale-while-revalidate=600");
    }

    if (source === "all") {
      const model = String(req.query.model || "gfs").toLowerCase();
      const hours = req.query.hours || 23;

      const results = await Promise.allSettled([
        fetchVrain1h(),
        fetchVrain30m(hours),
        fetchWindy(model),
        fetchAvcRain(),
      ]);

      const [vrain1h, vrain30m, windy, avc] = results;

      return jsonOk(
        res,
        {
          ok: true,
          source: "all",
          updatedAt: new Date().toISOString(),
          vrain1h:
            vrain1h.status === "fulfilled"
              ? { ok: true, data: vrain1h.value }
              : { ok: false, error: vrain1h.reason?.message || String(vrain1h.reason) },
          vrain30m:
            vrain30m.status === "fulfilled"
              ? { ok: true, data: vrain30m.value }
              : { ok: false, error: vrain30m.reason?.message || String(vrain30m.reason) },
          windy:
            windy.status === "fulfilled"
              ? { ok: true, data: windy.value }
              : { ok: false, error: windy.reason?.message || String(windy.reason) },
          avc:
            avc.status === "fulfilled"
              ? { ok: true, data: avc.value }
              : { ok: false, error: avc.reason?.message || String(avc.reason) },
        },
        "s-maxage=300, stale-while-revalidate=600"
      );
    }

    return res.status(400).json({
      ok: false,
      error: "source không hợp lệ",
      source,
      supported_sources: ["vrain-1h", "vrain-30m", "windy", "avc", "all"],
      legacy_urls: [
        "/api/rain",
        "/api/rain-30m",
        "/api/rain-avc",
        "/api/windy-rain",
      ],
    });
  } catch (err) {
    return jsonError(res, err, source);
  }
}
