/**
 * Vercel API:
 *
 * 1) API cũ:
 *    /api/qt1865-compliance?year=2026&month=6
 *
 * 2) API PCTT Hydro:
 *    /api/qt1865-compliance?mode=pctt-hydro&year=2026&month=6&ids=1,2,3,4
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
  return res.status(status).json(data);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 2) {
  const n = num(v);
  if (n === null) return null;
  return Number(n.toFixed(d));
}

function sum(values) {
  return values.reduce((s, v) => s + (num(v) || 0), 0);
}

function avg(values) {
  const arr = values.map(num).filter(v => v !== null);
  if (!arr.length) return null;
  return sum(arr) / arr.length;
}

function findExtreme(rows, key, type = "max") {
  const valid = rows
    .map(r => ({ time: r.time, value: num(r[key]) }))
    .filter(x => x.value !== null);

  if (!valid.length) return { value: null, time: null };

  return valid.reduce((best, cur) => {
    if (type === "min") return cur.value < best.value ? cur : best;
    return cur.value > best.value ? cur : best;
  }, valid[0]);
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
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(Number(year), Number(month), 0);
  const end = `${year}-${String(month).padStart(2, "0")}-${String(
    endDate.getDate()
  ).padStart(2, "0")}`;

  return { start, end };
}

function dateKey(iso) {
  return new Date(iso).toISOString().slice(0, 10);
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
  const r = num(rate) || 0;
  if (r >= 90) return "TỐT";
  if (r >= 80) return "KHÁ";
  if (r >= 70) return "TRUNG BÌNH";
  return "CẦN CẢI THIỆN";
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
    waterLevelMax: round(d.waterLevels.length ? Math.max(...d.waterLevels) : null, 2),
    waterLevelMin: round(d.waterLevels.length ? Math.min(...d.waterLevels) : null, 2),
    inflowAvg: round(avg(d.inflows), 2),
    inflowMax: round(d.inflows.length ? Math.max(...d.inflows) : null, 2),
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

    return (num(cur.rainfallTotal) || 0) > (num(best.rainfallTotal) || 0)
      ? cur
      : best;
  }, null);

  if (rainMaxDay && num(rainMaxDay.rainfallTotal) > 0) {
    events.push({
      type: "rain_max_day",
      level: rainMaxDay.rainfallTotal >= 50 ? "warning" : "info",
      time: rainMaxDay.date,
      title: "Ngày mưa lớn nhất tháng",
      description: `Lượng mưa ngày lớn nhất đạt ${round(rainMaxDay.rainfallTotal, 2)} mm.`,
    });
  }

  const spillMax = findExtreme(rows, "spillway_flow", "max");

  if (spillMax.value && spillMax.value > 0) {
    events.push({
      type: "spillway_flow",
      level: "warning",
      time: spillMax.time,
      title: "Có ghi nhận xả tràn",
      description: `Q xả lớn nhất đạt ${round(spillMax.value, 2)} m3/s.`,
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
- Đánh giá tổng thể trạng thái hồ trong tháng.
- Nêu rõ hồ đang ở trạng thái: tích nước, suy giảm dung tích, vận hành bình thường, thận trọng nguồn nước, hoặc cần chú ý.
- Không chỉ lặp lại số liệu.

2. Thủy văn và dòng chảy
- Phân tích xu thế Q về hồ.
- So sánh tương quan giữa Q về, Q chạy máy, Q xả và biến động mực nước.
- Nhận diện rủi ro nguồn nước nếu có.

3. Đánh giá tần suất nước về hồ
- Diễn giải ý nghĩa tần suất nước về.
- Cho biết tháng này thuộc nhóm nhiều nước, trung bình, ít nước hoặc rất ít nước.
- Đánh giá ảnh hưởng đến phát điện, tích nước và vận hành các tháng tiếp theo.

4. Mưa trong tháng
- Nhận xét vai trò của mưa đối với dòng chảy về hồ.
- Đánh giá phân bố mưa có hỗ trợ cải thiện nguồn nước hay không.
- Nếu tổng mưa có nhưng mực nước vẫn giảm, cần nêu rõ khả năng mưa chưa đủ để bù lượng nước ra/vận hành.

5. Vận hành hồ chứa và tuân thủ QT1865
- Đánh giá chế độ vận hành hồ trong tháng.
- Phân tích số ngày đảm bảo, không đảm bảo, cảnh báo.
- Phân biệt rõ:
  + Ngày “cảnh báo Q cao hơn quy định” nhưng vẫn đảm bảo.
  + Ngày “không đảm bảo” do mực nước hoặc lưu lượng.
  + Ngày không đạt chạy máy liên tục 12 giờ.
- Nhận định mức độ ảnh hưởng đến vận hành và tuân thủ quy trình.

6. Kết luận và kiến nghị
- Đưa ra kết luận ngắn gọn về tình hình vận hành tháng.
- Đưa ra ít nhất 3 kiến nghị cụ thể, có thể hành động.
- Kiến nghị phải gắn với số liệu thực tế.

Cuối báo cáo thêm dòng:
Đánh giá chung: ${overallRating}

Không dùng markdown bảng.
Không dùng gạch đầu dòng quá dài.
Không viết quá 900 từ.
`.trim();
}

async function fetchAllHourly(startIso, endIso) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const pageSize = 1000;
  let offset = 0;
  let all = [];

  while (true) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/reservoir_hourly_data`);

    url.searchParams.set(
      "select",
      "time,water_level,inflow,turbine_flow,spillway_flow,rainfallreal"
    );

    url.searchParams.append("time", `gte.${startIso}`);
    url.searchParams.append("time", `lt.${endIso}`);
    url.searchParams.set("order", "time.asc");
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
      throw new Error(`Supabase ${response.status}: ${text}`);
    }

    const rows = text ? JSON.parse(text) : [];

    all = all.concat(rows);

    if (rows.length < pageSize) break;

    offset += pageSize;
  }

  return all;
}

async function fetchLevelLimits(year) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  try {
    const url = new URL(`${SUPABASE_URL}/rest/v1/reservoir_level_limits`);

    url.searchParams.set("select", "date,mnghd,mnght,mndl,mntrl");
    url.searchParams.append("date", `gte.${year}-01-01`);
    url.searchParams.append("date", `lte.${year}-12-31`);
    url.searchParams.set("order", "date.asc");
    url.searchParams.set("limit", "400");

    const response = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const text = await response.text();

    if (!response.ok) return [];

    return text ? JSON.parse(text) : [];
  } catch (_) {
    return [];
  }
}

async function fetchInflowFrequency(month, inflowAvg) {
  const q = num(inflowAvg);

  if (!SUPABASE_URL || !SUPABASE_KEY || !month || q === null) {
    return null;
  }

  try {
    const url = new URL(`${SUPABASE_URL}/rest/v1/monthly_inflow_frequency`);

    url.searchParams.set("select", "frequency_percent,month,inflow_value");
    url.searchParams.set("month", `eq.${month}`);
    url.searchParams.set("order", "frequency_percent.asc");

    const response = await fetch(url.toString(), {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const text = await response.text();

    if (!response.ok) return null;

    const rows = text ? JSON.parse(text) : [];

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
      comment: `Q về trung bình tháng ${month} là ${round(q, 2)} m3/s, gần với tần suất P=${frequencyLabel}, tương ứng Q=${inflowFrequencyValue} m3/s.`,
    };
  } catch (_) {
    return null;
  }
}

async function fetchQt1865Summary(year, month) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  try {
    const { start, end } = monthRangeDate(year, month);
    const url = new URL(`${SUPABASE_URL}/rest/v1/reservoir_release_compliance_1865`);

    url.searchParams.set(
      "select",
      "date,is_compliant,reason,is_turbine_12h_compliant"
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

    if (!response.ok) return null;

    const rows = text ? JSON.parse(text) : [];

    const totalDays = rows.length;
    const compliantDays = rows.filter(r => r.is_compliant).length;
    const nonCompliantDays = totalDays - compliantDays;
    const warningDays = rows.filter(r =>
      String(r.reason || "").includes("Cảnh báo")
    ).length;

    const turbine12hCompliantDays = rows.filter(
      r => r.is_turbine_12h_compliant
    ).length;

    const turbine12hNonCompliantDays =
      totalDays - turbine12hCompliantDays;

    const reasonMap = new Map();

    rows.forEach(r => {
      if (r.is_compliant && !String(r.reason || "").includes("Cảnh báo")) {
        return;
      }

      const reason = r.reason || "Không xác định";
      reasonMap.set(reason, (reasonMap.get(reason) || 0) + 1);
    });

    return {
      totalDays,
      compliantDays,
      nonCompliantDays,
      warningDays,
      complianceRate: totalDays
        ? Number(((compliantDays / totalDays) * 100).toFixed(1))
        : 0,
      turbine12hCompliantDays,
      turbine12hNonCompliantDays,
      turbine12hRate: totalDays
        ? Number(((turbine12hCompliantDays / totalDays) * 100).toFixed(1))
        : 0,
      reasons: Array.from(reasonMap.entries())
        .map(([reason, days]) => ({ reason, days }))
        .sort((a, b) => b.days - a.days),
    };
  } catch (_) {
    return null;
  }
}

/* =========================================================
   PCTT ĐÀ NẴNG HYDRO MODE
   mode=pctt-hydro
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
      countRaw: rowsRaw.length,
      count: rows.length,
      duplicateCount: rowsRaw.length - rows.length,
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
        name: "A Vương",
        waterLevel: numPctt(row.htl1),
        inflow: numPctt(row.qvao1),
        turbineFlow: numPctt(row.luuluongnhamay1),
        spillwayFlow: numPctt(row.qxaquacua1),
      },
      {
        id: 2,
        name: "Hồ 2",
        waterLevel: numPctt(row.htl2),
        inflow: numPctt(row.qvao2),
        turbineFlow: numPctt(row.luuluongnhamay2),
        spillwayFlow: numPctt(row.qxaquacua2),
      },
      {
        id: 3,
        name: "Hồ 3",
        waterLevel: numPctt(row.htl3),
        inflow: numPctt(row.qvao3),
        turbineFlow: numPctt(row.luuluongnhamay3),
        spillwayFlow: numPctt(row.qxaquacua3),
      },
      {
        id: 4,
        name: "Hồ 4",
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

  if (req.query.mode === "pctt-hydro") {
    return handlePcttHydro(req, res);
  }

  try {
    const now = new Date();

    const year = Number(req.query.year || now.getFullYear());
    const month = Number(req.query.month || now.getMonth() + 1);

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, {
        ok: false,
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

      return (num(cur.rainfallTotal) || 0) > (num(best.rainfallTotal) || 0)
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
      error: err.message,
    });
  }
}
