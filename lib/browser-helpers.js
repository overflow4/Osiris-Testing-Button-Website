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

async function osirisLogin(page, baseUrl, credentials) {
  // Fall back to default admin creds if none provided
  const creds = (credentials?.email) ? credentials : DEFAULT_CREDENTIALS;

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  try {
    // Phase A: click role button (Operator/Owner for admin access)
    const roleBtn = await page.$('button:has-text("Operator"), button:has-text("Owner"), button:has-text("Admin"), button:has-text("Staff")');
    if (roleBtn) { await roleBtn.click(); await page.waitForTimeout(2000); }

    // Phase B: fill credentials
    const hasPassword = await page.$('input[type="password"]');
    if (hasPassword) {
      const emailField = await page.$('input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i], input[placeholder*="username" i], input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])');
      if (emailField) await emailField.fill(creds.email);
      await hasPassword.fill(creds.password || '');
      await page.waitForTimeout(400);
      const submitBtn = await page.$('button:has-text("INITIALIZE"), button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]');
      if (submitBtn) { await submitBtn.click(); await page.waitForTimeout(5500); }
    }
  } catch (e) { /* ignore and check result below */ }

  const url = page.url();
  return !/login|signin|sign-in|auth/i.test(url);
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

module.exports = { createSession, osirisLogin, shot, safeClick, closeModal, runCheck };
