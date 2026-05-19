export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://avuong.vrain.vn/api/private/v1/organizations/summary",
      {
        headers: {
          "accept": "application/json, text/plain, */*",
          "referer": "https://avuong.vrain.vn/station/dashboard",
          "x-org-uuid": "ea275312-f0dd-44a5-9111-6191b333f506",
          "x-vrain-user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
          "cookie": "_ga=GA1.1.1963067761.1776247687; sid=769cb120-b113-4979-94f7-f975c324d97a; _ga_P14ZMM778Z=GS2.1.s1779176766$o11$g1$t1779176768$j58$l0$h0"
        }
      }
    );

    const text = await response.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(response.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
