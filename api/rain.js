export default async function handler(req, res) {
  try {
    const response = await fetch(
      "https://avuong.vrain.vn/api/private/v1/organizations/summary"
    );

    const data = await response.json();

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
