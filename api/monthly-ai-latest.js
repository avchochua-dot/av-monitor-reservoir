/**
 * API GỘP:
 * 1. GET: Lấy báo cáo AI tháng mới nhất từ Supabase.
 * 2. POST: Phân tích phương án xả tràn bằng OpenAI.
 *
 * File:
 * api/monthly-ai-latest.js
 *
 * Biến môi trường bắt buộc trên Vercel:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - OPENAI_API_KEY
 *
 * Biến tùy chọn:
 * - OPENAI_MODEL
 */

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY;

const OPENAI_MODEL =
  process.env.OPENAI_MODEL ||
  "gpt-4.1-mini";

const OPENAI_API_URL =
  "https://api.openai.com/v1/responses";

const MAX_PROMPT_LENGTH =
  180000;

const MAX_OUTPUT_TOKENS =
  4096;


/**
 * Trả JSON thống nhất.
 */
function json(
  res,
  status,
  data,
  cacheControl = "no-store"
) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    cacheControl
  );

  return res
    .status(status)
    .json(data);
}


/**
 * Thiết lập CORS.
 */
function applyCors(
  req,
  res
) {
  const origin =
    String(
      req.headers.origin || ""
    );

  const isAllowed =
    !origin ||
    origin ===
      "https://avuonghydro.com" ||
    origin ===
      "https://www.avuonghydro.com" ||
    /^https:\/\/[a-z0-9-]+\.vercel\.app$/i
      .test(origin);

  if (
    origin &&
    isAllowed
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
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Max-Age",
    "86400"
  );

  return isAllowed;
}


/**
 * Router chính.
 */
export default async function handler(
  req,
  res
) {
  const allowed =
    applyCors(
      req,
      res
    );

  if (
    req.method ===
    "OPTIONS"
  ) {
    if (!allowed) {
      return json(
        res,
        403,
        {
          ok: false,
          success: false,
          error:
            "Origin không được phép."
        }
      );
    }

    return res
      .status(204)
      .end();
  }

  if (!allowed) {
    return json(
      res,
      403,
      {
        ok: false,
        success: false,
        error:
          "Origin không được phép."
      }
    );
  }

  try {
    if (
      req.method ===
      "GET"
    ) {
      return await handleMonthlyReportGet(
        req,
        res
      );
    }

    if (
      req.method ===
      "POST"
    ) {
      return await handlePostRequest(
        req,
        res
      );
    }

    return json(
      res,
      405,
      {
        ok: false,
        success: false,
        error:
          "Method not allowed"
      }
    );
  } catch (error) {
    console.error(
      "[monthly-ai-latest]",
      error
    );

    return json(
      res,
      500,
      {
        ok: false,
        success: false,
        answer: "",
        error:
          getErrorMessage(
            error
          )
      }
    );
  }
}


/**
 * GET:
 * Lấy báo cáo AI tháng mới nhất từ Supabase.
 *
 * Ví dụ:
 * /api/monthly-ai-latest
 * ?year=2026
 * &month=7
 * &reportType=reservoir_operation
 */
