const DEFAULT_STATIONS = [
  { id: "adb491", code: "AV01", name: "Đập A Vương" },
  { id: "2137d8", code: "AV02", name: "Xã A Vương" },
  { id: "367c08", code: "AV03", name: "A Nông" },
  { id: "59171c", code: "AV04", name: "Tây Giang" },
  { id: "14eb20", code: "AV05", name: "Xã Dang" },
  { id: "7c19bd", code: "AV06", name: "Xã A Tép" },
  { id: "d7ecb0", code: "AV07", name: "Xã A Rooi" },
  { id: "da16dd", code: "AV08", name: "UBND Xã Blahee" }
];

function stripTags(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(value) {
  const s = String(value || "").replace(",", ".").replace(/[^0-9.\-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseGridRows(html) {
  const rows = [];
  const trRe = /<tr[^>]*(?:DXDataRow|dxgvDataRow)[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = tdRe.exec(m[1]))) cells.push(stripTags(c[1]));
    if (cells.length >= 7) {
      rows.push({
        code: cells[0],
        name: cells[1],
        date: cells[2],
        hour: cells[3],
        dayRain: parseNumber(cells[4]),
        hourRain: parseNumber(cells[5]),
        rain30: parseNumber(cells[6]),
        status: "Bình thường"
      });
    }
  }
  return rows;
}

function parseStatuses(html) {
  return DEFAULT_STATIONS.map(s => {
    const cardRe = new RegExp(`<div[^>]+id=["']card_${s.id}["'][\\s\\S]*?<span[^>]*>([\\s\\S]*?)<\\/span>`, "i");
    const m = html.match(cardRe);
    return { ...s, status: m ? stripTags(m[1]) : "Bình thường" };
  });
}

export default async function handler(req, res) {
  const sourceUrl = process.env.AVC_RAIN_SOURCE_URL || "https://avuong.com/TramDoMua.aspx";
  try {
    const upstream = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
        ...(process.env.AVC_RAIN_COOKIE ? { "cookie": process.env.AVC_RAIN_COOKIE } : {})
      }
    });
    const html = await upstream.text();
    const stations = parseStatuses(html);
    let data = parseGridRows(html);

    if (data.length) {
      data = data.map(row => {
        const st = stations.find(s => row.code && row.code.toUpperCase().includes(s.code)) || stations.find(s => row.name && row.name.includes(s.name));
        return { ...row, id: st?.id || row.code, status: st?.status || row.status || "Bình thường" };
      });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      source: sourceUrl,
      upstreamStatus: upstream.status,
      stations,
      data,
      note: data.length
        ? "Đã lấy được bảng dữ liệu 8 trạm từ TramDoMua.aspx."
        : "Đã lấy được danh sách/trạng thái 8 trạm, nhưng chưa thấy dòng dữ liệu trong bảng. Nếu trang yêu cầu đăng nhập, hãy cấu hình AVC_RAIN_COOKIE trong Vercel."
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stations: DEFAULT_STATIONS, data: [] });
  }
}
