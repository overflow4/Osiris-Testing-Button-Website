const http = require('http');
const { chromium } = require('playwright');

const PORT = 3847;

async function handleInvoiceTest(body) {
  const { quoteUrl, businessName } = body;
  if (!quoteUrl) return { error: 'Missing quoteUrl' };

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    console.log(`[invoice] Opening ${quoteUrl}`);
    await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for client-side rendering
    await page.waitForFunction(() => {
      return !document.querySelector('.animate-spin') || document.querySelectorAll('button').length > 2;
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    const screenshotBefore = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const beforeB64 = screenshotBefore.toString('base64');

    // Gather page info
    const pageInfo = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].map(b => ({
        text: b.textContent?.trim().slice(0, 50),
        disabled: b.disabled,
        visible: b.offsetParent !== null,
      }));
      const prices = document.body.innerText.match(/\$[\d,.]+/g) || [];
      const hasError = !!document.querySelector('[class*="error"], [class*="Error"]');
      const bodyText = document.body.innerText.slice(0, 3000);
      return { buttons, prices, hasError, bodyText };
    });

    const checks = [];
    let clickedTier = false;
    let clickedCheckout = false;
    let stripeRedirect = false;

    const isLoaded = !pageInfo.bodyText.includes('Loading your quote...') || pageInfo.buttons.length > 0;
    checks.push({ t: 'Quote page loaded', s: isLoaded, d: isLoaded ? `${pageInfo.buttons.length} buttons, ${pageInfo.prices.length} prices found` : 'Page stuck on loading spinner' });
    checks.push({ t: 'Price displayed', s: pageInfo.prices.length > 0, d: pageInfo.prices.length > 0 ? `Found: ${pageInfo.prices.join(', ')}` : 'No prices visible' });
    checks.push({ t: 'No errors on page', s: !pageInfo.hasError, d: pageInfo.hasError ? 'Error element detected' : 'Clean' });

    // Click tier button
    const tierButtons = await page.$$('button:not([disabled])');
    for (const btn of tierButtons) {
      const text = await btn.textContent().catch(() => '');
      if (/standard|deep|move|select|choose/i.test(text) && !/book|pay|checkout|approve/i.test(text)) {
        try {
          await btn.click();
          clickedTier = true;
          console.log(`[invoice] Clicked tier: "${text.trim().slice(0, 30)}"`);
          await page.waitForTimeout(1000);
          break;
        } catch (e) {}
      }
    }
    checks.push({ t: 'Tier/option selectable', s: clickedTier, d: clickedTier ? 'Clicked a tier button' : 'No tier buttons found' });

    const screenshotMid = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const midB64 = screenshotMid.toString('base64');

    // Click checkout button
    const allButtons = await page.$$('button:not([disabled])');
    for (const btn of allButtons) {
      const text = await btn.textContent().catch(() => '');
      if (/book|pay|checkout|approve|confirm|submit|continue/i.test(text)) {
        try {
          const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
          for (const cb of checkboxes) await cb.click().catch(() => {});
          await page.waitForTimeout(500);

          await btn.click();
          clickedCheckout = true;
          console.log(`[invoice] Clicked checkout: "${text.trim().slice(0, 30)}"`);

          try {
            await page.waitForURL(/stripe\.com|checkout/i, { timeout: 15000 });
            stripeRedirect = true;
          } catch (e) {
            if (/stripe|checkout/i.test(page.url())) stripeRedirect = true;
          }
          console.log(`[invoice] URL after checkout: ${page.url()}`);
          break;
        } catch (e) {}
      }
    }
    checks.push({ t: 'Checkout button clickable', s: clickedCheckout, d: clickedCheckout ? 'Clicked' : 'Not found' });
    checks.push({ t: 'Redirects to Stripe', s: stripeRedirect, d: stripeRedirect ? page.url().slice(0, 80) : 'No redirect' });

    const screenshotAfter = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const afterB64 = screenshotAfter.toString('base64');

    // DB check
    let dbVerified = false;
    try {
      const urlParts = quoteUrl.split('/');
      const token = urlParts[urlParts.length - 1];
      const dbRes = await fetch(`https://kcmbwstjmdrjkhxhkkjt.supabase.co/rest/v1/quotes?token=eq.${token}&select=status,selected_tier,selected_addons`, {
        headers: {
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjbWJ3c3RqbWRyamtoeGhra2p0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU3NTQwNiwiZXhwIjoyMDg1MTUxNDA2fQ.PacsDAnXZHXutdNVe8ClCJGDeDVQ2viu9b_aJLPmE24',
          'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjbWJ3c3RqbWRyamtoeGhra2p0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU3NTQwNiwiZXhwIjoyMDg1MTUxNDA2fQ.PacsDAnXZHXutdNVe8ClCJGDeDVQ2viu9b_aJLPmE24'
        }
      });
      const dbData = await dbRes.json();
      if (dbData.length > 0 && dbData[0].selected_tier) dbVerified = true;
    } catch (e) {}
    checks.push({ t: 'Selection saved to database', s: dbVerified, d: dbVerified ? 'Quote updated' : 'Not updated' });

    await browser.close();

    const passed = checks.filter(c => c.s).length;
    return {
      passed: passed >= checks.length - 1,
      score: `${passed}/${checks.length}`,
      checks,
      screenshots: { before: beforeB64, afterSelection: midB64, afterCheckout: afterB64 },
    };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { error: e.message };
  }
}

