module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[analyze-invoice][${requestId}] Incoming ${req.method} request`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { conversation, invoiceHtml, invoiceUrl, testType, businessName } = req.body;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(`[analyze-invoice][${requestId}] No ANTHROPIC_API_KEY set`);
    return res.status(200).json({ error: 'No ANTHROPIC_API_KEY configured.' });
  }

  console.log(`[analyze-invoice][${requestId}] Test type: ${testType}, Business: ${businessName}`);
  console.log(`[analyze-invoice][${requestId}] Conversation length: ${conversation?.length || 0} chars`);
  console.log(`[analyze-invoice][${requestId}] Invoice HTML length: ${invoiceHtml?.length || 0} chars`);
  console.log(`[analyze-invoice][${requestId}] Invoice URL: ${invoiceUrl}`);

  const prompt = `You are a QA inspector for a service business booking system. You are analyzing an invoice/quote page that was generated after a customer interaction.

## Context
- **Business:** ${businessName}
- **Test type:** ${testType}
- **Invoice URL:** ${invoiceUrl}

## Full Interaction
${conversation || 'No conversation data available.'}

## Invoice Page HTML
${invoiceHtml || 'No invoice HTML available.'}

## Your Task
Analyze the invoice page and the interaction that led to it. Check for:

1. **Price present** — Is there a clear price/quote amount displayed?
2. **Price consistency** — Does the price on the invoice match what was quoted during the conversation? Flag any discrepancy.
3. **Customer info** — Is the customer name, phone, address, or service type shown? Does it match what was discussed?
4. **Service details** — Does the service description match what was requested (e.g., standard cleaning, 3 bed 2 bath, exterior windows, etc.)?
5. **Visual/content issues** — Any broken elements, missing data, placeholder text, error messages, or obvious glitches visible in the HTML?
6. **Booking/payment flow** — Is there a clear way for the customer to book or pay (date picker, payment button, etc.)?

Respond with ONLY valid JSON in this exact format:
{
  "passed": true/false,
  "score": "X/6",
  "priceFound": { "pass": true/false, "detail": "..." },
  "priceConsistent": { "pass": true/false, "detail": "..." },
  "customerInfo": { "pass": true/false, "detail": "..." },
  "serviceDetails": { "pass": true/false, "detail": "..." },
  "noGlitches": { "pass": true/false, "detail": "..." },
  "bookingFlow": { "pass": true/false, "detail": "..." },
  "summary": "One-sentence overall assessment"
}`;

  try {
    console.log(`[analyze-invoice][${requestId}] Calling Claude API...`);
    const startTime = Date.now();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    const elapsed = Date.now() - startTime;
    console.log(`[analyze-invoice][${requestId}] Claude responded in ${elapsed}ms`);

    if (data.error) {
      console.error(`[analyze-invoice][${requestId}] Claude API error:`, JSON.stringify(data.error));
      return res.status(200).json({ error: data.error.message || 'Claude API error' });
    }

    const text = data.content?.[0]?.text || '';
    console.log(`[analyze-invoice][${requestId}] Raw response: ${text.slice(0, 500)}`);

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`[analyze-invoice][${requestId}] Could not parse JSON from response`);
      return res.status(200).json({ error: 'Could not parse analysis', raw: text });
    }

    const analysis = JSON.parse(jsonMatch[0]);
    console.log(`[analyze-invoice][${requestId}] Analysis: passed=${analysis.passed}, score=${analysis.score}`);

    return res.status(200).json(analysis);
  } catch (e) {
    console.error(`[analyze-invoice][${requestId}] FAILED:`, e.message);
    console.error(`[analyze-invoice][${requestId}] Stack:`, e.stack);
    return res.status(200).json({ error: e.message });
  }
};
