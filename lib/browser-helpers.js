const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

/**
 * Create a browser session and return { browser, page }.
 * When USE_LOCAL_PLAYWRIGHT=1, launches local chromium (no Browserbase needed, free).
 * Otherwise connects to a Browserbase cloud session.
 */
async function createSession(apiKey, projectId) {
  if (process.env.USE_LOCAL_PLAYWRIGHT === '1') {
    const playwright = require('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    return { browser, page, sessionId: 'local' };
  }
  const bb = new Browserbase({ apiKey });
  const session = await bb.sessions.create({ projectId });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  return { browser, page, sessionId: session.id };
}

/**
 * Osiris login: role button → credentials → INITIALIZE.
 * Returns true if logged in successfully.
 */
// Default admin credentials (user-provided, hard-coded as fallback)
const DEFAULT_CREDENTIALS = { email: 'admin', password: 'password' };

// Try selectors in priority order — return first that matches.
// Important: comma-combined selectors match by DOM order, not priority, which can
// pick the wrong button (e.g. "Back" before "INITIALIZE" when both are type=submit).
async function firstMatching(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.isVisible().catch(() => true);
        if (visible) return el;
      }
    } catch {}
  }
  return null;
}

// Role-button text patterns. We match in-page (page.evaluate) instead of via
// Playwright's :has-text() selector because the login screen is React Native
// Web — Pressables often render as <div role="button"> rather than <button>,
// and :has-text only walks <button> elements. Patterns are deliberately broad
// since we don't know the exact wording on every business's portal.
const ROLE_PATTERNS = {
  owner: /\b(operator|owner|founder|admin|manager)\b/i,
  technician: /\b(technician|employee|cleaner|crew|staff|tech|worker|field|pro)\b/i,
};

/**
 * Click the role button matching the requested role. Searches buttons,
 * role="button" elements, and links — anything clickable. Returns the
 * matched button text or null if nothing matched.
 */
async function clickRoleButton(page, role) {
  const pattern = ROLE_PATTERNS[role] || ROLE_PATTERNS.owner;
  return await page.evaluate(({ regexStr }) => {
    const re = new RegExp(regexStr, 'i');
    const candidates = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('[role="button"]'),
      ...document.querySelectorAll('a'),
      // React Native Web sometimes renders pressables as bare divs with onclick
      ...document.querySelectorAll('div[tabindex], div[onclick]'),
    ];
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.length > 60) continue;
      if (re.test(text)) {
        el.click();
        return text;
      }
    }
    return null;
  }, { regexStr: pattern.source });
}

/**
 * Log out of an active Osiris session. Osiris hides logout behind the
 * business-slug button in the bottom-left corner — clicking it reveals a
 * menu containing "Log out". Returns true if logout succeeded (URL returns
 * to a login/role-selection screen).
 */
async function osirisLogout(page) {
  try {
    // The slug button typically renders as the only button in a fixed/sticky
    // bottom-left container. Try several selector strategies before giving up.
    const slugBtn = await firstMatching(page, [
      // Bottom-left positioned containers that contain the active business name
      '[class*="sidebar"] button:last-of-type',
      '[class*="nav"] button:last-of-type',
      // Generic business-slug button patterns
      'button[aria-label*="business" i]',
      'button[aria-label*="account" i]',
      'button[aria-label*="workspace" i]',
      // Fall back to the bottom-most visible button on the page
      'button[class*="slug" i]',
      'button[class*="tenant" i]',
    ]);

    if (slugBtn) {
      await slugBtn.click();
      await page.waitForTimeout(800);
    } else {
      // Fall back: click the last visible button in the document — Osiris
      // pins the slug button to the bottom of the side nav, so it tends to
      // be last in DOM order.
      const clicked = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
        const target = visible[visible.length - 1];
        if (target) { target.click(); return true; }
        return false;
      });
      if (!clicked) return false;
      await page.waitForTimeout(800);
    }

    const logoutBtn = await firstMatching(page, [
      'button:has-text("Log out")',
      'button:has-text("Logout")',
      'button:has-text("Sign out")',
      '[role="menuitem"]:has-text("Log out")',
      '[role="menuitem"]:has-text("Logout")',
      'a:has-text("Log out")',
      'a:has-text("Logout")',
    ]);
    if (!logoutBtn) return false;
    await logoutBtn.click();
    await page.waitForTimeout(2500);
    return true;
  } catch {
    return false;
  }
}

