export default async function handler(req, res) {
  try {
    const body = new URLSearchParams();

    body.set("__EVENTTARGET", "RefreshData");
    body.set("__EVENTARGUMENT", "");
    body.set("__VIEWSTATE", "DÁN_VIEWSTATE_CỦA_BẠN_VÀO_ĐÂY");
    body.set("__VIEWSTATEGENERATOR", "0A4B555E");
    body.set("__EVENTVALIDATION", "DÁN_EVENTVALIDATION_CỦA_BẠN_VÀO_ĐÂY");

    body.set("DXScript", "1_10,1_11,1_22,1_63,1_12,1_13,1_14,1_29,1_18,1_210,1_221,1_222,1_208,1_224,1_233,1_235,1_236,1_227,1_231,1_237,1_180,1_181,1_16,1_41,23_0,23_1,23_8");

    const r = await fetch("http://kttv.avuong.com:84/TramDoMua.aspx", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": "ASP.NET_SessionId=m3tbwbw0vfnyp42oygvfz4iz",
        "Origin": "http://kttv.avuong.com:84",
        "Referer": "http://kttv.avuong.com:84/TramDoMua.aspx",
        "User-Agent": "Mozilla/5.0"
      },
      body
    });

    const html = await r.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({
      ok: true,
      hasData: html.includes("dxgvDataRow"),
      html
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
