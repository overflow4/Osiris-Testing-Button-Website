const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

/**
 * Tests public marketing/landing pages - no login required.
 * Checks: home, book, services, contact, about, blog, offer, areas pages.
 */

const PUBLIC_SECTIONS = [
  { path: '/', label: 'Home Page', expectText: 'book|clean|service|quote|window|spotless', checks: ['booking_form', 'trust_bar', 'cta'] },
  { path: '/book', label: 'Book Page', expectText: 'book|schedule|name|email|phone|quote' },
  { path: '/services', label: 'Services Hub', expectText: 'service|clean|window|price' },
  { path: '/contact', label: 'Contact Page', expectText: 'contact|phone|email|form|quote' },
  { path: '/about', label: 'About Page', expectText: 'about|team|story|mission|clean' },
  { path: '/blog', label: 'Blog Index', expectText: 'blog|post|article|read|category' },
  { path: '/areas', label: 'Areas Hub', expectText: 'area|city|location|serve|service' },
];

module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-public][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { websiteUrl, businessName, extraPaths } = req.body;
  if (!websiteUrl) return res.status(400).json({ error: 'Missing websiteUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  try {
    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });
    console.log(`[browser-public][${requestId}] Session: ${session.id}`);

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const base = websiteUrl.replace(/\/+$/, '');
    const results = [];

    // Build section list - defaults + any extras
    const sections = [...PUBLIC_SECTIONS];
    if (extraPaths?.length) {
      extraPaths.forEach(ep => sections.push({ path: ep.path, label: ep.label, expectText: ep.expectText || '' }));
    }

    for (const section of sections) {
      console.log(`[browser-public][${requestId}] Testing: ${section.label} (${section.path})`);
      try {
        await page.goto(`${base}${section.path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);

        const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });

        const info = await page.evaluate((expectPattern, checks) => {
          const body = document.body.innerText || '';
          const trimmed = body.trim();
          const hasContent = body.length > 50;
          const hasExpected = expectPattern ? new RegExp(expectPattern, 'i').test(body) : true;
          // Only flag as error if page is mostly just an error message
          const isError = trimmed.length < 400 && /^\s*(404|500|error|oops|not found|something went wrong|unauthorized|forbidden|page not found)/i.test(trimmed);

          const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
          const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
          const links = document.querySelectorAll('a[href]');
          const images = document.querySelectorAll('img');
          const forms = document.querySelectorAll('form');

          // Check for specific marketing page elements
          const checkResults = {};
          if (checks?.includes('booking_form')) {
            checkResults.booking_form = forms.length > 0 || inputs.length >= 3;
          }
          if (checks?.includes('trust_bar')) {
            checkResults.trust_bar = /insured|bonded|rated|stars|trust|guarantee/i.test(body);
          }
          if (checks?.includes('cta')) {
            const ctaButtons = buttons.filter(b => /book|quote|call|get started|schedule/i.test(b.textContent));
            checkResults.cta = ctaButtons.length > 0 || links.length > 5;
          }

          return {
            hasContent, hasExpected, isError,
            counts: { buttons: buttons.length, inputs: inputs.length, links: links.length, images: images.length, forms: forms.length },
            checkResults,
            textPreview: body.slice(0, 300),
          };
        }, section.expectText, section.checks || []).catch(() => ({
          hasContent: false, hasExpected: false, isError: true,
          counts: {}, checkResults: {}, textPreview: '',
        }));

        const passed = info.hasContent && !info.isError && info.hasExpected;
        const parts = [];
        if (info.counts.buttons) parts.push(`${info.counts.buttons} btn`);
        if (info.counts.forms) parts.push(`${info.counts.forms} form`);
        if (info.counts.images) parts.push(`${info.counts.images} img`);
        if (info.counts.links) parts.push(`${info.counts.links} link`);

        results.push({
          section: section.path,
          label: section.label,
          passed,
          detail: info.isError ? 'Error/404' : parts.join(', ') || 'Content loaded',
          screenshot: screenshot.toString('base64'),
          counts: info.counts,
          checkResults: info.checkResults,
        });

      } catch (e) {
        results.push({
          section: section.path,
          label: section.label,
          passed: false,
          detail: `Failed: ${e.message.slice(0, 100)}`,
          screenshot: null,
        });
      }
    }

    // Test home page interactions: booking form, quote calculator
    console.log(`[browser-public][${requestId}] Testing home page interactions...`);
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      // Try to fill booking form
      const formInteraction = await page.evaluate(() => {
        const results = { formFound: false, fieldsFound: 0, ctaFound: false };

        // Look for bedrooms/bathrooms dropdowns
        const selects = document.querySelectorAll('select');
        results.fieldsFound = selects.length;

        // Look for sqft input
        const sqftInput = document.querySelector('input[placeholder*="sqft" i], input[name*="sqft" i], input[placeholder*="square" i]');
        if (sqftInput) results.fieldsFound++;

        // Look for quote/book button
        const ctaBtn = [...document.querySelectorAll('button')].find(b => /quote|book|get.*price|calculate/i.test(b.textContent));
        results.ctaFound = !!ctaBtn;
        results.formFound = results.fieldsFound >= 2 || results.ctaFound;

        return results;
      });

      results.push({
        section: 'home_interactions',
        label: 'Home Page Interactions',
        passed: formInteraction.formFound,
        detail: `${formInteraction.fieldsFound} fields, CTA: ${formInteraction.ctaFound ? 'yes' : 'no'}`,
        screenshot: null,
        counts: formInteraction,
      });

    } catch (e) {
      results.push({
        section: 'home_interactions',
        label: 'Home Page Interactions',
        passed: false,
        detail: `Failed: ${e.message.slice(0, 100)}`,
        screenshot: null,
      });
    }

    await page.close();
    await browser.close();

    const passedCount = results.filter(r => r.passed).length;
    return res.status(200).json({
      passed: passedCount >= Math.ceil(results.length * 0.6),
      score: `${passedCount}/${results.length}`,
      results,
      businessName,
    });

  } catch (e) {
    console.error(`[browser-public][${requestId}] FAILED:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message });
  }
};
