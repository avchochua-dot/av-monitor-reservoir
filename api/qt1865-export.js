import ExcelJS from "exceljs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 2) {
  const n = num(v);
  if (n === null) return "";
  return Number(n.toFixed(d));
}

function vnDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = String(dateStr).split("-");
  return `${d}/${m}/${y}`;
}

function monthRange(year, month) {
  if (month) {
    const start = `${year}-${String(month).padStart(2, "0")}-01`;
    const endDate = new Date(Number(year), Number(month), 0);
    const end = `${year}-${String(month).padStart(2, "0")}-${String(
      endDate.getDate()
    ).padStart(2, "0")}`;
    return { start, end };
  }

  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
  };
}

async function fetchRows(start, end) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/reservoir_release_compliance_1865`);

  url.searchParams.set(
    "select",
    [
      "date",
      "mnh_min",
      "mnh_max",
      "q_min",
      "q_max",
      "water_level_avg",
      "water_level_max",
      "water_level_min",
      "turbine_flow_avg",
      "spillway_flow_avg",
      "total_outflow_avg",
      "total_outflow_min",
      "total_outflow_max",
      "diff_mnh_min",
      "diff_mnh_max",
      "diff_q_min",
      "diff_q_max",
      "mnh_status",
      "flow_status",
      "is_compliant",
      "reason",
      "record_count",
      "note"
    ].join(",")
  );

  url.searchParams.append("date", `gte.${start}`);
  url.searchParams.append("date", `lte.${end}`);
  url.searchParams.set("order", "date.asc");
  url.searchParams.set("limit", "1000");

  const response = await fetch(url.toString(), {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : [];
}

function styleCell(cell) {
  cell.font = { name: "Times New Roman", size: 12 };
  cell.alignment = {
    vertical: "middle",
    horizontal: "center",
    wrapText: true,
  };
  cell.border = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };
}

function styleHeader(cell) {
  styleCell(cell);
  cell.font = {
    name: "Times New Roman",
    size: 12,
    bold: true,
    color: { argb: "FFFFFFFF" },
  };
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1D4ED8" },
  };
}

function styleTitle(cell) {
  cell.font = {
    name: "Times New Roman",
    size: 16,
    bold: true,
  };
  cell.alignment = {
    vertical: "middle",
    horizontal: "center",
    wrapText: true,
  };
}

function styleSummaryTitle(cell) {
  cell.font = {
    name: "Times New Roman",
    size: 13,
    bold: true,
  };
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFEFF6FF" },
  };
  cell.alignment = {
    vertical: "middle",
    horizontal: "center",
    wrapText: true,
  };
  cell.border = {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };
}

function buildReasonSummary(rows) {
  const map = new Map();

  for (const r of rows) {
    if (r.is_compliant) continue;
    const reason = r.reason || "Không xác định";
    map.set(reason, (map.get(reason) || 0) + 1);
  }

  return Array.from(map.entries()).map(([reason, count]) => ({
    reason,
    count,
  }));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      res.status(500).json({
        ok: false,
        error: "Missing SUPABASE_URL or SUPABASE key",
      });
      return;
    }

    const year = Number(req.query.year || new Date().getFullYear());
    const month = req.query.month ? Number(req.query.month) : null;

    if (!year || year < 2000 || year > 2100) {
      res.status(400).json({ ok: false, error: "Invalid year" });
      return;
    }

    if (month !== null && (month < 1 || month > 12)) {
      res.status(400).json({ ok: false, error: "Invalid month" });
      return;
    }

    const { start, end } = monthRange(year, month);
    const rows = await fetchRows(start, end);

    const totalDays = rows.length;
    const compliantDays = rows.filter(r => r.is_compliant).length;
    const nonCompliantDays = totalDays - compliantDays;
    const complianceRate = totalDays
      ? Number(((compliantDays / totalDays) * 100).toFixed(1))
      : 0;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "A Vuong Dashboard AI";
    workbook.created = new Date();

    const ws = workbook.addWorksheet("QT1865", {
      pageSetup: {
        paperSize: 9,
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: {
          left: 0.3,
          right: 0.3,
          top: 0.5,
          bottom: 0.5,
          header: 0.2,
          footer: 0.2,
        },
      },
    });

    ws.mergeCells("A1:T1");
    ws.getCell("A1").value =
      `THỐNG KÊ ĐÁNH GIÁ TUÂN THỦ QUY TRÌNH LIÊN HỒ 1865 ${month ? `THÁNG ${String(month).padStart(2, "0")}/` : "NĂM "}${year}`;
    styleTitle(ws.getCell("A1"));
    ws.getRow(1).height = 30;

    ws.mergeCells("A2:T2");
    ws.getCell("A2").value =
      `Thời gian: ${vnDate(start)} - ${vnDate(end)} | Tổng ngày: ${totalDays} | Đảm bảo: ${compliantDays} | Không đảm bảo: ${nonCompliantDays} | Tỷ lệ đảm bảo: ${complianceRate}%`;
    ws.getCell("A2").font = {
      name: "Times New Roman",
      size: 12,
      bold: true,
      color: { argb: "FF1E40AF" },
    };
    ws.getCell("A2").alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: true,
    };
    ws.getRow(2).height = 26;

    const headers = [
      "STT",
      "Ngày",
      "MNH TB (m)",
      "MNH Max (m)",
      "MNH Min (m)",
      "GH dưới MNH (m)",
      "GH trên MNH (m)",
      "CL so GH dưới (m)",
      "CL so GH trên (m)",
      "Q máy TB (m³/s)",
      "Q xả TB (m³/s)",
      "Tổng Q ra TB (m³/s)",
      "Q ra Min (m³/s)",
      "Q ra Max (m³/s)",
      "Q quy định dưới",
      "Q quy định trên",
      "CL Q dưới",
      "CL Q trên",
      "Kết quả",
      "Nguyên nhân",
    ];

    ws.addRow(headers);
    ws.getRow(3).eachCell(styleHeader);
    ws.getRow(3).height = 34;

    rows.forEach((r, idx) => {
      const row = ws.addRow([
        idx + 1,
        vnDate(r.date),
        round(r.water_level_avg, 2),
        round(r.water_level_max, 2),
        round(r.water_level_min, 2),
        round(r.mnh_min, 2),
        round(r.mnh_max, 2),
        round(r.diff_mnh_min, 2),
        round(r.diff_mnh_max, 2),
        round(r.turbine_flow_avg, 2),
        round(r.spillway_flow_avg, 2),
        round(r.total_outflow_avg, 2),
        round(r.total_outflow_min, 2),
        round(r.total_outflow_max, 2),
        round(r.q_min, 2),
        round(r.q_max, 2),
        round(r.diff_q_min, 2),
        round(r.diff_q_max, 2),
        r.is_compliant ? "Đảm bảo" : "Không đảm bảo",
        r.reason || "",
      ]);

      row.eachCell(styleCell);

      const resultCell = row.getCell(19);

      if (r.is_compliant) {
        resultCell.font = {
          name: "Times New Roman",
          size: 12,
          bold: true,
          color: { argb: "FF15803D" },
        };
        resultCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFDCFCE7" },
        };
      } else {
        resultCell.font = {
          name: "Times New Roman",
          size: 12,
          bold: true,
          color: { argb: "FFB91C1C" },
        };
        resultCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFEE2E2" },
        };
      }

      row.height = 28;
    });

    const startSummaryRow = rows.length + 5;

    ws.mergeCells(`A${startSummaryRow}:T${startSummaryRow}`);
    ws.getCell(`A${startSummaryRow}`).value = "TỔNG HỢP THEO NGUYÊN NHÂN";
    styleSummaryTitle(ws.getCell(`A${startSummaryRow}`));

    const reasonHeaderRow = ws.addRow(["STT", "Nguyên nhân", "Số ngày"]);
    reasonHeaderRow.getCell(1).value = "STT";
    reasonHeaderRow.getCell(2).value = "Nguyên nhân";
    reasonHeaderRow.getCell(3).value = "Số ngày";

    for (let c = 1; c <= 3; c++) {
      styleHeader(reasonHeaderRow.getCell(c));
    }

    const reasonSummary = buildReasonSummary(rows);

    reasonSummary.forEach((item, idx) => {
      const row = ws.addRow([idx + 1, item.reason, item.count]);
      for (let c = 1; c <= 3; c++) {
        styleCell(row.getCell(c));
      }
      row.getCell(2).alignment = {
        vertical: "middle",
        horizontal: "left",
        wrapText: true,
      };
    });

    ws.columns = [
      { width: 6 },
      { width: 12 },
      { width: 12 },
      { width: 12 },
      { width: 12 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 16 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 12 },
      { width: 12 },
      { width: 16 },
      { width: 28 },
    ];

    ws.views = [{ state: "frozen", ySplit: 3 }];

    ws.autoFilter = {
      from: "A3",
      to: `T${rows.length + 3}`,
    };

    const fileName = month
      ? `Thong_ke_QT1865_${year}_thang_${String(month).padStart(2, "0")}.xlsx`
      : `Thong_ke_QT1865_${year}.xlsx`;

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(fileName)}"`
    );
    res.setHeader("Cache-Control", "no-store");

    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
