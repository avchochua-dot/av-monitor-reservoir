/**
 * Vercel API:
 *
 * 1) API QT1865 cũ - mặc định:
 *    /api/qt1865-compliance?year=2026&month=6
 *
 * 2) API QT1865 cũ - gọi rõ mode:
 *    /api/qt1865-compliance?mode=qt1865&year=2026&month=6
 *
 * 3) API báo cáo tháng / AI prompt:
 *    /api/qt1865-compliance?mode=monthly-report&year=2026&month=6
 *
 * 4) API PCTT Đà Nẵng:
 *    /api/qt1865-compliance?mode=pctt-hydro&year=2026&month=6&ids=1,2,3,4
 *    /api/qt1865-compliance?mode=pctt-hydro&start=2026-06-01T00:00:00+07:00&end=2026-06-30T23:59:59+07:00&ids=1,2,3,4
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FIX_VERSION = "AVUONG_QT2138_V06";

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = num(value);
  if (n === null) return null;
  return Number(n.toFixed(digits));
}

function sum(values) {
  return values.reduce((total, value) => total + (num(value) || 0), 0);
}

function avg(values) {
  const arr = values.map(num).filter(v => v !== null);
  if (!arr.length) return null;
  return sum(arr) / arr.length;
}

function monthRangeUtc(year, month) {
  const y = Number(year);
  const m = Number(month);

  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function monthRangeDate(year, month) {
  const y = Number(year);
  const m = Number(month);

  const start = `${y}-${String(m).padStart(2, "0")}-01`;

  const endDate = new Date(y, m, 0);
  const end = `${y}-${String(m).padStart(2, "0")}-${String(
    endDate.getDate()
  ).padStart(2, "0")}`;

  return { start, end };
}

function yearRangeDate(year) {
  const y = Number(year);
  return {
    start: `${y}-01-01`,
    end: `${y}-12-31`,
  };
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function monthOfDate(value) {
  const s = String(value || "");
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Number(match[2]);
}

function rowDateTime(row) {
  return row?.date || row?.time || null;
}

function pickNumber(row, keys) {
  for (const key of keys) {
    const v = num(row?.[key]);
    if (v !== null) return v;
  }
  return null;
}

function findExtreme(rows, key, type = "max") {
  const valid = rows
    .map(r => ({
      time: r.time,
      date: r.date || null,
      value: num(r[key]),
    }))
    .filter(x => x.value !== null);

  if (!valid.length) {
    return {
      value: null,
      time: null,
      date: null,
    };
  }

  return valid.reduce((best, cur) => {
    if (type === "min") return cur.value < best.value ? cur : best;
    return cur.value > best.value ? cur : best;
  }, valid[0]);
}

function extremeFromRows(rows, keys, type = "max") {
  const values = [];

  for (const row of rows || []) {
    const value = pickNumber(row, keys);
    if (value === null) continue;

    values.push({
      value,
      time: rowDateTime(row),
      date: row?.date || null,
    });
  }

  if (!values.length) {
    return {
      value: null,
      time: null,
      date: null,
    };
  }

  return values.reduce((best, cur) => {
    if (type === "min") return cur.value < best.value ? cur : best;
    return cur.value > best.value ? cur : best;
  }, values[0]);
}

function formatPercentLabel(value) {
  const n = num(value);
  if (n === null) return "-";

  const percent = n <= 1 ? n * 100 : n;
  const rounded = Number(percent.toFixed(2));

  if (Number.isInteger(rounded)) return `${rounded}%`;

  return `${String(rounded).replace(".", ",")}%`;
}

function classifyInflowFrequency(frequencyPercent) {
  const p = num(frequencyPercent);
  if (p === null) return "Chưa xác định";

  if (p <= 0.25) return "Nhóm nhiều nước";
  if (p <= 0.5) return "Nhóm trung bình đến khá";
  if (p <= 0.75) return "Nhóm ít nước";
  return "Nhóm rất ít nước / khô";
}

function classifyOverallRating(rate) {
  if (num(rate) === null) return "CHƯA ĐỦ ĐIỀU KIỆN";
  const r = num(rate) || 0;
  if (r >= 90) return "TỐT";
  if (r >= 80) return "KHÁ";
  if (r >= 70) return "TRUNG BÌNH";
  return "CẦN CẢI THIỆN";
}

/* =========================================================
   SUPABASE HELPERS
   ========================================================= */

function assertSupabaseEnv() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
}

