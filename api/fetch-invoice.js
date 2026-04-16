module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[fetch-invoice][${requestId}] Incoming ${req.method} request`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing "url"' });

  console.log(`[fetch-invoice][${requestId}] Fetching: ${url}`);

  try {
    const startTime = Date.now();
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    const elapsed = Date.now() - startTime;
    const html = await response.text();
    const finalUrl = response.url;

    console.log(`[fetch-invoice][${requestId}] Response: HTTP ${response.status} (${elapsed}ms)`);
    console.log(`[fetch-invoice][${requestId}] Final URL: ${finalUrl}`);
    console.log(`[fetch-invoice][${requestId}] HTML length: ${html.length} chars`);

    return res.status(200).json({
      status: response.status,
      finalUrl,
      html: html.slice(0, 50000),
      elapsed,
    });
  } catch (e) {
    console.error(`[fetch-invoice][${requestId}] FAILED:`, e.message);
    return res.status(200).json({ status: 0, error: e.message });
  }
};
