const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, body, from } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to" address' });

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailPass) {
    return res.status(200).json({
      sent: false,
      error: 'No Gmail credentials configured. Set GMAIL_USER and GMAIL_APP_PASSWORD env vars.',
    });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass },
    });

    const info = await transporter.sendMail({
      from: from || `"Alex Thompson" <${gmailUser}>`,
      to,
      subject: subject || 'Cleaning Inquiry - Alex Thompson',
      html: body || '<p>Test email from Osiris E2E runner</p>',
    });

    return res.status(200).json({ sent: true, provider: 'gmail', messageId: info.messageId });
  } catch (e) {
    return res.status(200).json({ sent: false, error: e.message });
  }
};
