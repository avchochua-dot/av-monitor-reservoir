const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function applyLimitYear(row, year) {
  const [, month, day] = String(row.date).slice(0, 10).split("-");
  return { ...row, date: `${year}-${month}-${day}` };
}

function between(month, day, fm, fd, tm, td) {
  const value = month * 100 + day;
  const from = fm * 100 + fd;
  const to = tm * 100 + td;
  return from <= to ? value >= from && value <= to : value >= from || value <= to;
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
      flood_level_min:fMin, flood_level_max:fMax, q_min:null, q_max:null,
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
  const rule = qt2138Rule(date);
  return res.status(200).json({
    ok:true, mode:"rules", date, procedureCode:rule ? "QT2138" : "QT1865",
    levelRule:rule ? {date,...rule} : null,
    downstreamThresholds:[
      {station_code:"AI_NGHIA",station_name:"Ai Nghia",bd1:6.5,bd2:8.0,bd3:9.0,decision_level_min:8.0,decision_level_max:8.5},
      {station_code:"HOI_KHACH",station_name:"Hoi Khach",bd1:14.5,bd2:15.5,bd3:16.5,decision_level_min:15.5,decision_level_max:16.0},
    ],
    activeOrder:null,
    warning:rule ? "Chua nhap lenh dieu hanh dang hieu luc; khong tu dong ket luan cat, giam lu theo gioi han tren." : null,
  });
}

export default async function handler(req, res) {
  try {
    if (String(req.query.mode || "").toLowerCase() === "rules") return rulesResponse(req,res);
    const year = Number(req.query.year || new Date().getFullYear());
    const from = `${year}-01-01T00:00:00+00:00`;
    const to = `${year}-12-31T23:59:59+00:00`;
    const operationQuery = `select=time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal&time=gte.${encodeURIComponent(from)}&time=lte.${encodeURIComponent(to)}&order=time.asc`;
    const operations = await fetchAll("reservoir_hourly_data", operationQuery);
    const rawLimits = await fetchAll("reservoir_level_limits", "select=date,mnghd,mnght,mndl,mntrl&order=date.asc");
    const limits = rawLimits.map(row => {
      const base = applyLimitYear(row,year);
      const rule = qt2138Rule(base.date);
      return rule ? {...base,...rule} : {...base,procedure_code:"QT1865"};
    });
    return res.status(200).json({
      ok:true, year, rulesSource:"QT2138_EMBEDDED", operations, limits,
      counts:{operations:operations.length,rawLimits:rawLimits.length,limits:limits.length},
    });
  } catch (error) {
    return res.status(500).json({ok:false,error:error.message});
  }
}
