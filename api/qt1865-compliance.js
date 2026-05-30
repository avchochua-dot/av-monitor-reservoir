import ExcelJS from "exceljs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

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
  const [y, m, d] = String(dateStr).slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function fmtDateTime(dateTimeStr) {
  if (!dateTimeStr) return "";
  const s = String(dateTimeStr);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return s;
  return `${m[4]}:${m[5]} ${m[3]}/${m[2]}`;
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

function getDisplayResult(row) {
  const reason = String(row.reason || "");

  if (row.is_compliant) return "Đảm bảo";
  if (reason.includes("MNH")) return "Không đảm bảo MNH";
  if (reason.includes("lưu lượng") || reason.includes("Q thấp")) {
    return "Không đảm bảo lưu lượng";
  }

  return "Không đảm bảo";
}

function buildReasonSummary(rows) {
  const map = new Map();

  for (const r of rows) {
    if (r.is_compliant && !String(r.reason || "").includes("Cảnh báo")) {
      continue;
    }

    const reason = r.reason || "Không xác định";

    if (!map.has(reason)) {
      map.set(reason, { reason, count: 0 });
    }

    map.get(reason).count += 1;
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function buildMonthSummary(rows) {
  const map = new Map();

  for (const r of rows) {
    const month = String(r.date || "").slice(0
