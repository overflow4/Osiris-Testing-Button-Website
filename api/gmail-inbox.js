// Read the test-sender's Gmail inbox via IMAP. Used by the email test to
// check whether the business actually replied via EMAIL (the correct channel
// for an email inquiry), instead of polling SMS and picking up cross-test
// noise.
//
// Reads from GMAIL_USER using GMAIL_APP_PASSWORD (already configured for
// outbound email in /api/proxy-email).

const { ImapFlow } = require('imapflow');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return res.status(200).json({ error: 'GMAIL_USER / GMAIL_APP_PASSWORD not configured' });
  }

  // Body params:
  //   since: ISO timestamp — only return emails received after this time.
  //   from: optional substring filter on sender address (case-insensitive).
  //   subject: optional substring filter on subject (case-insensitive).
  //   limit: max number of results (default 10).
  const { since, from, subject, limit = 10 } = req.body || {};
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 5 * 60 * 1000);

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const messages = [];
    try {
      // SEARCH for messages received after sinceDate. IMAP SINCE is
      // date-precision (whole days), so we still apply a finer filter below.
      const since2 = new Date(sinceDate.getTime());
      // Fetch up to ~50 most-recent messages, then filter.
      const seq = await client.search({ since: since2 }, { uid: true });
      const uids = (seq || []).slice(-50);
      if (uids.length === 0) {
        await lock.release();
        await client.logout().catch(() => {});
        return res.status(200).json({ count: 0, messages: [] });
      }

      for await (const msg of client.fetch(uids, { envelope: true, source: true, internalDate: true }, { uid: true })) {
        const env = msg.envelope || {};
        const internalDate = msg.internalDate || env.date;
        if (!internalDate || new Date(internalDate) < sinceDate) continue;

        const fromAddr = (env.from || []).map(a => `${a.name || ''} <${a.address || ''}>`).join(', ');
        const fromAddrLower = (env.from || []).map(a => (a.address || '').toLowerCase()).join(' ');
        const subjLower = (env.subject || '').toLowerCase();

        if (from && !fromAddrLower.includes(from.toLowerCase())) continue;
        if (subject && !subjLower.includes(subject.toLowerCase())) continue;

        // Pull a plain-text snippet from the source. Quick + dirty: strip HTML
        // tags and keep the first ~600 chars.
        let bodyText = '';
        try {
          const raw = msg.source ? msg.source.toString('utf8') : '';
          // Find the body after the blank line separating headers from body
          const sep = raw.indexOf('\r\n\r\n');
          let body = sep >= 0 ? raw.slice(sep + 4) : raw;
          // Decode quoted-printable soft line breaks
          body = body.replace(/=\r?\n/g, '');
          // Strip HTML tags
          body = body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
          body = body.replace(/<[^>]+>/g, ' ');
          body = body.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
          body = body.replace(/\s+/g, ' ').trim();
          bodyText = body.slice(0, 800);
        } catch (e) {}

        messages.push({
          uid: msg.uid,
          date: internalDate,
          from: fromAddr,
          subject: env.subject || '',
          bodyPreview: bodyText,
        });
        if (messages.length >= limit) break;
      }
    } finally {
      await lock.release();
    }
    await client.logout().catch(() => {});

    // Sort newest first
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));

    return res.status(200).json({ count: messages.length, messages });
  } catch (e) {
    console.error('[gmail-inbox] error:', e.message);
    try { await client.logout(); } catch {}
    return res.status(200).json({ error: e.message });
  }
};