async function fetchSupabasePaged(table, paramsBuilder) {
  assertSupabaseEnv();

  const pageSize = 1000;
  let offset = 0;
  let all = [];

  while (true) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);

    paramsBuilder(url.searchParams);

    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "count=exact",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Supabase ${table} ${response.status}: ${text}`);
    }

    const rows = text ? JSON.parse(text) : [];

    all = all.concat(rows);

    if (rows.length < pageSize) break;

    offset += pageSize;
  }

  return all;
}

/* =========================================================
   QT1865 LEGACY MODE
   ========================================================= */

const QT2138_EFFECTIVE_FROM = "2026-11-06";

function todayInVietnam() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function betweenMonthDay(month, day, fromMonth, fromDay, toMonth, toDay) {
  const value = month * 100 + day;
  const from = fromMonth * 100 + fromDay;
  const to = toMonth * 100 + toDay;
  return from <= to ? value >= from && value <= to : value >= from || value <= to;
}

// Kiểm tra Q ngày, mực nước tham chiếu và giờ vận hành theo phạm vi báo cáo.
// Không đánh giá điều kiện lựa chọn/chuyển chế độ cắt, giảm lũ trong báo cáo này.
function qt2138Reference(dateText, actualWaterLevel) {
  if (String(dateText) < QT2138_EFFECTIVE_FROM) return null;
  const match = String(dateText).match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);

  const floodPeriods = [
    [9, 1, 9, 30, 374, 374, 367, 368],
    [10, 1, 10, 31, 373, 373, 367, 368],
    [11, 1, 11, 21, 374, 376, 367, 368],
    [11, 22, 12, 20, 377, 380, 376, 376],
  ];
  for (const [fm, fd, tm, td, nMin, nMax, fMin, fMax] of floodPeriods) {
    if (!betweenMonthDay(month, day, fm, fd, tm, td)) continue;
    return {
      procedure_code: "QT2138", season: "FLOOD",
      normal_level_min: nMin, normal_level_max: nMax,
      flood_level_min: fMin, flood_level_max: fMax,
      mndl: fMin, mntrl: nMax, normal_q_min:15, q_min:15, q_max:null,
      turbine_12h_required: false, is_evaluable: false,
      rule_label: `MNĐL ${fMin}${fMin === fMax ? "" : `–${fMax}`} m; MNCN-BT ${nMin}${nMin === nMax ? "" : `–${nMax}`} m`,
    };
  }

  // [thời đoạn, khoảng PL III, Q trong khoảng, Q khi MNH thấp, Q tối thiểu khi MNH cao]
  const dryPeriods = [
    [12,21,1,31,375.5,378.3,18,22,15,18,22], [2,1,2,10,375.5,378.3,22,26,18,22,26],
    [2,11,2,20,375.2,378.1,22,26,18,22,26], [2,21,2,29,374.5,377.6,22,26,18,22,26],
    [3,1,3,10,373.7,377.0,22,26,18,22,26], [3,11,3,20,372.9,376.0,22,26,18,22,26],
    [3,21,3,31,371.9,374.9,22,26,18,22,26], [4,1,4,10,370.8,373.4,22,26,18,22,26],
    [4,11,4,20,369.4,372.2,18,22,15,18,22], [4,21,4,30,368.5,371.3,18,22,15,18,22],
    [5,1,5,10,367.4,370.6,18,22,15,18,22], [5,11,5,20,366.3,369.5,30,35,25,30,35],
    [5,21,5,31,364.1,366.8,30,35,25,30,35], [6,1,6,10,361.5,363.7,30,35,25,30,35],
    [6,11,6,20,358.5,360.8,24,28,20,24,28], [6,21,6,30,356.3,359.2,24,28,20,24,28],
    [7,1,7,10,354.3,357.1,24,28,20,24,28], [7,11,7,20,352.1,354.9,24,28,20,24,28],
    [7,21,7,31,350.2,353.0,24,28,20,24,28], [8,1,8,10,347.9,350.7,24,28,20,24,28],
    [8,11,8,20,345.2,348.0,24,28,20,24,28], [8,21,8,31,342.6,345.4,24,28,20,24,28],
  ];
  for (const [fm,fd,tm,td,levelMin,levelMax,midQMin,midQMax,lowQMin,lowQMax,highQMin] of dryPeriods) {
    if (!betweenMonthDay(month, day, fm, fd, tm, td)) continue;
    const wl = num(actualWaterLevel);
    let qMin = midQMin, qMax = midQMax, levelPosition = "IN_RANGE";
    if (wl !== null && wl < levelMin) {
      qMin = lowQMin; qMax = lowQMax; levelPosition = "BELOW_RANGE";
    } else if (wl !== null && wl > levelMax) {
      qMin = highQMin; qMax = null; levelPosition = "ABOVE_RANGE";
    }
    return {
      procedure_code: "QT2138", season: "DRY",
      dry_level_min: levelMin, dry_level_max: levelMax,
      mnh_min: levelMin, mnh_max: levelMax, q_min: qMin, q_max: qMax,
      level_position: levelPosition, turbine_12h_required: true,
      // Muốn kết luận phải kiểm tra >=2 đợt, mỗi đợt >=4h, tổng >=12h, khung 06h-22h.
      is_evaluable: false, rule_label: `PL III ${levelMin}–${levelMax} m`,
    };
  }
  return null;
}

function normalizeLegacyZero(value) {
  const n = num(value);
  return n === 0 ? null : n;
}

function normalizeProcedureRow(sourceRow, todayVn) {
  const date = String(sourceRow?.date || "").slice(0, 10);
  const actualWaterLevel = pickNumber(sourceRow, ["water_level_end", "water_level_avg", "mnh_avg", "mnh"]);
  // Q ngày đã được tính trong view hiện có: không tính trung bình lại.
  const actualOutflow = pickNumber(sourceRow, ["total_outflow_avg", "outflow_avg", "q_out_avg"]);
  const provisional = date >= todayVn;
  const reference = qt2138Reference(date, actualWaterLevel);
  const month = Number(date.slice(5,7)), day = Number(date.slice(8,10));
  const legacyFlood = !reference && betweenMonthDay(month, day, 9, 1, 12, 15);
  const count = num(sourceRow.record_count);
  const dailyFlowKnown = actualOutflow !== null && actualOutflow >= 0 && (count === null || count >= 24);
  const shared = {...sourceRow, water_level_end:actualWaterLevel, water_level_basis:"END_OF_OPERATION_DAY", is_provisional:provisional};

  if (legacyFlood || reference?.season === "FLOOD") {
    const lateLegacy = month * 100 + day >= 1116;
    const rule = reference || {
      procedure_code:"QT1865", season:"FLOOD",
      normal_level_min:lateLegacy ? 377 : 376, normal_level_max:lateLegacy ? 380 : 376,
      flood_level_min:lateLegacy ? 377 : 370, flood_level_max:lateLegacy ? 377 : 370,
      rule_label:lateLegacy ? "MNĐL 377 m; MN trước lũ 377–380 m" : "MNĐL 370 m; MN trước lũ 376 m",
    };
    const approvedQ = num(sourceRow.approved_q_min);
    const qMin = approvedQ !== null && approvedQ >= 0 && sourceRow.dispatch_order_ref ? approvedQ : 15;
    const flowMet = dailyFlowKnown ? actualOutflow >= qMin : null;
    const evaluable = !provisional && flowMet !== null;
    const reason = provisional ? "Tạm tính - ngày vận hành chưa kết thúc"
      : !dailyFlowKnown ? (actualOutflow === null ? "Chưa có Q trung bình ngày" : "Thiếu số liệu để chốt Q trung bình đủ ngày")
      : flowMet ? `Đạt Q trung bình ngày tối thiểu ${qMin} m³/s; không áp dụng yêu cầu giờ mùa cạn`
      : `Không đảm bảo lưu lượng: Q trung bình ngày dưới ${qMin} m³/s`;
    return {
      ...shared,...rule,q_min:qMin,q_max:null,normal_q_min:qMin,
      q_requirement_label:`≥ ${qMin} m³/s (vận hành bình thường mùa lũ)`,
      mnh_min:null,mnh_max:null,diff_mnh_min:null,diff_mnh_max:null,
      diff_q_min:actualOutflow===null?null:round(actualOutflow-qMin),diff_q_max:null,
      turbine_12h_required:false,is_turbine_12h_compliant:null,
      turbine_12h_start:null,turbine_12h_end:null,turbine_12h_status:"Không áp dụng trong mùa lũ",
      normal_flow_compliant:evaluable?flowMet:null,flow_compliant:evaluable?flowMet:null,
      flow_status:provisional?"Tạm tính":!dailyFlowKnown?"Chưa đủ số liệu Q ngày":flowMet?"Đạt Q tối thiểu":"Q dưới mức tối thiểu",
      mnh_status:"Thông số mùa lũ tham chiếu trên biểu đồ điều phối",
      is_evaluable:evaluable,is_compliant:evaluable?flowMet:null,
      evaluation_status:provisional?"PROVISIONAL":!evaluable?"INSUFFICIENT_DATA":flowMet?"COMPLIANT":"NON_COMPLIANT",
      assessment_basis:"DAILY_MINIMUM_OUTFLOW",reason,reason_summary:reason,
    };
  }

  if (!reference) {
    const mnhMin=normalizeLegacyZero(sourceRow.mnh_min),mnhMax=normalizeLegacyZero(sourceRow.mnh_max);
    const qMin=normalizeLegacyZero(sourceRow.q_min),qMax=normalizeLegacyZero(sourceRow.q_max);
    // Giữ nguyên kết quả/khung 12 giờ của view QT1865 trước ngày hiệu lực mới.
    const evaluable=!provisional && typeof sourceRow.is_compliant === "boolean" && dailyFlowKnown;
    const reason=provisional?"Tạm tính - ngày vận hành chưa kết thúc":!dailyFlowKnown?"Chưa đủ số liệu Q trung bình ngày":sourceRow.reason||"Kết quả theo QT1865";
    return {
      ...shared,procedure_code:"QT1865",season:"DRY",mnh_min:mnhMin,mnh_max:mnhMax,q_min:qMin,q_max:qMax,
      diff_mnh_min:mnhMin===null||actualWaterLevel===null?null:round(actualWaterLevel-mnhMin),
      diff_mnh_max:mnhMax===null||actualWaterLevel===null?null:round(actualWaterLevel-mnhMax),
      diff_q_min:qMin===null||actualOutflow===null?null:round(actualOutflow-qMin),
      diff_q_max:qMax===null||actualOutflow===null?null:round(actualOutflow-qMax),
      turbine_12h_required:true,is_evaluable:evaluable,is_compliant:evaluable?sourceRow.is_compliant:null,
      is_turbine_12h_compliant:provisional?null:sourceRow.is_turbine_12h_compliant,
      flow_compliant:!provisional&&dailyFlowKnown&&qMin!==null?actualOutflow>=qMin:null,
      evaluation_status:provisional?"PROVISIONAL":!evaluable?"INSUFFICIENT_DATA":sourceRow.is_compliant?"COMPLIANT":"NON_COMPLIANT",
      reason,reason_summary:reason,rule_label:"QT1865 - khoảng mực nước mùa cạn",
    };
  }

  const levelKnown=actualWaterLevel!==null;
  const qMin=levelKnown?reference.q_min:null,qMax=levelKnown?reference.q_max:null;
  const flowMet=levelKnown&&dailyFlowKnown&&qMin!==null?actualOutflow>=qMin:null;
  const highWarning=levelKnown&&dailyFlowKnown&&qMax!==null&&actualOutflow>qMax;
  const release=sourceRow.release_statistics;
  const timingMet=release?.complete===true?release.meets_qt2138:null;
  const evaluable=!provisional&&flowMet!==null&&timingMet!==null;
  const reasons=[];
  if(!levelKnown)reasons.push("Thiếu MNH để xác định nhánh Q theo Phụ lục III");
  if(!dailyFlowKnown)reasons.push("Thiếu Q trung bình đủ ngày");
  if(flowMet===false)reasons.push(`Không đảm bảo lưu lượng: Q trung bình ngày dưới ${qMin} m³/s`);
  if(timingMet===null)reasons.push(`Thiếu số liệu giờ xả: ${sourceRow.reservoir_flow_hours||0}/24 giờ hợp lệ`);
  if(timingMet===false)reasons.push(...release.failures);
  if(highWarning)reasons.push("Cảnh báo: Q cao hơn khoảng tham chiếu; chỉ tiêu Q tối thiểu vẫn đạt");
  const reason=provisional?"Tạm tính - ngày vận hành chưa kết thúc":reasons.join("; ")||"Đạt Q tối thiểu và yêu cầu các đợt xả mùa cạn theo QT2138";
  return {
    ...shared,...reference,q_min:qMin,q_max:qMax,
    q_requirement_label:qMin===null?"Chưa xác định do thiếu MNH":qMax===null?`≥ ${qMin} m³/s`:`${qMin}–${qMax} m³/s`,
    diff_mnh_min:levelKnown?round(actualWaterLevel-reference.mnh_min):null,
    diff_mnh_max:levelKnown?round(actualWaterLevel-reference.mnh_max):null,
    diff_q_min:actualOutflow===null||qMin===null?null:round(actualOutflow-qMin),
    diff_q_max:actualOutflow===null||qMax===null?null:round(actualOutflow-qMax),
    mnh_status:!levelKnown?"Thiếu MNH":reference.level_position==="BELOW_RANGE"?"MNH thấp hơn khoảng PL III - áp dụng nhánh Q thấp":reference.level_position==="ABOVE_RANGE"?"MNH cao hơn khoảng PL III - áp dụng nhánh Q cao":"MNH trong khoảng PL III",
    flow_status:provisional?"Tạm tính":flowMet===null?"Chưa đủ số liệu":flowMet?highWarning?"Đạt Q tối thiểu; cảnh báo Q cao":"Đạt Q tối thiểu":"Q dưới mức tối thiểu",
    flow_compliant:provisional?null:flowMet,
    turbine_12h_required:true,is_turbine_12h_compliant:provisional?null:timingMet,
    turbine_12h_start:release?.first_start_label??null,turbine_12h_end:release?.last_end_label??null,
    turbine_12h_status:provisional?"Tạm tính":timingMet===null?"Chưa đủ số liệu giờ xả":timingMet?"Đạt 2 đợt, mỗi đợt ≥4h; tổng ≥12h; đầu ≤06h, cuối ≥22h":release.failures.join("; "),
    is_evaluable:evaluable,is_compliant:evaluable?flowMet&&timingMet:null,
    evaluation_status:provisional?"PROVISIONAL":!evaluable?"INSUFFICIENT_DATA":flowMet&&timingMet?"COMPLIANT":"NON_COMPLIANT",
    assessment_basis:"DAILY_MINIMUM_OUTFLOW_AND_RELEASE_HOURS",reason,reason_summary:reason,
  };
}

async function fetchQt1865Rows(start, end) {
  return fetchSupabasePaged("reservoir_release_compliance_1865", params => {
    params.set("select", "*");
    params.append("date", `gte.${start}`);
    params.append("date", `lte.${end}`);
    params.set("order", "date.asc");
  });
}

// Các nhãn 01..24 trong bảng hồ là giờ vận hành hiện có, không đổi lại dữ liệu gốc.
function operationInstant(value) {
  const p=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  return p?Date.UTC(+p[1],+p[2]-1,+p[3],+p[4],+p[5])-7*3600000:null;
}

function operationDay(value) {
  const p=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if(!p)return null;
  const d=new Date(Date.UTC(+p[1],+p[2]-1,+p[3]));
  if(p[4]==="00"&&p[5]==="00")d.setUTCDate(d.getUTCDate()-1);
  return d.toISOString().slice(0,10);
}

async function loadComplianceContext(start, end) {
  const next=new Date(`${end}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);
  const nextDay=next.toISOString().slice(0,10);
  let hourly=[],source;
  try{
    hourly=await fetchAllHourly(`${start}T00:00:00+00:00`,`${nextDay}T00:00:01+00:00`);
    source={table:"reservoir_hourly_data",ok:true,rows:hourly.length,error:null};
  }catch(err){source={table:"reservoir_hourly_data",ok:false,rows:0,error:String(err.message||err).slice(0,250)};}
  const dayMap=new Map();
  for(const row of hourly){
    const date=operationDay(row.time),instant=operationInstant(row.time);
    if(!date||date<start||date>end||instant===null)continue;
    if(!dayMap.has(date))dayMap.set(date,new Map());
    dayMap.get(date).set(instant,{...row,date,instant});
  }
  for(const [date,rows]of dayMap)dayMap.set(date,[...rows.values()].sort((a,b)=>a.instant-b.instant));
  return {dayMap,sources:[source]};
}

