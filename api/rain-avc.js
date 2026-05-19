const LOGIN_URL = "http://kttv.avuong.com:84/Login.aspx";
const DATA_URL = "http://kttv.avuong.com:84/TramDoMua.aspx";

function pick(html, id) {
  const re = new RegExp(`id="${id}" value="([^"]*)"`);
  return html.match(re)?.[1] || "";
}

function getCookie(setCookie) {
  if (!setCookie) return "";
  if (Array.isArray(setCookie)) return setCookie.map(x => x.split(";")[0]).join("; ");
  return setCookie.split(",").map(x => x.split(";")[0]).join("; ");
}

export default async function handler(req, res) {
  try {
    const user = process.env.AVC_KTTV_USER;
    const pass = process.env.AVC_KTTV_PASS;

    if (!user || !pass) {
      return res.status(500).json({ ok: false, error: "Missing AVC_KTTV_USER or AVC_KTTV_PASS" });
    }

    const loginPage = await fetch(LOGIN_URL);
    const loginHtml = await loginPage.text();
    let cookie = getCookie(loginPage.headers.get("set-cookie"));

    const loginBody = new URLSearchParams();
    loginBody.set("__VIEWSTATE", pick(loginHtml, "__VIEWSTATE"));
    loginBody.set("__VIEWSTATEGENERATOR", pick(loginHtml, "__VIEWSTATEGENERATOR"));
    loginBody.set("__EVENTVALIDATION", pick(loginHtml, "__EVENTVALIDATION"));
    loginBody.set("txtU", user);
    loginBody.set("txtP", pass);
    loginBody.set("ChkMe", "on");
    loginBody.set("btLogin", "Login");

    const loginRes = await fetch(LOGIN_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookie,
        "Origin": "http://kttv.avuong.com:84",
        "Referer": LOGIN_URL,
        "User-Agent": "Mozilla/5.0"
      },
      body: loginBody
    });

    const loginCookie = getCookie(loginRes.headers.get("set-cookie"));
    if (loginCookie) cookie = cookie ? `${cookie}; ${loginCookie}` : loginCookie;

    const pageRes = await fetch(DATA_URL, {
      headers: {
        "Cookie": cookie,
        "Referer": LOGIN_URL,
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = await pageRes.text();

    res.status(200).json({
      ok: true,
      loggedIn: !html.includes("txtU") && !html.includes("Password"),
      hasData: html.includes("dxgvDataRow"),
      html
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
