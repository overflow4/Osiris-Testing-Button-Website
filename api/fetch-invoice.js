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

    // Extract the base URL and token from the quote URL
    // e.g. https://example.com/quote/abc123 -> base=https://example.com, token=abc123
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/').filter(Boolean);
    const quoteIdx = pathParts.indexOf('quote');
    const token = quoteIdx >= 0 ? pathParts[quoteIdx + 1] : null;

    let quoteData = null;

    // Try to fetch the quote data directly from the API (client-rendered pages)
    if (token) {
      const apiUrl = `${urlObj.origin}/api/quotes/${token}`;
      console.log(`[fetch-invoice][${requestId}] Trying API: ${apiUrl}`);
      try {
        const apiRes = await fetch(apiUrl, {
          headers: { 'Accept': 'application/json' },
        });
        if (apiRes.ok) {
          quoteData = await apiRes.json();
          console.log(`[fetch-invoice][${requestId}] Got quote API data: ${JSON.stringify(quoteData).length} chars`);
        } else {
          console.log(`[fetch-invoice][${requestId}] API returned ${apiRes.status}, falling back to HTML`);
        }
      } catch (apiErr) {
        console.log(`[fetch-invoice][${requestId}] API fetch failed: ${apiErr.message}, falling back to HTML`);
      }
    }

    // Also fetch the HTML page
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

    // If we got quote data from the API, format it as readable text for the LLM
    let content = html.slice(0, 50000);
    if (quoteData) {
      const q = quoteData.quote || {};
      const tiers = quoteData.tiers || [];
      const addons = quoteData.addons || [];
      const tierPrices = quoteData.tierPrices || {};
      const tenant = quoteData.tenant || {};

      let readable = '=== QUOTE DATA (from API) ===\n';
      readable += `Business: ${tenant.name || 'Unknown'}\n`;
      readable += `Customer: ${q.customer_name || 'N/A'}\n`;
      readable += `Phone: ${q.customer_phone || 'N/A'}\n`;
      readable += `Email: ${q.customer_email || 'N/A'}\n`;
      readable += `Address: ${q.customer_address || 'N/A'}\n`;
      readable += `Bedrooms: ${q.bedrooms || 'N/A'}, Bathrooms: ${q.bathrooms || 'N/A'}\n`;
      readable += `Service Category: ${q.service_category || 'N/A'}\n`;
      readable += `Status: ${q.status || 'N/A'}\n`;
      readable += `Valid Until: ${q.valid_until || 'N/A'}\n`;
      readable += `Notes: ${q.notes || 'N/A'}\n`;
      readable += `Discount: ${q.discount || 0}\n`;
      if (q.custom_base_price != null) readable += `Custom Base Price: ${q.custom_base_price}\n`;
      if (q.selected_tier) readable += `Selected Tier: ${q.selected_tier}\n`;

      readable += '\n--- Tiers ---\n';
      tiers.forEach(t => {
        const price = tierPrices[t.key];
        readable += `${t.name} (${t.key}): $${price?.price || 'N/A'}`;
        if (t.tagline) readable += ` - ${t.tagline}`;
        readable += '\n';
        if (t.included?.length) readable += `  Included: ${t.included.join(', ')}\n`;
      });

      if (addons.length) {
        readable += '\n--- Add-ons ---\n';
        addons.forEach(a => {
          readable += `${a.name} (${a.key}): $${a.price} [${a.priceType}]\n`;
        });
      }

      if (q.selected_addons?.length) {
        readable += '\n--- Selected Add-ons ---\n';
        q.selected_addons.forEach(a => {
          const key = typeof a === 'string' ? a : a.key;
          readable += `- ${key}`;
          if (typeof a !== 'string' && a.included) readable += ' (included)';
          readable += '\n';
        });
      }

      readable += '\n=== END QUOTE DATA ===\n';
      content = readable;
    }

    return res.status(200).json({
      status: response.status,
      finalUrl,
      html: content,
      quoteData: quoteData || null,
      elapsed,
    });
  } catch (e) {
    console.error(`[fetch-invoice][${requestId}] FAILED:`, e.message);
    return res.status(200).json({ status: 0, error: e.message });
  }
};