function releaseStatistics(date, hours) {
  const base=operationInstant(`${date}T00:00:00`);
  const slots=new Map(hours.map(r=>[(r.instant-base)/3600000,r]));
  const valid=r=>r&&num(r.turbine_flow)!==null&&num(r.spillway_flow)!==null&&num(r.turbine_flow)>=0&&num(r.spillway_flow)>=0;
  const complete=slots.size===24&&Array.from({length:24},(_,i)=>i+1).every(h=>valid(slots.get(h)));
  const intervals=[];let current=null,turbineHours=0,turbineLongest=0,turbineRun=0;
  for(let h=1;h<=24;h++){
    const row=slots.get(h),running=num(row?.turbine_flow)>0;
    if(running){turbineHours++;turbineRun++;turbineLongest=Math.max(turbineLongest,turbineRun);}else turbineRun=0;
    const releasing=valid(row)&&num(row.turbine_flow)+num(row.spillway_flow)>0;
    if(releasing){if(!current)current={start:h-1,end:h};else current.end=h;}
    else if(current){intervals.push({...current,hours:current.end-current.start});current=null;}
  }
  if(current)intervals.push({...current,hours:current.end-current.start});
  const total=intervals.reduce((s,x)=>s+x.hours,0),first=intervals[0],last=intervals.at(-1);
  const failures=[];
  if(intervals.length<2)failures.push("Không đủ 02 đợt xả trong ngày");
  if(intervals.some(x=>x.hours<4))failures.push("Có đợt xả liên tục dưới 04 giờ");
  if(total<12)failures.push("Tổng thời gian xả dưới 12 giờ");
  if(!first||first.start>6)failures.push("Bắt đầu xả sau 06 giờ hoặc không có đợt xả");
  if(!last||last.end<22)failures.push("Kết thúc xả trước 22 giờ hoặc không có đợt xả");
  const label=h=>new Date(base+h*3600000+7*3600000).toISOString().slice(0,19);
  return {complete,intervals,total_hours:total,period_count:intervals.length,
    turbine_hours:turbineHours,turbine_continuous_hours:turbineLongest,
    first_start_label:first?label(first.start):null,last_end_label:last?label(last.end):null,
    meets_qt2138:complete?failures.length===0:null,failures,time_basis:"HOURLY_RELEASE_GT_ZERO"};
}

