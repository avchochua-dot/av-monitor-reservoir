const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const FORECAST_SOURCE_PRIORITY = [
  "rf2q_v7",
  "rf2q_v6",
  "rf2q_v5",
  "rf2q_v4"
];

function setCors(req, res) {
  const origin =
    String(req.headers.origin || "");

  const allowedOrigins = [
    "https://avuonghydro.com",
    "https://www.avuonghydro.com"
  ];

  const isVercelPreview =
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(
      origin
    );

  if (
    allowedOrigins.includes(origin) ||
    isVercelPreview
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader(
    "Vary",
    "Origin"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
}

function json(res, status, data) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  return res
    .status(status)
    .json(data);
}

function checkEnvironment(res) {
  if (
    !SUPABASE_URL ||
    !SUPABASE_KEY
  ) {
    json(res, 500, {
      ok: false,
      success: false,
      error:
        "Thiếu SUPABASE_URL hoặc khóa Supabase trên Vercel."
    });

    return false;
  }

  return true;
}

async function fetchSupabaseRows(url) {
  const response =
    await fetch(
      url.toString(),
      {
        headers: {
          apikey:
            SUPABASE_KEY,

          Authorization:
            `Bearer ${SUPABASE_KEY}`,

          "Content-Type":
            "application/json"
        }
      }
    );

  const responseText =
    await response.text();

  let result;

  try {
    result =
      responseText
        ? JSON.parse(responseText)
        : [];
  } catch {
    result = responseText;
  }

  if (!response.ok) {
    const error =
      new Error(
        result?.message ||
        result?.error ||
        responseText ||
        "Supabase trả về lỗi."
      );

    error.status =
      response.status;

    error.details =
      result;

    throw error;
  }

  return Array.isArray(result)
    ? result
    : [];
}

function parseNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function normalizeDateTime(value) {
  if (!value) {
    return "";
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return "";
  }

  return date.toISOString();
}

function getLatestCreatedAt(rows) {
  let latest = "";

  for (const row of rows) {
    if (!row.created_at) {
      continue;
    }

    if (
      !latest ||
      new Date(row.created_at) >
      new Date(latest)
    ) {
      latest =
        row.created_at;
    }
  }

  return latest;
}

function deduplicateForecastRows(rows) {
  const map =
    new Map();

  /*
   * Dữ liệu đã được sắp:
   * forecast_time tăng dần,
   * created_at giảm dần.
   *
   * Vì vậy bản ghi đầu tiên của mỗi
   * source + forecast_time là bản mới nhất.
   */
  for (const row of rows) {
    const key =
      `${row.source}|${row.forecast_time}`;

    if (!map.has(key)) {
      map.set(
        key,
        row
      );
    }
  }

  return Array.from(
    map.values()
  );
}

function groupForecastRowsBySource(rows) {
  const groups =
    new Map();

  for (const row of rows) {
    const source =
      String(
        row.source || ""
      );

    if (!source) {
      continue;
    }

    if (!groups.has(source)) {
      groups.set(
        source,
        []
      );
    }

    groups
      .get(source)
      .push(row);
  }

  return groups;
}

function chooseBestForecastSource(rows) {
  const groups =
    groupForecastRowsBySource(
      rows
    );

  const candidates =
    Array
      .from(
        groups.entries()
      )
      .map(
        ([
          source,
          sourceRows
        ]) => {
          const uniqueTimes =
            new Set(
              sourceRows.map(
                row =>
                  row.forecast_time
              )
            );

          const priorityIndex =
            FORECAST_SOURCE_PRIORITY
              .indexOf(source);

          return {
            source,
            rows:
              sourceRows,

            pointCount:
              uniqueTimes.size,

            updatedAt:
              getLatestCreatedAt(
                sourceRows
              ),

            priority:
              priorityIndex >= 0
                ? priorityIndex
                : 999
          };
        }
      )
      .sort((a, b) => {
        /*
         * Ưu tiên nguồn có nhiều mốc thời gian nhất.
         */
        if (
          b.pointCount !==
          a.pointCount
        ) {
          return (
            b.pointCount -
            a.pointCount
          );
        }

        /*
         * Nếu độ phủ bằng nhau,
         * ưu tiên lần cập nhật mới nhất.
         */
        const updatedDifference =
          new Date(
            b.updatedAt || 0
          ) -
          new Date(
            a.updatedAt || 0
          );

        if (
          updatedDifference !== 0
        ) {
          return updatedDifference;
        }

        /*
         * Cuối cùng dùng thứ tự ưu tiên mô hình.
         */
        return (
          a.priority -
          b.priority
        );
      });

  return (
    candidates[0] ||
    null
  );
}

function buildExpectedHourlyTimes(
  fromIso,
  toIso
) {
  const from =
    new Date(fromIso);

  const to =
    new Date(toIso);

  if (
    Number.isNaN(
      from.getTime()
    ) ||
    Number.isNaN(
      to.getTime()
    ) ||
    to < from
  ) {
    return [];
  }

  const result = [];

  const cursor =
    new Date(from);

  cursor.setUTCMinutes(
    0,
    0,
    0
  );

  const end =
    new Date(to);

  end.setUTCMinutes(
    0,
    0,
    0
  );

  while (
    cursor.getTime() <=
    end.getTime()
  ) {
    result.push(
      cursor.toISOString()
    );

    cursor.setUTCHours(
      cursor.getUTCHours() + 1
    );

    /*
     * Chống dữ liệu đầu vào bất thường
     * làm vòng lặp quá lớn.
     */
    if (
      result.length >
      24 * 366
    ) {
      break;
    }
  }

  return result;
}

function calculateForecastCoverage(
  rows,
  fromIso,
  toIso
) {
  const expectedTimes =
    buildExpectedHourlyTimes(
      fromIso,
      toIso
    );

  const receivedTimes =
    new Set(
      rows.map(row => {
        const date =
          new Date(
            row.forecast_time
          );

        if (
          Number.isNaN(
            date.getTime()
          )
        ) {
          return "";
        }

        date.setUTCMinutes(
          0,
          0,
          0
        );

        return date.toISOString();
      })
    );

  receivedTimes.delete("");

  const missingHours =
    expectedTimes.filter(
      value =>
        !receivedTimes.has(value)
    );

  return {
    expectedHours:
      expectedTimes.length,

    receivedHours:
      receivedTimes.size,

    missingHours,

    complete:
      expectedTimes.length > 0 &&
      missingHours.length === 0
  };
}

/* =========================================================
   CHẾ ĐỘ 1: TRA TẦN SUẤT Q VỀ THEO THÁNG
   ========================================================= */

async function handleFrequency(req, res) {
  const month =
    Number(
      req.query.month
    );

  const inflow =
    Number(
      req.query.inflow
    );

  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isFinite(inflow)
  ) {
    return json(
      res,
      400,
      {
        ok: false,
        success: false,
        mode:
          "frequency",

        error:
          "Thiếu hoặc sai month/inflow.",

        required:
          {
            month:
              "Số nguyên từ 1 đến 12",

            inflow:
              "Lưu lượng Q về dạng số"
          },

        query:
          req.query
      }
    );
  }

  const url =
    new URL(
      `${SUPABASE_URL}/rest/v1/monthly_inflow_frequency`
    );

  url.searchParams.set(
    "select",
    [
      "id",
      "frequency_percent",
      "month",
      "inflow_value"
    ].join(",")
  );

  url.searchParams.set(
    "month",
    `eq.${month}`
  );

  url.searchParams.set(
    "order",
    "frequency_percent.asc"
  );

  const rows =
    await fetchSupabaseRows(
      url
    );

  if (!rows.length) {
    return json(
      res,
      404,
      {
        ok: false,
        success: false,
        mode:
          "frequency",

        error:
          "Không tìm thấy dữ liệu tần suất Q về.",

        month,
        inflow,

        hint:
          "Kiểm tra dữ liệu monthly_inflow_frequency, RLS hoặc biến môi trường Vercel."
      }
    );
  }

  let nearest =
    rows[0];

  for (const row of rows) {
    const currentDistance =
      Math.abs(
        Number(
          row.inflow_value
        ) -
        inflow
      );

    const nearestDistance =
      Math.abs(
        Number(
          nearest.inflow_value
        ) -
        inflow
      );

    if (
      currentDistance <
      nearestDistance
    ) {
      nearest = row;
    }
  }

  return json(
    res,
    200,
    {
      ok: true,
      success: true,
      mode:
        "frequency",

      month,
      inflow,

      nearest: {
        id:
          nearest.id,

        frequencyPercent:
          parseNumber(
            nearest.frequency_percent
          ),

        month:
          Number(
            nearest.month
          ),

        inflowValue:
          parseNumber(
            nearest.inflow_value
          )
      },

      rows:
        rows.map(row => ({
          id:
            row.id,

          frequencyPercent:
            parseNumber(
              row.frequency_percent
            ),

          month:
            Number(
              row.month
            ),

          inflowValue:
            parseNumber(
              row.inflow_value
            )
        })),

      comment:
        `Q về trung bình tháng ${month} là ${inflow} m³/s, ` +
        `gần với tần suất P=${nearest.frequency_percent}% ` +
        `có Q=${nearest.inflow_value} m³/s.`
    }
  );
}

