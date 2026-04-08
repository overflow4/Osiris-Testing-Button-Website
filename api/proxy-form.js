module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { targetUrl, formData } = req.body;
  if (!targetUrl || !formData) return res.status(400).json({ error: 'Missing targetUrl or formData' });

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });

    const text = await response.text();
    res.status(200).json({
      status: response.status,
      statusText: response.statusText,
      body: text.slice(0, 2000),
    });
  } catch (e) {
    res.status(200).json({
      status: 0,
      statusText: 'Network Error',
      body: e.message,
    });
  }
}