function attachComplianceContext(source, context) {
  const date=String(source.date||"").slice(0,10),hours=context.dayMap.get(date)||[];
  const vals=key=>hours.map(r=>num(r[key])).filter(v=>v!==null);
  const levels=vals("water_level"),release=releaseStatistics(date,hours);
  return {...source,
    water_level_min:levels.length?Math.min(...levels):source.water_level_min,
    water_level_max:levels.length?Math.max(...levels):source.water_level_max,
    turbine_running_hours:num(source.turbine_running_hours)??(hours.length?release.turbine_hours:null),
    turbine_continuous_hours:num(source.turbine_continuous_hours)??(hours.length?release.turbine_continuous_hours:null),
    operation_sample_hours:hours.length,reservoir_level_hours:levels.length,
    reservoir_flow_hours:hours.filter(r=>num(r.turbine_flow)!==null&&num(r.spillway_flow)!==null&&num(r.turbine_flow)>=0&&num(r.spillway_flow)>=0).length,
    complete_operating_day:release.complete,release_statistics:release,
    release_total_hours:hours.length?release.total_hours:null,release_period_count:hours.length?release.period_count:null,
    hourly_assessment:hours.map(r=>({time:r.time,actual_time_utc:new Date(r.instant).toISOString(),water_level:r.water_level,
      turbine_flow:r.turbine_flow,spillway_flow:r.spillway_flow,total_outflow:num(r.turbine_flow)===null||num(r.spillway_flow)===null?null:num(r.turbine_flow)+num(r.spillway_flow)})),
  };
}

function summarizeReasonsQt1865(rows) {
  const reasonMap = new Map();

  for (const row of rows || []) {
    if (row.is_provisional) continue;
    const reason = String(row.reason || "").trim();

    if (row.is_evaluable !== false && row.is_compliant && !reason.includes("Cảnh báo")) {
      continue;
    }

    const key = reason || "Không xác định";
    reasonMap.set(key, (reasonMap.get(key) || 0) + 1);
  }

  return Array.from(reasonMap.entries())
    .map(([reason, count]) => ({
      reason,
      count,
      days: count,
    }))
    .sort((a, b) => b.count - a.count);
}

function summarizeQt1865Rows(rows) {
  const dataDays = rows.length;
  const provisionalDays = rows.filter(r => r.is_provisional).length;
  const evaluatedRows = rows.filter(r => !r.is_provisional && r.is_evaluable !== false && typeof r.is_compliant === "boolean");
  const totalDays = evaluatedRows.length;
  const unevaluatedDays = dataDays - provisionalDays - totalDays;

  const compliantDays = evaluatedRows.filter(r => r.is_compliant === true).length;
  const nonCompliantDays = evaluatedRows.filter(r => r.is_compliant === false).length;

  const warningDays = evaluatedRows.filter(r =>
    String(r.reason || "").includes("Cảnh báo")
  ).length;
  const warningCompliantDays = evaluatedRows.filter(r =>
    r.is_compliant === true && String(r.reason || "").includes("Cảnh báo")
  ).length;

  const turbineRows = rows.filter(r => !r.is_provisional && r.turbine_12h_required === true);
  const turbine12hCompliantDays = turbineRows.filter(r =>
    r.is_turbine_12h_compliant === true
  ).length;
  const turbine12hNonCompliantDays = turbineRows.filter(r => r.is_turbine_12h_compliant === false).length;
  const turbine12hApplicableDays = turbineRows.length;
  const turbine12hEvaluatedDays = turbine12hCompliantDays + turbine12hNonCompliantDays;
  const normalFlowRows = rows.filter(r => !r.is_provisional && typeof r.normal_flow_compliant === "boolean");

  const waterLevelAvgValues = rows.map(r =>
    pickNumber(r, [
      "water_level_avg",
      "mnh_avg",
      "mnh",
      "waterLevelAvg",
    ])
  );

  const totalOutflowValues = rows.map(r =>
    pickNumber(r, [
      "total_outflow_avg",
      "outflow_avg",
      "q_out_avg",
      "qxa_avg",
    ])
  );

  const inflowValues = rows.map(r =>
    pickNumber(r, [
      "inflow_avg",
      "q_in_avg",
      "inflow",
      "qve_avg",
    ])
  );

  const turbineFlowValues = rows.map(r =>
    pickNumber(r, [
      "turbine_flow_avg",
      "q_turbine_avg",
      "qcm_avg",
      "turbine_avg",
    ])
  );

  const spillwayFlowValues = rows.map(r =>
    pickNumber(r, [
      "spillway_flow_avg",
      "q_spillway_avg",
      "qxa_avg",
      "spillway_avg",
    ])
  );

  const rainfallValues = rows.map(r =>
    pickNumber(r, [
      "rainfall_total",
      "rainfall",
      "rainfallreal",
      "rain_total",
    ])
  );

  const waterLevelMax = extremeFromRows(
    rows,
    [
      "water_level_max",
      "water_level_avg",
      "mnh_avg",
      "mnh",
    ],
    "max"
  );

  const waterLevelMin = extremeFromRows(
    rows,
    [
      "water_level_min",
      "water_level_avg",
      "mnh_avg",
      "mnh",
    ],
    "min"
  );

  const inflowMax = extremeFromRows(
    rows,
    [
      "inflow_max",
      "inflow_avg",
      "q_in_avg",
      "inflow",
      "qve_avg",
    ],
    "max"
  );

  const totalOutflowMax = extremeFromRows(
    rows,
    [
      "total_outflow_max",
      "total_outflow_avg",
      "outflow_avg",
      "q_out_avg",
      "qxa_avg",
    ],
    "max"
  );

  const rainMax = extremeFromRows(
    rows,
    [
      "rainfall_total",
      "rainfall",
      "rainfallreal",
      "rain_total",
    ],
    "max"
  );

  const summary = {
    dataDays,
    totalDays,
    evaluatedDays: totalDays,
    unevaluatedDays,
    provisionalDays,
    compliantDays,
    nonCompliantDays,
    warningDays,
    warningCompliantDays,
    complianceRate: totalDays
      ? Number(((compliantDays / totalDays) * 100).toFixed(1))
      : null,

    turbine12hCompliantDays,
    turbine12hNonCompliantDays,
    turbine12hApplicableDays,
    turbine12hEvaluatedDays,
    turbine12hRate: turbine12hEvaluatedDays
      ? Number(((turbine12hCompliantDays / turbine12hEvaluatedDays) * 100).toFixed(1))
      : null,
    normalFlowCheckedDays:normalFlowRows.length,
    normalFlowMetDays:normalFlowRows.filter(r => r.normal_flow_compliant).length,
    normalFlowBelowDays:normalFlowRows.filter(r => !r.normal_flow_compliant).length,

    waterLevelAvg: round(avg(waterLevelAvgValues), 2),
    waterLevelMax: {
      value: round(waterLevelMax.value, 2),
      time: waterLevelMax.time,
      date: waterLevelMax.date,
    },
    waterLevelMin: {
      value: round(waterLevelMin.value, 2),
      time: waterLevelMin.time,
      date: waterLevelMin.date,
    },

    inflowAvg: round(avg(inflowValues), 2),
    inflowMax: {
      value: round(inflowMax.value, 2),
      time: inflowMax.time,
      date: inflowMax.date,
    },

    totalOutflowAvg: round(avg(totalOutflowValues), 2),
    totalOutflowMax: {
      value: round(totalOutflowMax.value, 2),
      time: totalOutflowMax.time,
      date: totalOutflowMax.date,
    },

    turbineFlowAvg: round(avg(turbineFlowValues), 2),
    spillwayFlowAvg: round(avg(spillwayFlowValues), 2),

    rainfallTotal: round(sum(rainfallValues), 2),
    rainyDays: rows.filter(r => {
      const rain = pickNumber(r, [
        "rainfall_total",
        "rainfall",
        "rainfallreal",
        "rain_total",
      ]);
      return rain !== null && rain > 0;
    }).length,

    rainMaxDay: {
      date: rainMax.date,
      value: round(rainMax.value, 2),
    },

    comment:
      dataDays === 0
        ? "Chưa có dữ liệu vận hành trong kỳ."
        : `Có ${dataDays} ngày dữ liệu, ${totalDays} ngày đủ điều kiện đánh giá; tỷ lệ đảm bảo đạt ${
            totalDays
              ? Number(((compliantDays / totalDays) * 100).toFixed(1))
              : 0
          }%, số ngày không đảm bảo ${nonCompliantDays}, số ngày cảnh báo ${warningDays}.`,
  };

  summary.total_days = summary.totalDays;
  summary.data_days = summary.dataDays;
  summary.evaluated_days = summary.evaluatedDays;
  summary.unevaluated_days = summary.unevaluatedDays;
  summary.provisional_days = summary.provisionalDays;
  summary.compliant_days = summary.compliantDays;
  summary.non_compliant_days = summary.nonCompliantDays;
  summary.warning_days = summary.warningDays;
  summary.compliance_rate = summary.complianceRate;
  summary.turbine_12h_compliant_days = summary.turbine12hCompliantDays;
  summary.turbine_12h_non_compliant_days = summary.turbine12hNonCompliantDays;
  summary.turbine_12h_rate = summary.turbine12hRate;

  return summary;
}

