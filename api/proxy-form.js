module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[proxy-form][${requestId}] Incoming ${req.method} request`);
  console.log(`[proxy-form][${requestId}] Headers:`, JSON.stringify(req.headers, null, 2));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    console.log(`[proxy-form][${requestId}] CORS preflight — returning 200`);
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    console.log(`[proxy-form][${requestId}] Method not allowed: ${req.method}`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { targetUrl, formData } = req.body;
  console.log(`[proxy-form][${requestId}] Target URL: ${targetUrl}`);
  console.log(`[proxy-form][${requestId}] Form data:`, JSON.stringify(formData));

  if (!targetUrl || !formData) {
    console.log(`[proxy-form][${requestId}] Missing targetUrl or formData — aborting`);
    return res.status(400).json({ error: 'Missing targetUrl or formData' });
  }

  try {
    console.log(`[proxy-form][${requestId}] Sending POST to ${targetUrl}...`);
    const startTime = Date.now();

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData),
    });

    const elapsed = Date.now() - startTime;
    const text = await response.text();

    console.log(`[proxy-form][${requestId}] Response: HTTP ${response.status} ${response.statusText} (${elapsed}ms)`);
    console.log(`[proxy-form][${requestId}] Response headers:`, JSON.stringify(Object.fromEntries(response.headers.entries())));
    console.log(`[proxy-form][${requestId}] Response body (first 500 chars): ${text.slice(0, 500)}`);

    res.status(200).json({
      status: response.status,
      statusText: response.statusText,
      body: text.slice(0, 2000),
    });
  } catch (e) {
    console.error(`[proxy-form][${requestId}] Request FAILED:`, e.message);
    console.error(`[proxy-form][${requestId}] Error stack:`, e.stack);
    res.status(200).json({
      status: 0,
      statusText: 'Network Error',
      body: e.message,
    });
  }
}