/* =========================================================
   CHẾ ĐỘ 2: LẤY CHUỖI Q VỀ DỰ BÁO THEO GIỜ
   ========================================================= */

async function handleForecast(req, res) {
  const source =
    String(
      req.query.source ||
      "auto"
    ).trim();

  const from =
    normalizeDateTime(
      req.query.from
    );

  const to =
    normalizeDateTime(
      req.query.to
    );

  if (!from || !to) {
    return json(
      res,
      400,
      {
        ok: false,
        success: false,
        mode:
          "forecast",

        error:
          "Thời gian from hoặc to không hợp lệ.",

        required:
          {
            source:
              "auto hoặc tên nguồn như rf2q_v7",

            from:
              "Thời điểm bắt đầu dạng ISO",

            to:
              "Thời điểm kết thúc dạng ISO"
          },

        query:
          req.query
      }
    );
  }

  if (
    new Date(to) <
    new Date(from)
  ) {
    return json(
      res,
      400,
      {
        ok: false,
        success: false,
        mode:
          "forecast",

        error:
          "Thời gian kết thúc phải sau thời gian bắt đầu."
      }
    );
  }

  const url =
    new URL(
      `${SUPABASE_URL}/rest/v1/inflow_forecast`
    );

  url.searchParams.set(
    "select",
    [
      "forecast_time",
      "source",
      "inflow_m3s",
      "base_q",
      "rain_mm",
      "lag_hours",
      "api24_mm",
      "lag_fast_h",
      "lag_slow_h",
      "created_at"
    ].join(",")
  );

  /*
   * Dùng append vì cùng một cột forecast_time
   * có cả điều kiện gte và lte.
   */
  url.searchParams.append(
    "forecast_time",
    `gte.${from}`
  );

  url.searchParams.append(
    "forecast_time",
    `lte.${to}`
  );

  if (
    source &&
    source !== "auto"
  ) {
    url.searchParams.set(
      "source",
      `eq.${source}`
    );
  }

  url.searchParams.set(
    "order",
    "forecast_time.asc,created_at.desc"
  );

  const rawRows =
    await fetchSupabaseRows(
      url
    );

  const deduplicatedRows =
    deduplicateForecastRows(
      rawRows
    );

  if (
    !deduplicatedRows.length
  ) {
    return json(
      res,
      404,
      {
        ok: false,
        success: false,
        mode:
          "forecast",

        error:
          "Không có dữ liệu Q về dự báo trong khoảng thời gian đã chọn.",

        source,
        from,
        to
      }
    );
  }

  let selectedSource =
    source;

  let selectedRows =
    deduplicatedRows;

  if (
    source === "auto"
  ) {
    const selected =
      chooseBestForecastSource(
        deduplicatedRows
      );

    if (!selected) {
      return json(
        res,
        404,
        {
          ok: false,
          success: false,
          mode:
            "forecast",

          error:
            "Không chọn được nguồn dự báo phù hợp."
        }
      );
    }

    selectedSource =
      selected.source;

    selectedRows =
      selected.rows;
  }

  selectedRows.sort(
    (a, b) =>
      new Date(
        a.forecast_time
      ) -
      new Date(
        b.forecast_time
      )
  );

  const data =
    selectedRows
      .map(row => ({
        forecastTime:
          row.forecast_time,

        source:
          row.source,

        inflowM3s:
          parseNumber(
            row.inflow_m3s
          ),

        baseQ:
          parseNumber(
            row.base_q
          ),

        rainMm:
          parseNumber(
            row.rain_mm
          ),

        lagHours:
          parseNumber(
            row.lag_hours
          ),

        api24Mm:
          parseNumber(
            row.api24_mm
          ),

        lagFastHours:
          parseNumber(
            row.lag_fast_h
          ),

        lagSlowHours:
          parseNumber(
            row.lag_slow_h
          ),

        createdAt:
          row.created_at
      }))
      .filter(
        row =>
          Number.isFinite(
            row.inflowM3s
          )
      );

  if (!data.length) {
    return json(
      res,
      422,
      {
        ok: false,
        success: false,
        mode:
          "forecast",

        error:
          "Có bản ghi dự báo nhưng không có giá trị inflow_m3s hợp lệ.",

        source:
          selectedSource
      }
    );
  }

  const values =
    data.map(
      row =>
        row.inflowM3s
    );

  const minimum =
    Math.min(...values);

  const maximum =
    Math.max(...values);

  const average =
    values.reduce(
      (sum, value) =>
        sum + value,
      0
    ) /
    values.length;

  const coverage =
    calculateForecastCoverage(
      data.map(row => ({
        forecast_time:
          row.forecastTime
      })),
      from,
      to
    );

  return json(
    res,
    200,
    {
      ok: true,
      success: true,
      mode:
        "forecast",

      requestedSource:
        source,

      source:
        selectedSource,

      from,
      to,

      updatedAt:
        getLatestCreatedAt(
          selectedRows
        ),

      statistics: {
        minimum:
          Number(
            minimum.toFixed(3)
          ),

        average:
          Number(
            average.toFixed(3)
          ),

        maximum:
          Number(
            maximum.toFixed(3)
          )
      },

      coverage,

      data
    }
  );
}

