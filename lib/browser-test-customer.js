const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

/**
 * Tests customer-facing pages: quote page and tip page (token-authenticated).
 * Checks: tier selection, addons, pricing, checkout flow, tip buttons.
 */
module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-customer][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { quoteUrl, tipUrl, businessName, businessType } = req.body;
  if (!quoteUrl && !tipUrl) return res.status(400).json({ error: 'Missing quoteUrl or tipUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  try {
    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const results = [];

    // ── QUOTE PAGE TESTS ──
    if (quoteUrl) {
      console.log(`[browser-customer][${requestId}] Testing quote page: ${quoteUrl}`);
      await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for React render
      await page.waitForFunction(() => {
        return !document.querySelector('.animate-spin') || document.querySelector('[class*="tier"], [class*="quote"]');
      }, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const quoteScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 50 });

      // Analyze quote page structure
      const quoteInfo = await page.evaluate((bizType) => {
        const body = document.body.innerText || '';
        const trimmed = body.trim();
        const isError = trimmed.length < 400 && /^\s*(expired|invalid|not found|404|500|error|oops|unauthorized)/i.test(trimmed);
        const isLoading = body.length < 200 && /loading/i.test(body);

        // Tier selection
        const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        const tierButtons = buttons.filter(b => /standard|deep|extra|move|good|better|best|select|choose/i.test(b.textContent));

        // Addons
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        const addonCheckboxes = [...checkboxes].filter(cb => {
          const label = cb.closest('label')?.textContent || cb.parentElement?.textContent || '';
          return /interior|track|pressure|gutter|fridge|oven|laundry|window|addon|add-on/i.test(label);
        });

        // Pricing
        const prices = body.match(/\$[\d,.]+/g) || [];
        const hasSubtotal = /subtotal|total|price|cost/i.test(body);

        // Customer info fields
        const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, textarea');
        const nameInput = document.querySelector('input[name*="name" i], input[placeholder*="name" i]');
        const emailInput = document.querySelector('input[name*="email" i], input[type="email"]');
        const addressInput = document.querySelector('input[name*="address" i], input[placeholder*="address" i]');
        const dateInput = document.querySelector('input[type="date"], [class*="date"], [class*="calendar"]');

        // Service agreement
        const agreementCheckbox = [...checkboxes].find(cb => {
          const label = cb.closest('label')?.textContent || cb.parentElement?.textContent || '';
          return /agree|terms|service agreement/i.test(label);
        });

        // Membership/plan selector
        const hasPlanSelector = /one-time|biweekly|monthly|membership|plan|frequency/i.test(body);

        // Checkout button
        const checkoutBtn = buttons.find(b => /approve|pay|book|checkout|confirm|submit/i.test(b.textContent));

        // Quantity controls
        const quantityControls = document.querySelectorAll('button:has-text("+"), button:has-text("-"), [class*="quantity"]');

        return {
          isError, isLoading,
          tierButtonCount: tierButtons.length,
          tierLabels: tierButtons.map(b => b.textContent?.trim().slice(0, 30)),
          addonCount: addonCheckboxes.length,
          priceCount: prices.length,
          prices: prices.slice(0, 5),
          hasSubtotal,
          inputCount: inputs.length,
          hasNameInput: !!nameInput,
          hasEmailInput: !!emailInput,
          hasAddressInput: !!addressInput,
          hasDateInput: !!dateInput,
          hasAgreementCheckbox: !!agreementCheckbox,
          hasPlanSelector,
          hasCheckoutButton: !!checkoutBtn,
          checkoutButtonText: checkoutBtn?.textContent?.trim().slice(0, 40) || '',
          quantityControlCount: quantityControls.length,
          buttonCount: buttons.length,
        };
      }, businessType || 'house_cleaning').catch(() => ({ isError: true }));

      // Build results
      results.push({
        section: 'quote_load',
        label: 'Quote Page Load',
        passed: !quoteInfo.isError && !quoteInfo.isLoading,
        detail: quoteInfo.isError ? 'Error/expired' : quoteInfo.isLoading ? 'Stuck loading' : `${quoteInfo.buttonCount} buttons, ${quoteInfo.priceCount} prices`,
        screenshot: quoteScreenshot.toString('base64'),
      });

      if (!quoteInfo.isError && !quoteInfo.isLoading) {
        results.push({
          section: 'tier_selection',
          label: 'Tier Selection Buttons',
          passed: quoteInfo.tierButtonCount >= 2,
          detail: quoteInfo.tierButtonCount >= 2 ? `Found ${quoteInfo.tierButtonCount}: ${quoteInfo.tierLabels.join(', ')}` : `Only ${quoteInfo.tierButtonCount} tier buttons`,
          screenshot: null,
        });

        results.push({
          section: 'addon_checkboxes',
          label: 'Addon Checkboxes',
          passed: quoteInfo.addonCount > 0,
          detail: `${quoteInfo.addonCount} addon checkboxes found`,
          screenshot: null,
        });

        results.push({
          section: 'pricing_display',
          label: 'Pricing Display',
          passed: quoteInfo.priceCount > 0 && quoteInfo.hasSubtotal,
          detail: `${quoteInfo.priceCount} prices: ${quoteInfo.prices.join(', ')}${quoteInfo.hasSubtotal ? ' (subtotal visible)' : ''}`,
          screenshot: null,
        });

        results.push({
          section: 'customer_fields',
          label: 'Customer Info Fields',
          passed: quoteInfo.hasNameInput || quoteInfo.hasEmailInput,
          detail: `Name: ${quoteInfo.hasNameInput}, Email: ${quoteInfo.hasEmailInput}, Address: ${quoteInfo.hasAddressInput}, Date: ${quoteInfo.hasDateInput}`,
          screenshot: null,
        });

        results.push({
          section: 'plan_selector',
          label: 'Membership/Plan Selector',
          passed: quoteInfo.hasPlanSelector,
          detail: quoteInfo.hasPlanSelector ? 'Plan options found' : 'No plan selector',
          screenshot: null,
        });

        results.push({
          section: 'service_agreement',
          label: 'Service Agreement Checkbox',
          passed: quoteInfo.hasAgreementCheckbox,
          detail: quoteInfo.hasAgreementCheckbox ? 'Agreement checkbox found' : 'No agreement checkbox',
          screenshot: null,
        });

        results.push({
          section: 'checkout_button',
          label: 'Checkout/Pay Button',
          passed: quoteInfo.hasCheckoutButton,
          detail: quoteInfo.hasCheckoutButton ? `"${quoteInfo.checkoutButtonText}"` : 'No checkout button found',
          screenshot: null,
        });

        // Try tier selection interaction
        try {
          const tierBtn = await page.$('button:has-text("Standard"), button:has-text("Deep"), button:has-text("Good"), button:has-text("Better")');
          if (tierBtn) {
            await tierBtn.click();
            await page.waitForTimeout(1500);
            const afterTierScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 50 });

            // Check if price changed
            const afterPrices = await page.evaluate(() => {
              return (document.body.innerText.match(/\$[\d,.]+/g) || []).slice(0, 5);
            });

            results.push({
              section: 'tier_interaction',
              label: 'Tier Selection Click',
              passed: true,
              detail: `Clicked tier, prices after: ${afterPrices.join(', ')}`,
              screenshot: afterTierScreenshot.toString('base64'),
            });
          }
        } catch (e) {
          results.push({
            section: 'tier_interaction',
            label: 'Tier Selection Click',
            passed: false,
            detail: `Click failed: ${e.message.slice(0, 80)}`,
            screenshot: null,
          });
        }

        // Try addon checkbox interaction
        try {
          const addonCb = await page.$('input[type="checkbox"]');
          if (addonCb) {
            const wasChecked = await addonCb.isChecked();
            await addonCb.click();
            await page.waitForTimeout(1000);
            const isNowChecked = await addonCb.isChecked();
            results.push({
              section: 'addon_interaction',
              label: 'Addon Toggle',
              passed: wasChecked !== isNowChecked,
              detail: wasChecked !== isNowChecked ? 'Checkbox toggled successfully' : 'Checkbox did not toggle',
              screenshot: null,
            });
          }
        } catch (e) {}
      }
    }

    // ── TIP PAGE TESTS ──
    if (tipUrl) {
      console.log(`[browser-customer][${requestId}] Testing tip page: ${tipUrl}`);
      await page.goto(tipUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      const tipScreenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 50 });

      const tipInfo = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const trimmed = body.trim();
        const isError = trimmed.length < 400 && /^\s*(expired|invalid|not found|404|500|error|oops|unauthorized)/i.test(trimmed);

        const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);

        // Preset tip buttons ($5, $10, $15, $20, $25)
        const presetButtons = buttons.filter(b => /\$\d+/.test(b.textContent));

        // Custom amount input
        const customInput = document.querySelector('input[type="number"], input[placeholder*="amount" i], input[placeholder*="custom" i]');

        // Submit button
        const submitBtn = buttons.find(b => /tip|submit|pay|send/i.test(b.textContent));

        return {
          isError,
          presetCount: presetButtons.length,
          presetValues: presetButtons.map(b => b.textContent?.trim().slice(0, 10)),
          hasCustomInput: !!customInput,
          hasSubmitButton: !!submitBtn,
          submitButtonText: submitBtn?.textContent?.trim().slice(0, 30) || '',
          buttonCount: buttons.length,
        };
      }).catch(() => ({ isError: true }));

      results.push({
        section: 'tip_load',
        label: 'Tip Page Load',
        passed: !tipInfo.isError,
        detail: tipInfo.isError ? 'Error/expired' : `${tipInfo.buttonCount} buttons`,
        screenshot: tipScreenshot.toString('base64'),
      });

      if (!tipInfo.isError) {
        results.push({
          section: 'tip_presets',
          label: 'Preset Tip Buttons',
          passed: tipInfo.presetCount >= 3,
          detail: `${tipInfo.presetCount} preset buttons: ${tipInfo.presetValues.join(', ')}`,
          screenshot: null,
        });

        results.push({
          section: 'tip_custom',
          label: 'Custom Tip Amount',
          passed: tipInfo.hasCustomInput,
          detail: tipInfo.hasCustomInput ? 'Custom amount input found' : 'No custom input',
          screenshot: null,
        });

        results.push({
          section: 'tip_submit',
          label: 'Tip Submit Button',
          passed: tipInfo.hasSubmitButton,
          detail: tipInfo.hasSubmitButton ? `"${tipInfo.submitButtonText}"` : 'No submit button',
          screenshot: null,
        });

        // Try clicking a preset tip
        try {
          const presetBtn = await page.$('button:has-text("$10"), button:has-text("$5")');
          if (presetBtn) {
            await presetBtn.click();
            await page.waitForTimeout(1000);
            const afterTip = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });

            // Check if submit button became active
            const submitActive = await page.evaluate(() => {
              const btn = [...document.querySelectorAll('button')].find(b => /tip|submit|pay/i.test(b.textContent));
              return btn ? !btn.disabled : false;
            });

            results.push({
              section: 'tip_interaction',
              label: 'Tip Preset Click',
              passed: true,
              detail: `Preset clicked, submit ${submitActive ? 'active' : 'still disabled'}`,
              screenshot: afterTip.toString('base64'),
            });
          }
        } catch (e) {}
      }
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
    console.error(`[browser-customer][${requestId}] FAILED:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message });
  }
};
