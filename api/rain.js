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
          "cookie": "_ga=GA1.1.1963067761.1776247687; loginImage=%7B%22url%22%3A%22https%3A%2F%2Fassets.vrain.vn%2Fkttv%2Fimages%2F1.jpg%22%2C%22caption%22%3A%22%C4%90%E1%BA%A3o%20ch%C3%A8%20Thanh%20Ch%C6%B0%C6%A1ng%20-%20Ngh%E1%BB%87%20An%22%7D; sid=9748500e-4176-49d2-a4ae-f471df16718c; _ga_P14ZMM778Z=GS2.1.s1779185964$o13$g1$t1779186057$j60$l0$h0"
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
