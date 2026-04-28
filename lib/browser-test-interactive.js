const { createSession, osirisLogin, shot, safeClick, runCheck } = require('./browser-helpers');

/**
 * Discovery-based interactive test.
 * Logs into admin, walks every nav link, exercises every visible button on
 * each page, reports per-page health. Resilient to UI changes — doesn't rely
 * on hardcoded selectors for specific buttons/modals.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { baseUrl, credentials, businessName } = req.body;
  if (!baseUrl) return res.status(400).json({ error: 'Missing baseUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') {
    return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });
  }

  let browser, page;
  const results = [];

  try {
    const session = await createSession();
    browser = session.browser;
    page = session.page;

    const base = baseUrl.replace(/\/+$/, '');
    let origin;
    try { origin = new URL(base).origin; } catch { origin = base; }

    // ── Login ──
    await runCheck(results, 'Login', async () => {
      const ok = await osirisLogin(page, base, credentials);
      return { passed: ok, detail: ok ? `Logged in → ${page.url()}` : `Failed at ${page.url()}`, screenshot: await shot(page) };
    });

    // ── Discover nav links ──
    let navLinks = [];
    await runCheck(results, 'Navigation Discovery', async () => {
      navLinks = await page.evaluate((allowedOrigin) => {
        const candidates = [...document.querySelectorAll('nav a[href], aside a[href], [role="navigation"] a[href], header a[href], [class*="sidebar"] a[href]')];
        const seen = new Set();
        return candidates
          .map(l => ({ text: (l.textContent || '').trim().slice(0, 40), href: l.href }))
          .filter(l => {
            if (!l.text || !l.href || l.href === '#') return false;
            if (seen.has(l.href)) return false;
            if (/javascript:|logout|sign.?out/i.test(l.href + l.text)) return false;
            try {
              if (new URL(l.href).origin !== allowedOrigin) return false;
            } catch { return false; }
            seen.add(l.href);
            return true;
          });
      }, origin);
      return {
        passed: navLinks.length > 0,
        detail: `${navLinks.length} navigation links discovered`,
        screenshot: await shot(page),
      };
    });

    // ── Test every discovered page ──
    let totalPagesLoaded = 0;
    let totalButtonsClicked = 0;
    let totalJsErrors = 0;

    // Capture JS errors during the run
    const jsErrors = [];
    page.on('pageerror', err => jsErrors.push(err.message));

    for (const link of navLinks.slice(0, 30)) {
      const errorsBefore = jsErrors.length;
      await runCheck(results, `Page: ${link.text}`, async () => {
        try {
          await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(3000);
        } catch (e) {
          return { passed: false, detail: `Failed to load: ${e.message}` };
        }

        const info = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          const visibleButtons = [...document.querySelectorAll('button:not([disabled])')].filter(b => b.offsetParent !== null);
          const visibleLinks = [...document.querySelectorAll('a[href]')].filter(a => a.offsetParent !== null);
          const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
          const tabs = document.querySelectorAll('[role="tab"], [class*="tab"]');
          const charts = document.querySelectorAll('canvas, svg[class*="chart"], [class*="recharts"]');
          const cards = document.querySelectorAll('[class*="card"], [class*="metric"], [class*="stat"]');
          const tables = document.querySelectorAll('table, [role="grid"]');
          // Only flag as error if body is dominated by error text (not just contains numbers like 404 in metrics)
          const trimmed = bodyText.trim();
          const hasError = trimmed.length < 250 && /^\s*(404|500|page not found|not found|something went wrong|unauthorized|forbidden|access denied|access required)/i.test(trimmed);
          return {
            hasContent: bodyText.length > 100,
            hasError,
            buttonCount: visibleButtons.length,
            linkCount: visibleLinks.length,
            inputCount: inputs.length,
            tabCount: tabs.length,
            chartCount: charts.length,
            cardCount: cards.length,
            tableCount: tables.length,
            url: window.location.href,
          };
        });

        if (info.hasContent) totalPagesLoaded++;

        // Try clicking up to 5 visible non-destructive buttons
        let clicked = 0;
        let clickedSafely = 0;
        const startUrl = page.url();
        const buttons = await page.$$('button:not([disabled])');
        for (const btn of buttons.slice(0, 8)) {
          const text = (await btn.textContent().catch(() => '') || '').trim().slice(0, 30);
          const visible = await btn.isVisible().catch(() => false);
          if (!visible || !text) continue;
          if (/logout|sign out|delete|remove|confirm delete|disable|deactivate/i.test(text)) continue;
          try {
            await btn.click({ timeout: 2000 });
            await page.waitForTimeout(800);
            clicked++;
            // If page navigated, return to start
            if (page.url() !== startUrl) {
              try {
                if (new URL(page.url()).origin !== origin) {
                  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                }
              } catch {}
            }
            // Close any opened modal
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(300);
            clickedSafely++;
            if (clicked >= 5) break;
          } catch {}
        }
        totalButtonsClicked += clickedSafely;

        const errorsDuring = jsErrors.length - errorsBefore;
        totalJsErrors += errorsDuring;

        const passed = info.hasContent && !info.hasError;
        const detailParts = [];
        detailParts.push(`${info.buttonCount} buttons`);
        if (info.inputCount) detailParts.push(`${info.inputCount} inputs`);
        if (info.tabCount) detailParts.push(`${info.tabCount} tabs`);
        if (info.chartCount) detailParts.push(`${info.chartCount} charts`);
        if (info.cardCount) detailParts.push(`${info.cardCount} cards`);
        if (info.tableCount) detailParts.push(`${info.tableCount} tables`);
        if (clickedSafely) detailParts.push(`clicked ${clickedSafely} buttons OK`);
        if (errorsDuring) detailParts.push(`${errorsDuring} JS errors`);
        if (info.hasError) detailParts.push('PAGE ERROR');
        return {
          passed,
          detail: detailParts.join(' • '),
          screenshot: await shot(page),
        };
      });
    }

    // ── Final summary ──
    await runCheck(results, 'Overall Health', async () => {
      const passed = totalPagesLoaded >= Math.max(1, Math.floor(navLinks.length * 0.6)) && totalJsErrors === 0;
      return {
        passed,
        detail: `${totalPagesLoaded}/${navLinks.length} pages loaded, ${totalButtonsClicked} buttons clicked safely, ${totalJsErrors} JS errors total`,
      };
    });

    await browser.close();

    const passedCount = results.filter(r => r.passed).length;
    const totalCount = results.length;
    return res.status(200).json({
      passed: passedCount >= Math.floor(totalCount * 0.7),
      score: `${passedCount}/${totalCount}`,
      results,
      businessName,
    });

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    console.error('[interactive] FAILED:', e.message);
    return res.status(200).json({ error: e.message, results });
  }
};