async function dumpVisibleClickables(page) {
  return await page.evaluate(() => {
    const els = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('[role="button"]'),
      ...document.querySelectorAll('a'),
      ...document.querySelectorAll('div[tabindex], div[onclick]'),
    ];
    return els
      .filter(e => e.offsetParent !== null)
      .map(e => (e.innerText || e.textContent || '').trim())
      .filter(t => t && t.length < 80)
      .slice(0, 40);
  }).catch(() => []);
}

async function dumpInputs(page) {
  return await page.evaluate(() => {
    const inputs = [
      ...document.querySelectorAll('input'),
      ...document.querySelectorAll('textarea'),
    ];
    return inputs
      .filter(i => i.offsetParent !== null || i.type === 'hidden')
      .map(i => ({
        tag: i.tagName.toLowerCase(),
        type: i.type || '',
        name: i.name || '',
        id: i.id || '',
        placeholder: i.placeholder || '',
        autocomplete: i.autocomplete || i.getAttribute('autocomplete') || '',
        ariaLabel: i.getAttribute('aria-label') || '',
        secureTextEntry: i.getAttribute('data-secure-text-entry') || i.getAttribute('secure-text-entry') || '',
      }))
      .slice(0, 20);
  }).catch(() => []);
}

/**
 * Returns the most recent osirisLogin diagnostic info for `page`, if any.
 * Set whenever osirisLogin returns false. `null` when login succeeded.
 */
function getLoginDiagnostics(page) {
  return page._osirisLoginDiag || null;
}

/**
 * Logs into Osiris. Returns true on success, false on failure. On failure,
 * diagnostic info (phase, reason, visible clickables, URL, screenshot) is
 * stashed on the page via `page._osirisLoginDiag`; callers can read it via
 * getLoginDiagnostics(page) to surface specifics in test reports.
 */