/* =========================================================
   API CHÍNH
   ========================================================= */

export default async function handler(req, res) {
  setCors(req, res);

  if (
    req.method === "OPTIONS"
  ) {
    return res
      .status(204)
      .end();
  }

  if (
    req.method !== "GET"
  ) {
    return json(
      res,
      405,
      {
        ok: false,
        success: false,
        error:
          "API chỉ hỗ trợ phương thức GET."
      }
    );
  }

  if (!checkEnvironment(res)) {
    return;
  }

  try {
    /*
     * Hỗ trợ cả action và mode để frontend dễ gọi.
     */
    const mode =
      String(
        req.query.action ||
        req.query.mode ||
        ""
      )
        .trim()
        .toLowerCase();

    /*
     * Tương thích với URL cũ:
     * nếu có month hoặc inflow thì chạy tra tần suất.
     */
    const isFrequencyRequest =
      mode === "frequency" ||
      (
        !mode &&
        (
          req.query.month !==
            undefined ||
          req.query.inflow !==
            undefined
        )
      );

    /*
     * Nếu có from/to hoặc chọn forecast thì lấy chuỗi dự báo.
     */
    const isForecastRequest =
      mode === "forecast" ||
      (
        !mode &&
        (
          req.query.from !==
            undefined ||
          req.query.to !==
            undefined ||
          req.query.source !==
            undefined
        )
      );

    if (
      isFrequencyRequest
    ) {
      return await handleFrequency(
        req,
        res
      );
    }

    if (
      isForecastRequest
    ) {
      return await handleForecast(
        req,
        res
      );
    }

    return json(
      res,
      400,
      {
        ok: false,
        success: false,

        error:
          "Chưa xác định chế độ xử lý API.",

        usage: {
          frequency:
            "/api/inflow-frequency?action=frequency&month=7&inflow=100",

          forecastAuto:
            "/api/inflow-frequency?action=forecast&source=auto&from=2026-07-27T18:00:00%2B07:00&to=2026-07-29T18:00:00%2B07:00",

          forecastBySource:
            "/api/inflow-frequency?action=forecast&source=rf2q_v7&from=2026-07-27T18:00:00%2B07:00&to=2026-07-29T18:00:00%2B07:00"
        }
      }
    );
  } catch (error) {
    console.error(
      "[inflow-frequency]",
      error
    );

    return json(
      res,
      error.status || 500,
      {
        ok: false,
        success: false,

        error:
          error.message ||
          "Lỗi hệ thống.",

        details:
          error.details ||
          null
      }
    );
  }
}