function buildMonthlyQt1865Summary(rows, year) {
  const result = [];

  for (let m = 1; m <= 12; m++) {
    const monthRows = (rows || []).filter(r => monthOfDate(r.date) === m);
    const s = summarizeQt1865Rows(monthRows);

    result.push({
      year: Number(year),
      month: m,

      dataDays: s.dataDays,
      totalDays: s.totalDays,
      evaluatedDays: s.evaluatedDays,
      unevaluatedDays: s.unevaluatedDays,
      provisionalDays: s.provisionalDays,
      compliantDays: s.compliantDays,
      nonCompliantDays: s.nonCompliantDays,
      warningDays: s.warningDays,
      complianceRate: s.complianceRate,

      turbine12hCompliantDays: s.turbine12hCompliantDays,
      turbine12hNonCompliantDays: s.turbine12hNonCompliantDays,
      turbine12hApplicableDays:s.turbine12hApplicableDays,
      turbine12hEvaluatedDays:s.turbine12hEvaluatedDays,
      turbine12hRate: s.turbine12hRate,

      total_days: s.totalDays,
      compliant_days: s.compliantDays,
      non_compliant_days: s.nonCompliantDays,
      warning_days: s.warningDays,
      compliance_rate: s.complianceRate,
    });
  }

  return result;
}

async function fetchInflowFrequency(month, inflowAvg) {
  const q = num(inflowAvg);

  if (!SUPABASE_URL || !SUPABASE_KEY || !month || q === null) {
    return null;
  }

  try {
    const rows = await fetchSupabasePaged("monthly_inflow_frequency", params => {
      params.set("select", "frequency_percent,month,inflow_value");
      params.set("month", `eq.${month}`);
      params.set("order", "frequency_percent.asc");
    });

    if (!rows.length) return null;

    let nearest = rows[0];

    for (const row of rows) {
      const d1 = Math.abs(Number(row.inflow_value) - q);
      const d2 = Math.abs(Number(nearest.inflow_value) - q);

      if (d1 < d2) nearest = row;
    }

    const frequencyPercent = Number(nearest.frequency_percent);
    const frequencyLabel = formatPercentLabel(frequencyPercent);
    const inflowFrequencyValue = round(nearest.inflow_value, 2);
    const classification = classifyInflowFrequency(frequencyPercent);

    return {
      month,
      inflowAvg: round(q, 2),
      frequencyPercent,
      frequencyLabel,
      inflowFrequencyValue,
      classification,
      nearest,
      rows,
      comment: `Q về trung bình tháng ${month} là ${round(
        q,
        2
      )} m3/s, gần với tần suất P=${frequencyLabel}, tương ứng Q=${inflowFrequencyValue} m3/s.`,
    };
  } catch (_) {
    return null;
  }
}

async function handleQt1865Compliance(req, res) {
  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());

    const hasMonth =
      req.query.month !== undefined &&
      req.query.month !== null &&
      String(req.query.month).trim() !== "";

    const month = hasMonth ? Number(req.query.month) : null;

    if (!year || (hasMonth && (!month || month < 1 || month > 12))) {
      return json(res, 400, {
        ok: false,
        mode: "qt1865",
        error: "Invalid year/month",
      });
    }

    const range = hasMonth
      ? monthRangeDate(year, month)
      : yearRangeDate(year);

    const [sourceRows,context] = await Promise.all([
      fetchQt1865Rows(range.start, range.end),loadComplianceContext(range.start,range.end),
    ]);
    const rows = sourceRows.map(row => normalizeProcedureRow(attachComplianceContext(row,context), todayInVietnam()));
    const sourceCoverage={sources:context.sources,
      days_with_hourly_data:rows.filter(r=>r.operation_sample_hours>0).length,
      complete_hourly_days:rows.filter(r=>r.complete_operating_day).length,
      required_sources:["reservoir_release_compliance_1865","reservoir_hourly_data"],
      note:"Q ngày dùng nguyên giá trị trung bình trong Supabase. Số liệu giờ 01–24 dùng kiểm tra thời gian vận hành/xả nước mùa cạn.",
    };
    const assessmentScope="Kiểm tra Q chạy máy, Q xả trung bình ngày tối thiểu, mực nước tham chiếu và thời gian vận hành theo mùa/quy trình áp dụng.";
    if(String(req.query.mode||"").toLowerCase()==="diagnostics")return json(res,200,{ok:true,fixVersion:FIX_VERSION,period:range,sourceCoverage,assessmentScope});
    if(String(req.query.mode||"").toLowerCase()==="hourly"){
      const day=String(req.query.date||"").slice(0,10),row=rows.find(r=>r.date===day);
      if(!row)return json(res,404,{ok:false,error:"Không có ngày được yêu cầu trong kỳ báo cáo"});
      return json(res,200,{ok:true,fixVersion:FIX_VERSION,date:day,sourceCoverage,assessmentScope,hours:row.hourly_assessment,releaseStatistics:row.release_statistics});
    }

    const summary = summarizeQt1865Rows(rows);
    const summaryByReason = summarizeReasonsQt1865(rows);
    const monthlySummary = buildMonthlyQt1865Summary(rows, year);

    let inflowFrequency = null;

    if (hasMonth) {
      inflowFrequency = await fetchInflowFrequency(
        month,
        summary.inflowAvg
      );

      if (inflowFrequency) {
        summary.inflowFrequency = inflowFrequency;
      }
    }

    return json(res, 200, {
      ok: true,
      fixVersion:FIX_VERSION,
      waterLevelBasis:"END_OF_OPERATION_DAY", timeBasis:"OPERATION_CLOCK_01_24",
      mode: "procedure-compliance",
      source: "supabase",
      sourceCoverage,
      assessmentScope,
      procedureLabel: range.end < QT2138_EFFECTIVE_FROM
        ? "QT1865"
        : range.start >= QT2138_EFFECTIVE_FROM
          ? "QT2138"
          : "QT1865 đến 05/11/2026; QT2138 từ 06/11/2026",
      effectiveFrom: QT2138_EFFECTIVE_FROM,

      year,
      month: hasMonth ? month : null,

      period: {
        start: range.start,
        end: range.end,
      },

      summary,
      rows:rows.map(({hourly_assessment,...row})=>row),
      summaryByReason,
      monthlySummary,

      inflowFrequency,
      frequencyTable: inflowFrequency?.rows || [],
      count: rows.length,
      sourceCount: sourceRows.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "qt1865",
      error: err.message,
    });
  }
}

/* =========================================================
   MONTHLY REPORT MODE
   ========================================================= */

