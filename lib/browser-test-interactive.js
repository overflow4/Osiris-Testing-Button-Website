const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

/**
 * Interactive dashboard tests - actually clicks buttons, opens modals, fills forms.
 * Covers the gaps that page-load-only testing misses.
 */
module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-interactive][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { baseUrl, credentials, businessName } = req.body;
  if (!baseUrl) return res.status(400).json({ error: 'Missing baseUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  const results = [];

  try {
    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({ projectId: process.env.BROWSERBASE_PROJECT_ID });
    console.log(`[browser-interactive][${requestId}] Session: ${session.id}`);

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const base = baseUrl.replace(/\/+$/, '');

    // ── Phase 1: Login ──
    if (credentials?.email) {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      try {
        const roleBtn = await page.$('button:has-text("Operator"), button:has-text("Owner"), button:has-text("Admin"), button:has-text("Staff")');
        if (roleBtn) { await roleBtn.click(); await page.waitForTimeout(2500); }

        const hasPassword = await page.$('input[type="password"]');
        if (hasPassword) {
          const emailField = await page.$('input[type="email"], input[name="email"], input[name="username"], input[placeholder*="email" i], input[placeholder*="username" i], input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])');
          if (emailField) await emailField.fill(credentials.email);
          await hasPassword.fill(credentials.password || '');
          await page.waitForTimeout(500);
          const submitBtn = await page.$('button:has-text("INITIALIZE"), button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]');
          if (submitBtn) { await submitBtn.click(); await page.waitForTimeout(6000); }
        }
      } catch (e) { console.log(`[interactive][${requestId}] Login failed: ${e.message}`); }

      const stillOnLogin = /login|signin|auth/i.test(page.url());
      if (stillOnLogin) {
        results.push({ section: 'login', label: 'Login', passed: false, detail: `Stuck on ${page.url()}`, screenshot: null });
        await browser.close();
        return res.status(200).json({ passed: false, score: '0/1', results, businessName });
      }
    }

    // ── Phase 2: Global Search Bar ──
    try {
      console.log(`[browser-interactive][${requestId}] Testing global search...`);
      const searchInput = await page.$('input[type="search"], input[placeholder*="search" i]');
      if (searchInput) {
        await searchInput.click();
        await searchInput.type('test', { delay: 80 });
        await page.waitForTimeout(1500);
        const hasResults = await page.evaluate(() => {
          const dropdown = document.querySelector('[class*="result"], [class*="search"] [class*="item"], [role="listbox"]');
          return !!dropdown;
        });
        const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
        results.push({ section: 'global_search', label: 'Global Search Bar', passed: true, detail: hasResults ? 'Results dropdown shown' : 'Search input typed (no results visible)', screenshot: ss.toString('base64') });
        // Close dropdown
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      } else {
        results.push({ section: 'global_search', label: 'Global Search Bar', passed: false, detail: 'No search input found', screenshot: null });
      }
    } catch (e) {
      results.push({ section: 'global_search', label: 'Global Search Bar', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 3: Sidebar collapse toggle ──
    try {
      const initialWidth = await page.evaluate(() => {
        const aside = document.querySelector('aside, nav, [class*="sidebar"]');
        return aside?.offsetWidth || 0;
      });
      // Try keyboard shortcut Cmd+B
      await page.keyboard.press('Meta+b').catch(() => {});
      await page.waitForTimeout(800);
      const newWidth = await page.evaluate(() => {
        const aside = document.querySelector('aside, nav, [class*="sidebar"]');
        return aside?.offsetWidth || 0;
      });
      const changed = initialWidth > 0 && Math.abs(initialWidth - newWidth) > 10;
      results.push({ section: 'sidebar_toggle', label: 'Sidebar Collapse (Cmd+B)', passed: changed, detail: changed ? `Width ${initialWidth}→${newWidth}` : `No width change (${initialWidth}→${newWidth})`, screenshot: null });
      // Restore
      if (changed) await page.keyboard.press('Meta+b').catch(() => {});
      await page.waitForTimeout(400);
    } catch (e) {
      results.push({ section: 'sidebar_toggle', label: 'Sidebar Collapse (Cmd+B)', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 4: Customers page — open New Customer modal ──
    try {
      console.log(`[browser-interactive][${requestId}] Testing New Customer modal...`);
      await page.goto(`${base}/customers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);

      const newBtn = await page.$('button:has-text("New Customer"), button:has-text("Add Customer"), button:has-text("+ Customer"), button:has-text("New")');
      if (newBtn) {
        await newBtn.click();
        await page.waitForTimeout(1500);

        const modalInfo = await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="Dialog"]');
          if (!modal) return { open: false };
          const inputs = modal.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea');
          const hasFirstName = !!modal.querySelector('input[name*="first" i], input[placeholder*="first" i]');
          const hasPhone = !!modal.querySelector('input[name*="phone" i], input[type="tel"], input[placeholder*="phone" i]');
          const hasEmail = !!modal.querySelector('input[type="email"], input[name*="email" i]');
          return { open: true, inputCount: inputs.length, hasFirstName, hasPhone, hasEmail };
        });

        const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
        const passed = modalInfo.open && modalInfo.inputCount >= 3;
        results.push({ section: 'new_customer_modal', label: 'New Customer Modal', passed, detail: modalInfo.open ? `Modal opened with ${modalInfo.inputCount} fields (name:${modalInfo.hasFirstName}, phone:${modalInfo.hasPhone}, email:${modalInfo.hasEmail})` : 'Modal did not open', screenshot: ss.toString('base64') });

        // Close modal
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      } else {
        results.push({ section: 'new_customer_modal', label: 'New Customer Modal', passed: false, detail: 'No New Customer button found', screenshot: null });
      }
    } catch (e) {
      results.push({ section: 'new_customer_modal', label: 'New Customer Modal', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 5: Calendar — open Create Job modal ──
    try {
      console.log(`[browser-interactive][${requestId}] Testing Create Job modal...`);
      await page.goto(`${base}/calendar`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(4000);

      // Try FAB button or "New Job" button first
      let opened = false;
      const fabBtn = await page.$('button:has-text("New Job"), button:has-text("Add Job"), button:has-text("Create Job"), button[aria-label*="add" i], button[class*="fab"]');
      if (fabBtn) {
        await fabBtn.click();
        await page.waitForTimeout(1500);
        opened = true;
      }

      const modalInfo = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="Dialog"], [class*="drawer"]');
        if (!modal) return { open: false };
        const inputs = modal.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea, select');
        const hasPhone = !!modal.querySelector('input[name*="phone" i], input[type="tel"], input[placeholder*="phone" i]');
        const hasAddress = !!modal.querySelector('input[name*="address" i], input[placeholder*="address" i]');
        const hasService = !!modal.querySelector('select[name*="service" i], [class*="service"] select, input[name*="service" i]');
        const hasDate = !!modal.querySelector('input[type="date"], input[type="datetime-local"], [class*="date"]');
        return { open: true, inputCount: inputs.length, hasPhone, hasAddress, hasService, hasDate };
      });

      const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
      const passed = modalInfo.open && modalInfo.inputCount >= 3;
      results.push({ section: 'create_job_modal', label: 'Create Job Modal', passed, detail: modalInfo.open ? `Modal opened with ${modalInfo.inputCount} fields (phone:${modalInfo.hasPhone}, address:${modalInfo.hasAddress}, service:${modalInfo.hasService}, date:${modalInfo.hasDate})` : (opened ? 'Button clicked but no modal appeared' : 'No create job button found'), screenshot: ss.toString('base64') });

      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    } catch (e) {
      results.push({ section: 'create_job_modal', label: 'Create Job Modal', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 6: Settings modal ──
    try {
      console.log(`[browser-interactive][${requestId}] Testing Settings modal...`);
      // Settings can be triggered from sidebar button
      const settingsBtn = await page.$('button[aria-label*="settings" i], button:has-text("Settings"), a[href*="/settings"]');
      if (settingsBtn) {
        await settingsBtn.click();
        await page.waitForTimeout(2500);

        const settingsInfo = await page.evaluate(() => {
          const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="Dialog"]');
          const onSettingsPage = /settings/i.test(window.location.pathname);
          const tabs = document.querySelectorAll('[role="tab"], [class*="tab"]');
          const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
          return { modalOpen: !!modal, onSettingsPage, tabCount: tabs.length, inputCount: inputs.length };
        });

        const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
        const passed = settingsInfo.modalOpen || settingsInfo.onSettingsPage;
        results.push({ section: 'settings', label: 'Settings', passed, detail: passed ? `${settingsInfo.modalOpen ? 'Modal' : 'Page'} with ${settingsInfo.tabCount} tabs, ${settingsInfo.inputCount} inputs` : 'Settings did not open', screenshot: ss.toString('base64') });

        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
      } else {
        results.push({ section: 'settings', label: 'Settings', passed: false, detail: 'No settings button found', screenshot: null });
      }
    } catch (e) {
      results.push({ section: 'settings', label: 'Settings', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 7: Admin panel tabs ──
    try {
      console.log(`[browser-interactive][${requestId}] Testing Admin tabs...`);
      await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(4000);

      const tabNames = ['Controls', 'Booking Flow', 'Credentials', 'Setup Checklist', 'Cleaners', 'Campaigns', 'Info'];
      const tabResults = [];

      for (const tabName of tabNames) {
        try {
          const tabBtn = await page.$(`button:has-text("${tabName}"), [role="tab"]:has-text("${tabName}"), a:has-text("${tabName}")`);
          if (tabBtn) {
            await tabBtn.click();
            await page.waitForTimeout(1500);
            const hasContent = await page.evaluate(() => {
              return document.body.innerText.length > 200;
            });
            tabResults.push({ tab: tabName, clicked: true, hasContent });
          } else {
            tabResults.push({ tab: tabName, clicked: false, hasContent: false });
          }
        } catch (e) {
          tabResults.push({ tab: tabName, clicked: false, error: e.message.slice(0, 50) });
        }
      }

      const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
      const clickedCount = tabResults.filter(t => t.clicked).length;
      results.push({
        section: 'admin_tabs',
        label: 'Admin Panel Tabs',
        passed: clickedCount >= 3,
        detail: `${clickedCount}/${tabNames.length} tabs clickable: ${tabResults.filter(t => t.clicked).map(t => t.tab).join(', ')}`,
        screenshot: ss.toString('base64'),
      });
    } catch (e) {
      results.push({ section: 'admin_tabs', label: 'Admin Panel Tabs', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 8: Customer detail — SMS input and action buttons ──
    try {
      console.log(`[browser-interactive][${requestId}] Testing customer detail page...`);
      await page.goto(`${base}/customers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(4000);

      // Click first customer in list
      const customerRow = await page.$('[class*="customer"]:not([class*="new"]), [class*="list"] > div:first-child, [class*="conversation"]:first-child, li:has(button):first-child');
      if (customerRow) {
        await customerRow.click();
        await page.waitForTimeout(2500);

        const detailInfo = await page.evaluate(() => {
          const body = document.body.innerText || '';
          const tabs = [...document.querySelectorAll('[role="tab"], [class*="tab"]')].map(t => t.textContent?.trim());
          const hasMessagesTab = tabs.some(t => /message/i.test(t || ''));
          const hasJobsTab = tabs.some(t => /job/i.test(t || ''));
          const hasSmsInput = !!document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i], input[placeholder*="sms" i]');
          const hasActionButtons = [...document.querySelectorAll('button')].filter(b => /payment|charge|edit|delete|transcript|lost|sms|text/i.test(b.textContent)).length;
          return { tabCount: tabs.length, hasMessagesTab, hasJobsTab, hasSmsInput, hasActionButtons };
        });

        const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
        const passed = detailInfo.tabCount >= 2 || detailInfo.hasSmsInput || detailInfo.hasActionButtons >= 2;
        results.push({
          section: 'customer_detail',
          label: 'Customer Detail Page',
          passed,
          detail: `${detailInfo.tabCount} tabs, SMS input:${detailInfo.hasSmsInput}, ${detailInfo.hasActionButtons} action buttons`,
          screenshot: ss.toString('base64'),
        });
      } else {
        results.push({ section: 'customer_detail', label: 'Customer Detail Page', passed: false, detail: 'No customer to click', screenshot: null });
      }
    } catch (e) {
      results.push({ section: 'customer_detail', label: 'Customer Detail Page', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 9: Calendar view toggle ──
    try {
      console.log(`[browser-interactive][${requestId}] Testing calendar view modes...`);
      await page.goto(`${base}/calendar`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(4000);

      const viewButtons = ['Week', 'Month', 'Day', 'List'];
      const viewResults = [];

      for (const vb of viewButtons) {
        try {
          const btn = await page.$(`button:has-text("${vb}")`);
          if (btn) {
            await btn.click();
            await page.waitForTimeout(1200);
            viewResults.push({ view: vb, clicked: true });
          }
        } catch (e) {}
      }

      const passed = viewResults.length >= 2;
      results.push({
        section: 'calendar_views',
        label: 'Calendar View Modes',
        passed,
        detail: `${viewResults.length}/${viewButtons.length} views clickable: ${viewResults.map(v => v.view).join(', ')}`,
        screenshot: null,
      });
    } catch (e) {
      results.push({ section: 'calendar_views', label: 'Calendar View Modes', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    // ── Phase 10: Theme toggle ──
    try {
      const themeBtn = await page.$('button[aria-label*="theme" i], button[aria-label*="dark" i], button:has-text("🌙"), button:has-text("☀")');
      if (themeBtn) {
        const beforeScheme = await page.evaluate(() => document.documentElement.className + ' ' + (document.documentElement.dataset.theme || ''));
        await themeBtn.click();
        await page.waitForTimeout(800);
        const afterScheme = await page.evaluate(() => document.documentElement.className + ' ' + (document.documentElement.dataset.theme || ''));
        results.push({ section: 'theme_toggle', label: 'Dark/Light Theme Toggle', passed: beforeScheme !== afterScheme, detail: beforeScheme !== afterScheme ? 'Theme changed' : 'Theme did not change', screenshot: null });
      } else {
        results.push({ section: 'theme_toggle', label: 'Dark/Light Theme Toggle', passed: false, detail: 'No theme button found', screenshot: null });
      }
    } catch (e) {
      results.push({ section: 'theme_toggle', label: 'Dark/Light Theme Toggle', passed: false, detail: `Failed: ${e.message.slice(0, 80)}`, screenshot: null });
    }

    await page.close();
    await browser.close();

    const passedCount = results.filter(r => r.passed).length;
    return res.status(200).json({
      passed: passedCount >= Math.ceil(results.length * 0.5),
      score: `${passedCount}/${results.length}`,
      results,
      businessName,
    });

  } catch (e) {
    console.error(`[browser-interactive][${requestId}] FAILED:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message, partialResults: results });
  }
};
