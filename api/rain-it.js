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
    // Lưu ý: Đưa VRAIN_API_KEY vào Environment Variables của Vercel để bảo mật
    const API_KEY = process.env.VRAIN_API_KEY || "YOUR_FALLBACK_API_KEY"; 
    const TARGET_URL = "http://14.241.121.249:89/api/QuanTracRain"; // Thay bằng URL thực tế nếu cần

    // 3. Xử lý Timeout 8.5s bằng AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    // 4. Gọi API đích với cú pháp Header chuẩn xác
    const response = await fetch(TARGET_URL, {
      method: 'GET',
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": API_KEY // Lỗi cú pháp cũ đã được khắc phục tại đây
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API đối tác phản hồi mã lỗi: ${response.status}`);
    }

    const data = await response.json();

    // 5. Trả dữ liệu mượt mà về cho Frontend
    return res.status(200).json({
      ok: true,
      data: data
    });

  } catch (error) {
    console.error("Lỗi API Proxy /rain-it:", error);

    // Bắt lỗi Timeout 8.5s
    if (error.name === 'AbortError') {
      return res.status(504).json({
        ok: false,
        error: "Gateway Timeout: API đích mất quá 8.5s để phản hồi."
      });
    }

    // Các lỗi Internal khác
    return res.status(500).json({
      ok: false,
      error: "Internal Server Error: Không thể lấy dữ liệu.",
      details: error.message
    });
  }
}
