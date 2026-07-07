export default async function handler(req, res) {
  // 1. THIẾT LẬP CORS (Cross-Origin Resource Sharing)
  // Cho phép UI Dashboard truy cập API này mà không bị trình duyệt chặn
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Khuyến nghị: Thay '*' bằng domain thực tế của Dashboard A Vương khi lên Production
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization, x-api-key'
  );

  // 2. XỬ LÝ PREFLIGHT REQUEST
  // Trình duyệt luôn gửi request OPTIONS trước khi gọi GET/POST để kiểm tra quyền
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const API_KEY = process.env.IT_RAIN_API_KEY;
  const BASE_URL = "http://14.241.121.249:89/api/QuanTracRain";

  if (!API_KEY) {
    return res.status(500).json({
      ok: false,
      error: "Thiếu biến môi trường IT_RAIN_API_KEY trên Vercel"
    });
  }

  const mode = req.query.auth || "x-api-key";
  const url = new URL(BASE_URL);

  // Chuyển tiếp tham số query (bỏ qua 'auth')
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== "auth") url.searchParams.set(k, v);
  }

  const headers = {
    Accept: "application/json"
  };

  // Cấu hình linh hoạt các chuẩn Authentication
  if (mode === "x-api-key") {
    headers["x-api-key"] = API_KEY;
  } else if (mode === "bearer") {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  } else if (mode === "key") {
    url.searchParams.set("key", API_KEY);
  } else if (mode === "api_key") {
    url.searchParams.set("api_key", API_KEY);
  }

  // 3. TỐI ƯU TIMEOUT CONTROL
  // Giới hạn 8500ms (8.5 giây) để chủ động xử lý lỗi trước khi Vercel chém process ở giây thứ 10
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8500);

  try {
    const started = Date.now();

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal
    });

    clearTimeout(timeout);

    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }

    return res.status(response.status).json({
      ok: response.ok,
      mode,
      status: response.status,
      statusText: response.statusText,
      elapsed_ms: Date.now() - started,
      source_url: BASE_URL,
      data: body
    });

  } catch (err) {
    clearTimeout(timeout);

    // Bắt chính xác lỗi Timeout hoặc lỗi kết nối (Firewall chặn)
    const isTimeout = err.name === 'AbortError';
    
    return res.status(isTimeout ? 504 : 500).json({
      ok: false,
      mode,
      source_url: BASE_URL,
      error_name: isTimeout ? 'GatewayTimeout' : err.name,
      error_message: isTimeout 
        ? 'Máy chủ nội bộ không phản hồi trong 8.5 giây. Vui lòng kiểm tra lại cấu hình Firewall.' 
        : err.message,
      error_cause: err.cause
        ? {
            code: err.cause.code,
            errno: err.cause.errno,
            syscall: err.cause.syscall,
            address: err.cause.address,
            port: err.cause.port
          }
        : null
    });
  }
}
