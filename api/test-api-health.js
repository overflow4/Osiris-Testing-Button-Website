/**
 * API Health Test - checks cron endpoints, webhook endpoints, and API routes.
 * Sends GET/POST to each endpoint and verifies response status.
 */
module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[api-health][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { apiBaseUrl, endpoints, businessName } = req.body;
  if (!apiBaseUrl || !endpoints?.length) return res.status(400).json({ error: 'Missing apiBaseUrl or endpoints' });

  const base = apiBaseUrl.replace(/\/+$/, '');
  const results = [];

  for (const ep of endpoints) {
    const url = `${base}${ep.path}`;
    const method = ep.method || 'GET';
    const label = ep.label || ep.path;

    try {
      const startTime = Date.now();
      const fetchOpts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      };

      if (method === 'POST' && ep.body) {
        fetchOpts.body = JSON.stringify(ep.body);
      }

      const r = await fetch(url, fetchOpts);
      const elapsed = Date.now() - startTime;
      let responseBody = '';
      try {
        responseBody = await r.text();
        if (responseBody.length > 500) responseBody = responseBody.slice(0, 500) + '...';
      } catch (e) {}

      // Determine pass criteria:
      // - 2xx/3xx = success
      // - 400 = endpoint exists, payload validation firing (good for webhooks)
      // - 401/403 = endpoint exists but protected (good for crons)
      // - 405 = wrong method but endpoint exists
      // - 404/5xx = BAD (missing or broken)
      const ACCEPTED = new Set([400, 401, 403, 405]);
      const statusOk = ep.expectStatus
        ? r.status === ep.expectStatus
        : (r.status >= 200 && r.status < 400) || ACCEPTED.has(r.status);

      const bodyOk = ep.expectBody
        ? new RegExp(ep.expectBody, 'i').test(responseBody)
        : true;

      // Annotate status meaning for UI
      let statusMeaning = '';
      if (r.status >= 200 && r.status < 300) statusMeaning = 'OK';
      else if (r.status >= 300 && r.status < 400) statusMeaning = 'redirect';
      else if (r.status === 400) statusMeaning = 'validation (alive)';
      else if (r.status === 401 || r.status === 403) statusMeaning = 'protected (alive)';
      else if (r.status === 404) statusMeaning = 'NOT FOUND';
      else if (r.status === 405) statusMeaning = 'method not allowed';
      else if (r.status >= 500) statusMeaning = 'SERVER ERROR';
      else statusMeaning = `status ${r.status}`;

      results.push({
        path: ep.path,
        label,
        category: ep.category || 'api',
        method,
        status: r.status,
        elapsed,
        passed: statusOk && bodyOk,
        detail: `HTTP ${r.status} ${statusMeaning} (${elapsed}ms)`,
        responsePreview: responseBody.slice(0, 200),
      });

    } catch (e) {
      results.push({
        path: ep.path,
        label,
        category: ep.category || 'api',
        method,
        status: 0,
        elapsed: 0,
        passed: false,
        detail: `Failed: ${e.message.slice(0, 100)}`,
        responsePreview: '',
      });
    }
  }

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;

  return res.status(200).json({
    passed: passedCount >= Math.ceil(totalCount * 0.7),
    score: `${passedCount}/${totalCount}`,
    results,
    businessName,
  });
};
