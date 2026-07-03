export default async function handler(req, res) {
  try {
    const USER = process.env.AVC_KTTV_USER;
    const PASS = process.env.AVC_KTTV_PASS;

    // 1. GET login page để lấy VIEWSTATE
    const loginPage = await fetch("http://kttv.avuong.com:84/Login.aspx");
    const html = await loginPage.text();

    const viewState = html.match(/id="__VIEWSTATE" value="(.*?)"/)?.[1];
    const eventValidation = html.match(/id="__EVENTVALIDATION" value="(.*?)"/)?.[1];
    const viewStateGen = html.match(/id="__VIEWSTATEGENERATOR" value="(.*?)"/)?.[1];

    if (!viewState) {
      return res.status(500).json({ error: "Không lấy được VIEWSTATE" });
    }

    // Lấy cookie session
    const cookie = loginPage.headers.get("set-cookie");

    // 2. POST login
    const loginRes = await fetch("http://kttv.avuong.com:84/Login.aspx", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookie
      },
      body: new URLSearchParams({
        "__VIEWSTATE": viewState,
        "__EVENTVALIDATION": eventValidation,
        "__VIEWSTATEGENERATOR": viewStateGen,
        "ctl00$ContentPlaceHolder1$txtUserName": USER,
        "ctl00$ContentPlaceHolder1$txtPassword": PASS,
        "ctl00$ContentPlaceHolder1$btnLogin": "Đăng nhập"
      })
    });

    const cookie2 = loginRes.headers.get("set-cookie") || cookie;

    // 3. CALL dữ liệu mưa
    const dataRes = await fetch("http://kttv.avuong.com:84/TramDoMua.aspx", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookie2
      },
      body: new URLSearchParams({
        "__EVENTTARGET": "RefreshData"
      })
    });

    const dataHtml = await dataRes.text();

    // 4. Parse dữ liệu (tùy chỉnh theo HTML)
    const stations = [];

    const regex = /AV\d+_[^<]+[\s\S]*?(\d+(\.\d+)?)\s*mm/g;
    let match;

    while ((match = regex.exec(dataHtml)) !== null) {
      stations.push({
        name: match[0].split(" ")[0],
        rain: parseFloat(match[1])
      });
    }

    res.status(200).json({
      ok: true,
      stations
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
