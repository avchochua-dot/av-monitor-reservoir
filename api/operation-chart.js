const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FIX_VERSION = "AVUONG_QT2138_V05";

const ALLOWED_ORIGINS = new Set([
  "https://avuonghydro.com",
  "https://www.avuonghydro.com",
  "https://av-monitor-reservoir.vercel.app",
]);

function setCors(req, res) {
  const origin = String(req.headers.origin || "");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
}

async function fetchAll(table, query, pageSize = 1000) {
  let from = 0;
  let all = [];
  while (true) {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
        Prefer: "count=exact",
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${table}: ${text}`);
    const rows = JSON.parse(text);
    all = all.concat(rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

function between(month, day, fm, fd, tm, td) {
  const value = month * 100 + day;
  const from = fm * 100 + fd;
  const to = tm * 100 + td;
  return from <= to ? value >= from && value <= to : value >= from || value <= to;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function legacyRule(date, rawLimits) {
  const [, mm, dd] = date.split("-").map(Number);
  const flood = between(mm, dd, 9, 1, 12, 15);
  if (flood) {
    const late = mm * 100 + dd >= 1116;
    return {
      date, procedure_code:"QT1865", season:"FLOOD",
      mnghd:null, mnght:null, mndl:late ? 377 : 370, mntrl:late ? 380 : 376,
      dry_level_min:null, dry_level_max:null,
      flood_level_min:late ? 377 : 370, flood_level_max:late ? 377 : 370,
      normal_level_min:late ? 377 : 376, normal_level_max:late ? 380 : 376,
      normal_q_min:15,
    };
  }
  // Prefer the exact year. Never let 01/01 of the following year overwrite it.
  const candidates = rawLimits.filter(r => String(r.date).slice(5,10) === date.slice(5,10)
    && numberOrNull(r.mnghd) !== null && numberOrNull(r.mnght) !== null);
  candidates.sort((a,b) => {
    const score = r => String(r.date).slice(0,10) === date ? 0 : Math.abs(Number(String(r.date).slice(0,4))-Number(date.slice(0,4)))+1;
    return score(a)-score(b) || String(b.date).localeCompare(String(a.date));
  });
  const chosen = candidates[0];
  // PL III: 16/12-31/01 has the same range; this also covers a missing boundary row.
  const earlyYear = between(mm, dd, 12, 16, 1, 31);
  const lo = chosen ? numberOrNull(chosen.mnghd) : (earlyYear ? 375.5 : null);
  const hi = chosen ? numberOrNull(chosen.mnght) : (earlyYear ? 378.3 : null);
  return {
    date, procedure_code:"QT1865", season:"DRY",
    mnghd:lo, mnght:hi, mndl:null, mntrl:null,
    dry_level_min:lo, dry_level_max:hi,
    normal_level_min:null, normal_level_max:null, flood_level_min:null, flood_level_max:null,
  };
}

function qt2138Rule(dateText) {
  if (dateText < "2026-11-06") return null;
  const [, mm, dd] = dateText.split("-").map(Number);
  const floodPeriods = [
    [9,1,9,30,374,374,367,368], [10,1,10,31,373,373,367,368],
    [11,1,11,21,374,376,367,368], [11,22,12,20,377,380,376,376],
  ];
  for (const [fm,fd,tm,td,nMin,nMax,fMin,fMax] of floodPeriods) {
    if (between(mm,dd,fm,fd,tm,td)) return {
      procedure_code:"QT2138", season:"FLOOD",
      mnghd:null, mnght:null, mndl:fMin, mntrl:nMax,
      dry_level_min:null, dry_level_max:null,
      normal_level_min:nMin, normal_level_max:nMax,
      flood_level_min:fMin, flood_level_max:fMax, normal_q_min:15, q_min:null, q_max:null,
    };
  }
  const dryPeriods = [
    [12,21,1,31,375.5,378.3,18,22], [2,1,2,10,375.5,378.3,22,26],
    [2,11,2,20,375.2,378.1,22,26], [2,21,2,29,374.5,377.6,22,26],
    [3,1,3,10,373.7,377.0,22,26], [3,11,3,20,372.9,376.0,22,26],
    [3,21,3,31,371.9,374.9,22,26], [4,1,4,10,370.8,373.4,22,26],
    [4,11,4,20,369.4,372.2,18,22], [4,21,4,30,368.5,371.3,18,22],
    [5,1,5,10,367.4,370.6,18,22], [5,11,5,20,366.3,369.5,30,35],
    [5,21,5,31,364.1,366.8,30,35], [6,1,6,10,361.5,363.7,30,35],
    [6,11,6,20,358.5,360.8,24,28], [6,21,6,30,356.3,359.2,24,28],
    [7,1,7,10,354.3,357.1,24,28], [7,11,7,20,352.1,354.9,24,28],
    [7,21,7,31,350.2,353.0,24,28], [8,1,8,10,347.9,350.7,24,28],
    [8,11,8,20,345.2,348.0,24,28], [8,21,8,31,342.6,345.4,24,28],
  ];
  for (const [fm,fd,tm,td,dMin,dMax,qMin,qMax] of dryPeriods) {
    if (between(mm,dd,fm,fd,tm,td)) return {
      procedure_code:"QT2138", season:"DRY",
      mnghd:dMin, mnght:dMax, mndl:null, mntrl:null,
      dry_level_min:dMin, dry_level_max:dMax,
      normal_level_min:null, normal_level_max:null,
      flood_level_min:null, flood_level_max:null, q_min:qMin, q_max:qMax,
    };
  }
  return null;
}

function rulesResponse(req, res) {
  const requested = String(req.query.date || "");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0,10);
  const rule = qt2138Rule(date) || legacyRule(date, []);
  return res.status(200).json({
    ok:true, fixVersion:FIX_VERSION, mode:"rules", date, procedureCode:rule.procedure_code,
    levelRule:{date,...rule},
    downstreamThresholds:[
      {station_code:"AI_NGHIA",station_name:"Ai Nghia",bd1:6.5,bd2:8.0,bd3:9.0,decision_level_min:8.0,decision_level_max:8.5},
      {station_code:"HOI_KHACH",station_name:"Hoi Khach",bd1:14.5,bd2:15.5,bd3:16.5,decision_level_min:15.5,decision_level_max:16.0},
    ],
    activeOrder:null,
    warning:"Các khoảng mực nước là thông số tham chiếu; đánh giá giảm lũ phải đối chiếu chế độ, dự báo, mực nước hạ du và chỉ đạo áp dụng. Chế độ bình thường kiểm tra riêng Q trung bình ngày tối thiểu 15 m³/s.",
  });
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (String(req.query.mode || "").toLowerCase() === "rules") return rulesResponse(req,res);
    const year = Number(req.query.year || new Date().getFullYear());
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ok:false,error:"Năm không hợp lệ"});
    const from = `${year}-01-01T00:00:00+00:00`;
    const to = `${year+1}-01-01T00:00:00+00:00`;
    const operationQuery = `select=time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal&time=gte.${encodeURIComponent(from)}&time=lte.${encodeURIComponent(to)}&order=time.asc`;
    const operations = await fetchAll("reservoir_hourly_data", operationQuery);
    const rawLimits = await fetchAll("reservoir_level_limits", "select=date,mnghd,mnght,mndl,mntrl&order=date.asc");
    const limits = [];
    for (let d = new Date(Date.UTC(year, 0, 1)); d.getUTCFullYear() === year; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      const rule = qt2138Rule(date);
      limits.push(rule ? { date, ...rule } : legacyRule(date, rawLimits));
    }
    return res.status(200).json({
      ok:true, fixVersion:FIX_VERSION, year, rulesSource:"VERSIONED_QT1865_QT2138", operations, limits,
      timeBasis:"OPERATION_CLOCK_01_24", dailyWaterLevelBasis:"END_OF_OPERATION_DAY",
      counts:{operations:operations.length,rawLimits:rawLimits.length,limits:limits.length},
    });
  } catch (error) {
    return res.status(500).json({ok:false,error:error.message});
  }
}
