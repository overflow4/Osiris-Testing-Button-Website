const { createSession, shot, safeClick, closeModal, runCheck } = require('./browser-helpers');

/**
 * Crew portal job execution flow test.
 * Exercises the full crew-facing workflow: schedule → job detail → status progression
 * → checklist → payment method → charge/tip buttons.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { crewPortalUrl, businessName } = req.body;
  if (!crewPortalUrl) return res.status(400).json({ error: 'Missing crewPortalUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  const results = [];

  try {
    const sess = await createSession(apiKey, process.env.BROWSERBASE_PROJECT_ID);
    browser = sess.browser;
    const page = sess.page;

    // ── 1. Load portal ──
    await runCheck(results, 'Crew Portal Load', async () => {
      await page.goto(crewPortalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      const info = await page.evaluate(() => {
        const body = document.body.innerText || '';
        const trimmed = body.trim();
        const isError = trimmed.length < 400 && /^\s*(expired|invalid|not found|404|500|unauthorized)/i.test(trimmed);
        return {
          isError,
          buttons: document.querySelectorAll('button').length,
          hasSchedule: /schedule|today|job|week|day/i.test(body),
        };
      });
      return { passed: !info.isError && (info.buttons > 2 || info.hasSchedule), detail: info.isError ? 'Token expired or invalid' : `${info.buttons} buttons, schedule:${info.hasSchedule}`, screenshot: await shot(page) };
    });

    // ── 2. Day/Week view toggle ──
    for (const view of ['Day', 'Week']) {
      await runCheck(results, `Crew ${view} View`, async () => {
        const ok = await safeClick(page, `button:has-text("${view}")`, 800);
        return { passed: ok, detail: ok ? `${view} view clicked` : `No ${view} button` };
      });
    }

    // ── 3. Date navigation ──
    await runCheck(results, 'Crew Date Nav', async () => {
      const prev = await safeClick(page, 'button:has-text("Prev"), button[aria-label*="prev" i]', 500);
      const next = await safeClick(page, 'button:has-text("Next"), button[aria-label*="next" i]', 500);
      const today = await safeClick(page, 'button:has-text("Today"), button:has-text("Go Today")', 500);
      return { passed: prev || next || today, detail: `prev:${prev}, next:${next}, today:${today}` };
    });

    // ── 4. Availability drawer ──
    await runCheck(results, 'Availability Drawer', async () => {
      const ok = await safeClick(page, 'button:has-text("Availability"), button:has-text("Time Off")', 1500);
      if (!ok) return { passed: false, detail: 'No Availability button' };
      const info = await page.evaluate(() => ({
        hasCalendar: !!document.querySelector('[class*="calendar"], [class*="date"]'),
        hasTimePicker: document.querySelectorAll('input[type="time"]').length > 0,
        hasWeeklyToggle: [...document.querySelectorAll('button')].some(b => /weekly|calendar mode/i.test(b.textContent)),
      }));
      await closeModal(page);
      return { passed: info.hasCalendar || info.hasTimePicker, detail: `cal:${info.hasCalendar}, time:${info.hasTimePicker}, weekly:${info.hasWeeklyToggle}`, screenshot: await shot(page) };
    });

    // ── 5. Click a job card ──
    await runCheck(results, 'Click Job Card', async () => {
      const clicked = await page.evaluate(() => {
        const card = document.querySelector('[class*="job"], [class*="card"], [class*="appointment"]:not([class*="nav"])');
        if (!card) return false;
        card.click();
        return true;
      });
      if (!clicked) return { passed: false, detail: 'No job cards to click' };
      await page.waitForTimeout(2000);
      return { passed: true, detail: 'Job card clicked', screenshot: await shot(page) };
    });

    // ── 6. Job detail buttons ──
    await runCheck(results, 'Job Status Buttons (ON MY WAY / ARRIVED / COMPLETE)', async () => {
      const found = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')].map(b => b.textContent?.trim());
        return {
          onMyWay: buttons.some(t => /on my way/i.test(t || '')),
          arrived: buttons.some(t => /arrived/i.test(t || '')),
          complete: buttons.some(t => /complete/i.test(t || '')),
          cantMakeIt: buttons.some(t => /can.?t make it/i.test(t || '')),
          accept: buttons.some(t => /^accept$/i.test(t || '')),
          decline: buttons.some(t => /^decline$/i.test(t || '')),
        };
      });
      const count = Object.values(found).filter(Boolean).length;
      return { passed: count >= 2, detail: Object.entries(found).filter(([, v]) => v).map(([k]) => k).join(', ') || 'None found' };
    });

    // ── 7. Checklist items ──
    await runCheck(results, 'Checklist Items', async () => {
      const info = await page.evaluate(() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        const hasChecklistText = /checklist|task|item/i.test(document.body.innerText);
        return { checkboxCount: checkboxes.length, hasChecklistText };
      });
      return { passed: info.checkboxCount > 0 || info.hasChecklistText, detail: `${info.checkboxCount} checkboxes, checklist text:${info.hasChecklistText}` };
    });

    // ── 8. Payment method selector ──
    await runCheck(results, 'Payment Method Selector', async () => {
      const found = await page.evaluate(() => {
        const body = document.body.innerText;
        const methods = ['Card', 'Cash', 'Check', 'Venmo'].filter(m => new RegExp(`\\b${m}\\b`, 'i').test(body));
        return { methodsFound: methods.length, methods };
      });
      return { passed: found.methodsFound >= 2, detail: `${found.methodsFound}/4 methods: ${found.methods.join(', ')}` };
    });

    // ── 9. Charge Customer button ──
    await runCheck(results, 'CHARGE CUSTOMER Button', async () => {
      const found = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /charge.*customer|charge.*card/i.test(b.textContent)));
      return { passed: found, detail: found ? 'Charge Customer button present' : 'Not found' };
    });

    // ── 10. Send Tip Link button ──
    await runCheck(results, 'SEND TIP LINK Button', async () => {
      const found = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /send.*tip|tip.*link/i.test(b.textContent)));
      return { passed: found, detail: found ? 'Send Tip Link button present' : 'Not found' };
    });

    // ── 11. Message input ──
    await runCheck(results, 'Customer Message Input', async () => {
      const found = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input, textarea')];
        const msgInput = inputs.find(i => /message|send|text/i.test(i.placeholder || '') || /message|sms|chat/i.test(i.name || ''));
        const sendBtn = [...document.querySelectorAll('button')].some(b => /^send$|send.*message/i.test(b.textContent));
        return { hasInput: !!msgInput, hasSendBtn: sendBtn };
      });
      return { passed: found.hasInput && found.hasSendBtn, detail: `input:${found.hasInput}, send:${found.hasSendBtn}` };
    });

    // ── 12. Logout button ──
    await runCheck(results, 'Logout Button', async () => {
      const found = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /logout|sign out/i.test(b.textContent)));
      return { passed: found, detail: found ? 'Logout present' : 'Not found' };
    });

    await browser.close();

    const passedCount = results.filter(r => r.passed).length;
    return res.status(200).json({
      passed: passedCount >= Math.ceil(results.length * 0.5),
      score: `${passedCount}/${results.length}`,
      results,
      businessName,
    });

  } catch (e) {
    console.error(`[browser-crew-flow] FAILED:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message, partialResults: results });
  }
};