async function handlePortalTest(body) {
  const { portalUrl, businessName, credentials } = body;
  if (!portalUrl) return { error: 'Missing portalUrl' };

  const SECTIONS = [
    { key: 'dashboard', path: '/', label: 'Dashboard' },
    { key: 'jobs', path: '/jobs', label: 'Jobs' },
    { key: 'customers', path: '/customers', label: 'Customers' },
    { key: 'settings', path: '/settings', label: 'Settings' },
  ];

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const baseUrl = portalUrl.replace(/\/+$/, '');
    const results = [];

    console.log(`[portal] Opening ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // Login check
    const loginScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const hasLoginForm = await page.evaluate(() => {
      return document.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"]').length > 0;
    }).catch(() => false);

    let loggedIn = !hasLoginForm;
    if (hasLoginForm && credentials) {
      try {
        const emailField = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
        if (emailField) await emailField.fill(credentials.email || '');
        const passField = await page.$('input[type="password"], input[name="password"]');
        if (passField) await passField.fill(credentials.password || '');
        const submitBtn = await page.$('button[type="submit"]');
        if (submitBtn) { await submitBtn.click(); await page.waitForTimeout(5000); loggedIn = true; }
      } catch (e) {}
    }

    results.push({
      section: 'login', label: 'Portal Login',
      passed: loggedIn,
      detail: hasLoginForm ? (loggedIn ? 'Logged in' : 'Login failed') : 'No login required',
      screenshot: loginScreenshot.toString('base64'),
    });

    // Main page
    await page.waitForTimeout(3000);
    const mainScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const navInfo = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href], nav a, aside a')];
      const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
      return {
        linkCount: links.length,
        buttonCount: buttons.length,
        bodyText: document.body.innerText.slice(0, 1000),
      };
    });

    results.push({
      section: 'main', label: 'Main Page',
      passed: navInfo.linkCount > 0 || navInfo.buttonCount > 0,
      detail: `${navInfo.linkCount} links, ${navInfo.buttonCount} buttons`,
      screenshot: mainScreenshot.toString('base64'),
    });

    // Navigate sections
    for (const section of SECTIONS) {
      console.log(`[portal] Testing: ${section.label}`);
      try {
        await page.goto(`${baseUrl}${section.path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        const ss = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
        const info = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          return {
            hasContent: bodyText.length > 100,
            hasError: /error|not found|404|500/i.test(bodyText) && bodyText.length < 500,
            buttonCount: [...document.querySelectorAll('button:not([disabled])')].filter(b => b.offsetParent !== null).length,
            inputCount: document.querySelectorAll('input, select, textarea').length,
          };
        }).catch(() => ({ hasContent: false, hasError: true, buttonCount: 0, inputCount: 0 }));

        // Try clicking a button
        let clickResults = [];
        const btns = await page.$$('button:not([disabled])');
        for (const btn of btns.slice(0, 3)) {
          const text = await btn.textContent().catch(() => '');
          const visible = await btn.isVisible().catch(() => false);
          if (visible && text.trim() && !/logout|sign out|delete|remove/i.test(text)) {
            try {
              await btn.click();
              await page.waitForTimeout(1500);
              const ok = await page.evaluate(() => !document.querySelector('[class*="error"]'));
              clickResults.push({ button: text.trim().slice(0, 30), worked: ok });
              await page.goto(`${baseUrl}${section.path}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
              await page.waitForTimeout(2000);
              break;
            } catch (e) {
              clickResults.push({ button: text.trim().slice(0, 30), worked: false });
            }
          }
        }

        results.push({
          section: section.key, label: section.label,
          passed: info.hasContent && !info.hasError,
          detail: info.hasError ? 'Error on page' : `${info.buttonCount} buttons, ${info.inputCount} inputs`,
          screenshot: ss.toString('base64'),
          clickResults,
        });
      } catch (e) {
        results.push({ section: section.key, label: section.label, passed: false, detail: e.message, screenshot: null });
      }
    }

    // Manual job input
    console.log(`[portal] Testing manual job input...`);
    try {
      let jobPageFound = false;
      for (const jp of ['/jobs/new', '/jobs/create', '/new-job']) {
        try {
          await page.goto(`${baseUrl}${jp}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(3000);
          const hasForm = await page.evaluate(() => document.querySelectorAll('input, textarea').length > 2);
          if (hasForm) { jobPageFound = true; break; }
        } catch (e) {}
      }

      if (!jobPageFound) {
        await page.goto(`${baseUrl}/jobs`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(3000);
        const addBtn = await page.$('button:has-text("Add"), button:has-text("New"), button:has-text("Create"), a:has-text("Add"), a:has-text("New")');
        if (addBtn) { await addBtn.click(); await page.waitForTimeout(3000); jobPageFound = true; }
      }

      const jobSs = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
      const formFields = jobPageFound ? await page.evaluate(() => {
        return [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')]
          .filter(i => i.offsetParent !== null)
          .map(i => ({ type: i.type || i.tagName.toLowerCase(), name: i.name || i.id || '', placeholder: i.placeholder || '' }));
      }) : [];

      results.push({
        section: 'manual_job', label: 'Manual Job Input',
        passed: formFields.length > 0,
        detail: formFields.length > 0 ? `Form with ${formFields.length} fields` : 'No form found',
        screenshot: jobSs.toString('base64'),
        formFields: formFields.slice(0, 10),
      });
    } catch (e) {
      results.push({ section: 'manual_job', label: 'Manual Job Input', passed: false, detail: e.message, screenshot: null });
    }

    await browser.close();

    const passedCount = results.filter(r => r.passed).length;
    return {
      passed: passedCount >= results.length - 1,
      score: `${passedCount}/${results.length}`,
      results,
      businessName,
    };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { error: e.message };
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      let result;

      if (req.url === '/invoice') {
        result = await handleInvoiceTest(data);
      } else if (req.url === '/portal') {
        result = await handlePortalTest(data);
      } else {
        result = { error: 'Unknown endpoint. Use /invoice or /portal' };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Browser test server running at http://localhost:${PORT}`);
  console.log(`  Endpoints:`);
  console.log(`    POST /invoice  — Invoice/quote page browser test`);
  console.log(`    POST /portal   — Portal browser test\n`);
});
