module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[twilio-send][${requestId}] Incoming ${req.method} request`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, body } = req.body;
  console.log(`[twilio-send][${requestId}] To: ${to}, Body length: ${body?.length || 0}`);

  if (!to || !body) return res.status(400).json({ error: 'Missing "to" or "body"' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  console.log(`[twilio-send][${requestId}] TWILIO_ACCOUNT_SID set: ${!!accountSid}`);
  console.log(`[twilio-send][${requestId}] TWILIO_AUTH_TOKEN set: ${!!authToken}`);
  console.log(`[twilio-send][${requestId}] TWILIO_PHONE_NUMBER: ${fromNumber || 'N/A'}`);

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(200).json({ sent: false, error: 'Twilio credentials not configured.' });
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    console.log(`[twilio-send][${requestId}] Sending SMS: ${fromNumber} -> ${to}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: fromNumber, Body: body }).toString(),
    });

    const data = await response.json();
    if (data.sid) {
      console.log(`[twilio-send][${requestId}] Sent successfully. SID: ${data.sid}, Status: ${data.status}`);
      return res.status(200).json({ sent: true, sid: data.sid, status: data.status });
    } else {
      console.error(`[twilio-send][${requestId}] Twilio error:`, JSON.stringify(data));
      return res.status(200).json({ sent: false, error: data.message || 'Twilio send failed' });
    }
  } catch (e) {
    console.error(`[twilio-send][${requestId}] FAILED:`, e.message);
    console.error(`[twilio-send][${requestId}] Stack:`, e.stack);
    return res.status(200).json({ sent: false, error: e.message });
  }
};
