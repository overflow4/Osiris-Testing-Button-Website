const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-invoice][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { quoteUrl, businessName } = req.body;
  if (!quoteUrl) return res.status(400).json({ error: 'Missing quoteUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  const supabaseUrl = process.env.SUPABASE_URL || 'https://kcmbwstjmdrjkhxhkkjt.supabase.co';
  const supabaseKey = process.env.SUPABASE_KEY || '';

  let browser;
  try {
    console.log(`[browser-invoice][${requestId}] Creating Browserbase session...`);
    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });
    console.log(`[browser-invoice][${requestId}] Session created: ${session.id}`);

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    // Step 1: Navigate to quote page
    console.log(`[browser-invoice][${requestId}] Navigating to ${quoteUrl}`);
    await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the page to render (it's client-side React)
    await page.waitForFunction(() => {
      return !document.querySelector('.animate-spin') || document.querySelector('[class*="tier"], [class*="quote"], [class*="clean"]');
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Take initial screenshot
    const screenshotBefore = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const beforeB64 = screenshotBefore.toString('base64');
    console.log(`[browser-invoice][${requestId}] Initial screenshot taken`);

    // Step 2: Gather page info
    const pageInfo = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].map(b => ({
        text: b.textContent?.trim().slice(0, 50),
        disabled: b.disabled,
        visible: b.offsetParent !== null,
      }));
      const links = [...document.querySelectorAll('a[href]')].map(a => ({
        text: a.textContent?.trim().slice(0, 50),
        href: a.href,
      }));
      const inputs = [...document.querySelectorAll('input, select, textarea')].map(i => ({
        type: i.type || i.tagName.toLowerCase(),
        name: i.name,
        placeholder: i.placeholder,
      }));
      const prices = document.body.innerText.match(/\$[\d,.]+/g) || [];
      const hasError = !!document.querySelector('[class*="error"], [class*="Error"]');
      const bodyText = document.body.innerText.slice(0, 3000);
      return { buttons, links, inputs, prices, hasError, bodyText };
    });
    console.log(`[browser-invoice][${requestId}] Page has ${pageInfo.buttons.length} buttons, ${pageInfo.prices.length} prices`);

    // Step 3: Try to click tier/option buttons
    const checks = [];
    let clickedTier = false;
    let clickedCheckout = false;
    let stripeRedirect = false;

    // Check if page loaded properly (not stuck on loading)
    const isLoaded = !pageInfo.bodyText.includes('Loading your quote...') || pageInfo.buttons.length > 0;
    checks.push({ t: 'Quote page loaded', s: isLoaded, d: isLoaded ? `${pageInfo.buttons.length} buttons, ${pageInfo.prices.length} prices found` : 'Page stuck on loading spinner' });

    // Check prices are displayed
    checks.push({ t: 'Price displayed', s: pageInfo.prices.length > 0, d: pageInfo.prices.length > 0 ? `Found: ${pageInfo.prices.join(', ')}` : 'No prices visible' });

    // Check for errors
    checks.push({ t: 'No errors on page', s: !pageInfo.hasError, d: pageInfo.hasError ? 'Error element detected' : 'Clean' });

    // Try clicking tier selection buttons (look for tier cards or radio-like buttons)
    const tierButtons = await page.$$('button:not([disabled])');
    for (const btn of tierButtons) {
      const text = await btn.textContent().catch(() => '');
      if (/standard|deep|move|select|choose/i.test(text) && !/book|pay|checkout|approve/i.test(text)) {
        try {
          await btn.click();
          clickedTier = true;
          console.log(`[browser-invoice][${requestId}] Clicked tier button: "${text.trim().slice(0, 30)}"`);
          await page.waitForTimeout(1000);
          break;
        } catch (e) {
          console.log(`[browser-invoice][${requestId}] Failed to click: ${e.message}`);
        }
      }
    }
    checks.push({ t: 'Tier/option selectable', s: clickedTier, d: clickedTier ? 'Successfully clicked a tier button' : 'No tier selection buttons found or clickable' });

    // Take mid-state screenshot after selection
    const screenshotMid = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const midB64 = screenshotMid.toString('base64');

    // Step 4: Try to find and click checkout/book button
    const allButtons = await page.$$('button:not([disabled])');
    for (const btn of allButtons) {
      const text = await btn.textContent().catch(() => '');
      if (/book|pay|checkout|approve|confirm|submit|continue/i.test(text)) {
        try {
          // Check for any required checkboxes (like service agreement)
          const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
          for (const cb of checkboxes) {
            await cb.click().catch(() => {});
          }
          await page.waitForTimeout(500);

          // Click the checkout button
          await btn.click();
          clickedCheckout = true;
          console.log(`[browser-invoice][${requestId}] Clicked checkout button: "${text.trim().slice(0, 30)}"`);

          // Wait for navigation/redirect
          try {
            await page.waitForURL(/stripe\.com|checkout/i, { timeout: 15000 });
            stripeRedirect = true;
            console.log(`[browser-invoice][${requestId}] Redirected to: ${page.url()}`);
          } catch (e) {
            // Check if URL changed at all
            const currentUrl = page.url();
            if (/stripe|checkout/i.test(currentUrl)) {
              stripeRedirect = true;
            }
            console.log(`[browser-invoice][${requestId}] After click, URL: ${currentUrl}`);
          }
          break;
        } catch (e) {
          console.log(`[browser-invoice][${requestId}] Checkout click failed: ${e.message}`);
        }
      }
    }
    checks.push({ t: 'Checkout button clickable', s: clickedCheckout, d: clickedCheckout ? 'Checkout button clicked' : 'No checkout/book button found' });
    checks.push({ t: 'Redirects to Stripe', s: stripeRedirect, d: stripeRedirect ? `Redirected to ${page.url().slice(0, 80)}` : 'No Stripe redirect detected' });

    // Take final screenshot (Stripe page or result)
    const screenshotAfter = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
    const afterB64 = screenshotAfter.toString('base64');
    console.log(`[browser-invoice][${requestId}] Final screenshot taken`);

    // Step 5: Check DB for quote status update
    let dbVerified = false;
    if (supabaseKey) {
      try {
        const urlParts = quoteUrl.split('/');
        const token = urlParts[urlParts.length - 1];
        // Check if the quote was updated (status = approved, selected_tier set)
        const dbRes = await fetch(`${supabaseUrl}/rest/v1/quotes?token=eq.${token}&select=status,selected_tier,selected_addons`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        const dbData = await dbRes.json();
        if (dbData.length > 0 && dbData[0].selected_tier) {
          dbVerified = true;
        }
        console.log(`[browser-invoice][${requestId}] DB check: ${JSON.stringify(dbData)}`);
      } catch (e) {
        console.log(`[browser-invoice][${requestId}] DB check failed: ${e.message}`);
      }
    }
    checks.push({ t: 'Selection saved to database', s: dbVerified, d: dbVerified ? 'Quote updated in DB' : 'Quote not yet updated or no DB access' });

    const passed = checks.filter(c => c.s).length;
    const total = checks.length;

    await page.close();
    await browser.close();

    return res.status(200).json({
      passed: passed >= total - 1,
      score: `${passed}/${total}`,
      checks,
      screenshots: {
        before: beforeB64,
        afterSelection: midB64,
        afterCheckout: afterB64,
      },
    });

  } catch (e) {
    console.error(`[browser-invoice][${requestId}] FAILED:`, e.message);
    console.error(`[browser-invoice][${requestId}] Stack:`, e.stack);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message });
  }
};
