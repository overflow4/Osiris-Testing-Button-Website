module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[twilio-messages][${requestId}] Incoming ${req.method} request`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { from, since, limit } = req.query;
  console.log(`[twilio-messages][${requestId}] Params: from=${from}, since=${since}, limit=${limit}`);

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !twilioNumber) {
    return res.status(200).json({ messages: [], error: 'Twilio credentials not configured.' });
  }

  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const params = new URLSearchParams({
      To: twilioNumber,
      PageSize: String(limit || 20),
    });
    if (from) params.set('From', from);
    if (since) params.set('DateSent>', since);

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json?${params.toString()}`;
    console.log(`[twilio-messages][${requestId}] Fetching: ${url.replace(accountSid, 'AC***')}`);

    const response = await fetch(url, {
      headers: { 'Authorization': `Basic ${auth}` },
    });

    const data = await response.json();
    const messages = (data.messages || []).map(m => ({
      sid: m.sid,
      from: m.from,
      to: m.to,
      body: m.body,
      status: m.status,
      direction: m.direction,
      dateSent: m.date_sent,
      dateCreated: m.date_created,
    }));

    console.log(`[twilio-messages][${requestId}] Found ${messages.length} messages`);
    if (messages.length > 0) {
      console.log(`[twilio-messages][${requestId}] Latest: from=${messages[0].from}, body="${messages[0].body?.slice(0, 80)}..."`);
    }

    return res.status(200).json({ messages });
  } catch (e) {
    console.error(`[twilio-messages][${requestId}] FAILED:`, e.message);
    console.error(`[twilio-messages][${requestId}] Stack:`, e.stack);
    return res.status(200).json({ messages: [], error: e.message });
  }
};