async function osirisLogin(page, baseUrl, credentials, role = 'owner') {
  const creds = (credentials?.email) ? credentials : DEFAULT_CREDENTIALS;
  const tag = `[osirisLogin/${role}]`;
  page._osirisLoginDiag = null;

  const fail = async (phase, reason) => {
    const visibleClickables = await dumpVisibleClickables(page);
    const inputs = await dumpInputs(page);
    let screenshot = null;
    try {
      const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
      screenshot = ss.toString('base64');
    } catch {}
    console.log(`${tag} FAIL @ ${phase}: ${reason} | url=${page.url()} | clickables=${JSON.stringify(visibleClickables)} | inputs=${JSON.stringify(inputs)}`);
    page._osirisLoginDiag = { phase, reason, visibleClickables, inputs, url: page.url(), screenshot };
    return false;
  };

  // Find a password-like input: strict type=password first, then sniff
  // attributes (name, autocomplete, placeholder, aria-label) for "password".
  // React Native Web's TextInput with secureTextEntry sometimes drops the
  // type=password attribute, so we have to be flexible.
  const findPasswordField = async () => {
    return await page.evaluateHandle(() => {
      const inputs = [...document.querySelectorAll('input, textarea')]
        .filter(i => i.offsetParent !== null);
      // Pass 1: explicit type=password
      const byType = inputs.find(i => i.type === 'password');
      if (byType) return byType;
      // Pass 2: any attribute hints "password"
      const passRe = /password|passwd|pass[_\s-]?word/i;
      const byAttr = inputs.find(i =>
        passRe.test(i.name || '') ||
        passRe.test(i.id || '') ||
        passRe.test(i.placeholder || '') ||
        passRe.test(i.getAttribute('autocomplete') || '') ||
        passRe.test(i.getAttribute('aria-label') || '')
      );
      if (byAttr) return byAttr;
      // Pass 3: two-input form, second one is likely the password
      if (inputs.length >= 2) return inputs[1];
      return null;
    }).then(h => (h && h.asElement()) ? h.asElement() : null).catch(() => null);
  };

  const findUserField = async () => {
    return await page.evaluateHandle(() => {
      const inputs = [...document.querySelectorAll('input, textarea')]
        .filter(i => i.offsetParent !== null && i.type !== 'password' && i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'submit');
      const userRe = /user|email|login|account|name/i;
      const byAttr = inputs.find(i =>
        userRe.test(i.name || '') ||
        userRe.test(i.id || '') ||
        userRe.test(i.placeholder || '') ||
        userRe.test(i.getAttribute('autocomplete') || '') ||
        userRe.test(i.getAttribute('aria-label') || '')
      );
      if (byAttr) return byAttr;
      // Fall back to first non-password text-like input
      return inputs[0] || null;
    }).then(h => (h && h.asElement()) ? h.asElement() : null).catch(() => null);
  };

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  // If the session is already authenticated, the page won't show role buttons.
  try {
    const currentUrl = page.url();
    const onAuthScreen = /\/(login|signin|sign-in|auth)(\/|$|\?)/i.test(currentUrl)
      || currentUrl === baseUrl
      || currentUrl === baseUrl + '/'
      || new URL(currentUrl).pathname === '/';
    if (!onAuthScreen) {
      console.log(`${tag} active session detected at ${currentUrl} — logging out first`);
      await osirisLogout(page);
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }
  } catch {}

  // The landing page might be marketing/SaaS content with a "Sign In" or
  // "Login" CTA before the role-selection screen. Try clicking that first
  // if no role button is visible yet.
  const initialRoleVisible = await page.evaluate((rxStr) => {
    const re = new RegExp(rxStr, 'i');
    const els = [...document.querySelectorAll('button, [role="button"], a, div[tabindex]')];
    return els.some(e => e.offsetParent !== null && re.test((e.innerText || e.textContent || '').trim()));
  }, ROLE_PATTERNS[role]?.source || ROLE_PATTERNS.owner.source).catch(() => false);

  if (!initialRoleVisible) {
    const ctaClicked = await page.evaluate(() => {
      const re = /^(sign in|log in|login|get started|launch|enter|continue|portal)$/i;
      const els = [...document.querySelectorAll('button, [role="button"], a, div[tabindex]')];
      for (const el of els) {
        if (el.offsetParent === null) continue;
        const txt = (el.innerText || el.textContent || '').trim();
        if (re.test(txt)) { el.click(); return txt; }
      }
      return null;
    }).catch(() => null);
    if (ctaClicked) {
      console.log(`${tag} clicked landing-page CTA "${ctaClicked}" before role selection`);
      await page.waitForTimeout(3000);
    }
  }

  try {
    // Phase A: Role selection.
    const clickedText = await clickRoleButton(page, role);
    console.log(`${tag} role button clicked: ${clickedText || 'NONE FOUND'}`);
    if (!clickedText) {
      return await fail('role_select', `no clickable matched ${role} pattern`);
    }

    // Phase B: Wait for the credentials screen.
    await page.waitForFunction(
      () => [...document.querySelectorAll('input, textarea')].some(i => i.offsetParent !== null),
      { timeout: 8000 }
    ).catch(() => null);

    // Some Osiris flows are PHONE-ONLY (e.g. Technician / Cleaner). There's
    // a single tel-style input and no password. Detect this first.
    const phoneOnlyInfo = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input, textarea')]
        .filter(i => i.offsetParent !== null && i.type !== 'hidden' && i.type !== 'submit');
      const visibleCount = inputs.length;
      const hasPassword = inputs.some(i => i.type === 'password' || /password/i.test(i.name || i.id || i.placeholder || i.getAttribute('autocomplete') || ''));
      const phoneInput = inputs.find(i =>
        i.type === 'tel' ||
        /phone|tel|mobile/i.test(i.name || i.id || i.placeholder || i.getAttribute('autocomplete') || '')
      );
      return { visibleCount, hasPassword, hasPhone: !!phoneInput };
    }).catch(() => ({ visibleCount: 0, hasPassword: false, hasPhone: false }));

    if (!phoneOnlyInfo.hasPassword && phoneOnlyInfo.hasPhone) {
      // Phone-only login. Fill the phone field — we use creds.email here as
      // the catch-all credential value so the caller can pass a test phone in
      // either field. Strip any non-digit / leading-+ formatting too.
      const rawPhone = (creds.email || creds.password || '').toString();
      const phone = rawPhone.replace(/[^0-9+]/g, '');
      const filled = await page.evaluate((value) => {
        const inputs = [...document.querySelectorAll('input, textarea')].filter(i => i.offsetParent !== null);
        const phoneEl = inputs.find(i =>
          i.type === 'tel' ||
          /phone|tel|mobile/i.test(i.name || i.id || i.placeholder || i.getAttribute('autocomplete') || '')
        );
        if (!phoneEl) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(phoneEl, value);
        phoneEl.dispatchEvent(new Event('input', { bubbles: true }));
        phoneEl.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, phone);
      if (!filled) {
        return await fail('credentials_screen_phone', 'phone-only login detected but failed to fill phone field');
      }
      console.log(`${tag} phone-only login: filled "${phone}"`);
      // Skip Phase B's userField/password fill block; jump to submit.
    } else {
      const passField = await findPasswordField();
      if (!passField) {
        return await fail('credentials_screen', `no password-like input found after clicking "${clickedText}"`);
      }
      const userField = await findUserField();
      if (userField) await userField.fill(creds.email);
      await passField.fill(creds.password || '');
    }
    await page.waitForTimeout(400);

    // Phase C: Submit. Click via in-page evaluation so we match Pressables
    // (role=button divs) the same way we match role buttons.
    const submitClicked = await page.evaluate(() => {
      // Strict priority: INITIALIZE > Sign In > Log In > Submit. Avoid Back.
      const candidates = [
        ...document.querySelectorAll('button'),
        ...document.querySelectorAll('[role="button"]'),
        ...document.querySelectorAll('a'),
        ...document.querySelectorAll('div[tabindex]'),
      ].filter(el => el.offsetParent !== null);
      const text = el => (el.innerText || el.textContent || '').trim();
      const positivePatterns = [
        /^initialize$/i,
        /^\[\s*initialize\s*\]$/i,
        /^sign\s*in$/i,
        /^log\s*in$/i,
        /^login$/i,
        /^submit$/i,
        /^enter$/i,
        /^continue$/i,
      ];
      const negativeRe = /back|cancel|forgot|reset/i;
      for (const re of positivePatterns) {
        const match = candidates.find(el => {
          const t = text(el);
          return re.test(t) && !negativeRe.test(t);
        });
        if (match) { match.click(); return text(match); }
      }
      return null;
    }).catch(() => null);
    if (!submitClicked) {
      return await fail('submit_button', 'no submit button matched on credentials screen');
    }
    console.log(`${tag} submit clicked: "${submitClicked}"`);

    // Phase D: Wait for the credentials screen to go away. We can't rely on
    // type=password since some inputs lack it; instead, wait for the URL to
    // change OR for the Sign In button to disappear. Both URLs are normalized
    // to strip trailing slashes — without this, a `baseUrl` of
    // "https://cleanmachine.live" compared to a `location.href` of
    // "https://cleanmachine.live/" returns "url-changed" before any real
    // navigation has happened, falsely reporting login success.
    const normalizedStart = baseUrl.replace(/\/+$/, '');
    const advanced = await Promise.race([
      page.waitForFunction(
        (startUrl) => {
          const currentNormalized = location.href.replace(/\/+$/, '').replace(/\?$/, '');
          if (currentNormalized === startUrl) return false;
          return !/\/(login|signin|sign-in|auth)(\/|$|\?)/i.test(location.href);
        },
        normalizedStart,
        { timeout: 12000 }
      ).then(() => 'url-changed').catch(() => null),
      page.waitForFunction(
        () => {
          const buttons = [...document.querySelectorAll('button, [role="button"], a, div[tabindex]')]
            .filter(el => el.offsetParent !== null);
          return !buttons.some(b => /^sign\s*in$|^log\s*in$|^login$|initialize/i.test((b.innerText || b.textContent || '').trim()));
        },
        { timeout: 12000 }
      ).then(() => 'signin-gone').catch(() => null),
    ]);
    if (!advanced) {
      // Probe for explicit error messages that indicate WHY auth failed —
      // surfacing the actual product message is far more useful than a
      // generic "wrong creds" diagnostic. Common cases:
      //   - "No crew account found for this phone number. Contact your manager."
      //   - "Invalid username or password"
      //   - "User not found"
      const errorMessage = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const matchers = [
          /no\s+crew\s+account\s+found[^.\n]*\.?/i,
          /no\s+account\s+found[^.\n]*\.?/i,
          /no\s+such\s+user[^.\n]*\.?/i,
          /user\s+not\s+found[^.\n]*\.?/i,
          /invalid\s+(username|password|credentials|phone)[^.\n]*\.?/i,
          /incorrect\s+(username|password|phone)[^.\n]*\.?/i,
          /(?:does\s+not\s+exist|doesn'?t\s+exist)[^.\n]*\.?/i,
          /contact\s+your\s+manager[^.\n]*\.?/i,
        ];
        for (const re of matchers) {
          const m = text.match(re);
          if (m) return m[0].trim();
        }
        return null;
      }).catch(() => null);
      const reason = errorMessage
        ? `${role} login rejected: "${errorMessage}"`
        : `still on credentials screen after submit "${submitClicked}" — wrong creds for ${role}?`;
      return await fail('credentials_rejected', reason);
    }
    await page.waitForTimeout(2500);
  } catch (e) {
    return await fail('exception', e.message);
  }

  const url = page.url();
  const stillOnAuth = /\/(login|signin|sign-in|auth|role)(\/|$|\?)/i.test(url);
  if (stillOnAuth) {
    return await fail('post_login_url', `redirected to auth URL after submit: ${url}`);
  }
  console.log(`${tag} login complete at ${url}`);
  return true;
}

