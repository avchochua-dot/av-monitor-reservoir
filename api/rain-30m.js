const API_BASE = "https://kttv-open.vrain.vn";

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTime(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

async function callVrain(path) {
  const apiKey = process.env.VRAIN_API_KEY;

  const res = await fetch(`${API_BASE}${path}`, {
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

export default async function handler(req, res) {
  try {
    const requestedHours = Number(req.query.hours || 24);
    const safeHours = Math.min(requestedHours, 23.5);

    const end = new Date();
    const start = new Date(end.getTime() - safeHours * 60 * 60 * 1000);

    const stations = await callVrain("/v1/stations");

    const stats = await callVrain(
      `/v1/stations/stats?start_time=${encodeURIComponent(formatTime(start))}&end_time=${encodeURIComponent(formatTime(end))}&format=10m`
    );

    const statRows = stats?.Data || stats?.data || [];

    const output = stations.map((s) => {
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
        const rain30m = group.reduce((sum, v) => sum + Number(v.depth || 0), 0);

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

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
