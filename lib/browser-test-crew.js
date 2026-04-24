const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk').default;

/**
 * Tests the Crew Portal (token-authenticated).
 * Checks: schedule view, job cards, availability, job detail, messaging.
 */
module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  console.log(`[browser-crew][${requestId}] Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { crewPortalUrl, businessName } = req.body;
  if (!crewPortalUrl) return res.status(400).json({ error: 'Missing crewPortalUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured' });

  let browser;
  try {
    const bb = new Browserbase({ apiKey });
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });
    console.log(`[browser-crew][${requestId}] Session: ${session.id}`);

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    const results = [];

    // Step 1: Navigate to crew portal
    console.log(`[browser-crew][${requestId}] Loading crew portal: ${crewPortalUrl}`);
    await page.goto(crewPortalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

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
