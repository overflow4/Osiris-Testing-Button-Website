const { createSession } = require('./browser-helpers');

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
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  const supabaseUrl = process.env.SUPABASE_URL || 'https://kcmbwstjmdrjkhxhkkjt.supabase.co';
  const supabaseKey = process.env.SUPABASE_KEY || '';

  let browser;
  try {
    const sess = await createSession(apiKey, process.env.BROWSERBASE_PROJECT_ID);
    browser = sess.browser;
    const page = sess.page;
    const context = page.context();

    // Step 1: Navigate to quote page
    console.log(`[browser-invoice][${requestId}] Navigating to ${quoteUrl}`);
    await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for client-side React to actually render the quote.
    // The old condition `!document.querySelector('.animate-spin') || ...` was wrong:
    // before any spinner mounts, querySelector returns null → !null === true → wait
    // resolves immediately. Use a POSITIVE wait: at least 3 buttons OR a $-price
    // present in body text. Also explicitly tolerate pages that are stuck on
    // "Loading your quote..." by waiting up to 25s before giving up.
    await page.waitForFunction(() => {
      const buttons = document.querySelectorAll('button').length;
      const hasPrice = /\$\d/.test(document.body.innerText || '');
      const stillLoading = /loading your quote/i.test(document.body.innerText || '');
      return (buttons >= 3 || hasPrice) && !stillLoading;
    }, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);

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

    // Step 4: Accept terms/agreement checkboxes FIRST (before looking for checkout button).
    // The "Save Card and Book" button is disabled until T&C is accepted, so if we search
    // for enabled buttons first, we'd miss it entirely.
    let checkedAgreement = false;
    const agreementInfo = await page.evaluate(() => {
      // Handle both native checkboxes AND custom (div-based / role=switch / label-wrapped) toggles
      const nativeCheckboxes = [...document.querySelectorAll('input[type="checkbox"]')];
      const customToggles = [...document.querySelectorAll('[role="switch"], [role="checkbox"], button[aria-checked="false"]')];

      // Find the agreement-like checkbox by nearby text
      const isAgreement = (el) => {
        const context = (el.closest('label')?.textContent || el.parentElement?.textContent || el.getAttribute('aria-label') || '').toLowerCase();
        return /agree|terms|service agreement|conditions|policy|accept/i.test(context);
      };

      let checkedCount = 0;
      let clickedLabels = [];

      // Native checkboxes: click them if unchecked AND look like agreements (or just all of them as fallback)
      for (const cb of nativeCheckboxes) {
        if (cb.checked) continue;
        if (!isAgreement(cb) && nativeCheckboxes.length > 1) continue; // skip non-agreement if there are multiple
        const label = cb.closest('label');
        if (label) { label.click(); } else { cb.click(); }
        clickedLabels.push((cb.closest('label')?.textContent || '').trim().slice(0, 40));
        checkedCount++;
      }

      // Custom toggles: find by role + click
      for (const t of customToggles) {
        if (!isAgreement(t)) continue;
        t.click();
        clickedLabels.push((t.closest('label')?.textContent || t.textContent || '').trim().slice(0, 40));
        checkedCount++;
      }

      // Nothing matched — try all native checkboxes as a last resort
      if (checkedCount === 0 && nativeCheckboxes.length === 1) {
        const cb = nativeCheckboxes[0];
        if (!cb.checked) {
          const label = cb.closest('label');
          if (label) label.click(); else cb.click();
          clickedLabels.push('(fallback: single checkbox)');
          checkedCount++;
        }
      }

      return { checkedCount, clickedLabels };
    });
    checkedAgreement = agreementInfo.checkedCount > 0;
    if (checkedAgreement) {
      console.log(`[browser-invoice][${requestId}] Checked ${agreementInfo.checkedCount} agreement box(es): ${agreementInfo.clickedLabels.join(' | ')}`);
      await page.waitForTimeout(800); // let the state update
    } else {
      console.log(`[browser-invoice][${requestId}] No agreement checkboxes found`);
    }
    checks.push({ t: 'Agreement checkbox accepted', s: checkedAgreement, d: checkedAgreement ? `Checked ${agreementInfo.checkedCount} box(es)` : 'No agreement found (may not be required)' });

    // Step 5: Watch for popup window / new tab that some Stripe flows use
    let popupPage = null;
    const popupPromise = context.waitForEvent('page', { timeout: 20000 }).then(p => { popupPage = p; return p; }).catch(() => null);

    // Step 6: Find and click the checkout button.
    // Now that the agreement is checked, previously-disabled buttons are enabled.
    // Prioritize specific phrases ("Save Card and Book" is the WinBros button).
    // Patterns most-specific first so "Save Card and Book" wins over a generic "Book" link
    const priorityPatterns = [
      'save.*card.*book|book.*save.*card',
      'approve.*pay|approve.*book',
      'book.*now|pay.*now',
      'book|pay|checkout|approve|confirm|submit|continue',
    ];

    const checkoutBtnHandle = await page.evaluateHandle((patterns) => {
      const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && !b.disabled);
      const submits = [...document.querySelectorAll('input[type="submit"]')].filter(i => !i.disabled);
      const all = [...buttons, ...submits];
      for (const p of patterns) {
        const re = new RegExp(p, 'i');
        const match = all.find(b => re.test(b.textContent || b.value || ''));
        if (match) return match;
      }
      return null;
    }, priorityPatterns);

    const btnElement = checkoutBtnHandle.asElement();
    if (btnElement) {
      const btnText = await btnElement.evaluate(el => (el.textContent || el.value || '').trim().slice(0, 50)).catch(() => '');
      const btnEnabled = await btnElement.evaluate(el => !el.disabled).catch(() => false);
      console.log(`[browser-invoice][${requestId}] Found checkout button: "${btnText}" (enabled: ${btnEnabled})`);

      // If still disabled (button needs more state), try clicking agreement again and wait
      if (!btnEnabled) {
        await page.waitForTimeout(1500);
      }

      try {
        await btnElement.scrollIntoViewIfNeeded().catch(() => {});
        await btnElement.click({ timeout: 8000 });
        clickedCheckout = true;
        console.log(`[browser-invoice][${requestId}] Clicked "${btnText}"`);

        // Wait for redirect, popup, or same-page Stripe Elements iframe
        const startUrl = page.url();
        const redirectPromise = page.waitForURL(/stripe\.com|checkout\.stripe|buy\.stripe/i, { timeout: 25000 }).then(() => 'main-nav');
        const raceResult = await Promise.race([
          redirectPromise,
          popupPromise.then(p => p ? 'popup' : null),
          new Promise(r => setTimeout(() => r('timeout'), 25000)),
        ]);

        if (raceResult === 'main-nav') {
          stripeRedirect = true;
          console.log(`[browser-invoice][${requestId}] Main page redirected to: ${page.url()}`);
        } else if (raceResult === 'popup' && popupPage) {
          await popupPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
          const popupUrl = popupPage.url();
          console.log(`[browser-invoice][${requestId}] Popup opened: ${popupUrl}`);
          if (/stripe\.com|checkout/i.test(popupUrl)) stripeRedirect = true;
        } else {
          // Timed out — check current state
          const currentUrl = page.url();
          const hasStripeIframe = await page.evaluate(() =>
            !!document.querySelector('iframe[src*="stripe.com"], iframe[name*="stripe" i], iframe[title*="stripe" i]')
          ).catch(() => false);
          if (/stripe|checkout/i.test(currentUrl)) {
            stripeRedirect = true;
          } else if (hasStripeIframe) {
            stripeRedirect = true;
            console.log(`[browser-invoice][${requestId}] Stripe Elements iframe detected on same page`);
          } else {
            console.log(`[browser-invoice][${requestId}] No redirect after 25s. URL: ${currentUrl}`);
          }
        }
      } catch (e) {
        console.log(`[browser-invoice][${requestId}] Checkout click failed: ${e.message}`);
      }
    } else {
      console.log(`[browser-invoice][${requestId}] No checkout button matched any priority pattern`);
    }

    checks.push({ t: 'Checkout button clickable', s: clickedCheckout, d: clickedCheckout ? 'Checkout button clicked' : 'No checkout/book button found (or still disabled)' });
    checks.push({ t: 'Redirects to Stripe', s: stripeRedirect, d: stripeRedirect ? `Reached Stripe: ${(popupPage?.url() || page.url()).slice(0, 80)}` : `No Stripe redirect (final URL: ${page.url().slice(0, 80)})` });

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
