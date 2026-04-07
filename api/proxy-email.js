export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { to, subject, body } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing "to" address' });

  // Use Supabase Edge Function or direct SMTP is not available from serverless.
  // For now, log the email attempt and return a placeholder response.
  // To enable real email sending, add a RESEND_API_KEY or SENDGRID_API_KEY env var.

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Osiris Test <test@osiris-test.dev>',
          to: [to],
          subject: subject || 'Osiris E2E Test - Cleaning Inquiry',
          html: body || '<p>Test email from Osiris E2E runner</p>',
        }),
      });
      const data = await response.json();
      return res.status(200).json({ sent: true, provider: 'resend', response: data });
    } catch (e) {
      return res.status(200).json({ sent: false, error: e.message });
    }
  }

  return res.status(200).json({
    sent: false,
    error: 'No email provider configured. Set RESEND_API_KEY env var to enable.',
  });
}
