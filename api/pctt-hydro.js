export default async function handler(req, res) {
  try {
    const year = Number(req.query.year || new Date().getFullYear());
    const month = Number(req.query.month || new Date().getMonth() + 1);

    const start = req.query.start || `${year}-${String(month).padStart(2, "0")}-01T00:00:00.000Z`;

    let end;
    if (req.query.end) {
      end = req.query.end;
    } else {
      const nextMonth = new Date(Date.UTC(year, month, 1, 23, 59, 59));
      end = nextMonth.toISOString();
    }

    const ids = req.query.ids || "1,2,3,4";

    const url =
      "https://pctt.danang.gov.vn/DesktopModules/PCTT/api/PCTTApi/baocaothuydiens_thongke" +
      `?ngaybatdau=${encodeURIComponent(start)}` +
      `&ngayketthuc=${encodeURIComponent(end)}` +
      `&lst_thuydien_id=${encodeURIComponent(ids)}`;

    const r = await fetch(url, {
      headers: {
        "accept": "application/xml,text/xml,*/*",
        "user-agent": "avuong-dashboard/1.0"
      }
    });

    if (!r.ok) {
      return res.status(r.status).json({
        ok: false,
        error: `PCTT API HTTP ${r.status}`,
        url
      });
    }

    const xml = await r.text();
    const rows = parsePcttXml(xml);

    const normalized = rows.map(normalizeRow);

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    return res.status(200).json({
      ok: true,
      source: "pctt.danang.gov.vn",
      start,
      end,
      ids,
      count: normalized.length,
      data: normalized
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}

function parsePcttXml(xml) {
  const tables = xml.match(/<Table[\s\S]*?<\/Table>/g) || [];

  return tables.map(block => {
    const obj = {};
    const tagRegex = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let m;

    while ((m = tagRegex.exec(block)) !== null) {
      const key = m[1];
      const raw = decodeXml(m[2] || "").trim();

      if (raw === "") {
        obj[key] = null;
      } else if (isFinite(Number(raw)) && !["ngay", "gio", "thoigianxa"].includes(key)) {
        obj[key] = Number(raw);
      } else {
        obj[key] = raw;
      }
    }

    return obj;
  });
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function normalizeRow(r) {
  return {
    time: r.thoigianxa || null,
    date: r.ngay || null,
    hour: r.gio || null,

    reservoirs: [
      {
        id: 1,
        name: "A Vương",
        waterLevel: num(r.htl1),
        inflow: num(r.qvao1),
        turbineFlow: num(r.luuluongnhamay1),
        spillwayFlow: num(r.qxaquacua1)
      },
      {
        id: 2,
        name: "Hồ 2",
        waterLevel: num(r.htl2),
        inflow: num(r.qvao2),
        turbineFlow: num(r.luuluongnhamay2),
        spillwayFlow: num(r.qxaquacua2)
      },
      {
        id: 3,
        name: "Hồ 3",
        waterLevel: num(r.htl3),
        inflow: num(r.qvao3),
        turbineFlow: num(r.luuluongnhamay3),
        spillwayFlow: num(r.qxaquacua3)
      },
      {
        id: 4,
        name: "Hồ 4",
        waterLevel: num(r.htl4),
        inflow: num(r.qvao4),
        turbineFlow: num(r.luuluongnhamay4),
        spillwayFlow: num(r.qxaquacua4)
      }
    ],

    basin: {
      qVeVuGia: num(r.qvevugia),
      qVeThuBon: num(r.qvethubon)
    },

    raw: r
  };
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
