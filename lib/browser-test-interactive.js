const { createSession, osirisLogin, shot, safeClick, closeModal, runCheck } = require('./browser-helpers');

/**
 * COMPREHENSIVE interactive test.
 * Clicks through every major feature, opens every modal, toggles every tab.
 * Split into phases — each phase is try/wrapped so a failure doesn't abort the run.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { baseUrl, credentials, businessName, phase = 'all' } = req.body;
  if (!baseUrl) return res.status(400).json({ error: 'Missing baseUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  const results = [];
  const base = baseUrl.replace(/\/+$/, '');

  try {
    const sess = await createSession(apiKey, process.env.BROWSERBASE_PROJECT_ID);
    browser = sess.browser;
    const page = sess.page;

    // Login
    const loggedIn = await osirisLogin(page, base, credentials);
    results.push({
      section: 'login', label: 'Login',
      passed: loggedIn,
      detail: loggedIn ? `Logged in → ${page.url().slice(0, 80)}` : 'Stuck on login page',
      screenshot: await shot(page),
    });
    if (!loggedIn) {
      await browser.close();
      return res.status(200).json({ passed: false, score: '0/1', results, businessName, note: 'Login failed, skipping all interactive tests' });
    }

    // ═══════════════════════════════════════════════════════════
    // PHASE 1: GLOBAL UI (sidebar, top nav, search, theme)
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Global Search Bar', async () => {
      const searchInput = await page.$('input[type="search"], input[placeholder*="search" i]');
      if (!searchInput) return { passed: false, detail: 'No search input' };
      await searchInput.click();
      await searchInput.type('test', { delay: 50 });
      await page.waitForTimeout(1200);
      const hasDropdown = await page.evaluate(() => !!document.querySelector('[class*="result"], [role="listbox"], [class*="dropdown"] [class*="item"]'));
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
      return { passed: true, detail: hasDropdown ? 'Search + dropdown' : 'Search input works' };
    });

    await runCheck(results, 'Theme Toggle', async () => {
      const before = await page.evaluate(() => document.documentElement.className + document.documentElement.dataset.theme);
      const ok = await safeClick(page, 'button[aria-label*="theme" i], button[aria-label*="dark" i], button[title*="theme" i]', 600);
      if (!ok) return { passed: false, detail: 'No theme button' };
      const after = await page.evaluate(() => document.documentElement.className + document.documentElement.dataset.theme);
      return { passed: before !== after, detail: before !== after ? 'Theme changed' : 'Theme unchanged' };
    });

    await runCheck(results, 'Sidebar Collapse (Cmd+B)', async () => {
      const before = await page.evaluate(() => (document.querySelector('aside, nav, [class*="sidebar"]') || {}).offsetWidth || 0);
      await page.keyboard.press('Meta+b').catch(() => {});
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => (document.querySelector('aside, nav, [class*="sidebar"]') || {}).offsetWidth || 0);
      const changed = before > 0 && Math.abs(before - after) > 10;
      if (changed) { await page.keyboard.press('Meta+b').catch(() => {}); await page.waitForTimeout(300); }
      return { passed: changed, detail: changed ? `${before}→${after}` : 'No change' };
    });

    await runCheck(results, 'Account Switcher', async () => {
      const switcher = await page.$('[class*="account"], [class*="tenant"], [class*="switcher"], button:has-text("Switch")');
      return { passed: !!switcher, detail: switcher ? 'Account switcher found' : 'Not found' };
    });

    await runCheck(results, 'System Active Toggle', async () => {
      const toggle = await page.evaluate(() => {
        const els = [...document.querySelectorAll('[class*="toggle"], [class*="switch"], input[role="switch"]')];
        return els.some(e => /system|active|sms|online/i.test(e.closest('label, [class*="label"]')?.textContent || e.getAttribute('aria-label') || ''));
      });
      return { passed: toggle, detail: toggle ? 'System toggle found' : 'Not found' };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 2: COMMAND CENTER
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Command Center Load', async () => {
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        cards: document.querySelectorAll('[class*="card"], [class*="stat"], [class*="metric"]').length,
        charts: document.querySelectorAll('canvas, svg[class*="chart"], [class*="recharts"]').length,
        hasRevenue: /revenue|earnings|\$/i.test(document.body.innerText),
        hasActivity: /activity|recent|feed/i.test(document.body.innerText),
      }));
      return { passed: info.cards >= 3 && info.charts >= 1, detail: `${info.cards} cards, ${info.charts} charts, revenue:${info.hasRevenue}, activity:${info.hasActivity}`, screenshot: await shot(page) };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 3: CUSTOMERS CRUD (New → Edit → Delete)
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Customers Page Load', async () => {
      await page.goto(`${base}/customers`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        hasSearch: !!document.querySelector('input[type="search"], input[placeholder*="search" i]'),
        customerCount: document.querySelectorAll('[class*="customer"], [class*="conversation"], li, [class*="row"]').length,
        hasNewBtn: [...document.querySelectorAll('button')].some(b => /new customer|add customer|\+/i.test(b.textContent)),
      }));
      return { passed: info.hasSearch || info.hasNewBtn, detail: `search:${info.hasSearch}, new btn:${info.hasNewBtn}, ${info.customerCount} items`, screenshot: await shot(page) };
    });

    const testCustomerName = `Test_${Date.now().toString().slice(-6)}`;

    await runCheck(results, 'New Customer Modal', async () => {
      const ok = await safeClick(page, 'button:has-text("New Customer"), button:has-text("Add Customer"), button:has-text("+ Customer"), button[aria-label*="new" i]', 1500);
      if (!ok) return { passed: false, detail: 'New Customer button not found' };
      const modal = await page.evaluate(() => {
        const m = document.querySelector('[role="dialog"], [class*="modal"], [class*="Dialog"]');
        if (!m) return null;
        return {
          inputCount: m.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea').length,
          hasFirstName: !!m.querySelector('input[name*="first" i], input[placeholder*="first" i]'),
          hasPhone: !!m.querySelector('input[name*="phone" i], input[type="tel"], input[placeholder*="phone" i]'),
          hasEmail: !!m.querySelector('input[type="email"], input[name*="email" i]'),
          hasAddress: !!m.querySelector('input[name*="address" i], input[placeholder*="address" i]'),
          hasCommercial: !!m.querySelector('input[name*="commercial" i], label:has(input[type="checkbox"])'),
        };
      });
      if (!modal) return { passed: false, detail: 'Modal did not open' };
      return { passed: modal.inputCount >= 4, detail: `${modal.inputCount} fields (first:${modal.hasFirstName}, phone:${modal.hasPhone}, email:${modal.hasEmail}, addr:${modal.hasAddress}, commercial:${modal.hasCommercial})`, screenshot: await shot(page) };
    });

    // Fill and submit the new customer
    await runCheck(results, 'Create Customer (end-to-end)', async () => {
      // Modal should still be open from previous check
      const firstNameField = await page.$('input[name*="first" i], input[placeholder*="first" i]');
      if (!firstNameField) return { passed: false, detail: 'No first name field visible' };
      await firstNameField.fill(testCustomerName);
      const lastField = await page.$('input[name*="last" i], input[placeholder*="last" i]');
      if (lastField) await lastField.fill('Automation');
      const phoneField = await page.$('input[name*="phone" i], input[type="tel"]');
      if (phoneField) await phoneField.fill(`555${Date.now().toString().slice(-7)}`);
      const emailField = await page.$('input[type="email"], input[name*="email" i]');
      if (emailField) await emailField.fill(`test+${Date.now()}@test.com`);
      const addressField = await page.$('input[name*="address" i], input[placeholder*="address" i]');
      if (addressField) await addressField.fill('123 Test St');
      await page.waitForTimeout(400);
      const submitBtn = await page.$('button:has-text("Create"), button:has-text("Save"), button:has-text("Add"), button[type="submit"]');
      if (!submitBtn) return { passed: false, detail: 'No submit button' };
      await submitBtn.click();
      await page.waitForTimeout(3000);
      const created = await page.evaluate((name) => document.body.innerText.includes(name), testCustomerName);
      return { passed: created, detail: created ? `Created ${testCustomerName}` : 'Customer not found in list after submit', screenshot: await shot(page) };
    });

    await runCheck(results, 'Select Customer', async () => {
      const selected = await page.evaluate((name) => {
        const rows = [...document.querySelectorAll('[class*="customer"], [class*="conversation"], li, div')];
        const row = rows.find(r => r.textContent?.includes(name));
        if (!row) return false;
        row.click();
        return true;
      }, testCustomerName);
      if (!selected) return { passed: false, detail: 'Could not click customer row' };
      await page.waitForTimeout(2000);
      const info = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll('[role="tab"], [class*="tab"]')].map(t => t.textContent?.trim()).filter(Boolean);
        const hasSmsInput = !!document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i]');
        return { tabs, hasSmsInput };
      });
      return { passed: info.tabs.length > 0 || info.hasSmsInput, detail: `Tabs: ${info.tabs.slice(0, 5).join(', ')} | SMS input: ${info.hasSmsInput}` };
    });

    await runCheck(results, 'Messages Tab', async () => {
      const clicked = await safeClick(page, '[role="tab"]:has-text("Messages"), button:has-text("Messages"), [class*="tab"]:has-text("Messages")', 1200);
      const hasInput = await page.evaluate(() => !!document.querySelector('input[placeholder*="message" i], textarea[placeholder*="message" i]'));
      return { passed: clicked || hasInput, detail: `Tab clicked:${clicked}, input:${hasInput}` };
    });

    await runCheck(results, 'Jobs Tab', async () => {
      const clicked = await safeClick(page, '[role="tab"]:has-text("Jobs"), button:has-text("Jobs")', 1200);
      return { passed: clicked, detail: clicked ? 'Jobs tab clicked' : 'No Jobs tab' };
    });

    await runCheck(results, 'Quotes Tab', async () => {
      const clicked = await safeClick(page, '[role="tab"]:has-text("Quotes"), button:has-text("Quotes")', 1200);
      return { passed: clicked, detail: clicked ? 'Quotes tab clicked' : 'No Quotes tab' };
    });

    await runCheck(results, 'Create Payment Link Popover', async () => {
      const clicked = await safeClick(page, 'button:has-text("Payment Link"), button:has-text("Create Payment"), button:has-text("Pay Link")', 1200);
      if (!clicked) return { passed: false, detail: 'No payment link button' };
      const popover = await page.evaluate(() => {
        const types = ['card on file', 'enter card', 'payment', 'invoice', 'charge card', 'create quote'];
        const text = document.body.innerText.toLowerCase();
        const typesFound = types.filter(t => text.includes(t)).length;
        return { typesFound };
      });
      await closeModal(page);
      return { passed: popover.typesFound >= 2, detail: `${popover.typesFound}/6 payment types visible` };
    });

    await runCheck(results, 'Charge Card Dialog', async () => {
      const clicked = await safeClick(page, 'button:has-text("Charge Card"), button:has-text("Charge")', 1200);
      if (!clicked) return { passed: false, detail: 'No Charge Card button' };
      const info = await page.evaluate(() => {
        const modal = document.querySelector('[role="dialog"], [class*="modal"]');
        if (!modal) return null;
        const amountInput = modal.querySelector('input[type="number"], input[placeholder*="amount" i], input[name*="amount" i]');
        const descInput = modal.querySelector('textarea, input[placeholder*="description" i], input[name*="description" i]');
        return { hasAmount: !!amountInput, hasDesc: !!descInput };
      });
      await closeModal(page);
      return { passed: !!info && info.hasAmount, detail: info ? `amount:${info.hasAmount}, desc:${info.hasDesc}` : 'No dialog' };
    });

    await runCheck(results, 'Edit Customer Modal', async () => {
      const clicked = await safeClick(page, 'button:has-text("Edit Customer"), button:has-text("Edit"), button[aria-label*="edit" i]', 1500);
      if (!clicked) return { passed: false, detail: 'No edit button' };
      const modal = await page.evaluate(() => {
        const m = document.querySelector('[role="dialog"], [class*="modal"]');
        return m ? { inputCount: m.querySelectorAll('input, textarea, select').length } : null;
      });
      await closeModal(page);
      return { passed: !!modal && modal.inputCount >= 3, detail: modal ? `${modal.inputCount} fields` : 'No edit modal' };
    });

    await runCheck(results, 'Delete Customer Confirmation', async () => {
      const clicked = await safeClick(page, 'button:has-text("Delete Customer"), button:has-text("Delete")', 1500);
      if (!clicked) return { passed: false, detail: 'No delete button' };
      const confirmVisible = await page.evaluate(() => {
        const text = document.body.innerText;
        return /are you sure|confirm|delete/i.test(text) && !!document.querySelector('[role="dialog"], [class*="modal"], [class*="confirm"]');
      });
      // Cancel the delete — we don't actually want to remove it
      await safeClick(page, 'button:has-text("Cancel"), button:has-text("No"), [role="dialog"] button:has-text("Close")', 800);
      await closeModal(page);
      return { passed: confirmVisible, detail: confirmVisible ? 'Confirmation shown, cancelled' : 'No confirmation dialog' };
    });

    await runCheck(results, 'Copy Transcript Button', async () => {
      const found = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /copy.*transcript|transcript.*copy/i.test(b.textContent)));
      return { passed: found, detail: found ? 'Copy Transcript button present' : 'Not found' };
    });

    await runCheck(results, 'Mark as Lost Button', async () => {
      const found = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /mark.*lost|lost/i.test(b.textContent)));
      return { passed: found, detail: found ? 'Mark as Lost button present' : 'Not found' };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 4: CALENDAR / JOBS
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Calendar Load', async () => {
      await page.goto(`${base}/calendar`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(4000);
      const info = await page.evaluate(() => ({
        hasCalendar: !!document.querySelector('[class*="calendar"], [class*="fc-"], [class*="gantt"]'),
        viewButtons: [...document.querySelectorAll('button')].filter(b => /week|month|day|list|gantt/i.test(b.textContent)).length,
      }));
      return { passed: info.hasCalendar, detail: `Calendar:${info.hasCalendar}, ${info.viewButtons} view buttons`, screenshot: await shot(page) };
    });

    for (const view of ['Week', 'Month', 'Day', 'List']) {
      await runCheck(results, `Calendar ${view} View`, async () => {
        const ok = await safeClick(page, `button:has-text("${view}")`, 1000);
        return { passed: ok, detail: ok ? `Switched to ${view}` : `No ${view} button` };
      });
    }

    await runCheck(results, 'Calendar Today Button', async () => {
      const ok = await safeClick(page, 'button:has-text("Today")', 800);
      return { passed: ok, detail: ok ? 'Today clicked' : 'No Today button' };
    });

    await runCheck(results, 'Calendar Prev/Next', async () => {
      const prev = await safeClick(page, 'button:has-text("Prev"), button[aria-label*="prev" i], button[aria-label*="previous" i]', 600);
      const next = await safeClick(page, 'button:has-text("Next"), button[aria-label*="next" i]', 600);
      return { passed: prev || next, detail: `prev:${prev}, next:${next}` };
    });

    await runCheck(results, 'Create Job Modal', async () => {
      const ok = await safeClick(page, 'button:has-text("New Job"), button:has-text("Add Job"), button:has-text("Create Job"), button[class*="fab"], button[aria-label*="add" i]', 1500);
      const modal = await page.evaluate(() => {
        const m = document.querySelector('[role="dialog"], [class*="modal"], [class*="drawer"]');
        if (!m) return null;
        const inputs = m.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea, select');
        return {
          inputCount: inputs.length,
          hasPhone: !!m.querySelector('input[name*="phone" i], input[type="tel"], input[placeholder*="phone" i]'),
          hasAddress: !!m.querySelector('input[name*="address" i], input[placeholder*="address" i]'),
          hasService: !!m.querySelector('select[name*="service" i], [class*="service"] select, input[name*="service" i]'),
          hasDate: !!m.querySelector('input[type="date"], input[type="datetime-local"], [class*="date"]'),
          hasBedrooms: !!m.querySelector('input[name*="bed" i], select[name*="bed" i]'),
          hasAddons: m.querySelectorAll('input[type="checkbox"]').length > 0,
        };
      });
      if (!modal) { await closeModal(page); return { passed: false, detail: 'No create job modal' }; }
      await closeModal(page);
      return { passed: modal.inputCount >= 3, detail: `${modal.inputCount} fields (phone:${modal.hasPhone}, addr:${modal.hasAddress}, svc:${modal.hasService}, date:${modal.hasDate}, bed:${modal.hasBedrooms}, addons:${modal.hasAddons})`, screenshot: await shot(page) };
    });

    await runCheck(results, 'Click Existing Job Event', async () => {
      const clicked = await page.evaluate(() => {
        const event = document.querySelector('[class*="event"], [class*="fc-event"], [class*="job-card"]');
        if (!event) return false;
        event.click();
        return true;
      });
      if (!clicked) return { passed: false, detail: 'No job events visible' };
      await page.waitForTimeout(1500);
      const popover = await page.evaluate(() => {
        const p = document.querySelector('[class*="popover"], [role="dialog"], [class*="detail"]');
        if (!p) return null;
        const btns = [...p.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean);
        return { buttons: btns.slice(0, 10) };
      });
      await closeModal(page);
      return { passed: !!popover, detail: popover ? `Popover buttons: ${popover.buttons.join(', ')}` : 'No popover' };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 5: PIPELINE / INBOX / ASSISTANT / CALLS
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Pipeline Page', async () => {
      await page.goto(`${base}/pipeline`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => {
        const text = document.body.innerText;
        const stages = ['New Lead', 'Engaged', 'Paid', 'Booked', 'Quoted'].filter(s => text.includes(s)).length;
        const hasImport = [...document.querySelectorAll('button')].some(b => /import/i.test(b.textContent));
        const hasRefresh = [...document.querySelectorAll('button')].some(b => /refresh/i.test(b.textContent));
        const columns = document.querySelectorAll('[class*="column"], [class*="kanban"], [class*="stage"]').length;
        return { stages, hasImport, hasRefresh, columns };
      });
      return { passed: info.stages >= 2 || info.columns >= 2, detail: `${info.stages} stages, ${info.columns} columns, import:${info.hasImport}, refresh:${info.hasRefresh}`, screenshot: await shot(page) };
    });

    await runCheck(results, 'Pipeline Import CSV', async () => {
      const clicked = await safeClick(page, 'button:has-text("Import")', 1500);
      if (!clicked) return { passed: false, detail: 'No Import button' };
      const modal = await page.evaluate(() => {
        const m = document.querySelector('[role="dialog"], [class*="modal"]');
        if (!m) return null;
        return { hasFileInput: !!m.querySelector('input[type="file"]'), hasDropzone: !!m.querySelector('[class*="drop"], [class*="upload"]') };
      });
      await closeModal(page);
      return { passed: !!modal, detail: modal ? `file:${modal.hasFileInput}, dropzone:${modal.hasDropzone}` : 'No import modal' };
    });

    await runCheck(results, 'Inbox Page', async () => {
      await page.goto(`${base}/inbox`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        threads: document.querySelectorAll('[class*="thread"], [class*="conversation"]').length,
        hasAiBadge: /ai|bot|auto/i.test(document.body.innerText),
      }));
      return { passed: info.threads > 0 || info.hasAiBadge, detail: `${info.threads} threads, AI mentioned:${info.hasAiBadge}` };
    });

    await runCheck(results, 'Inbox Click Thread', async () => {
      const clicked = await page.evaluate(() => {
        const t = document.querySelector('[class*="thread"], [class*="conversation"]');
        if (!t) return false;
        t.click();
        return true;
      });
      if (!clicked) return { passed: false, detail: 'No thread to click' };
      await page.waitForTimeout(1500);
      const hasMessages = await page.evaluate(() => document.querySelectorAll('[class*="message"], [class*="bubble"]').length > 0);
      return { passed: hasMessages, detail: hasMessages ? 'Messages loaded' : 'No messages after click' };
    });

    await runCheck(results, 'Assistant Page', async () => {
      await page.goto(`${base}/assistant`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        hasMessageInput: !!document.querySelector('textarea, input[placeholder*="message" i], input[placeholder*="ask" i]'),
        hasNewBtn: [...document.querySelectorAll('button')].some(b => /new|start/i.test(b.textContent)),
        hasSidebar: !!document.querySelector('aside, [class*="sidebar"]'),
      }));
      return { passed: info.hasMessageInput, detail: `input:${info.hasMessageInput}, new btn:${info.hasNewBtn}, sidebar:${info.hasSidebar}` };
    });

    await runCheck(results, 'Calls Page', async () => {
      await page.goto(`${base}/calls`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        hasTable: !!document.querySelector('table, [class*="table"], [role="grid"]'),
        hasBadges: document.querySelectorAll('[class*="badge"]').length,
        hasFilter: !!document.querySelector('select, input[placeholder*="filter" i], input[type="search"]'),
      }));
      return { passed: info.hasTable || info.hasBadges > 0, detail: `table:${info.hasTable}, ${info.hasBadges} badges, filter:${info.hasFilter}` };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 6: INSIGHTS (all 6 sub-pages)
    // ═══════════════════════════════════════════════════════════
    for (const [path, label, expectText] of [
      ['/insights/leads', 'Insights: Leads', /conversion|revenue|source/i],
      ['/insights/crews', 'Insights: Crews', /revenue|rating|team|rank/i],
      ['/insights/retention', 'Insights: Retention', /health|repeat|risk|lifecycle/i],
      ['/insights/revenue', 'Insights: Revenue', /mrr|monthly|revenue|trend/i],
      ['/insights/pricing', 'Insights: Pricing', /price|tier|addon|variance/i],
      ['/insights/funnel', 'Insights: Funnel', /funnel|conversion|stage|bottleneck/i],
    ]) {
      await runCheck(results, label, async () => {
        await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        const info = await page.evaluate((pattern) => {
          const body = document.body.innerText;
          return {
            hasExpected: new RegExp(pattern).test(body),
            cards: document.querySelectorAll('[class*="card"], [class*="metric"]').length,
            charts: document.querySelectorAll('canvas, svg[class*="chart"], [class*="recharts"]').length,
            tables: document.querySelectorAll('table, [role="grid"]').length,
          };
        }, expectText.source);
        return { passed: info.hasExpected && (info.cards >= 2 || info.charts >= 1 || info.tables >= 1), detail: `${info.cards} cards, ${info.charts} charts, ${info.tables} tables, content:${info.hasExpected}` };
      });
    }

    // Insights Crews sort buttons
    await runCheck(results, 'Insights: Crews Sort Buttons', async () => {
      await page.goto(`${base}/insights/crews`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2500);
      let clicked = 0;
      for (const sort of ['Revenue', 'Jobs', 'Rating', 'Tips']) {
        if (await safeClick(page, `button:has-text("${sort}")`, 500)) clicked++;
      }
      return { passed: clicked >= 2, detail: `${clicked}/4 sort buttons worked` };
    });

    // Insights Revenue month selector
    await runCheck(results, 'Insights: Revenue Month Selector', async () => {
      await page.goto(`${base}/insights/revenue`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2500);
      const hasSelector = await page.$('select, [role="combobox"], [class*="select"]');
      return { passed: !!hasSelector, detail: hasSelector ? 'Month selector present' : 'Not found' };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 7: RETARGETING / CAMPAIGNS
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Retargeting Page', async () => {
      await page.goto(`${base}/retargeting`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        tabs: [...document.querySelectorAll('[role="tab"], [class*="tab"], button')].filter(t => /all|unresponsive|quoted|one.?time|lapsed|new lead|lost/i.test(t.textContent)).length,
        hasCheckbox: !!document.querySelector('input[type="checkbox"]'),
        hasRows: document.querySelectorAll('tr, [class*="row"]').length,
      }));
      return { passed: info.tabs >= 2 || info.hasRows > 0, detail: `${info.tabs} filter tabs, checkbox:${info.hasCheckbox}, ${info.hasRows} rows`, screenshot: await shot(page) };
    });

    await runCheck(results, 'Retargeting Filter Tabs', async () => {
      let clicked = 0;
      for (const tab of ['All', 'Unresponsive', 'Quoted', 'One-Time', 'Lapsed', 'Lost']) {
        if (await safeClick(page, `button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`, 400)) clicked++;
      }
      return { passed: clicked >= 3, detail: `${clicked}/6 filter tabs clicked` };
    });

    await runCheck(results, 'Campaigns Page', async () => {
      await page.goto(`${base}/campaigns`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        hasImport: [...document.querySelectorAll('button')].some(b => /import/i.test(b.textContent)),
        hasRefresh: [...document.querySelectorAll('button')].some(b => /refresh/i.test(b.textContent)),
        cards: document.querySelectorAll('[class*="card"], [class*="stat"]').length,
        hasSequence: /sequence|journey|retargeting/i.test(document.body.innerText),
      }));
      return { passed: info.hasImport || info.cards >= 2, detail: `import:${info.hasImport}, refresh:${info.hasRefresh}, ${info.cards} cards, sequence:${info.hasSequence}` };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 8: LEADERBOARD / EARNINGS / MEMBERSHIPS
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Leaderboard Page', async () => {
      await page.goto(`${base}/leaderboard`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        hasPodium: /gold|silver|bronze|1st|2nd|3rd/i.test(document.body.innerText),
        hasRankings: document.querySelectorAll('[class*="rank"], [class*="leader"]').length,
        timeRangeButtons: [...document.querySelectorAll('button')].filter(b => /today|week|month|quarter|year/i.test(b.textContent)).length,
      }));
      return { passed: info.timeRangeButtons >= 2 || info.hasRankings >= 3 || info.hasPodium, detail: `podium:${info.hasPodium}, ${info.hasRankings} rank items, ${info.timeRangeButtons} time buttons` };
    });

    await runCheck(results, 'Leaderboard Time Range Tabs', async () => {
      let clicked = 0;
      for (const range of ['Today', 'Week', 'Month', 'Quarter', 'Year']) {
        if (await safeClick(page, `button:has-text("${range}")`, 400)) clicked++;
      }
      return { passed: clicked >= 2, detail: `${clicked}/5 time ranges clicked` };
    });

    await runCheck(results, 'Earnings Page', async () => {
      await page.goto(`${base}/earnings`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        hasTip: /tip/i.test(document.body.innerText),
        hasUpsell: /upsell/i.test(document.body.innerText),
        tabs: document.querySelectorAll('[role="tab"], [class*="tab"]').length,
      }));
      return { passed: info.hasTip || info.hasUpsell, detail: `tip:${info.hasTip}, upsell:${info.hasUpsell}, ${info.tabs} tabs` };
    });

    await runCheck(results, 'Memberships Page', async () => {
      await page.goto(`${base}/memberships`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        hasTable: !!document.querySelector('table, [class*="table"]'),
        hasFilter: !!document.querySelector('select, [role="combobox"]'),
        hasCreateBtn: [...document.querySelectorAll('button')].some(b => /create|add|new/i.test(b.textContent)),
      }));
      return { passed: info.hasTable || info.hasCreateBtn, detail: `table:${info.hasTable}, filter:${info.hasFilter}, create:${info.hasCreateBtn}` };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 9: ADMIN PANEL — all 7 tabs
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Admin Page Load', async () => {
      await page.goto(`${base}/admin`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(4000);
      const info = await page.evaluate(() => ({
        hasBusinessList: !!document.querySelector('[class*="business"], [class*="tenant"], aside'),
        hasProgress: /progress|complete|setup/i.test(document.body.innerText),
        tabs: [...document.querySelectorAll('[role="tab"], button')].filter(t => /controls|booking|credentials|checklist|cleaners|campaigns|info/i.test(t.textContent)).length,
      }));
      return { passed: info.hasBusinessList || info.tabs >= 2, detail: `business list:${info.hasBusinessList}, progress:${info.hasProgress}, ${info.tabs} admin tabs`, screenshot: await shot(page) };
    });

    for (const tab of ['Controls', 'Booking Flow', 'Credentials', 'Setup Checklist', 'Cleaners', 'Campaigns', 'Info']) {
      await runCheck(results, `Admin Tab: ${tab}`, async () => {
        const clicked = await safeClick(page, `button:has-text("${tab}"), [role="tab"]:has-text("${tab}"), a:has-text("${tab}")`, 1500);
        if (!clicked) return { passed: false, detail: 'Tab not found' };
        const info = await page.evaluate(() => ({
          switches: document.querySelectorAll('input[type="checkbox"], input[role="switch"], [class*="switch"]').length,
          inputs: document.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), textarea, select').length,
        }));
        return { passed: true, detail: `${info.switches} switches, ${info.inputs} inputs` };
      });
    }

    await runCheck(results, 'Admin: Test All Connections Button', async () => {
      await safeClick(page, 'button:has-text("Credentials"), [role="tab"]:has-text("Credentials")', 1500);
      const found = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /test.*all.*connections|test connection/i.test(b.textContent)));
      return { passed: found, detail: found ? 'Test Connections button present' : 'Not found' };
    });

    await runCheck(results, 'Admin: Register Webhooks Button', async () => {
      const found = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /register.*webhook/i.test(b.textContent)));
      return { passed: found, detail: found ? 'Register Webhooks button present' : 'Not found' };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 10: SETTINGS MODAL
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Settings Modal', async () => {
      // Try sidebar Settings button first
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2500);
      const clicked = await safeClick(page, 'button[aria-label*="settings" i], button:has-text("Settings"), a:has-text("Settings")', 2000);
      if (!clicked) return { passed: false, detail: 'No Settings button' };
      const info = await page.evaluate(() => {
        const m = document.querySelector('[role="dialog"], [class*="modal"], [class*="Dialog"]');
        const onSettingsPage = /\/settings/.test(window.location.pathname);
        const tabs = document.querySelectorAll('[role="tab"], [class*="tab"]');
        return { modalOpen: !!m, onSettingsPage, tabCount: tabs.length, inputCount: document.querySelectorAll('input, select, textarea').length };
      });
      const passed = info.modalOpen || info.onSettingsPage;
      return { passed, detail: passed ? `${info.modalOpen ? 'Modal' : 'Page'}, ${info.tabCount} tabs, ${info.inputCount} inputs` : 'Settings did not open', screenshot: await shot(page) };
    });

    for (const tab of ['General', 'Service Editor', 'Services']) {
      await runCheck(results, `Settings Tab: ${tab}`, async () => {
        const clicked = await safeClick(page, `button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`, 1000);
        return { passed: clicked, detail: clicked ? 'Tab clicked' : 'Tab not found' };
      });
    }
    await closeModal(page);

    // ═══════════════════════════════════════════════════════════
    // PHASE 11: EXCEPTIONS / RAIN DAY
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Exceptions Page', async () => {
      await page.goto(`${base}/exceptions`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        tabs: [...document.querySelectorAll('[role="tab"], button')].filter(t => /events|exceptions|demonstration/i.test(t.textContent)).length,
        hasSourceFilter: !!document.querySelector('select, [role="combobox"]'),
        hasSearch: !!document.querySelector('input[type="search"], input[placeholder*="search" i]'),
      }));
      return { passed: info.tabs >= 1 || info.hasSourceFilter, detail: `${info.tabs} tabs, filter:${info.hasSourceFilter}, search:${info.hasSearch}` };
    });

    await runCheck(results, 'Exceptions: Click Through Tabs', async () => {
      let clicked = 0;
      for (const tab of ['System Events', 'Exceptions', 'Demonstration']) {
        if (await safeClick(page, `button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`, 600)) clicked++;
      }
      return { passed: clicked >= 1, detail: `${clicked}/3 tabs clicked` };
    });

    await runCheck(results, 'Rain Day Page', async () => {
      await page.goto(`${base}/rain-day`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        hasDatePicker: !!document.querySelector('input[type="date"], [class*="date"], [class*="calendar"]'),
        hasJobs: /job|reschedule|weather/i.test(document.body.innerText),
      }));
      return { passed: info.hasDatePicker || info.hasJobs, detail: `date:${info.hasDatePicker}, jobs:${info.hasJobs}` };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 12: WINBROS-SPECIFIC (Performance, Payroll, Service Plans)
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Performance Page (WinBros)', async () => {
      await page.goto(`${base}/performance`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        onPage: /performance|revenue|team leads|sales/i.test(document.body.innerText),
        periodButtons: [...document.querySelectorAll('button')].filter(b => /^(day|week|month)$/i.test(b.textContent.trim())).length,
        tables: document.querySelectorAll('table').length,
      }));
      return { passed: info.onPage && (info.periodButtons >= 1 || info.tables >= 1), detail: `onPage:${info.onPage}, ${info.periodButtons} period btns, ${info.tables} tables` };
    });

    await runCheck(results, 'Performance Period Toggles', async () => {
      let clicked = 0;
      for (const period of ['Day', 'Week', 'Month']) {
        if (await safeClick(page, `button:has-text("${period}")`, 400)) clicked++;
      }
      return { passed: clicked >= 1, detail: `${clicked}/3 periods clicked` };
    });

    await runCheck(results, 'Payroll Page (WinBros)', async () => {
      await page.goto(`${base}/payroll`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        onPage: /payroll|pay rate|commission|technician|salesman/i.test(document.body.innerText),
        hasNav: [...document.querySelectorAll('button')].filter(b => /prev|next|week/i.test(b.textContent)).length,
        hasTables: document.querySelectorAll('table').length,
      }));
      return { passed: info.onPage, detail: `onPage:${info.onPage}, ${info.hasNav} nav btns, ${info.hasTables} tables` };
    });

    await runCheck(results, 'Service Plan Hub (WinBros)', async () => {
      await page.goto(`${base}/service-plan-hub`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        onPage: /arr|plan|annual|monthly/i.test(document.body.innerText),
        charts: document.querySelectorAll('canvas, svg[class*="chart"], [class*="recharts"]').length,
        cards: document.querySelectorAll('[class*="card"]').length,
      }));
      return { passed: info.onPage && (info.charts >= 1 || info.cards >= 2), detail: `onPage:${info.onPage}, ${info.charts} charts, ${info.cards} cards` };
    });

    await runCheck(results, 'Service Plan Schedule (WinBros)', async () => {
      await page.goto(`${base}/service-plan-schedule`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3500);
      const info = await page.evaluate(() => ({
        onPage: /schedule|unscheduled|plan|auto/i.test(document.body.innerText),
        hasAutoBtn: [...document.querySelectorAll('button')].some(b => /auto.*schedule|schedule.*auto/i.test(b.textContent)),
        hasUnscheduled: /unscheduled/i.test(document.body.innerText),
        cells: document.querySelectorAll('[class*="cell"], [class*="day"], [class*="droppable"]').length,
      }));
      return { passed: info.onPage && (info.hasAutoBtn || info.hasUnscheduled), detail: `onPage:${info.onPage}, auto btn:${info.hasAutoBtn}, unscheduled:${info.hasUnscheduled}, ${info.cells} cells` };
    });

    // ═══════════════════════════════════════════════════════════
    // PHASE 13: TEAMS / CREW ASSIGNMENT / MY SCHEDULE
    // ═══════════════════════════════════════════════════════════
    await runCheck(results, 'Teams Page', async () => {
      await page.goto(`${base}/teams`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        hasRoster: !!document.querySelector('aside, [class*="list"], [class*="roster"]'),
        hasTabs: document.querySelectorAll('[role="tab"], [class*="tab"]').length,
        hasEdit: [...document.querySelectorAll('button')].some(b => /edit/i.test(b.textContent)),
      }));
      return { passed: info.hasRoster || info.hasTabs > 0, detail: `roster:${info.hasRoster}, ${info.hasTabs} tabs, edit:${info.hasEdit}` };
    });

    await runCheck(results, 'Teams Click Cleaner', async () => {
      const clicked = await page.evaluate(() => {
        const items = [...document.querySelectorAll('[class*="cleaner"], [class*="member"], [class*="list"] > div, li')];
        if (items.length === 0) return false;
        items[0].click();
        return true;
      });
      if (!clicked) return { passed: false, detail: 'No cleaners' };
      await page.waitForTimeout(1500);
      let tabsClicked = 0;
      for (const tab of ['Overview', 'Jobs', 'Messages', 'SMS']) {
        if (await safeClick(page, `button:has-text("${tab}"), [role="tab"]:has-text("${tab}")`, 400)) tabsClicked++;
      }
      return { passed: tabsClicked >= 1, detail: `${tabsClicked}/4 cleaner tabs clickable` };
    });

    await runCheck(results, 'Crew Assignment Page', async () => {
      await page.goto(`${base}/crew-assignment`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        onPage: /crew|assign|week|cleaner/i.test(document.body.innerText),
        draggables: document.querySelectorAll('[draggable="true"], [class*="drag"]').length,
      }));
      return { passed: info.onPage, detail: `onPage:${info.onPage}, ${info.draggables} draggable items` };
    });

    await runCheck(results, 'My Schedule Page', async () => {
      await page.goto(`${base}/my-schedule`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(3000);
      const info = await page.evaluate(() => ({
        onPage: /schedule|time.?off|availability/i.test(document.body.innerText),
        viewToggles: [...document.querySelectorAll('button')].filter(b => /day|week/i.test(b.textContent)).length,
      }));
      return { passed: info.onPage, detail: `onPage:${info.onPage}, ${info.viewToggles} view toggles` };
    });

    await browser.close();

    const passedCount = results.filter(r => r.passed).length;
    return res.status(200).json({
      passed: passedCount >= Math.ceil(results.length * 0.55),
      score: `${passedCount}/${results.length}`,
      results,
      businessName,
    });

  } catch (e) {
    console.error(`[browser-interactive] FAILED:`, e.message, e.stack?.slice(0, 400));
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message, partialResults: results, partialScore: `${results.filter(r => r.passed).length}/${results.length}` });
  }
};
