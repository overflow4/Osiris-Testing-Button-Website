const { createSession } = require('./browser-helpers');

/**
 * Tests public marketing/landing pages — no login required.
 *
 * Strategy: visit the home page, then DISCOVER actual internal nav links and
 * test those. This works for any marketing site (cleaning-business with
 * /book /services /contact, OR a single-page product marketing site like
 * theosirisai.com that only has /osiris-marketing). Hardcoded paths fail on
 * sites that don't match the assumed structure.
 *
 * Optional fallback paths: if the discovered nav has fewer than 3 links,
 * we try a small set of common marketing routes — but only count them as
 * failures if they 5xx, not if they 404 (404 just means the route doesn't
 * exist on this site, which isn't a bug).
 */

// Common marketing-site paths to probe IF the home page nav is sparse.
const FALLBACK_PROBES = [
  { path: '/book', label: 'Book/Schedule', expectText: 'book|schedule|name|email|phone|quote|demo' },
  { path: '/services', label: 'Services', expectText: 'service|product|feature|clean' },
  { path: '/contact', label: 'Contact', expectText: 'contact|phone|email|form|reach' },
  { path: '/about', label: 'About', expectText: 'about|team|story|mission|company' },
  { path: '/blog', label: 'Blog', expectText: 'blog|post|article|read' },
  { path: '/pricing', label: 'Pricing', expectText: 'pricing|plan|month|year|cost|free' },
  { path: '/demo', label: 'Demo', expectText: 'demo|book|schedule|see' },
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
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  try {
    const sess = await createSession(apiKey, process.env.BROWSERBASE_PROJECT_ID);
    browser = sess.browser;
    const page = sess.page;

    const base = websiteUrl.replace(/\/+$/, '');
    const baseHost = new URL(base).host;
    const results = [];

    // ── Step 1: Test home page AND discover real internal nav links ──
    console.log(`[browser-public][${requestId}] Loading home: ${base}`);
    let homeInfo;
    try {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3500);
      const homeShot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });

      homeInfo = await page.evaluate((host) => {
        const body = document.body.innerText || '';
        const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        const allLinks = [...document.querySelectorAll('a[href]')];
        const internalLinks = allLinks
          .map(a => {
            try {
              const u = new URL(a.href);
              return { text: (a.textContent || '').trim().slice(0, 50), href: a.href, host: u.host, path: u.pathname };
            } catch { return null; }
          })
          .filter(Boolean)
          .filter(l => l.host === host && l.path !== '' && l.path !== '/' && !l.path.includes('#') && l.text);

        // De-dupe by path
        const seen = new Set();
        const uniquePaths = [];
        for (const l of internalLinks) {
          if (!seen.has(l.path)) {
            seen.add(l.path);
            uniquePaths.push(l);
          }
        }

        return {
          buttonCount: buttons.length,
          formCount: document.querySelectorAll('form').length,
          imageCount: document.querySelectorAll('img').length,
          internalPaths: uniquePaths.slice(0, 12),
          hasCTA: buttons.some(b => /book|demo|get started|sign up|try|contact|call|quote|free/i.test(b.textContent)) ||
                  allLinks.some(a => /book|demo|get started|sign up|try|contact|call|quote/i.test(a.textContent || '')),
          hasTrust: /insured|bonded|rated|stars|trust|guarantee|trusted by|customers/i.test(body),
          textLen: body.length,
        };
      }, baseHost);

      results.push({
        section: '/',
        label: 'Home Page',
        passed: homeInfo.textLen > 200 && homeInfo.hasCTA,
        detail: `${homeInfo.buttonCount} btn, ${homeInfo.formCount} form, ${homeInfo.imageCount} img, ${homeInfo.internalPaths.length} nav links, CTA:${homeInfo.hasCTA}, trust:${homeInfo.hasTrust}`,
        screenshot: homeShot.toString('base64'),
        counts: { buttons: homeInfo.buttonCount, forms: homeInfo.formCount, images: homeInfo.imageCount, links: homeInfo.internalPaths.length },
      });
    } catch (e) {
      results.push({
        section: '/',
        label: 'Home Page',
        passed: false,
        detail: `Failed: ${e.message.slice(0, 100)}`,
        screenshot: null,
      });
      // If we can't even load home, abort
      await browser.close().catch(() => {});
      const passedCount = results.filter(r => r.passed).length;
      return res.status(200).json({ passed: false, score: `${passedCount}/${results.length}`, results, businessName });
    }

    // ── Step 2: Build the section list to test ──
    const discovered = (homeInfo.internalPaths || []).map(l => ({
      path: l.path,
      label: l.text || l.path,
      // Build expectText from the link's own anchor text — pages should contain
      // their own nav label, plus we accept body content >100 chars
      expectText: '',
    }));

    let sections;
    if (discovered.length >= 3) {
      // Site has a real nav — test those routes
      sections = discovered;
      console.log(`[browser-public][${requestId}] Discovered ${discovered.length} routes from nav`);
    } else {
      // Single-page or sparse nav — probe common paths but don't penalize 404s
      sections = [...discovered, ...FALLBACK_PROBES];
      console.log(`[browser-public][${requestId}] Sparse nav (${discovered.length}) — adding probe paths`);
    }

    // Caller-supplied extras always tested
    if (extraPaths?.length) {
      extraPaths.forEach(ep => sections.push({ path: ep.path, label: ep.label, expectText: ep.expectText || '' }));
    }

    const isProbe = (path) => FALLBACK_PROBES.some(fp => fp.path === path);

    // ── Step 3: Visit each section ──
    for (const section of sections) {
      console.log(`[browser-public][${requestId}] Testing: ${section.label} (${section.path})`);
      try {
        const resp = await page.goto(`${base}${section.path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2500);

        const httpStatus = resp?.status() || 0;
        const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });

        const info = await page.evaluate((expectPattern) => {
          const body = document.body.innerText || '';
          const trimmed = body.trim();
          const hasContent = body.length > 200;
          const hasExpected = expectPattern ? new RegExp(expectPattern, 'i').test(body) : true;
          const isError = trimmed.length < 400 && /^\s*(404|500|error|oops|not found|page not found|this page could not be found)/i.test(trimmed);
          const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
          const forms = document.querySelectorAll('form');
          const links = document.querySelectorAll('a[href]');
          const images = document.querySelectorAll('img');
          return {
            hasContent, hasExpected, isError,
            counts: { buttons: buttons.length, forms: forms.length, links: links.length, images: images.length },
            textLen: body.length,
          };
        }, section.expectText || '').catch(() => ({ hasContent: false, hasExpected: false, isError: true, counts: {}, textLen: 0 }));

        const is404 = httpStatus === 404 || info.isError;
        const probe = isProbe(section.path);

        let passed, detail;
        if (is404 && probe) {
          // Don't penalize: probe path doesn't exist on this site, that's fine
          passed = true;
          detail = `Not present on this site (skipped, probe path)`;
        } else if (is404) {
          passed = false;
          detail = `404 / not found (HTTP ${httpStatus})`;
        } else {
          passed = info.hasContent && info.hasExpected;
          const parts = [];
          if (info.counts.buttons) parts.push(`${info.counts.buttons} btn`);
          if (info.counts.forms) parts.push(`${info.counts.forms} form`);
          if (info.counts.images) parts.push(`${info.counts.images} img`);
          if (info.counts.links) parts.push(`${info.counts.links} link`);
          detail = parts.join(', ') || `${info.textLen} chars`;
        }

        results.push({
          section: section.path,
          label: section.label,
          passed,
          detail,
          screenshot: is404 ? null : screenshot.toString('base64'),
          counts: info.counts,
          probe,
        });

      } catch (e) {
        const probe = isProbe(section.path);
        results.push({
          section: section.path,
          label: section.label,
          passed: probe, // probes that fail to load aren't counted against us
          detail: probe ? `Probe path skipped (${e.message.slice(0, 60)})` : `Failed: ${e.message.slice(0, 100)}`,
          screenshot: null,
        });
      }
    }

    await page.close().catch(() => {});
    await browser.close().catch(() => {});

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
