const http = require('http');
const { chromium } = require('playwright');

// Tell lib handlers to use local Playwright instead of Browserbase
process.env.USE_LOCAL_PLAYWRIGHT = '1';

// Delegate-to-lib: lib handlers work directly with req/res. For the new endpoints
// (/interactive, /crewflow) we don't duplicate the 70+ sub-checks — we just shim
// req/res and call the same lib handler that Vercel calls.
//
// Hot-reload: every request re-requires the handler and helpers from disk
// after purging Node's require cache. Without this, edits to lib files
// (e.g. fixing a login flow) silently keep using the old code in memory
// until the server is manually restarted, producing "fix doesn't work"
// cycles where stale code is being run.
const HANDLER_PATHS = {
  invoice: './lib/browser-test-invoice',
  interactive: './lib/browser-test-interactive',
  crewflow: './lib/browser-test-crew-flow',
  crew: './lib/browser-test-crew',
  public: './lib/browser-test-public',
};

function loadFreshLibHandler(handlerName) {
  const handlerRel = HANDLER_PATHS[handlerName];
  if (!handlerRel) return null;
  // Purge anything under ./lib so handler + helpers reload together.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/lib/browser-')) delete require.cache[key];
  }
  return require(handlerRel);
}

async function delegateToLibHandler(handlerName, data) {
  const handler = loadFreshLibHandler(handlerName);
  if (!handler) return { error: `No lib handler for ${handlerName}` };
  return await new Promise((resolve) => {
    const reqShim = { method: 'POST', body: data, query: {} };
    const resShim = {
      _status: 200, _body: null,
      setHeader() {},
      status(s) { this._status = s; return this; },
      json(b) { this._body = b; resolve(b); return this; },
      end() { if (!this._body) resolve({}); return this; },
    };
    Promise.resolve(handler(reqShim, resShim)).catch(e => resolve({ error: e.message }));
  });
}

const PORT = 3847;

const SUPABASE_URL = 'https://kcmbwstjmdrjkhxhkkjt.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjbWJ3c3RqbWRyamtoeGhra2p0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTU3NTQwNiwiZXhwIjoyMDg1MTUxNDA2fQ.PacsDAnXZHXutdNVe8ClCJGDeDVQ2viu9b_aJLPmE24';

async function takeScreenshot(page, label) {
  const ss = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 });
  return { label, data: ss.toString('base64') };
}

// Click every visible non-destructive button on the page and report results
// If a click navigates to a different origin, navigate back to keep the test scoped.
async function testAllButtons(page, label) {
  const results = [];
  const buttons = await page.$$('button');
  const buttonInfos = [];

  const startUrl = page.url();
  let startOrigin;
  try { startOrigin = new URL(startUrl).origin; } catch { startOrigin = null; }

  for (const btn of buttons) {
    const text = (await btn.textContent().catch(() => '')).trim().slice(0, 40);
    const visible = await btn.isVisible().catch(() => false);
    const disabled = await btn.evaluate(el => el.disabled).catch(() => true);
    if (visible && !disabled && text && !/logout|sign out|delete|remove|cancel|close/i.test(text)) {
      buttonInfos.push({ btn, text });
    }
  }

  for (const { btn, text } of buttonInfos) {
    try {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 3000 });
      await page.waitForTimeout(1000);
      // If the click navigated us to a different origin, return to start
      let currentOrigin;
      try { currentOrigin = new URL(page.url()).origin; } catch { currentOrigin = null; }
      const navigatedAway = startOrigin && currentOrigin && currentOrigin !== startOrigin;
      if (navigatedAway) {
        console.log(`[${label}] Button "${text}": navigated to external origin ${currentOrigin}, returning`);
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);
      }
      const hasError = await page.evaluate(() => {
        const body = document.body.innerText;
        return /unhandled|crash|fatal|cannot read|undefined is not/i.test(body);
      });
      results.push({ button: text, clickable: true, error: hasError, externalNav: navigatedAway });
      if (hasError) console.log(`[${label}] Button "${text}": clicked but caused error`);
      else console.log(`[${label}] Button "${text}": OK`);
    } catch (e) {
      results.push({ button: text, clickable: false, error: true });
      console.log(`[${label}] Button "${text}": FAILED - ${e.message}`);
    }
  }
  return results;
}

