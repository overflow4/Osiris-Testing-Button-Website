// Single dispatcher for all browser tests — keeps Vercel function count under Hobby plan limit
const handlers = {
  invoice: require('../lib/browser-test-invoice'),
  portal: require('../lib/browser-test-portal'),
  pages: require('../lib/browser-test-pages'),
  public: require('../lib/browser-test-public'),
  crew: require('../lib/browser-test-crew'),
  customer: require('../lib/browser-test-customer'),
  interactive: require('../lib/browser-test-interactive'),
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query.type || (req.body && req.body.type);
  const fn = handlers[type];
  if (!fn) {
    return res.status(400).json({ error: `Unknown test type: ${type}. Valid: ${Object.keys(handlers).join(', ')}` });
  }
  return fn(req, res);
};