async function handleMonthlyReportGet(
  req,
  res
) {
  if (
    !SUPABASE_URL ||
    !SUPABASE_KEY
  ) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  const year =
    Number(
      req.query.year
    );

  const month =
    Number(
      req.query.month
    );

  const reportType =
    String(
      req.query.reportType ||
      "reservoir_operation"
    );

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12
  ) {
    return json(
      res,
      400,
      {
        ok: false,
        success: false,
        error:
          "Invalid year/month"
      }
    );
  }

  const url =
    new URL(
      `${SUPABASE_URL}/rest/v1/monthly_ai_reports`
    );

  url.searchParams.set(
    "select",
    "*"
  );

  url.searchParams.set(
    "year",
    `eq.${year}`
  );

  url.searchParams.set(
    "month",
    `eq.${month}`
  );

  url.searchParams.set(
    "report_type",
    `eq.${reportType}`
  );

  url.searchParams.set(
    "order",
    "created_at.desc"
  );

  url.searchParams.set(
    "limit",
    "1"
  );

  const response =
    await fetch(
      url.toString(),
      {
        method:
          "GET",

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

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${responseText}`
    );
  }

  let rows = [];

  if (responseText) {
    try {
      rows =
        JSON.parse(
          responseText
        );
    } catch (error) {
      throw new Error(
        "Supabase trả về JSON không hợp lệ."
      );
    }
  }

  return json(
    res,
    200,
    {
      ok: true,
      success: true,
      latest:
        Array.isArray(rows)
          ? rows[0] || null
          : null
    },
    "s-maxage=60, stale-while-revalidate=120"
  );
}


/**
 * Router cho các yêu cầu POST.
 */
async function handlePostRequest(
  req,
  res
) {
  const body =
    parseRequestBody(
      req.body
    );

  const action =
    String(
      body.action ||
      "spill-analysis"
    )
      .trim()
      .toLowerCase();

  if (
    action ===
      "spill-analysis" ||
    action ===
      "spill_analysis"
  ) {
    return await handleSpillAnalysis(
      body,
      res
    );
  }

  return json(
    res,
    400,
    {
      ok: false,
      success: false,
      answer: "",
      error:
        `Action không được hỗ trợ: ${action}`
    }
  );
}


/**
 * POST:
 * Phân tích phương án xả tràn bằng OpenAI.
 */
async function handleSpillAnalysis(
  body,
  res
) {
  if (!OPENAI_API_KEY) {
    return json(
      res,
      500,
      {
        ok: false,
        success: false,
        answer: "",
        error:
          "Backend chưa cấu hình OPENAI_API_KEY."
      }
    );
  }

  const question =
    String(
      body.question || ""
    ).trim();

  if (!question) {
    return json(
      res,
      400,
      {
        ok: false,
        success: false,
        answer: "",
        error:
          "Thiếu nội dung phương án cần AI phân tích."
      }
    );
  }

  if (
    question.length >
    MAX_PROMPT_LENGTH
  ) {
    return json(
      res,
      413,
      {
        ok: false,
        success: false,
        answer: "",
        error:
          "Dữ liệu phương án quá dài."
      }
    );
  }

  const sessionId =
    sanitizeSessionId(
      body.sessionId
    );

  const instructions =
    buildSpillInstructions();

  console.log(
    "[spill-analysis] request",
    {
      model:
        OPENAI_MODEL,
      sessionId:
        sessionId,
      questionLength:
        question.length
    }
  );

  const aiResult =
    await callOpenAI({
      instructions:
        instructions,
      input:
        question
    });

  console.log(
    "[spill-analysis] success",
    {
      model:
        aiResult.model,
      answerLength:
        aiResult.answer.length
    }
  );

  return json(
    res,
    200,
    {
      ok: true,
      success: true,

      answer:
        aiResult.answer,

      responseMode:
        "SPILL_ANALYSIS",

      provider:
        "openai",

      model:
        aiResult.model,

      responseId:
        aiResult.responseId,

      sessionId:
        sessionId,

      generatedAt:
        new Date()
          .toISOString(),

      sources: []
    }
  );
}


/**
 * Quy tắc dành riêng cho AI phân tích xả tràn.
 */
/**
 * Quy tắc dành riêng cho AI phân tích xả tràn.
 *
 * AI chỉ tạo một báo cáo phương án ngắn gọn,
 * không chia thành nhiều bản tóm tắt trùng nhau.
 */
function buildSpillInstructions() {
  return [
    "Bạn là trợ lý kỹ thuật hỗ trợ lập báo cáo phương án xả tràn hồ thủy điện A Vương.",
    "",
    "MỤC TIÊU",
    "",
    "Tạo một báo cáo phương án duy nhất, ngắn gọn, chính xác, dễ đọc và bám tuyệt đối vào dữ liệu được cung cấp.",
    "",
    "NGUYÊN TẮC BẮT BUỘC",
    "",
    "1. Chỉ sử dụng số liệu do hệ thống tính toán cung cấp.",
    "2. Không tự tính lại, không tự nội suy, không tự suy đoán và không thay đổi bất kỳ số liệu nào.",
    "3. Không phát lệnh vận hành.",
    "4. Không sử dụng từ tiếng Anh 'engine'; phải dùng cụm 'hệ thống tính toán'.",
    "5. Không dùng các kết luận tuyệt đối như 'an toàn', 'hoàn toàn khả thi', 'chắc chắn' hoặc 'ổn định thực tế'.",
    "6. Chỉ được kết luận theo dữ liệu đầu vào hiện tại và kết quả do hệ thống tính toán cung cấp.",
    "7. Tổng lưu lượng xả được hiểu là lưu lượng qua máy cộng lưu lượng qua tràn.",
    "8. Q máy phải gọi là 'lưu lượng qua máy', không được gọi là công suất máy phát.",
    "9. Q về hồ phải được mô tả là giá trị giả định, giá trị ước tính hoặc giá trị đầu vào dùng cho tính toán.",
    "10. Không được mô tả Q về hồ là lưu lượng ổn định thực tế hoặc khẳng định Q về không thay đổi.",
    "11. Khi Q về thực tế thay đổi đáng kể, phải yêu cầu cập nhật số liệu và tính toán lại phương án.",
    "12. Không được bỏ sót các thông số chính có giá trị.",
    "13. Không liệt kê lại toàn bộ bảng kết quả theo giờ.",
    "14. Không lặp lại cùng một số liệu ở nhiều đoạn.",
    "15. Không viết các câu chung chung khi dữ liệu đã có số cụ thể.",
    "",
    "QUY TẮC ƯU TIÊN DỮ LIỆU",
    "",
    "16. Thời gian bắt đầu chỉ được lấy từ input.start.",
    "17. Thời hạn chỉ được lấy từ input.deadline.",
    "18. Thời điểm đạt mục tiêu chỉ được lấy từ result.finishTime.",
    "19. Không được suy luận thời điểm đạt mục tiêu từ keyRows, hourly hoặc bảng kết quả theo giờ.",
    "20. Nếu result.finishTime không có giá trị, phải ghi 'chưa xác định', không được tự đoán.",
    "21. Nếu result.finishTime bằng input.deadline, phải ghi rõ phương án đạt mục tiêu đúng thời hạn.",
    "22. Nếu result.maintainedToDeadline là true, phải ghi rõ phương án duy trì mực nước hồ mục tiêu đến hết thời hạn.",
    "23. Nếu result.maintainedToDeadline là false, phải ghi rõ phương án chưa bảo đảm duy trì đến hết thời hạn.",
    "24. Nếu result.reached là false, không được viết phương án đã đạt mục tiêu.",
    "25. Nếu result.reached là true, không được viết phương án chưa đạt mục tiêu.",
    "26. Nếu result.exceedHours lớn hơn 0, phải nêu rõ có khoảng vượt giới hạn.",
    "27. Nếu result.nearHours lớn hơn 0 nhưng result.exceedHours bằng 0, phải nêu rõ có khoảng cận giới hạn nhưng không vượt giới hạn.",
    "28. Nếu có cảnh báo trong result.warnings, phải thể hiện ngắn gọn cảnh báo đó.",
    "29. Nếu dữ liệu có mâu thuẫn giữa input, result và keyRows, phải nêu rõ 'cần kiểm tra lại dữ liệu đầu vào và kết quả tính toán', không được tự chọn một giá trị để thay thế.",
    "",
    "NỘI DUNG BÁO CÁO CẦN THỂ HIỆN",
    "",
    "30. Chế độ tính toán.",
    "31. Thời gian bắt đầu và thời hạn.",
    "32. Mực nước hồ ban đầu và mực nước hồ mục tiêu.",
    "33. Thể tích cần hạ.",
    "34. Q về giả định dùng cho tính toán.",
    "35. Lưu lượng qua máy.",
    "36. Tổng lưu lượng xả tối đa theo văn bản.",
    "37. Q tràn trung bình ban ngày và ban đêm.",
    "38. Tổng lưu lượng lớn nhất áp dụng.",
    "39. Thời điểm đạt mực nước hồ mục tiêu.",
    "40. Khả năng duy trì mực nước hồ đến hết thời hạn.",
    "41. Tình trạng cận giới hạn, vượt giới hạn hoặc cảnh báo, nếu có.",
    "42. Kết luận rõ phương án đạt hay chưa đạt yêu cầu theo kết quả tính toán.",
    "",
    "CÁCH TRÌNH BÀY",
    "",
    "43. Mở đầu bằng tiêu đề: BÁO CÁO PHƯƠNG ÁN XẢ TRÀN.",
    "44. Sau tiêu đề, chỉ viết một báo cáo duy nhất.",
    "45. Nội dung tối đa 3 đoạn văn ngắn.",
    "46. Độ dài mục tiêu từ 160 đến 230 từ.",
    "47. Không tạo các mục TÓM TẮT GIAO BAN, VĂN BẢN PHƯƠNG ÁN hoặc ĐIỂM CẦN LƯU Ý.",
    "48. Không dùng danh sách dài trong phần trả lời.",
    "49. Không dùng mã HTML.",
    "50. Không dùng định dạng Markdown như ###, ** hoặc khối mã.",
    "51. Trả lời hoàn toàn bằng tiếng Việt.",
    "52. Đoạn cuối phải nhắc đối chiếu văn bản điều hành, cập nhật số liệu thực tế và phê duyệt đúng thẩm quyền trước khi áp dụng.",
    "",
    "CÁCH DIỄN ĐẠT ƯU TIÊN",
    "",
    "Ưu tiên các cụm: 'theo dữ liệu đầu vào hiện tại', 'theo kết quả tính toán', 'trong giới hạn tính toán', 'Q về giả định dùng cho tính toán'.",
    "Tránh các cụm: 'an toàn', 'hoàn toàn khả thi', 'chắc chắn', 'ổn định thực tế', 'công suất máy phát', 'kết quả engine'."
  ].join("\n");
}


/**
 * Gọi OpenAI Responses API.
 */
async function callOpenAI({
  instructions,
  input
}) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => {
        controller.abort();
      },
      55000
    );

  try {
    const response =
      await fetch(
        OPENAI_API_URL,
        {
          method:
            "POST",

          headers: {
            Authorization:
              `Bearer ${OPENAI_API_KEY}`,

            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              model:
                OPENAI_MODEL,

              instructions:
                String(
                  instructions || ""
                ),

              input:
                String(
                  input || ""
                ),

              max_output_tokens:
                MAX_OUTPUT_TOKENS
            }),

          signal:
            controller.signal
        }
      );

    const responseText =
      await response.text();

    let result;

    try {
      result =
        responseText
          ? JSON.parse(
              responseText
            )
          : {};
    } catch (error) {
      throw new Error(
        `OpenAI trả về dữ liệu không phải JSON. HTTP ${response.status}`
      );
    }

    if (!response.ok) {
      const apiMessage =
        result &&
        result.error &&
        result.error.message
          ? result.error.message
          : responseText.slice(
              0,
              700
            );

      throw new Error(
        `OpenAI API lỗi HTTP ${response.status}: ${apiMessage}`
      );
    }

    const answer =
      extractOpenAIText(
        result
      );

    if (!answer) {
      throw new Error(
        "OpenAI không trả về nội dung phân tích."
      );
    }

    return {
      answer:
        answer.trim(),

      model:
        String(
          result.model ||
          OPENAI_MODEL
        ),

      responseId:
        String(
          result.id || ""
        )
    };
  } catch (error) {
    if (
      error &&
      error.name ===
        "AbortError"
    ) {
      throw new Error(
        "OpenAI xử lý quá thời gian cho phép."
      );
    }

    throw error;
  } finally {
    clearTimeout(
      timeout
    );
  }
}


/**
 * Trích nội dung văn bản từ Responses API.
 */
function extractOpenAIText(
  result
) {
  if (
    result &&
    typeof result.output_text ===
      "string" &&
    result.output_text.trim()
  ) {
    return result.output_text.trim();
  }

  const output =
    Array.isArray(
      result &&
      result.output
    )
      ? result.output
      : [];

  const textParts = [];

  output.forEach(
    item => {
      const content =
        Array.isArray(
          item &&
          item.content
        )
          ? item.content
          : [];

      content.forEach(
        part => {
          if (
            part &&
            typeof part.text ===
              "string" &&
            part.text
          ) {
            textParts.push(
              part.text
            );
          }
        }
      );
    }
  );

  return textParts
    .join(
      "\n"
    )
    .trim();
}


/**
 * Chuẩn hóa request body.
 */
function parseRequestBody(
  body
) {
  if (!body) {
    return {};
  }

  if (
    typeof body ===
    "object"
  ) {
    return body;
  }

  try {
    return JSON.parse(
      String(body)
    );
  } catch (error) {
    throw new Error(
      "Request body không phải JSON hợp lệ."
    );
  }
}


/**
 * Làm sạch sessionId.
 */
function sanitizeSessionId(
  value
) {
  const clean =
    String(
      value || ""
    )
      .replace(
        /[^a-zA-Z0-9_.-]/g,
        ""
      )
      .slice(
        0,
        120
      );

  return (
    clean ||
    "spill-plan-" +
    Date.now()
  );
}


/**
 * Chuẩn hóa lỗi.
 */
function getErrorMessage(
  error
) {
  if (!error) {
    return "Lỗi không xác định.";
  }

  if (error.message) {
    return String(
      error.message
    );
  }

  return String(
    error
  );
}