/**
 * Fast screenshot (not full page) as base64.
 */
async function shot(page) {
  try {
    const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 45 });
    return ss.toString('base64');
  } catch { return null; }
}

/**
 * Safely click a selector. Returns true if clicked.
 */
async function safeClick(page, selector, waitAfter = 1000) {
  try {
    const el = await page.$(selector);
    if (!el) return false;
    const visible = await el.isVisible().catch(() => false);
    if (!visible) return false;
    await el.click({ timeout: 3000 });
    await page.waitForTimeout(waitAfter);
    return true;
  } catch { return false; }
}

/**
 * Close any open modal/dialog via Escape.
 */
async function closeModal(page) {
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  } catch {}
}

/**
 * Safely run an async test and push its result. Never throws.
 */
async function runCheck(results, label, fn) {
  try {
    const result = await fn();
    const passed = result?.passed ?? !!result;
    const detail = result?.detail || (passed ? 'OK' : 'Failed');
    results.push({ section: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label, passed, detail, screenshot: result?.screenshot || null });
  } catch (e) {
    results.push({ section: label.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label, passed: false, detail: `Exception: ${e.message.slice(0, 120)}`, screenshot: null });
  }
}

module.exports = { createSession, osirisLogin, osirisLogout, getLoginDiagnostics, shot, safeClick, closeModal, runCheck };