// ═══════════════════════════════════════════
// INVOICE BROWSER TEST
// ═══════════════════════════════════════════
async function handleInvoiceTest(body) {
  const { quoteUrl, businessName } = body;
  if (!quoteUrl) return { error: 'Missing quoteUrl' };

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const screenshots = [];
    const checks = [];

    // Step 1: Navigate
    console.log(`[invoice] Opening ${quoteUrl}`);
    await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      return !document.querySelector('.animate-spin') || document.querySelectorAll('button').length > 2;
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    screenshots.push(await takeScreenshot(page, 'Initial Load'));

    // Step 2: Page state
    const pageInfo = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].map(b => ({
        text: b.textContent?.trim().slice(0, 50), disabled: b.disabled, visible: b.offsetParent !== null,
      }));
      const prices = document.body.innerText.match(/\$[\d,.]+/g) || [];
      const hasError = !!document.querySelector('[class*="error"], [class*="Error"]');
      const bodyText = document.body.innerText.slice(0, 3000);
      return { buttons, prices, hasError, bodyText };
    });

    const isLoaded = !pageInfo.bodyText.includes('Loading your quote...') || pageInfo.buttons.length > 0;
    checks.push({ t: 'Quote page loaded', s: isLoaded, d: isLoaded ? `${pageInfo.buttons.length} buttons, ${pageInfo.prices.length} prices` : 'Stuck on loading spinner' });
    checks.push({ t: 'Price displayed', s: pageInfo.prices.length > 0, d: pageInfo.prices.length > 0 ? `Found: ${pageInfo.prices.join(', ')}` : 'No prices visible' });
    checks.push({ t: 'No errors on page', s: !pageInfo.hasError, d: pageInfo.hasError ? 'Error detected' : 'Clean' });

    // Step 3: Test ALL buttons
    const currentUrl = page.url();
    const allButtonResults = await testAllButtons(page, 'invoice');
    const allClickable = allButtonResults.filter(r => r.clickable).length;
    const allWithErrors = allButtonResults.filter(r => r.error).length;
    checks.push({
      t: 'All buttons pressable',
      s: allClickable === allButtonResults.length && allWithErrors === 0,
      d: `${allClickable}/${allButtonResults.length} clickable, ${allWithErrors} caused errors`,
    });

    // Navigate back to the quote page for tier selection test
    await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      return !document.querySelector('.animate-spin') || document.querySelectorAll('button').length > 2;
    }, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Step 4: Click tier button
    let clickedTier = false;
    const tierButtons = await page.$$('button:not([disabled])');
    for (const btn of tierButtons) {
      const text = await btn.textContent().catch(() => '');
      if (/standard|deep|move|select|choose/i.test(text) && !/book|pay|checkout|approve/i.test(text)) {
        try {
          await btn.click();
          clickedTier = true;
          console.log(`[invoice] Selected tier: "${text.trim().slice(0, 30)}"`);
          await page.waitForTimeout(1500);
          break;
        } catch (e) {}
      }
    }
    checks.push({ t: 'Tier/option selectable', s: clickedTier, d: clickedTier ? 'Tier selected' : 'No tier buttons found' });
    screenshots.push(await takeScreenshot(page, 'After Tier Selection'));

    // Step 5: Click checkout
    let clickedCheckout = false;
    let stripeRedirect = false;
    const checkoutButtons = await page.$$('button:not([disabled])');
    for (const btn of checkoutButtons) {
      const text = await btn.textContent().catch(() => '');
      if (/book|pay|checkout|approve|confirm|submit|continue/i.test(text)) {
        try {
          // Check all checkboxes, toggle switches, and service agreement elements
          const checkboxes = await page.$$('input[type="checkbox"]:not(:checked)');
          for (const cb of checkboxes) await cb.click().catch(() => {});

          // Also click any labels/elements containing "agree", "terms", "service agreement"
          const agreeEls = await page.$$('label, div, span, button');
          for (const el of agreeEls) {
            const elText = await el.textContent().catch(() => '');
            if (/i agree|accept|terms|service agreement|acknowledge/i.test(elText) && elText.length < 200) {
              const isCheckbox = await el.evaluate(e => e.querySelector('input[type="checkbox"]') !== null).catch(() => false);
              if (isCheckbox) {
                const cb = await el.$('input[type="checkbox"]');
                const checked = cb ? await cb.isChecked().catch(() => false) : false;
                if (!checked) await el.click().catch(() => {});
              } else {
                // Could be a custom toggle or clickable agreement text
                await el.click().catch(() => {});
              }
              console.log(`[invoice] Clicked agreement: "${elText.trim().slice(0, 40)}"`);
            }
          }

          // Also handle switch/toggle components (common in React UIs)
          const switches = await page.$$('[role="switch"][aria-checked="false"], [role="checkbox"][aria-checked="false"]');
          for (const sw of switches) await sw.click().catch(() => {});

          await page.waitForTimeout(1000);

          // Check if the checkout button is now enabled (it might have been disabled before agreement)
          const btnStillDisabled = await btn.evaluate(el => el.disabled).catch(() => false);
          if (btnStillDisabled) {
            console.log('[invoice] Checkout button still disabled after agreements — looking for another');
            // Re-scan for enabled checkout buttons
            const retryBtns = await page.$$('button:not([disabled])');
            for (const rb of retryBtns) {
              const rt = await rb.textContent().catch(() => '');
              if (/book|pay|checkout|approve|confirm|submit|continue/i.test(rt)) {
                await rb.click();
                clickedCheckout = true;
                console.log(`[invoice] Clicked enabled checkout: "${rt.trim().slice(0, 30)}"`);
                break;
              }
            }
          } else {
            await btn.click();
            clickedCheckout = true;
            console.log(`[invoice] Clicked checkout: "${text.trim().slice(0, 30)}"`);
          }

          if (clickedCheckout) {
            // Wait longer for Stripe redirect — page may process payment session first
            try {
              await page.waitForURL(/stripe\.com|checkout/i, { timeout: 20000 });
              stripeRedirect = true;
            } catch (e) {
              // Check current URL and also wait a bit more
              await page.waitForTimeout(3000);
              if (/stripe|checkout/i.test(page.url())) stripeRedirect = true;
            }
            console.log(`[invoice] After checkout URL: ${page.url()}`);
          }
          break;
        } catch (e) {
          console.log(`[invoice] Checkout attempt failed: ${e.message}`);
        }
      }
    }
    checks.push({ t: 'Checkout button clickable', s: clickedCheckout, d: clickedCheckout ? 'Clicked' : 'Not found' });
    checks.push({ t: 'Redirects to Stripe', s: stripeRedirect, d: stripeRedirect ? page.url().slice(0, 80) : 'No redirect' });
    screenshots.push(await takeScreenshot(page, 'After Checkout'));

    // Step 6: DB verification
    let dbVerified = false;
    try {
      const token = quoteUrl.split('/').pop();
      const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/quotes?token=eq.${token}&select=status,selected_tier,selected_addons`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      const dbData = await dbRes.json();
      if (dbData.length > 0 && dbData[0].selected_tier) dbVerified = true;
      console.log(`[invoice] DB: ${JSON.stringify(dbData)}`);
    } catch (e) {}
    checks.push({ t: 'Selection saved to database', s: dbVerified, d: dbVerified ? 'Quote updated in DB' : 'Not updated' });

    await browser.close();

    const passed = checks.filter(c => c.s).length;
    return {
      passed: passed >= checks.length - 1,
      score: `${passed}/${checks.length}`,
      checks,
      buttonResults: allButtonResults,
      screenshots: {
        before: screenshots[0]?.data,
        afterSelection: screenshots[1]?.data,
        afterCheckout: screenshots[2]?.data,
      },
      allScreenshots: screenshots,
    };

  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════
// PORTAL BROWSER TEST
// ═══════════════════════════════════════════
async function handlePortalTest(body) {
  const { portalUrl, businessName, credentials, tenantSlug } = body;
  if (!portalUrl) return { error: 'Missing portalUrl' };

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const baseUrl = portalUrl.replace(/\/+$/, '');
    const results = [];

    // Step 1: Navigate to portal
    console.log(`[portal:${businessName}] Opening ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for client-side rendering (React apps show loading spinner first)
    console.log(`[portal:${businessName}] Waiting for page to render...`);
    await page.waitForFunction(() => {
      const body = document.body?.innerText || '';
      // Wait until we see either a login form, dashboard content, or navigation
      return body.length > 200 ||
        document.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"]').length > 0 ||
        document.querySelectorAll('nav a, aside a').length > 0;
    }, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Step 2: Login — check URL for login redirect AND check for form elements
    const currentUrl = page.url();
    const isLoginPage = /login|signin|sign-in|auth/i.test(currentUrl);
    const hasLoginForm = await page.evaluate(() => {
      return document.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"], input[placeholder*="email" i], input[placeholder*="password" i]').length > 0;
    }).catch(() => false);

    // Probe a protected route — many portals have a public landing page at "/"
    // but redirect protected routes (/jobs, /dashboard) to /login. Without this
    // probe we'd falsely conclude "no login required".
    let protectedRedirectsToLogin = false;
    if (!isLoginPage && !hasLoginForm) {
      for (const probe of ['/jobs', '/dashboard', '/admin']) {
        try {
          await page.goto(`${baseUrl}${probe}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(2500);
          const probeUrl = page.url();
          if (/login|signin|sign-in|auth/i.test(probeUrl)) {
            protectedRedirectsToLogin = true;
            console.log(`[portal:${businessName}] Protected route ${probe} redirected to ${probeUrl} — login required`);
            break;
          }
        } catch (e) {}
      }
    }

    const needsLogin = hasLoginForm || isLoginPage || protectedRedirectsToLogin;
    console.log(`[portal:${businessName}] Login page: ${isLoginPage}, Login form: ${hasLoginForm}, Protected→login: ${protectedRedirectsToLogin}, URL: ${currentUrl}`);

    let loggedIn = !needsLogin;
    const hasCredentials = credentials && credentials.email && credentials.password;

    if (needsLogin && hasCredentials) {
      // If we were redirected to a login URL but form hasn't loaded, go there explicitly
      if (!hasLoginForm && isLoginPage) {
        await page.waitForTimeout(3000);
      }
      // If still no form, try navigating to /login directly
      if (!hasLoginForm) {
        console.log(`[portal:${businessName}] Navigating to login page directly...`);
        await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForFunction(() => {
          return document.querySelectorAll('input[type="email"], input[type="password"], input[name="email"], input[name="password"], input[placeholder*="email" i]').length > 0;
        }, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }

      console.log(`[portal:${businessName}] Logging in with ${credentials.email}...`);
      try {
        // Try multiple selectors for email field
        const emailField = await page.$('input[type="email"]')
          || await page.$('input[name="email"]')
          || await page.$('input[placeholder*="email" i]')
          || await page.$('input[type="text"]');
        if (emailField) {
          await emailField.click();
          await emailField.fill(credentials.email);
          console.log(`[portal:${businessName}] Filled email field`);
        }

        const passField = await page.$('input[type="password"]')
          || await page.$('input[name="password"]')
          || await page.$('input[placeholder*="password" i]');
        if (passField) {
          await passField.click();
          await passField.fill(credentials.password);
          console.log(`[portal:${businessName}] Filled password field`);
        }

        // Try multiple selectors for submit button
        const submitBtn = await page.$('button[type="submit"]')
          || await page.$('button:has-text("Log in")')
          || await page.$('button:has-text("Sign in")')
          || await page.$('button:has-text("Login")')
          || await page.$('button:has-text("Continue")');
        if (submitBtn) {
          await submitBtn.click();
          console.log(`[portal:${businessName}] Clicked submit button`);
          // Wait for navigation after login
          await page.waitForURL(url => !/login|signin|auth/i.test(url), { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(3000);
          // Check if we're still on login page
          const afterLoginUrl = page.url();
          loggedIn = !/login|signin|auth/i.test(afterLoginUrl);
          console.log(`[portal:${businessName}] After login URL: ${afterLoginUrl}, logged in: ${loggedIn}`);
        } else {
          console.log(`[portal:${businessName}] No submit button found`);
          // Try pressing Enter
          if (passField) { await passField.press('Enter'); await page.waitForTimeout(5000); }
          const afterLoginUrl = page.url();
          loggedIn = !/login|signin|auth/i.test(afterLoginUrl);
        }
      } catch (e) { console.log(`[portal:${businessName}] Login failed: ${e.message}`); }
    } else if (needsLogin && !hasCredentials) {
      console.log(`[portal:${businessName}] Login required but no credentials configured`);
    }

    const loginSs = await takeScreenshot(page, 'Login / Landing');
    results.push({
      section: 'login', label: 'Portal Login',
      passed: loggedIn,
      detail: needsLogin ? (loggedIn ? 'Logged in successfully' : (!hasCredentials ? 'Login form found but no credentials configured — add portal email/password in business settings' : 'Login failed — check credentials')) : 'No login required',
      screenshot: loginSs.data,
    });

    // Step 3: Discover all navigation links — same-origin only
    const portalOrigin = new URL(baseUrl).origin;
    const navLinks = await page.evaluate((allowedOrigin) => {
      const allLinks = [...document.querySelectorAll('a[href], nav a, aside a, [role="navigation"] a')];
      const seen = new Set();
      return allLinks
        .map(l => ({ text: l.textContent?.trim().slice(0, 40), href: l.href }))
        .filter(l => {
          if (!l.text || !l.href || l.href === '#' || seen.has(l.href)) return false;
          if (/logout|sign.?out|javascript:/i.test(l.href) || /logout|sign.?out/i.test(l.text)) return false;
          // Only same-origin links — don't follow external "Powered by" or OAuth redirects
          try {
            const linkOrigin = new URL(l.href).origin;
            if (linkOrigin !== allowedOrigin) return false;
          } catch (e) { return false; }
          seen.add(l.href);
          return true;
        });
    }, portalOrigin);
    console.log(`[portal:${businessName}] Found ${navLinks.length} same-origin nav links (filtered to ${portalOrigin})`);

    // Step 4: Visit every discovered navigation link
    for (const link of navLinks.slice(0, 15)) {
      console.log(`[portal:${businessName}] Visiting: ${link.text} (${link.href})`);
      try {
        await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(4000);

        const ss = await takeScreenshot(page, link.text);
        const info = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          return {
            hasContent: bodyText.length > 100,
            hasError: (/error|not found|404|500|crash/i.test(bodyText) && bodyText.length < 500) || !!document.querySelector('[class*="error" i]'),
            buttonCount: [...document.querySelectorAll('button:not([disabled])')].filter(b => b.offsetParent !== null).length,
            inputCount: document.querySelectorAll('input, select, textarea').length,
            textSnippet: bodyText.slice(0, 200),
          };
        }).catch(() => ({ hasContent: false, hasError: true, buttonCount: 0, inputCount: 0, textSnippet: '' }));

        // Test ALL buttons on this page
        const buttonResults = await testAllButtons(page, `portal:${link.text}`);
        // Navigate back after button tests
        await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);

        results.push({
          section: link.text.toLowerCase().replace(/\s+/g, '_'),
          label: link.text,
          passed: info.hasContent && !info.hasError,
          detail: info.hasError ? `Error on page` : `${info.buttonCount} buttons, ${info.inputCount} inputs — ${buttonResults.filter(r => r.clickable).length}/${buttonResults.length} buttons clickable`,
          screenshot: ss.data,
          buttonResults,
          url: link.href,
        });
      } catch (e) {
        results.push({
          section: link.text.toLowerCase().replace(/\s+/g, '_'),
          label: link.text,
          passed: false,
          detail: `Failed to load: ${e.message}`,
          screenshot: null,
        });
      }
    }

    // Step 5: Test manual job input — actually fill the form and submit
    console.log(`[portal:${businessName}] Testing manual job input...`);
    try {
      // If we're not logged in, skip — the form-fill logic would otherwise type
      // test data into the login form and report a misleading success.
      if (needsLogin && !loggedIn) {
        results.push({
          section: 'manual_job', label: 'Manual Job Input',
          passed: false,
          detail: 'Skipped — not logged in to portal (cannot reach job creation page)',
          screenshot: null,
        });
        throw new Error('__skip_manual_job__');
      }

      let jobPageFound = false;
      for (const jp of ['/jobs/new', '/jobs/create', '/new-job', '/add-job']) {
        try {
          await page.goto(`${baseUrl}${jp}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForTimeout(3000);
          const landedUrl = page.url();
          // If we got bounced to a login page, this isn't a job form
          if (/login|signin|sign-in|auth/i.test(landedUrl)) continue;
          const hasForm = await page.evaluate(() => document.querySelectorAll('input:not([type="hidden"]), textarea').length > 2);
          if (hasForm) { jobPageFound = true; break; }
        } catch (e) {}
      }

      if (!jobPageFound) {
        // Try clicking "Add" or "New" from the jobs page
        await page.goto(`${baseUrl}/jobs`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(3000);
        const jobsListUrl = page.url();
        if (/login|signin|sign-in|auth/i.test(jobsListUrl)) {
          // Bounced to login — skip
          results.push({
            section: 'manual_job', label: 'Manual Job Input',
            passed: false,
            detail: `Skipped — /jobs redirected to login (${jobsListUrl.slice(0, 80)})`,
            screenshot: null,
          });
          throw new Error('__skip_manual_job__');
        }
        const addBtn = await page.$('button:has-text("Add"), button:has-text("New"), button:has-text("Create"), a:has-text("Add"), a:has-text("New")');
        if (addBtn) { await addBtn.click(); await page.waitForTimeout(3000); jobPageFound = true; }
      }

      const jobSsBefore = await takeScreenshot(page, 'Job Form (Empty)');

      if (jobPageFound) {
        // Fill in test data
        const formFields = await page.evaluate(() => {
          return [...document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select')]
            .filter(i => i.offsetParent !== null)
            .map(i => ({ type: i.type || i.tagName.toLowerCase(), name: (i.name || i.id || i.placeholder || '').toLowerCase(), tag: i.tagName }));
        });

        console.log(`[portal:${businessName}] Found ${formFields.length} form fields`);

        // Fill fields intelligently based on name/placeholder
        for (const field of formFields) {
          try {
            const selector = field.name
              ? `input[name="${field.name}"], input[id="${field.name}"], textarea[name="${field.name}"], input[placeholder*="${field.name}" i]`
              : null;
            if (!selector) continue;

            const el = await page.$(selector);
            if (!el) continue;

            if (/name|customer/i.test(field.name)) await el.fill('Test Customer');
            else if (/phone|tel/i.test(field.name)) await el.fill('5551234567');
            else if (/email/i.test(field.name)) await el.fill('test@example.com');
            else if (/address|street/i.test(field.name)) await el.fill('123 Test Street');
            else if (/city/i.test(field.name)) await el.fill('Test City');
            else if (/state|province/i.test(field.name)) await el.fill('CA');
            else if (/zip|postal/i.test(field.name)) await el.fill('90210');
            else if (/bed/i.test(field.name)) await el.fill('3');
            else if (/bath/i.test(field.name)) await el.fill('2');
            else if (/note|comment|description|message/i.test(field.name)) await el.fill('Automated test entry from Jack\'s Tester');
            else if (/date/i.test(field.name)) {
              const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
              await el.fill(tomorrow);
            }
            else if (field.type === 'text' || field.type === 'textarea') await el.fill('Test data');
          } catch (e) {}
        }

        // Handle select dropdowns
        const selects = await page.$$('select');
        for (const sel of selects) {
          try {
            const options = await sel.evaluate(el => [...el.options].map((o, i) => ({ value: o.value, index: i })));
            if (options.length > 1) {
              await sel.selectOption({ index: 1 }); // Select first non-default option
            }
          } catch (e) {}
        }

        await page.waitForTimeout(1000);
        const jobSsFilled = await takeScreenshot(page, 'Job Form (Filled)');

        // Try to submit the form
        let submitted = false;
        const submitBtns = await page.$$('button[type="submit"], button:has-text("Save"), button:has-text("Create"), button:has-text("Submit"), button:has-text("Add Job")');
        for (const btn of submitBtns) {
          const visible = await btn.isVisible().catch(() => false);
          if (visible) {
            try {
              await btn.click();
              await page.waitForTimeout(3000);
              submitted = true;
              console.log(`[portal:${businessName}] Job form submitted`);
              break;
            } catch (e) {}
          }
        }

        const jobSsAfter = await takeScreenshot(page, 'After Job Submit');

        // Check for success indicators
        const afterSubmitInfo = await page.evaluate(() => {
          const bodyText = document.body.innerText;
          return {
            hasSuccess: /success|created|saved|added/i.test(bodyText),
            hasError: /error|fail|invalid|required/i.test(bodyText),
            url: window.location.href,
          };
        });
        const redirectedToLogin = /login|signin|sign-in|auth/i.test(afterSubmitInfo.url);

        results.push({
          section: 'manual_job',
          label: 'Manual Job Input',
          passed: jobPageFound && submitted && !redirectedToLogin && (afterSubmitInfo.hasSuccess || !afterSubmitInfo.hasError),
          detail: !submitted ? 'Could not submit form'
            : redirectedToLogin ? `Redirected to login page (${afterSubmitInfo.url.slice(0, 80)}) — not actually a job form`
            : afterSubmitInfo.hasSuccess ? 'Job created successfully'
            : afterSubmitInfo.hasError ? 'Form submitted but errors detected'
            : `Form submitted, redirected to ${afterSubmitInfo.url.slice(0, 60)}`,
          screenshot: jobSsFilled.data,
          formFields: formFields.slice(0, 15),
          extraScreenshots: [jobSsBefore, jobSsFilled, jobSsAfter],
        });
      } else {
        results.push({
          section: 'manual_job',
          label: 'Manual Job Input',
          passed: false,
          detail: 'Could not find job creation page',
          screenshot: jobSsBefore.data,
        });
      }
    } catch (e) {
      // Sentinel from the early-skip branches: result already pushed, don't double-report
      if (e.message === '__skip_manual_job__') {
        console.log(`[portal:${businessName}] Manual job input skipped (login required)`);
      } else {
        console.log(`[portal:${businessName}] Job input test failed: ${e.message}`);
        results.push({
          section: 'manual_job', label: 'Manual Job Input',
          passed: false, detail: `Failed: ${e.message}`, screenshot: null,
        });
      }
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

// ═══════════════════════════════════════════
// GENERIC PAGES TEST (for dashboard deep testing)
// ═══════════════════════════════════════════
async function handlePagesTest(data) {
  const { baseUrl, sections, credentials, businessName, loginFirst } = data;
  if (!baseUrl || !sections?.length) return { error: 'Missing baseUrl or sections' };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const base = baseUrl.replace(/\/+$/, '');
    const results = [];

    // Login if needed (Osiris flow: role → credentials → INITIALIZE)
    if (loginFirst && credentials?.email) {
      console.log(`[pages:${businessName}] Logging in at ${base}...`);
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      try {
        // Phase A: role button FIRST
        const roleBtn = await page.$('button:has-text("Operator"), button:has-text("Owner"), button:has-text("Admin"), button:has-text("Staff")');
        if (roleBtn) { await roleBtn.click(); await page.waitForTimeout(2500); }

        // Phase B: credentials
        const hasPassword = await page.$('input[type="password"]');
        if (hasPassword) {
          const emailField = await page.$('input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i], input[placeholder*="username" i], input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])');
          if (emailField) await emailField.fill(credentials.email || '');
          await hasPassword.fill(credentials.password || '');
          await page.waitForTimeout(500);
          const submitBtn = await page.$('button:has-text("INITIALIZE"), button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]');
          if (submitBtn) { await submitBtn.click(); await page.waitForTimeout(6000); }
        }
      } catch (e) { console.log(`[pages:${businessName}] Login failed: ${e.message}`); }

      const endUrl = page.url();
      const stillOnLogin = /login|signin|sign-in|auth/i.test(endUrl);
      const loginSs = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
      results.push({ section: 'login', label: 'Login', passed: !stillOnLogin, detail: stillOnLogin ? `Stuck on login` : `Logged in → ${endUrl.slice(0, 80)}`, screenshot: loginSs.toString('base64') });
    }

    // Test each section
    for (const section of sections) {
      const sectionKey = section.key || section.path.replace(/\//g, '_').replace(/^_/, '') || 'root';
      console.log(`[pages:${businessName}] Testing: ${section.label} (${section.path})`);
      try {
        await page.goto(`${base}${section.path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(section.waitMs || 6000);
        // Wait for any loading spinner to clear (up to 8s extra)
        await page.waitForFunction(() => {
          return !document.querySelector('.animate-spin, [class*="loading-spinner"], [class*="LoadingSpinner"]');
        }, { timeout: 8000 }).catch(() => {});
        const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
        const info = await page.evaluate((expectPattern) => {
          const bodyText = document.body.innerText || '';
          const trimmed = bodyText.trim();
          const hasContent = bodyText.length > 50;
          const hasExpected = expectPattern ? new RegExp(expectPattern, 'i').test(bodyText) : true;
          // Stricter error detection: only flag pages dominated by error text (under 200 chars)
          // and starting with a clear error indicator. Avoids false positives from pages
          // that happen to contain the word "error" near the top.
          const isError = trimmed.length < 200 && /^\s*(404|500|page not found|not found|something went wrong|unauthorized|forbidden|access denied)/i.test(trimmed);
          const isLoading = bodyText.length < 200 && /loading\.\.\.|please wait/i.test(bodyText);
          const buttons = [...document.querySelectorAll('button:not([disabled])')].filter(b => b.offsetParent !== null);
          const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
          const tables = document.querySelectorAll('table, [role="grid"], [class*="table"]');
          const charts = document.querySelectorAll('canvas, svg[class*="chart"], [class*="chart"], [class*="recharts"]');
          const toggles = document.querySelectorAll('input[type="checkbox"], input[role="switch"], [class*="switch"], [class*="toggle"]');
          const tabs = document.querySelectorAll('[role="tab"], [class*="tab"]');
          const cards = document.querySelectorAll('[class*="card"]');
          const badges = document.querySelectorAll('[class*="badge"]');
          return { hasContent, hasExpected, isError, isLoading,
            url: window.location.href,
            textPreview: bodyText.slice(0, 250),
            counts: { buttons: buttons.length, inputs: inputs.length, tables: tables.length, charts: charts.length, toggles: toggles.length, tabs: tabs.length, cards: cards.length, badges: badges.length } };
        }, section.expectText || null).catch(() => ({ hasContent: false, hasExpected: false, isError: true, isLoading: false, counts: {}, textPreview: '' }));
        const passed = info.hasContent && !info.isError && !info.isLoading && info.hasExpected;
        const countParts = [];
        if (info.counts.buttons) countParts.push(`${info.counts.buttons} btn`);
        if (info.counts.inputs) countParts.push(`${info.counts.inputs} input`);
        if (info.counts.tables) countParts.push(`${info.counts.tables} tbl`);
        if (info.counts.charts) countParts.push(`${info.counts.charts} chart`);
        if (info.counts.toggles) countParts.push(`${info.counts.toggles} toggle`);
        if (info.counts.tabs) countParts.push(`${info.counts.tabs} tab`);
        const preview = (info.textPreview || '').slice(0, 120).replace(/\s+/g, ' ').trim();
        const detail = info.isError ? `Error page: "${preview}"` :
                       info.isLoading ? `Stuck loading: "${preview}"` :
                       !info.hasContent ? `Empty page (URL: ${info.url || 'unknown'})` :
                       !info.hasExpected ? `Missing expected content. Got: "${preview}"` :
                       countParts.join(', ') || 'Content loaded';
        results.push({ section: sectionKey, label: section.label, passed, detail, screenshot: screenshot.toString('base64'), counts: info.counts });
      } catch (e) {
        results.push({ section: sectionKey, label: section.label, passed: false, detail: `Navigation failed: ${e.message.slice(0, 100)}`, screenshot: null, counts: {} });
      }
    }

    await browser.close();
    const passedCount = results.filter(r => r.passed).length;
    return { passed: passedCount >= Math.ceil(results.length * 0.7), score: `${passedCount}/${results.length}`, results, businessName };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════
// PUBLIC PAGES TEST
// ═══════════════════════════════════════════
async function handlePublicTest(data) {
  const { websiteUrl, businessName } = data;
  if (!websiteUrl) return { error: 'Missing websiteUrl' };

  const PUBLIC_SECTIONS = [
    { path: '/', label: 'Home Page', expectText: 'book|clean|service|quote|window|spotless' },
    { path: '/book', label: 'Book Page', expectText: 'book|schedule|name|email|phone|quote' },
    { path: '/services', label: 'Services Hub', expectText: 'service|clean|window|price' },
    { path: '/contact', label: 'Contact Page', expectText: 'contact|phone|email|form|quote' },
    { path: '/about', label: 'About Page', expectText: 'about|team|story|mission|clean' },
    { path: '/blog', label: 'Blog Index', expectText: 'blog|post|article|read|category' },
    { path: '/areas', label: 'Areas Hub', expectText: 'area|city|location|serve|service' },
  ];

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const base = websiteUrl.replace(/\/+$/, '');
    const results = [];

    for (const section of PUBLIC_SECTIONS) {
      console.log(`[public:${businessName}] Testing: ${section.label}`);
      try {
        await page.goto(`${base}${section.path}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        const screenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
        const info = await page.evaluate((expectPattern) => {
          const body = document.body.innerText || '';
          const trimmed = body.trim();
          const hasContent = body.length > 50;
          const hasExpected = expectPattern ? new RegExp(expectPattern, 'i').test(body) : true;
          const isError = trimmed.length < 400 && /^\s*(404|500|error|oops|not found|something went wrong|unauthorized|forbidden|page not found)/i.test(trimmed);
          const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
          const forms = document.querySelectorAll('form');
          const images = document.querySelectorAll('img');
          const links = document.querySelectorAll('a[href]');
          return { hasContent, hasExpected, isError, counts: { buttons: buttons.length, forms: forms.length, images: images.length, links: links.length } };
        }, section.expectText).catch(() => ({ hasContent: false, hasExpected: false, isError: true, counts: {} }));
        const passed = info.hasContent && !info.isError && info.hasExpected;
        const parts = [];
        if (info.counts.buttons) parts.push(`${info.counts.buttons} btn`);
        if (info.counts.forms) parts.push(`${info.counts.forms} form`);
        if (info.counts.images) parts.push(`${info.counts.images} img`);
        results.push({ section: section.path, label: section.label, passed, detail: info.isError ? 'Error/404' : parts.join(', ') || 'Content loaded', screenshot: screenshot.toString('base64'), counts: info.counts });
      } catch (e) {
        results.push({ section: section.path, label: section.label, passed: false, detail: `Failed: ${e.message.slice(0, 100)}`, screenshot: null });
      }
    }

    await browser.close();
    const passedCount = results.filter(r => r.passed).length;
    return { passed: passedCount >= Math.ceil(results.length * 0.6), score: `${passedCount}/${results.length}`, results, businessName };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════
// CUSTOMER PAGES TEST
// ═══════════════════════════════════════════
async function handleCustomerTest(data) {
  const { quoteUrl, tipUrl, businessName, businessType } = data;
  if (!quoteUrl && !tipUrl) return { error: 'Missing quoteUrl or tipUrl' };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const results = [];

    if (quoteUrl) {
      await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('.animate-spin') || document.querySelector('[class*="tier"], [class*="quote"]'), { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const ss = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 50 });
      const quoteInfo = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const trimmed = body.trim();
        const isError = trimmed.length < 400 && /^\s*(expired|invalid|not found|404|500|error|oops|unauthorized)/i.test(trimmed);
        const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        const tierButtons = buttons.filter(b => /standard|deep|extra|move|good|better|best|select|choose/i.test(b.textContent));
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        const prices = body.match(/\$[\d,.]+/g) || [];
        const hasSubtotal = /subtotal|total|price|cost/i.test(body);
        const checkoutBtn = buttons.find(b => /approve|pay|book|checkout|confirm/i.test(b.textContent));
        const hasPlanSelector = /one-time|biweekly|monthly|membership|plan|frequency/i.test(body);
        const agreementCb = [...checkboxes].find(cb => /agree|terms|service agreement/i.test(cb.closest('label')?.textContent || cb.parentElement?.textContent || ''));
        return { isError, tierButtonCount: tierButtons.length, addonCount: checkboxes.length, priceCount: prices.length, prices: prices.slice(0, 5), hasSubtotal, hasCheckoutButton: !!checkoutBtn, hasPlanSelector, hasAgreement: !!agreementCb, buttonCount: buttons.length };
      }).catch(() => ({ isError: true }));
      results.push({ section: 'quote_load', label: 'Quote Page Load', passed: !quoteInfo.isError, detail: quoteInfo.isError ? 'Error/expired' : `${quoteInfo.buttonCount} buttons, ${quoteInfo.priceCount} prices`, screenshot: ss.toString('base64') });
      if (!quoteInfo.isError) {
        results.push({ section: 'tier_selection', label: 'Tier Selection', passed: quoteInfo.tierButtonCount >= 2, detail: `${quoteInfo.tierButtonCount} tier buttons`, screenshot: null });
        results.push({ section: 'pricing', label: 'Pricing Display', passed: quoteInfo.priceCount > 0, detail: `${quoteInfo.priceCount} prices: ${quoteInfo.prices.join(', ')}`, screenshot: null });
        results.push({ section: 'checkout', label: 'Checkout Button', passed: quoteInfo.hasCheckoutButton, detail: quoteInfo.hasCheckoutButton ? 'Found' : 'Not found', screenshot: null });
        results.push({ section: 'plan_selector', label: 'Plan Selector', passed: quoteInfo.hasPlanSelector, detail: quoteInfo.hasPlanSelector ? 'Found' : 'Not found', screenshot: null });
        results.push({ section: 'agreement', label: 'Service Agreement', passed: quoteInfo.hasAgreement, detail: quoteInfo.hasAgreement ? 'Found' : 'Not found', screenshot: null });
      }
    }

    await browser.close();
    const passedCount = results.filter(r => r.passed).length;
    return { passed: passedCount >= Math.ceil(results.length * 0.6), score: `${passedCount}/${results.length}`, results, businessName };
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    return { error: e.message };
  }
}

// ═══════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════
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
      if (req.url === '/invoice') result = await delegateToLibHandler('invoice', data);
      else if (req.url === '/portal') result = await handlePortalTest(data);
      else if (req.url === '/pages') result = await handlePagesTest(data);
      else if (req.url === '/public') result = await delegateToLibHandler('public', data);
      else if (req.url === '/crew') result = await delegateToLibHandler('crew', data);
      else if (req.url === '/customer') result = await handleCustomerTest(data);
      else if (req.url === '/interactive') result = await delegateToLibHandler('interactive', data);
      else if (req.url === '/crewflow') result = await delegateToLibHandler('crewflow', data);
      else result = { error: 'Unknown endpoint. Use /invoice, /portal, /pages, /public, /crew, or /customer' };

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
  console.log(`    POST /invoice   — Invoice/quote page browser test`);
  console.log(`    POST /portal    — Portal browser test`);
  console.log(`    POST /pages     — Generic pages test (dashboard deep)`);
  console.log(`    POST /public    — Public marketing pages test`);
  console.log(`    POST /crew      — Crew portal test`);
  console.log(`    POST /customer     — Customer quote/tip pages test`);
  console.log(`    POST /interactive  — Comprehensive UI click-through (71 sub-checks)`);
  console.log(`    POST /crewflow     — Crew job execution flow test\n`);
  console.log(`  All runs local via Playwright — no Browserbase needed.\n`);
});