async function fetchAllHourly(startIso, endIso) {
  return fetchSupabasePaged("reservoir_hourly_data", params => {
    params.set(
      "select",
      "time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal"
    );
    params.append("time", `gte.${startIso}`);
    params.append("time", `lt.${endIso}`);
    params.set("order", "time.asc");
  });
}

async function fetchLevelLimits(year) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  try {
    return await fetchSupabasePaged("reservoir_level_limits", params => {
      params.set("select", "date,mnghd,mnght,mndl,mntrl");
      params.append("date", `gte.${year}-01-01`);
      params.append("date", `lte.${year}-12-31`);
      params.set("order", "date.asc");
    });
  } catch (_) {
    return [];
  }
}

async function fetchQt1865Summary(year, month) {
  try {
    const { start, end } = monthRangeDate(year, month);
    const sourceRows = await fetchQt1865Rows(start, end);
    const context = await loadComplianceContext(start, end);
    const rows = sourceRows.map(row => normalizeProcedureRow(attachComplianceContext(row,context), todayInVietnam()));
    const summary = summarizeQt1865Rows(rows);
    const reasons = summarizeReasonsQt1865(rows).map(r => ({
      reason: r.reason,
      days: r.days,
    }));

    return {
      totalDays: summary.totalDays,
      compliantDays: summary.compliantDays,
      nonCompliantDays: summary.nonCompliantDays,
      warningDays: summary.warningDays,
      complianceRate: summary.complianceRate,
      turbine12hCompliantDays: summary.turbine12hCompliantDays,
      turbine12hNonCompliantDays: summary.turbine12hNonCompliantDays,
      turbine12hRate: summary.turbine12hRate,
      reasons,
    };
  } catch (_) {
    return null;
  }
}

function groupDaily(rows) {
  const map = new Map();

  for (const r of rows) {
    const d = dateKey(r.time);

    if (!map.has(d)) {
      map.set(d, {
        date: d,
        waterLevels: [],
        inflows: [],
        turbineFlows: [],
        spillwayFlows: [],
        rainfallValues: [],
      });
    }

    const item = map.get(d);

    if (num(r.water_level) !== null) item.waterLevels.push(num(r.water_level));
    if (num(r.inflow) !== null) item.inflows.push(num(r.inflow));
    if (num(r.turbine_flow) !== null) item.turbineFlows.push(num(r.turbine_flow));
    if (num(r.spillway_flow) !== null) item.spillwayFlows.push(num(r.spillway_flow));
    if (num(r.rainfallreal) !== null) item.rainfallValues.push(num(r.rainfallreal));
  }

  return Array.from(map.values()).map(d => ({
    date: d.date,
    waterLevelAvg: round(avg(d.waterLevels), 2),
    waterLevelMax: round(
      d.waterLevels.length ? Math.max(...d.waterLevels) : null,
      2
    ),
    waterLevelMin: round(
      d.waterLevels.length ? Math.min(...d.waterLevels) : null,
      2
    ),
    inflowAvg: round(avg(d.inflows), 2),
    inflowMax: round(
      d.inflows.length ? Math.max(...d.inflows) : null,
      2
    ),
    turbineFlowAvg: round(avg(d.turbineFlows), 2),
    spillwayFlowAvg: round(avg(d.spillwayFlows), 2),
    rainfallTotal: round(sum(d.rainfallValues), 2),
  }));
}

function detectEvents(rows, daily, inflowFrequency = null) {
  const events = [];

  const inflowMax = findExtreme(rows, "inflow", "max");

  if (inflowMax.value !== null) {
    events.push({
      type: "inflow_max",
      level: inflowMax.value >= 500 ? "warning" : "info",
      time: inflowMax.time,
      title: "Lưu lượng về lớn nhất tháng",
      description: `Q về lớn nhất đạt ${round(inflowMax.value, 2)} m3/s.`,
    });
  }

  const wlMax = findExtreme(rows, "water_level", "max");

  if (wlMax.value !== null) {
    events.push({
      type: "water_level_max",
      level: "info",
      time: wlMax.time,
      title: "Mực nước hồ lớn nhất tháng",
      description: `MNH lớn nhất đạt ${round(wlMax.value, 2)} m.`,
    });
  }

  const rainMaxDay = daily.reduce((best, cur) => {
    if (!best) return cur;

    return (num(cur.rainfallTotal) || 0) >
      (num(best.rainfallTotal) || 0)
      ? cur
      : best;
  }, null);

  if (rainMaxDay && num(rainMaxDay.rainfallTotal) > 0) {
    events.push({
      type: "rain_max_day",
      level: rainMaxDay.rainfallTotal >= 50 ? "warning" : "info",
      time: rainMaxDay.date,
      title: "Ngày mưa lớn nhất tháng",
      description: `Lượng mưa ngày lớn nhất đạt ${round(
        rainMaxDay.rainfallTotal,
        2
      )} mm.`,
    });
  }

  const spillMax = findExtreme(rows, "spillway_flow", "max");

  if (spillMax.value && spillMax.value > 0) {
    events.push({
      type: "spillway_flow",
      level: "warning",
      time: spillMax.time,
      title: "Có ghi nhận xả tràn",
      description: `Q xả lớn nhất đạt ${round(
        spillMax.value,
        2
      )} m3/s.`,
    });
  }

  if (inflowFrequency) {
    events.push({
      type: "inflow_frequency",
      level: inflowFrequency.frequencyPercent >= 0.75 ? "warning" : "info",
      time: null,
      title: "Tần suất nước về tháng",
      description: `Q về trung bình tháng ${inflowFrequency.month} đạt ${inflowFrequency.inflowAvg} m3/s, gần tần suất P=${inflowFrequency.frequencyLabel}, thuộc ${inflowFrequency.classification.toLowerCase()}.`,
    });
  }

  return events;
}

function formatReasonSummary(qt1865Summary) {
  if (!qt1865Summary || !Array.isArray(qt1865Summary.reasons)) {
    return "- Chưa có dữ liệu nguyên nhân QT1865.";
  }

  if (!qt1865Summary.reasons.length) {
    return "- Không ghi nhận nguyên nhân không đảm bảo/cảnh báo nổi bật.";
  }

  return qt1865Summary.reasons
    .map(r => `- ${r.reason}: ${r.days} ngày`)
    .join("\n");
}

