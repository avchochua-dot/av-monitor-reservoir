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
    // TARGET_URL giờ trỏ vào Cloudflare Tunnel chạy trên máy nhân viên (đã whitelist),
    // thay vì gọi thẳng IP nội bộ 14.241.121.249:89 (bị chặn do IT chặn IP nước ngoài).
    const PROXY_SECRET = process.env.RAIN_PROXY_SECRET || "e4a1b8c2-7f9d-4e5a-b3c1-9d8e7f6a5b4c";
    const TARGET_URL = process.env.RAIN_TUNNEL_URL || "https://broadcast-arms-gen-twenty.trycloudflare.com/rain-proxy";

    // 3. Xử lý Timeout 8.5s bằng AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    console.log("[rain-it] Bắt đầu gọi TARGET_URL:", TARGET_URL);
    const startTime = Date.now();

    // 4. Gọi API đích qua tunnel — dùng header bí mật thay vì X-API-KEY
    // (API_KEY thật giờ nằm trong server.js trên máy nhân viên, không lộ ra Vercel/Frontend)
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

    const data = await response.json();

    // 5. Trả dữ liệu về cho Frontend
    return res.status(200).json({
      ok: true,
      data: data
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
