const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[proxy-email][${requestId}] Incoming ${req.method} request`);
  console.log(`[proxy-email][${requestId}] Headers:`, JSON.stringify(req.headers, null, 2));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    console.log(`[proxy-email][${requestId}] CORS preflight — returning 200`);
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    console.log(`[proxy-email][${requestId}] Method not allowed: ${req.method}`);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, subject, body, from } = req.body;
  console.log(`[proxy-email][${requestId}] Request body:`, JSON.stringify({ to, subject, from, bodyLength: body?.length || 0 }));

  if (!to) {
    console.log(`[proxy-email][${requestId}] Missing "to" address — aborting`);
    return res.status(400).json({ error: 'Missing "to" address' });
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  console.log(`[proxy-email][${requestId}] GMAIL_USER set: ${!!gmailUser} (${gmailUser ? gmailUser.slice(0, 3) + '***' : 'N/A'})`);
  console.log(`[proxy-email][${requestId}] GMAIL_APP_PASSWORD set: ${!!gmailPass} (length: ${gmailPass?.length || 0})`);

  if (!gmailUser || !gmailPass) {
    console.log(`[proxy-email][${requestId}] No Gmail credentials — returning error`);
    return res.status(200).json({
      sent: false,
      error: 'No Gmail credentials configured. Set GMAIL_USER and GMAIL_APP_PASSWORD env vars.',
    });
  }

  try {
    console.log(`[proxy-email][${requestId}] Creating nodemailer transport for ${gmailUser}`);
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });

    const mailOptions = {
      from: from || `"Alex Thompson" <${gmailUser}>`,
      to,
      subject: subject || 'Cleaning Inquiry - Alex Thompson',
      html: body || '<p>Test email from Jack\'s Tester</p>',
    };
    console.log(`[proxy-email][${requestId}] Sending email:`, JSON.stringify({ from: mailOptions.from, to: mailOptions.to, subject: mailOptions.subject }));

    const info = await transporter.sendMail(mailOptions);
    console.log(`[proxy-email][${requestId}] Email sent successfully. MessageId: ${info.messageId}`);
    console.log(`[proxy-email][${requestId}] SMTP response: ${info.response}`);

    return res.status(200).json({ sent: true, provider: 'gmail', messageId: info.messageId });
  } catch (e) {
    console.error(`[proxy-email][${requestId}] Email send FAILED:`, e.message);
    console.error(`[proxy-email][${requestId}] Error stack:`, e.stack);
    return res.status(200).json({ sent: false, error: e.message });
  }
};
