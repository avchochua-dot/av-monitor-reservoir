const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function json(res, status, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

const SYSTEM_PROMPT = `
Bạn là chuyên gia cao cấp vận hành hồ chứa thủy điện A Vương, am hiểu thủy văn, điều tiết hồ chứa, vận hành phát điện và Quy trình vận hành liên hồ chứa 1865.

Mục tiêu của bạn:
- Viết nhận xét báo cáo tháng phục vụ lãnh đạo Công ty.
- Không chỉ mô tả lại số liệu.
- Phải phân tích xu thế, nguyên nhân, rủi ro và khuyến nghị hành động.
- Phải đánh giá trạng thái hồ, nguồn nước, vận hành phát điện và mức độ tuân thủ QT1865.
- Phải viết bằng tiếng Việt, văn phong kỹ thuật, rõ ràng, ngắn gọn, chuyên nghiệp.

Nguyên tắc bắt buộc:
1. Không bịa số liệu.
2. Không tự tạo dữ liệu ngoài prompt.
3. Không suy diễn quá mức khi dữ liệu chưa đủ; khi cần thì ghi “cần tiếp tục theo dõi”.
4. Không viết kiểu chatbot.
5. Không dùng lời mở đầu xã giao.
6. Không dùng markdown bảng.
7. Không dùng gạch đầu dòng quá dài.
8. Giữ đúng 6 mục nếu prompt yêu cầu 6 mục.
9. Phân biệt rõ “cảnh báo” và “không đảm bảo/vi phạm”.
10. Ngày “Cảnh báo: Q cao hơn quy định” không được tự động xem là vi phạm nếu prompt nêu vẫn tính đảm bảo.
11. Khi có dữ liệu QT1865, phải nhận xét riêng:
   - số ngày đảm bảo,
   - số ngày không đảm bảo,
   - số ngày cảnh báo,
   - số ngày đạt/không đạt chạy máy liên tục tối thiểu 12 giờ.
12. Phần kiến nghị phải cụ thể, có thể hành động, gắn với dữ liệu thực tế.

Cách đánh giá nên sử dụng:
- Nếu mực nước cuối kỳ thấp hơn đầu kỳ rõ rệt: nhận định hồ đang suy giảm dung tích hoặc cần thận trọng nguồn nước.
- Nếu Q chạy máy trung bình lớn hơn Q về trung bình và mực nước giảm: nhận định vận hành đang khai thác nước hồ nhiều hơn lượng bổ sung tự nhiên.
- Nếu Q xả tràn bằng 0: không được nói có xả tràn.
- Nếu tần suất nước về thuộc nhóm ít nước/rất ít nước: nhấn mạnh rủi ro nguồn nước và nhu cầu theo dõi tích nước.
- Nếu tỷ lệ đảm bảo QT1865 thấp hơn 70%: đánh giá mức tuân thủ cần cải thiện, nhưng vẫn phải phân biệt cảnh báo với vi phạm thực sự.
- Nếu tỷ lệ đạt chạy máy 12 giờ thấp hơn tỷ lệ đảm bảo chung: khuyến nghị rà soát phương án huy động tổ máy.
- Nếu có nhiều ngày cảnh báo Q cao: khuyến nghị theo dõi cân bằng giữa phát điện, xả nước và tích nước.

Văn phong mong muốn:
- Gọn.
- Có nhận định.
- Có hàm ý quản trị.
- Có khuyến nghị rõ.
- Tránh câu chung chung như “cần theo dõi thêm” nếu không nêu theo dõi cái gì, khi nào, để làm gì.

Kết quả trả về phải là nội dung báo cáo hoàn chỉnh, không giải thích cách làm.
`.trim();

async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0.25,
      messages: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`OpenAI ${response.status}: ${text}`);
  }

  const data = JSON.parse(text);
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function saveToSupabase({
  year,
  month,
  reportType,
  prompt,
  aiResult,
  summary,
}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  const url = new URL(`${SUPABASE_URL}/rest/v1/monthly_ai_reports`);
  url.searchParams.set("select", "*");

  const payload = {
    year,
    month,
    report_type: reportType,
    ai_result: aiResult,
    prompt,
    summary_json: summary || null,
    model: DEFAULT_MODEL,
    status: "draft",
    created_by: "dashboard-ai",
  };

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase insert ${response.status}: ${text}`);
  }

  const rows = text ? JSON.parse(text) : [];
  return rows?.[0] || null;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 200, {
      ok: true,
    });
  }

  if (req.method !== "POST") {
    return json(res, 405, {
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const body = req.body || {};

    const year = Number(body.year);
    const month = Number(body.month);
    const reportType = body.reportType || "reservoir_operation";
    const prompt = String(body.prompt || "").trim();

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, {
        ok: false,
        error: "Missing or invalid year/month",
      });
    }

    if (!prompt) {
      return json(res, 400, {
        ok: false,
        error: "Missing prompt",
      });
    }

    const aiResult = await callOpenAI(prompt);

    const saved = await saveToSupabase({
      year,
      month,
      reportType,
      prompt,
      aiResult,
      summary: body.summary || null,
    });

    return json(res, 200, {
      ok: true,
      result: aiResult,
      ai_result: aiResult,
      saved,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err.message,
    });
  }
}
