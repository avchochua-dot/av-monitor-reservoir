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
      temperature: 0.35,
      messages: [
        {
          role: "system",
          content:
            "Bạn là chuyên gia thủy văn và vận hành hồ chứa thủy điện. Viết báo cáo kỹ thuật tiếng Việt, chuyên nghiệp, không bịa số liệu.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${text}`);

  const data = JSON.parse(text);
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function saveToSupabase({ year, month, reportType, prompt, aiResult, summary }) {
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
  if (!response.ok) throw new Error(`Supabase insert ${response.status}: ${text}`);

  const rows = text ? JSON.parse(text) : [];
  return rows?.[0] || null;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });
  if (req.method !== "POST") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    const year = Number(body.year);
    const month = Number(body.month);
    const reportType = body.reportType || "reservoir_operation";
    const prompt = String(body.prompt || "").trim();

    if (!year || !month || month < 1 || month > 12) {
      return json(res, 400, { ok: false, error: "Missing or invalid year/month" });
    }

    if (!prompt) {
      return json(res, 400, { ok: false, error: "Missing prompt" });
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
