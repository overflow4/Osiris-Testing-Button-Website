const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

// Portal sections to test
const PORTAL_SECTIONS = [
  { key: 'dashboard', path: '/', label: 'Dashboard', expectText: /dashboard|welcome|overview|job|customer/i },
  { key: 'jobs', path: '/jobs', label: 'Jobs', expectText: /job|booking|appointment|schedule/i },
  { key: 'customers', path: '/customers', label: 'Customers', expectText: /customer|client|contact|name/i },
  { key: 'settings', path: '/settings', label: 'Settings', expectText: /setting|profile|account|config/i },
];

module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-portal][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { portalUrl, tenantSlug, credentials, businessName } = req.body;
  if (!portalUrl) return res.status(400).json({ error: 'Missing portalUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  try {
    console.log(`[browser-portal][${requestId}] Creating Browserbase session for ${businessName}...`);
    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });
    console.log(`[browser-portal][${requestId}] Session created: ${session.id}`);

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const baseUrl = portalUrl.replace(/\/+$/, '');
    const results = [];

    // Step 1: Navigate to portal and wait for it to load
    console.log(`[browser-portal][${requestId}] Navigating to ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000); // Wait for client-side rendering

    // Step 2: Check if there's a login page and try to log in
    let loggedIn = false;
    const loginScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });

    // Look for login form elements
    const hasLoginForm = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"]');
      const loginBtn = document.querySelector('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")');
      return inputs.length > 0;
    }).catch(() => false);

    if (hasLoginForm && credentials) {
      console.log(`[browser-portal][${requestId}] Login form detected, attempting login...`);
      try {
        // Try common email field selectors
        const emailField = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
        if (emailField) await emailField.fill(credentials.email || '');

        const passField = await page.$('input[type="password"], input[name="password"]');
        if (passField) await passField.fill(credentials.password || '');

        // Click submit
        const submitBtn = await page.$('button[type="submit"]');
        if (submitBtn) {
          await submitBtn.click();
          await page.waitForTimeout(5000);
          loggedIn = true;
          console.log(`[browser-portal][${requestId}] Login submitted`);
        }
      } catch (e) {
        console.log(`[browser-portal][${requestId}] Login failed: ${e.message}`);
      }
    } else if (!hasLoginForm) {
      // Might already be logged in or no auth required
      loggedIn = true;
    }

    const loginResult = {
      section: 'login',
      label: 'Portal Login',
      passed: loggedIn || !hasLoginForm,
      detail: hasLoginForm ? (loggedIn ? 'Logged in successfully' : 'Login failed') : 'No login required',
      screenshot: loginScreenshot.toString('base64'),
    };
    results.push(loginResult);

    // Step 3: Take a screenshot of the main page after login
    await page.waitForTimeout(3000);
    const mainScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });

    // Discover navigation links
    const navInfo = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href], nav a, [role="navigation"] a, aside a')];
      const buttons = [...document.querySelectorAll('button')];
      return {
        links: links.map(l => ({ text: l.textContent?.trim().slice(0, 40), href: l.href })).filter(l => l.text),
        buttons: buttons.map(b => ({ text: b.textContent?.trim().slice(0, 40), disabled: b.disabled, visible: b.offsetParent !== null })).filter(b => b.text && b.visible),
        bodyText: document.body.innerText.slice(0, 2000),
      };
    });
    console.log(`[browser-portal][${requestId}] Found ${navInfo.links.length} nav links, ${navInfo.buttons.length} buttons`);

    results.push({
      section: 'main',
      label: 'Main Page',
      passed: navInfo.links.length > 0 || navInfo.buttons.length > 0,
      detail: `${navInfo.links.length} links, ${navInfo.buttons.length} buttons found`,
      screenshot: mainScreenshot.toString('base64'),
      navLinks: navInfo.links.slice(0, 20),
    });

    // Step 4: Navigate to each section
    for (const section of PORTAL_SECTIONS) {
      console.log(`[browser-portal][${requestId}] Testing section: ${section.label}`);
      try {
        // Try navigating via URL first
        const sectionUrl = `${baseUrl}${section.path}`;
        await page.goto(sectionUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        const sectionScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });

        // Check if the section rendered properly
        const sectionInfo = await page.evaluate((expectPattern) => {
          const bodyText = document.body.innerText;
          const hasContent = bodyText.length > 100;
          const hasExpected = new RegExp(expectPattern, 'i').test(bodyText);
          const hasError = /error|not found|404|500/i.test(bodyText) && bodyText.length < 500;
          const buttons = [...document.querySelectorAll('button:not([disabled])')].filter(b => b.offsetParent !== null);
          const clickableCount = buttons.length;
          const inputs = document.querySelectorAll('input, select, textarea');
          return {
            hasContent,
            hasExpected,
            hasError,
            clickableCount,
            inputCount: inputs.length,
            textPreview: bodyText.slice(0, 300),
          };
        }, section.expectText.source).catch(() => ({ hasContent: false, hasExpected: false, hasError: true, clickableCount: 0, inputCount: 0, textPreview: '' }));

        // Try clicking buttons in this section
        let clickResults = [];
        const sectionButtons = await page.$$('button:not([disabled])');
        const clickableButtons = [];
        for (const btn of sectionButtons.slice(0, 5)) {
          const text = await btn.textContent().catch(() => '');
          const isVisible = await btn.isVisible().catch(() => false);
          if (isVisible && text.trim() && !/logout|sign out|delete|remove/i.test(text)) {
            clickableButtons.push({ btn, text: text.trim().slice(0, 30) });
          }
        }

        // Click first non-destructive button and verify it doesn't break
        if (clickableButtons.length > 0) {
          const { btn, text } = clickableButtons[0];
          try {
            await btn.click();
            await page.waitForTimeout(1500);
            const afterClick = await page.evaluate(() => !document.querySelector('[class*="error"]'));
            clickResults.push({ button: text, worked: afterClick });
            console.log(`[browser-portal][${requestId}] Clicked "${text}" in ${section.label}: ${afterClick ? 'OK' : 'error'}`);
            // Navigate back
            await page.goto(sectionUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
            await page.waitForTimeout(2000);
          } catch (e) {
            clickResults.push({ button: text, worked: false, error: e.message });
          }
        }

        results.push({
          section: section.key,
          label: section.label,
          passed: sectionInfo.hasContent && !sectionInfo.hasError,
          detail: sectionInfo.hasError ? 'Error on page' : `${sectionInfo.clickableCount} buttons, ${sectionInfo.inputCount} inputs`,
          screenshot: sectionScreenshot.toString('base64'),
          clickResults,
        });

      } catch (e) {
        console.log(`[browser-portal][${requestId}] Section ${section.label} failed: ${e.message}`);
        results.push({
          section: section.key,
          label: section.label,
          passed: false,
          detail: `Navigation failed: ${e.message}`,
          screenshot: null,
        });
      }
    }

    // Step 5: Test manual job input
    console.log(`[browser-portal][${requestId}] Testing manual job input...`);
    try {
      // Try navigating to a "new job" or "add job" page
      const jobPaths = ['/jobs/new', '/jobs/create', '/new-job', '/jobs?action=new'];
      let jobPageFound = false;

      for (const jp of jobPaths) {
        try {
          await page.goto(`${baseUrl}${jp}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(3000);
          const hasForm = await page.evaluate(() => document.querySelectorAll('input, textarea').length > 2);
          if (hasForm) { jobPageFound = true; break; }
        } catch (e) {}
      }

      // If direct URL didn't work, try clicking an "Add" or "New" button from the jobs page
      if (!jobPageFound) {
        await page.goto(`${baseUrl}/jobs`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(3000);
        const addBtn = await page.$('button:has-text("Add"), button:has-text("New"), button:has-text("Create"), a:has-text("Add"), a:has-text("New")');
        if (addBtn) {
          await addBtn.click();
          await page.waitForTimeout(3000);
          jobPageFound = true;
        }
      }

      const jobScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });

      if (jobPageFound) {
        // Try filling in a test job
        const formFields = await page.evaluate(() => {
          const inputs = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')];
          return inputs.map(i => ({
            type: i.type || i.tagName.toLowerCase(),
            name: i.name || i.id || '',
            placeholder: i.placeholder || '',
            visible: i.offsetParent !== null,
          })).filter(f => f.visible);
        });

        results.push({
          section: 'manual_job',
          label: 'Manual Job Input',
          passed: formFields.length > 0,
          detail: formFields.length > 0 ? `Form found with ${formFields.length} fields` : 'No form fields found',
          screenshot: jobScreenshot.toString('base64'),
          formFields: formFields.slice(0, 10),
        });
      } else {
        results.push({
          section: 'manual_job',
          label: 'Manual Job Input',
          passed: false,
          detail: 'Could not find job creation page',
          screenshot: jobScreenshot.toString('base64'),
        });
      }
    } catch (e) {
      console.log(`[browser-portal][${requestId}] Job input test failed: ${e.message}`);
      results.push({
        section: 'manual_job',
        label: 'Manual Job Input',
        passed: false,
        detail: `Failed: ${e.message}`,
        screenshot: null,
      });
    }

    await page.close();
    await browser.close();

    const passedCount = results.filter(r => r.passed).length;
    const totalCount = results.length;

    return res.status(200).json({
      passed: passedCount >= totalCount - 1,
      score: `${passedCount}/${totalCount}`,
      results,
      businessName,
    });

  } catch (e) {
    console.error(`[browser-portal][${requestId}] FAILED:`, e.message);
    console.error(`[browser-portal][${requestId}] Stack:`, e.stack);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message });
  }
};
