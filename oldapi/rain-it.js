import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // 1. Cấu hình CORS - Cho phép Web App gọi API mà không bị chặn
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // Xử lý request preflight từ trình duyệt
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // 2. Khai báo biến môi trường và URL đích
    const PROXY_SECRET = process.env.RAIN_PROXY_SECRET || "e4a1b8c2-7f9d-4e5a-b3c1-9d8e7f6a5b4c";
    const TARGET_URL = process.env.RAIN_TUNNEL_URL || "https://broadcast-arms-gen-twenty.trycloudflare.com/rain-proxy";

    // 3. Xử lý Timeout 8.5s bằng AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    console.log("[rain-it] Bắt đầu gọi TARGET_URL:", TARGET_URL);
    const startTime = Date.now();

    // 4. Gọi API đích qua tunnel
    const response = await fetch(TARGET_URL, {
      method: 'GET',
      headers: {
        "Content-Type": "application/json",
        "X-PROXY-SECRET": PROXY_SECRET
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    console.log(`[rain-it] Phản hồi sau ${Date.now() - startTime}ms, status:`, response.status);

    if (!response.ok) {
      throw new Error(`API đối tác phản hồi mã lỗi: ${response.status}`);
    }

    const raw = await response.json();

    // Dữ liệu thực tế nằm ở raw.data.data (raw = {ok, data:{success, ..., data:[...]}})
    const rows = raw?.data?.data;

    let supabaseResult = { inserted: 0, error: null };

    if (Array.isArray(rows) && rows.length > 0) {
      // 5. Chuẩn hóa dữ liệu để khớp với schema bảng rain_data
      const records = rows.map(r => ({
        id: r.id,
        ngay: r.ngay,
        tram: r.tram,
        ten_tram: r.tenTram,
        giatri: parseFloat(r.giatri)
      }));

      // 6. Upsert vào Supabase — trùng id sẽ tự cập nhật, không tạo dòng mới
      const { error, count } = await supabase
        .from('rain_data')
        .upsert(records, { onConflict: 'id', count: 'exact' });

      if (error) {
        console.error("[rain-it] Lỗi upsert Supabase:", error);
        supabaseResult = { inserted: 0, error: error.message };
      } else {
        supabaseResult = { inserted: records.length, error: null };
        console.log(`[rain-it] Đã upsert ${records.length} dòng vào Supabase`);
      }
    }

    // 7. Trả dữ liệu về cho Frontend, kèm trạng thái lưu Supabase
    return res.status(200).json({
      ok: true,
      data: raw,
      supabase: supabaseResult
    });

  } catch (error) {
    // Log đầy đủ ra Vercel Runtime Logs để debug
    console.error("Lỗi API Proxy /rain-it:", {
      message: error.message,
      name: error.name,
      code: error.code,
      cause: error.cause,
      stack: error.stack
    });

    // Bắt lỗi Timeout 8.5s
    if (error.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        error: "Gateway Timeout: API đích mất quá 8.5s để phản hồi.",
        code: 'TIMEOUT'
      });
    }

    // Các lỗi Internal khác — trả kèm chi tiết để debug
    return res.status(500).json({
      ok: false,
      error: "Internal Server Error: Không thể lấy dữ liệu.",
      details: error.message,
      name: error.name,
      code: error.code || null,
      cause: error.cause ? {
        code: error.cause.code || null,
        message: error.cause.message || String(error.cause)
      } : null
    });
  }
}