function makeAiPrompt(data) {
  const f = data.inflowFrequency;
  const q = data.qt1865Summary;

  const waterLevelChange = data.summary.waterLevelChange;
  const overallRating = classifyOverallRating(q?.complianceRate);

  return `
Bạn là **Chuyên gia vận hành hồ chứa thủy điện A Vương**, am hiểu thủy văn, điều tiết hồ chứa, vận hành phát điện và yêu cầu tuân thủ Quy trình liên hồ chứa 1865.

Nhiệm vụ của bạn là viết **nhận xét báo cáo tháng phục vụ lãnh đạo**, không chỉ mô tả số liệu mà phải:
- Đánh giá trạng thái hồ chứa.
- Phân tích xu thế nguồn nước.
- Nhận diện rủi ro vận hành.
- Đánh giá mức độ tuân thủ QT1865.
- Đưa ra kiến nghị cụ thể, có thể hành động.

Văn phong:
- Kỹ thuật, rõ ràng, ngắn gọn.
- Giống văn phong báo cáo nội bộ ngành điện/thủy điện.
- Không viết chung chung.
- Không phóng đại, không suy diễn vượt dữ liệu.
- Nếu dữ liệu chưa đủ để kết luận, ghi rõ là “cần tiếp tục theo dõi”.

Dữ liệu tháng ${data.month}/${data.year}:

I. Dữ liệu mực nước hồ
- Mực nước hồ lớn nhất: ${data.summary.waterLevelMax?.value ?? "-"} m lúc ${data.summary.waterLevelMax?.time ?? "-"}
- Mực nước hồ nhỏ nhất: ${data.summary.waterLevelMin?.value ?? "-"} m lúc ${data.summary.waterLevelMin?.time ?? "-"}
- Mực nước đầu kỳ: ${data.summary.waterLevelStart ?? "-"} m
- Mực nước cuối kỳ: ${data.summary.waterLevelEnd ?? "-"} m
- Biến đổi mực nước trong kỳ: ${waterLevelChange ?? "-"} m

II. Dữ liệu dòng chảy và vận hành
- Q về trung bình: ${data.summary.inflowAvg ?? "-"} m³/s
- Q về lớn nhất: ${data.summary.inflowMax?.value ?? "-"} m³/s lúc ${data.summary.inflowMax?.time ?? "-"}
- Q chạy máy trung bình: ${data.summary.turbineFlowAvg ?? "-"} m³/s
- Q xả trung bình: ${data.summary.spillwayFlowAvg ?? "-"} m³/s

III. Dữ liệu mưa
- Tổng lượng mưa tháng: ${data.summary.rainfallTotal ?? "-"} mm
- Số ngày có mưa: ${data.summary.rainyDays ?? "-"} ngày
- Ngày mưa lớn nhất: ${data.summary.rainMaxDay?.date ?? "-"} với ${data.summary.rainMaxDay?.value ?? "-"} mm

IV. Đánh giá tần suất nước về
${f ? `- Q về trung bình tháng: ${f.inflowAvg} m³/s
- Gần với tần suất P=${f.frequencyLabel}
- Giá trị tra bảng tại tần suất gần nhất: ${f.inflowFrequencyValue} m³/s
- Phân loại thủy văn: ${f.classification}
- Nhận xét tần suất: ${f.comment}` : `- Chưa có dữ liệu tần suất nước về hoặc chưa tra được bảng tần suất.`}

V. Đánh giá tuân thủ QT1865
- Tổng số ngày có dữ liệu: ${q?.totalDays ?? "-"} ngày
- Số ngày đảm bảo quy trình: ${q?.compliantDays ?? "-"} ngày
- Số ngày không đảm bảo: ${q?.nonCompliantDays ?? "-"} ngày
- Số ngày cảnh báo Q cao hơn quy định nhưng vẫn tính đảm bảo: ${q?.warningDays ?? "-"} ngày
- Tỷ lệ đảm bảo quy trình: ${q?.complianceRate ?? "-"}%
- Số ngày đạt yêu cầu chạy máy liên tục tối thiểu 12 giờ: ${q?.turbine12hCompliantDays ?? "-"} ngày
- Số ngày không đạt yêu cầu chạy máy 12 giờ: ${q?.turbine12hNonCompliantDays ?? "-"} ngày
- Tỷ lệ đạt yêu cầu chạy máy 12 giờ: ${q?.turbine12hRate ?? "-"}%
- Các nguyên nhân không đảm bảo/cảnh báo chính:
${formatReasonSummary(q)}

Yêu cầu trả về đúng 6 mục sau:

1. Nhận xét chung
2. Thủy văn và dòng chảy
3. Đánh giá tần suất nước về hồ
4. Mưa trong tháng
5. Vận hành hồ chứa và tuân thủ QT1865
6. Kết luận và kiến nghị

Cuối báo cáo thêm dòng:
Đánh giá chung: ${overallRating}

Không dùng markdown bảng.
Không dùng gạch đầu dòng quá dài.
Không viết quá 900 từ.
`.trim();
}

async function handleMonthlyReport(req, res) {
  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, {
        ok: false,
        mode: "monthly-report",
        error: "Invalid year/month",
      });
    }

    const { startIso, endIso } = monthRangeUtc(year, month);

    const rows = await fetchAllHourly(startIso, endIso);
    const daily = groupDaily(rows);
    const limits = await fetchLevelLimits(year);

    const first = rows[0] || null;
    const last = rows[rows.length - 1] || null;

    const rainMaxDay = daily.reduce((best, cur) => {
      if (!best) return cur;

      return (num(cur.rainfallTotal) || 0) >
        (num(best.rainfallTotal) || 0)
        ? cur
        : best;
    }, null);

    const summary = {
      recordCount: rows.length,
      dayCount: daily.length,

      waterLevelStart: first ? round(first.water_level, 2) : null,
      waterLevelEnd: last ? round(last.water_level, 2) : null,

      waterLevelChange:
        first && last
          ? round(num(last.water_level) - num(first.water_level), 2)
          : null,

      waterLevelAvg: round(avg(rows.map(r => r.water_level)), 2),

      waterLevelMax: (() => {
        const x = findExtreme(rows, "water_level", "max");
        return {
          value: round(x.value, 2),
          time: x.time,
        };
      })(),

      waterLevelMin: (() => {
        const x = findExtreme(rows, "water_level", "min");
        return {
          value: round(x.value, 2),
          time: x.time,
        };
      })(),

      inflowAvg: round(avg(rows.map(r => r.inflow)), 2),

      inflowMax: (() => {
        const x = findExtreme(rows, "inflow", "max");
        return {
          value: round(x.value, 2),
          time: x.time,
        };
      })(),

      turbineFlowAvg: round(avg(rows.map(r => r.turbine_flow)), 2),

      spillwayFlowAvg: round(avg(rows.map(r => r.spillway_flow)), 2),

      rainfallTotal: round(sum(rows.map(r => r.rainfallreal)), 2),

      rainyDays: daily.filter(d => (num(d.rainfallTotal) || 0) > 0).length,

      rainMaxDay: rainMaxDay
        ? {
            date: rainMaxDay.date,
            value: round(rainMaxDay.rainfallTotal, 2),
          }
        : {
            date: null,
            value: null,
          },
    };

    const inflowFrequency = await fetchInflowFrequency(
      month,
      summary.inflowAvg
    );

    const qt1865Summary = await fetchQt1865Summary(year, month);

    const events = detectEvents(rows, daily, inflowFrequency);

    const result = {
      ok: true,
      mode: "monthly-report",
      source: "supabase",

      year,
      month,

      period: {
        start: startIso,
        endExclusive: endIso,
      },

      summary,
      inflowFrequency,
      qt1865Summary,
      daily,

      chartData: daily.map(d => ({
        date: d.date,
        waterLevelAvg: d.waterLevelAvg,
        inflowAvg: d.inflowAvg,
        turbineFlowAvg: d.turbineFlowAvg,
        spillwayFlowAvg: d.spillwayFlowAvg,
        rainfallTotal: d.rainfallTotal,
      })),

      levelLimits: limits,
      events,

      aiPrompt: makeAiPrompt({
        year,
        month,
        summary,
        inflowFrequency,
        qt1865Summary,
      }),
    };

    return json(res, 200, result);
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "monthly-report",
      error: err.message,
    });
  }
}

/* =========================================================
   PCTT ĐÀ NẴNG HYDRO MODE
   ========================================================= */

function getVietnamMonthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  const ym = `${y}-${String(m).padStart(2, "0")}`;

  const endDate = new Date(y, m, 0);
  const endDay = String(endDate.getDate()).padStart(2, "0");

  return {
    start: `${ym}-01T00:00:00+07:00`,
    end: `${ym}-${endDay}T23:59:59+07:00`,
  };
}

