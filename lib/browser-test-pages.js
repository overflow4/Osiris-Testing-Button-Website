const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

/**
 * Generic page tester - accepts a batch of sections to test.
 * Each section: { path, label, expectText, expectElements }
 * Navigates to each, takes screenshot, checks for expected content/elements.
 */
module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-pages][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { baseUrl, sections, credentials, businessName, loginFirst } = req.body;
  if (!baseUrl || !sections?.length) return res.status(400).json({ error: 'Missing baseUrl or sections' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  try {
    console.log(`[browser-pages][${requestId}] Creating Browserbase session for ${businessName || 'unknown'}...`);
    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });
    console.log(`[browser-pages][${requestId}] Session created: ${session.id}`);

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const base = baseUrl.replace(/\/+$/, '');
    const results = [];

    // Step 1: Login (Osiris flow: role → credentials → INITIALIZE)
    if (loginFirst && credentials?.email) {
      console.log(`[browser-pages][${requestId}] Logging in at ${base}...`);
      const { osirisLogin } = require('./browser-helpers');
      const loggedIn = await osirisLogin(page, base, credentials);
      const endUrl = page.url();
      const loginScreenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
      results.push({
        section: 'login',
        label: 'Login',
        passed: loggedIn,
        detail: loggedIn ? `Logged in → ${endUrl.slice(0, 80)}` : `Login failed — stuck at ${endUrl.slice(0, 80)}`,
        screenshot: loginScreenshot.toString('base64'),
      });
      if (!loggedIn) {
        // No point testing pages if not logged in — every page will just be the login wall
        console.log(`[browser-pages][${requestId}] Login failed; skipping section tests`);
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
        return res.status(200).json({ passed: false, score: '0/1', results, businessName, note: 'Login failed — skipped all sections' });
      }
    }

    // Step 2: Test each section
    let browserDead = false;
    for (const section of sections) {
      const sectionKey = section.key || section.path.replace(/\//g, '_').replace(/^_/, '') || 'root';

      // If a previous section crashed the browser, skip cleanly instead of hitting
      // "Target page, context or browser has been closed" on every subsequent navigation.
      if (browserDead) {
        results.push({ section: sectionKey, label: section.label, passed: false, detail: 'Skipped: browser crashed earlier in batch', screenshot: null, counts: {} });
        continue;
      }

      console.log(`[browser-pages][${requestId}] Testing: ${section.label} (${section.path})`);

      try {
        const sectionUrl = `${base}${section.path}`;
        await page.goto(sectionUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(section.waitMs || 4000);

        // Take screenshot (not full page to save bandwidth/time)
        const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });

        // Evaluate the page
        const info = await page.evaluate((expectPattern, expectElements) => {
          const bodyText = document.body.innerText || '';
          const trimmed = bodyText.trim();
          const hasContent = bodyText.length > 50;
          const hasExpected = expectPattern ? new RegExp(expectPattern, 'i').test(bodyText) : true;
          // Error detection: only flag pages that are mostly error text (no normal nav/content)
          const isError = trimmed.length < 400 && /^\s*(404|500|error|oops|not found|something went wrong|unauthorized|forbidden|page not found)/i.test(trimmed);
          const isLoading = bodyText.length < 200 && /loading\.\.\.|please wait/i.test(bodyText);

          // Count interactive elements
          const buttons = [...document.querySelectorAll('button:not([disabled])')].filter(b => b.offsetParent !== null);
          const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
          const links = document.querySelectorAll('a[href]');
          const tables = document.querySelectorAll('table, [role="grid"], [class*="table"]');
          const charts = document.querySelectorAll('canvas, svg[class*="chart"], [class*="chart"], [class*="recharts"]');
          const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"]');
          const toggles = document.querySelectorAll('input[type="checkbox"], input[role="switch"], [class*="switch"], [class*="toggle"]');
          const tabs = document.querySelectorAll('[role="tab"], [class*="tab"]');
          const cards = document.querySelectorAll('[class*="card"]');
          const badges = document.querySelectorAll('[class*="badge"]');

          // Check for specific expected elements
          let elementResults = {};
          if (expectElements) {
            for (const [name, selector] of Object.entries(expectElements)) {
              const found = document.querySelectorAll(selector);
              elementResults[name] = { found: found.length, selector };
            }
          }

          return {
            hasContent,
            hasExpected,
            isError,
            isLoading,
            url: window.location.href,
            title: document.title,
            counts: {
              buttons: buttons.length,
              inputs: inputs.length,
              links: links.length,
              tables: tables.length,
              charts: charts.length,
              modals: modals.length,
              toggles: toggles.length,
              tabs: tabs.length,
              cards: cards.length,
              badges: badges.length,
            },
            elementResults,
            textPreview: bodyText.slice(0, 300),
          };
        }, section.expectText || null, section.expectElements || null).catch(() => ({
          hasContent: false, hasExpected: false, isError: true, isLoading: false,
          counts: {}, elementResults: {}, textPreview: '',
        }));

        // Determine pass/fail
        const passed = info.hasContent && !info.isError && !info.isLoading && info.hasExpected;

        // Build detail string
        const countParts = [];
        if (info.counts.buttons) countParts.push(`${info.counts.buttons} btn`);
        if (info.counts.inputs) countParts.push(`${info.counts.inputs} input`);
        if (info.counts.tables) countParts.push(`${info.counts.tables} tbl`);
        if (info.counts.charts) countParts.push(`${info.counts.charts} chart`);
        if (info.counts.toggles) countParts.push(`${info.counts.toggles} toggle`);
        if (info.counts.tabs) countParts.push(`${info.counts.tabs} tab`);
        if (info.counts.cards) countParts.push(`${info.counts.cards} card`);
        if (info.counts.badges) countParts.push(`${info.counts.badges} badge`);

        let detail = info.isError ? 'Error page' :
                     info.isLoading ? 'Stuck loading' :
                     !info.hasContent ? 'Empty page' :
                     !info.hasExpected ? 'Missing expected content' :
                     countParts.join(', ') || 'Content loaded';

        // Check expected elements
        const elementChecks = [];
        for (const [name, result] of Object.entries(info.elementResults || {})) {
          elementChecks.push({
            name,
            found: result.found,
            passed: result.found > 0,
          });
        }

        results.push({
          section: sectionKey,
          label: section.label,
          passed,
          detail,
          screenshot: screenshot.toString('base64'),
          counts: info.counts,
          elementChecks,
          url: info.url,
        });

      } catch (e) {
        console.log(`[browser-pages][${requestId}] Section ${section.label} failed: ${e.message}`);
        const browserClosed = /closed|disconnected|detached|Target page/i.test(e.message);
        if (browserClosed) {
          browserDead = true;
          console.log(`[browser-pages][${requestId}] Browser died — skipping remaining sections`);
        }
        results.push({
          section: sectionKey,
          label: section.label,
          passed: false,
          detail: browserClosed ? 'Browser crashed / disconnected' : `Navigation failed: ${e.message.slice(0, 100)}`,
          screenshot: null,
          counts: {},
          elementChecks: [],
        });
      }
    }

    await page.close().catch(() => {});
    await browser.close().catch(() => {});

    const passedCount = results.filter(r => r.passed).length;
    const totalCount = results.length;

    return res.status(200).json({
      passed: passedCount >= Math.ceil(totalCount * 0.7),
      score: `${passedCount}/${totalCount}`,
      results,
      businessName,
    });

  } catch (e) {
    console.error(`[browser-pages][${requestId}] FAILED:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message });
  }
};
