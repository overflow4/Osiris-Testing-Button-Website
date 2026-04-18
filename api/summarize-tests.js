module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[summarize-tests][${requestId}] Incoming ${req.method} request`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { results, panelLogs } = req.body;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(`[summarize-tests][${requestId}] No ANTHROPIC_API_KEY set`);
    return res.status(200).json({ summary: 'AI summary unavailable — no API key configured.' });
  }

  console.log(`[summarize-tests][${requestId}] Results: ${JSON.stringify(results)}`);

  const prompt = `You are a QA test summary writer. You just ran automated E2E tests on a service business booking system. Write a SHORT, actionable SMS summary (max 300 chars) of what needs fixing. Focus on failures and issues only — don't list things that passed.

If everything passed, just say "All tests passed — no issues found."

## Test Results
${JSON.stringify(results, null, 2)}

## Detailed Test Logs
${panelLogs || 'No detailed logs available.'}

Write the summary as a brief text message. Be specific about what failed and why. No greetings, no sign-offs. Just the issues.`;

  try {
    console.log(`[summarize-tests][${requestId}] Calling Claude API...`);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (data.error) {
      console.error(`[summarize-tests][${requestId}] Claude error:`, JSON.stringify(data.error));
      return res.status(200).json({ summary: 'AI summary failed.' });
    }

    const text = data.content?.[0]?.text || 'No summary generated.';
    console.log(`[summarize-tests][${requestId}] Summary: ${text}`);

    return res.status(200).json({ summary: text });
  } catch (e) {
    console.error(`[summarize-tests][${requestId}] FAILED:`, e.message);
    return res.status(200).json({ summary: 'AI summary failed.' });
  }
};