function parsePcttXml(xml) {
  const tables = String(xml || "").match(/<Table[\s\S]*?<\/Table>/g) || [];

  return tables.map(block => {
    const row = {};
    const re = /<([a-zA-Z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let match;

    while ((match = re.exec(block)) !== null) {
      const key = match[1];
      const raw = decodePcttXml(match[2] || "").trim();

      if (raw === "") {
        row[key] = null;
      } else if (
        key !== "thoigianxa" &&
        key !== "ngay" &&
        key !== "gio" &&
        Number.isFinite(Number(raw))
      ) {
        row[key] = Number(raw);
      } else {
        row[key] = raw;
      }
    }

    return row;
  });
}

function decodePcttXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function normalizePcttRow(row) {
  return {
    time: row.thoigianxa || null,
    date: row.ngay || null,
    hour: row.gio || null,

    reservoirs: [
      {
        id: 1,
        name: "Hồ thủy điện A Vương",
        shortName: "A Vương",
        waterLevel: numPctt(row.htl1),
        inflow: numPctt(row.qvao1),
        turbineFlow: numPctt(row.luuluongnhamay1),
        spillwayFlow: numPctt(row.qxaquacua1),
      },
      {
        id: 2,
        name: "Hồ thủy điện Đăk Mi 4",
        shortName: "Đăk Mi 4",
        waterLevel: numPctt(row.htl2),
        inflow: numPctt(row.qvao2),
        turbineFlow: numPctt(row.luuluongnhamay2),
        spillwayFlow: numPctt(row.qxaquacua2),
      },
      {
        id: 3,
        name: "Hồ thủy điện Sông Bung 4",
        shortName: "Sông Bung 4",
        waterLevel: numPctt(row.htl3),
        inflow: numPctt(row.qvao3),
        turbineFlow: numPctt(row.luuluongnhamay3),
        spillwayFlow: numPctt(row.qxaquacua3),
      },
      {
        id: 4,
        name: "Hồ thủy điện Sông Tranh 2",
        shortName: "Sông Tranh 2",
        waterLevel: numPctt(row.htl4),
        inflow: numPctt(row.qvao4),
        turbineFlow: numPctt(row.luuluongnhamay4),
        spillwayFlow: numPctt(row.qxaquacua4),
      },
    ],

    basin: {
      qVeVuGia: numPctt(row.qvevugia),
      qVeThuBon: numPctt(row.qvethubon),
    },

    raw: row,
  };
}

function numPctt(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dedupePcttRowsByTime(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = row.time;

    if (!map.has(key)) {
      map.set(key, row);
      continue;
    }

    const oldRow = map.get(key);

    if (scorePcttRow(row) > scorePcttRow(oldRow)) {
      map.set(key, row);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });
}

function scorePcttRow(row) {
  let score = 0;

  for (const r of row.reservoirs || []) {
    if (r.waterLevel !== null) score++;
    if (r.inflow !== null) score++;
    if (r.turbineFlow !== null) score++;
    if (r.spillwayFlow !== null) score++;
  }

  if (row.basin?.qVeVuGia !== null) score++;
  if (row.basin?.qVeThuBon !== null) score++;

  return score;
}

/* =========================================================
   PCTT DUPLICATE BREAKDOWN HELPERS
   ========================================================= */

function hasPcttReservoirValue(reservoir) {
  if (!reservoir) return false;

  return (
    reservoir.waterLevel !== null ||
    reservoir.inflow !== null ||
    reservoir.turbineFlow !== null ||
    reservoir.spillwayFlow !== null
  );
}

function pcttReservoirSignature(reservoir) {
  if (!reservoir) return "null|null|null|null";

  return [
    reservoir.waterLevel ?? "null",
    reservoir.inflow ?? "null",
    reservoir.turbineFlow ?? "null",
    reservoir.spillwayFlow ?? "null",
  ].join("|");
}

function buildPcttDuplicateStatsByPlant(rowsRaw) {
  const plantMap = new Map();

  for (const row of rowsRaw || []) {
    const time = row?.time || null;
    if (!time) continue;

    for (const reservoir of row.reservoirs || []) {
      if (!reservoir || !hasPcttReservoirValue(reservoir)) continue;

      const plantId = reservoir.id;
      const plantKey = String(plantId);

      if (!plantMap.has(plantKey)) {
        plantMap.set(plantKey, {
          id: reservoir.id,
          name: reservoir.name,
          shortName: reservoir.shortName,
          rawRows: 0,
          timeMap: new Map(),
        });
      }

      const plant = plantMap.get(plantKey);
      plant.rawRows += 1;

      if (!plant.timeMap.has(time)) {
        plant.timeMap.set(time, new Map());
      }

      const sigMap = plant.timeMap.get(time);
      const signature = pcttReservoirSignature(reservoir);
      sigMap.set(signature, (sigMap.get(signature) || 0) + 1);
    }
  }

  const stats = Array.from(plantMap.values())
    .map(plant => {
      let duplicateRows = 0;
      let duplicateTimestamps = 0;
      let uniqueRows = 0;
      let maxDuplicateAtOneTime = 0;

      for (const [, sigMap] of plant.timeMap.entries()) {
        let timeUniqueCount = 0;
        let timeDuplicateCount = 0;

        for (const [, count] of sigMap.entries()) {
          timeUniqueCount += 1;
          if (count > 1) {
            timeDuplicateCount += count - 1;
            if (count - 1 > maxDuplicateAtOneTime) {
              maxDuplicateAtOneTime = count - 1;
            }
          }
        }

        uniqueRows += timeUniqueCount;
        duplicateRows += timeDuplicateCount;
        if (timeDuplicateCount > 0) {
          duplicateTimestamps += 1;
        }
      }

      return {
        id: plant.id,
        name: plant.name,
        shortName: plant.shortName,
        rawRows: plant.rawRows,
        uniqueRows,
        duplicateRows,
        duplicateTimestamps,
        maxDuplicateAtOneTime,
      };
    })
    .sort((a, b) => a.id - b.id);

  const summary = {
    rawRows: stats.reduce((s, x) => s + x.rawRows, 0),
    uniqueRows: stats.reduce((s, x) => s + x.uniqueRows, 0),
    duplicateRows: stats.reduce((s, x) => s + x.duplicateRows, 0),
    plantsWithDuplicates: stats.filter(x => x.duplicateRows > 0).length,
  };

  return {
    stats,
    summary,
  };
}

async function handlePcttHydro(req, res) {
  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, {
        ok: false,
        mode: "pctt-hydro",
        error: "Invalid year/month",
      });
    }

    const vnRange = getVietnamMonthRange(year, month);

    const start = req.query.start || vnRange.start;
    const end = req.query.end || vnRange.end;
    const ids = String(req.query.ids || "1,2,3,4");

    const url =
      "https://pctt.danang.gov.vn/DesktopModules/PCTT/api/PCTTApi/baocaothuydiens_thongke" +
      `?ngaybatdau=${encodeURIComponent(start)}` +
      `&ngayketthuc=${encodeURIComponent(end)}` +
      `&lst_thuydien_id=${encodeURIComponent(ids)}`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/xml,text/xml,*/*",
        "User-Agent": "av-monitor-reservoir/1.0",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      return json(res, response.status, {
        ok: false,
        mode: "pctt-hydro",
        source: "pctt.danang.gov.vn",
        error: `PCTT API HTTP ${response.status}`,
        detail: text.slice(0, 1000),
        url,
      });
    }

    const rowsRaw = parsePcttXml(text)
      .map(normalizePcttRow)
      .filter(r => r.time);

    const rows = dedupePcttRowsByTime(rowsRaw);
    const latest = rows[0] || null;

    const duplicateBreakdown = buildPcttDuplicateStatsByPlant(rowsRaw);

    return json(res, 200, {
      ok: true,
      mode: "pctt-hydro",
      source: "pctt.danang.gov.vn",

      year,
      month,
      ids,

      period: {
        start,
        endInclusive: end,
      },

      // giữ nguyên field cũ
      countRaw: rowsRaw.length,
      count: rows.length,
      duplicateCount: rowsRaw.length - rows.length,

      // field mới
      duplicateStatsByPlant: duplicateBreakdown.stats,
      duplicateStatsSummary: duplicateBreakdown.summary,

      latest,
      data: rows,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      mode: "pctt-hydro",
      error: err.message,
    });
  }
}

/* =========================================================
   MAIN HANDLER
   ========================================================= */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "GET") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed",
    });
  }

  const mode = String(req.query.mode || "qt1865").trim();

  if (mode === "pctt-hydro") {
    return handlePcttHydro(req, res);
  }

  if (mode === "monthly-report") {
    return handleMonthlyReport(req, res);
  }

  return handleQt1865Compliance(req, res);
}
