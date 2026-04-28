const { createSession, osirisLogin, getLoginDiagnostics } = require('./browser-helpers');

const PORTAL_URL = 'https://cleanmachine.live';

/**
 * Tests the Crew Portal.
 * Logs into cleanmachine.live via the Employee/Technician role button
 * (NOT Owner/Operator — owner login lands on the admin dashboard, not crew).
 * If a previous test left an owner session active, this also drives the
 * logout flow (business-slug button in bottom-left → Log out) before
 * re-logging-in as technician.
 */
module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-crew][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { crewPortalUrl, credentials, businessName } = req.body;
  // crewPortalUrl is kept for back-compat but the test now drives the same
  // role-selection login as admin, just clicking the technician button.
  const baseUrl = (crewPortalUrl && /^https?:\/\/[^/]+$/.test(crewPortalUrl.replace(/\/+$/, '')))
    ? crewPortalUrl.replace(/\/+$/, '')
    : PORTAL_URL;

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  try {
    const sess = await createSession(apiKey, process.env.BROWSERBASE_PROJECT_ID);
    browser = sess.browser;
    const page = sess.page;
    console.log(`[browser-crew][${requestId}] Session: ${sess.sessionId}`);

    const results = [];

    // Step 1: Login as technician via cleanmachine.live role-selection screen.
    // osirisLogin handles the active-session case by clicking the bottom-left
    // business slug → Log out before picking the technician role button.
    console.log(`[browser-crew][${requestId}] Logging in as technician at ${baseUrl}...`);
    const loggedIn = await osirisLogin(page, baseUrl, credentials, 'technician');
    if (!loggedIn) {
      const diag = getLoginDiagnostics(page) || {};
      const clickablesPreview = (diag.visibleClickables || []).slice(0, 12).join(' | ') || 'none';
      const inputsPreview = (diag.inputs || [])
        .map(i => `${i.tag}[type=${i.type || '?'}, name=${i.name || '?'}, ph="${(i.placeholder || '').slice(0, 30)}", ac=${i.autocomplete || '?'}]`)
        .join(' | ') || 'none';
      const detail = `Login failed @ ${diag.phase || 'unknown'}: ${diag.reason || 'no diagnostic'}. ` +
        `URL: ${diag.url || baseUrl}. Visible buttons: [${clickablesPreview}]. Inputs: [${inputsPreview}]`;
      const failShot = diag.screenshot
        || await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 }).then(b => b.toString('base64')).catch(() => null);
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      return res.status(200).json({
        passed: false,
        score: '0/1',
        results: [{
          section: 'crew_login',
          label: 'Crew Login (Technician)',
          passed: false,
          detail,
          screenshot: failShot,
        }],
        businessName,
      });
    }
    await page.waitForTimeout(3000);

    const mainScreenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });

    // Check if portal loaded (not expired/invalid token)
    const portalInfo = await page.evaluate(() => {
      const body = document.body.innerText || '';
      const trimmed = body.trim();
      // Only flag errors if the whole page is mostly just an error message
      const isError = trimmed.length < 400 && /^\s*(expired|invalid|not found|404|500|error|oops|unauthorized|forbidden)/i.test(trimmed);
      const hasSchedule = /schedule|today|job|week|day/i.test(body);
      const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
      const jobCards = document.querySelectorAll('[class*="job"], [class*="card"], [class*="appointment"]');

      // Look for crew portal specific elements
      const hasViewToggle = buttons.some(b => /day|week/i.test(b.textContent));
      const hasAvailability = buttons.some(b => /availability|time off/i.test(b.textContent));
      const hasLogout = buttons.some(b => /logout|sign out/i.test(b.textContent));
      const hasNavigation = buttons.some(b => /prev|next|today|go today/i.test(b.textContent));

      return {
        isError, hasSchedule, hasViewToggle, hasAvailability, hasLogout, hasNavigation,
        buttonCount: buttons.length,
        jobCardCount: jobCards.length,
        textPreview: body.slice(0, 500),
      };
    }).catch(() => ({ isError: true }));

    results.push({
      section: 'crew_main',
      label: 'Crew Portal Main',
      passed: !portalInfo.isError && (portalInfo.hasSchedule || portalInfo.buttonCount > 2),
      detail: portalInfo.isError ? 'Portal error/expired' : `${portalInfo.buttonCount} buttons, ${portalInfo.jobCardCount} job cards`,
      screenshot: mainScreenshot.toString('base64'),
    });

    if (!portalInfo.isError) {
      // Step 2: Check for Day/Week view toggle
      results.push({
        section: 'view_toggle',
        label: 'Day/Week View Toggle',
        passed: portalInfo.hasViewToggle,
        detail: portalInfo.hasViewToggle ? 'View toggle found' : 'No view toggle found',
        screenshot: null,
      });

      // Step 3: Check navigation (prev/next/today)
      results.push({
        section: 'navigation',
        label: 'Date Navigation',
        passed: portalInfo.hasNavigation,
        detail: portalInfo.hasNavigation ? 'Navigation buttons found' : 'No navigation found',
        screenshot: null,
      });

      // Step 4: Check availability button
      results.push({
        section: 'availability',
        label: 'Availability Button',
        passed: portalInfo.hasAvailability,
        detail: portalInfo.hasAvailability ? 'Availability button found' : 'No availability button',
        screenshot: null,
      });

      // Step 5: Check logout
      results.push({
        section: 'logout',
        label: 'Logout Button',
        passed: portalInfo.hasLogout,
        detail: portalInfo.hasLogout ? 'Logout button found' : 'No logout button',
        screenshot: null,
      });

      // Step 6: Try clicking a job card if any exist
      if (portalInfo.jobCardCount > 0) {
        try {
          const jobCard = await page.$('[class*="job"], [class*="card"], [class*="appointment"]');
          if (jobCard) {
            await jobCard.click();
            await page.waitForTimeout(2000);

            const jobDetailScreenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });

            const jobDetail = await page.evaluate(() => {
              const body = document.body.innerText || '';
              const hasStatus = /on my way|arrived|complete|accept|decline/i.test(body);
              const hasChecklist = /checklist|item|task/i.test(body);
              const hasMessage = document.querySelector('input[placeholder*="message" i], textarea');
              return { hasStatus, hasChecklist, hasMessage: !!hasMessage };
            });

            results.push({
              section: 'job_detail',
              label: 'Job Detail View',
              passed: jobDetail.hasStatus || jobDetail.hasChecklist,
              detail: `Status buttons: ${jobDetail.hasStatus}, Checklist: ${jobDetail.hasChecklist}, Message input: ${jobDetail.hasMessage}`,
              screenshot: jobDetailScreenshot.toString('base64'),
            });
          }
        } catch (e) {
          results.push({
            section: 'job_detail',
            label: 'Job Detail View',
            passed: false,
            detail: `Failed to open job: ${e.message.slice(0, 80)}`,
            screenshot: null,
          });
        }
      }

      // Step 7: Test availability drawer (if button exists)
      if (portalInfo.hasAvailability) {
        try {
          const availBtn = await page.$('button:has-text("Availability"), button:has-text("Time Off")');
          if (availBtn) {
            await availBtn.click();
            await page.waitForTimeout(2000);

            const availScreenshot = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
            const availInfo = await page.evaluate(() => {
              const body = document.body.innerText || '';
              const hasCalendar = /calendar|date|month|week/i.test(body);
              const hasTimePicker = document.querySelectorAll('input[type="time"], [class*="time"]').length > 0;
              return { hasCalendar, hasTimePicker };
            });

            results.push({
              section: 'availability_drawer',
              label: 'Availability Drawer',
              passed: availInfo.hasCalendar || availInfo.hasTimePicker,
              detail: `Calendar: ${availInfo.hasCalendar}, Time picker: ${availInfo.hasTimePicker}`,
              screenshot: availScreenshot.toString('base64'),
            });
          }
        } catch (e) {
          results.push({
            section: 'availability_drawer',
            label: 'Availability Drawer',
            passed: false,
            detail: `Failed: ${e.message.slice(0, 80)}`,
            screenshot: null,
          });
        }
      }
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
    console.error(`[browser-crew][${requestId}] FAILED:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ error: e.message });
  }
};
