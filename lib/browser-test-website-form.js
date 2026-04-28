const { createSession } = require('./browser-helpers');

/**
 * Drives the public booking wizard on a customer-facing website to submit a
 * real lead — the same path a real customer takes. Replaces the old
 * /api/proxy-form path which JSON-POSTed straight to the webhook and bypassed
 * structured wizard fields (bedrooms / bathrooms / sqft / frequency), causing
 * the bot to fall into its catch-all "what's the address + bed/bath" reply.
 *
 * Wizard pattern (Spotless Scrubbers style):
 *   1. Choose service type           — <select> or button tile
 *   2. Choose bedrooms / bathrooms   — house_cleaning only (button rows)
 *      or square footage             — window_cleaning only (input)
 *   3. Choose frequency              — One-time / Weekly / Bi-weekly / Monthly
 *   4. Click "Get My Quote"          — reveals the contact form + price
 *   5. Fill name / phone / email     — and address if the form has one
 *   6. Click submit                  — "Book My Cleaning" / "Get Your Free Quote"
 *
 * Field discovery is semantic (label / placeholder / nearby text), not
 * selector-based, so this same handler should work on different businesses'
 * sites with similar wizard shapes.
 */

const TEST_DATA = {
  name: 'Alex Thompson',
  phone: '4246771145',
  email: 'alex.thompson.test@gmail.com',
  address: '742 Evergreen Terrace, Naperville, IL 60540',
  bedrooms: 3,
  bathrooms: 2,
  sqft: 2500,
  frequency: 'One-time',
};

const SERVICE_HINTS = {
  house_cleaning: { tile: 'Standard', selectValue: 'standard', text: 'standard' },
  window_cleaning: { tile: 'Exterior', selectValue: 'exterior', text: 'window' },
};

module.exports = async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 10);
  const tag = `[browser-website-form][${requestId}]`;
  console.log(`${tag} Incoming ${req.method}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { websiteUrl, bizType = 'house_cleaning', businessName } = req.body;
  if (!websiteUrl) return res.status(400).json({ error: 'Missing websiteUrl' });

  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey && process.env.USE_LOCAL_PLAYWRIGHT !== '1') {
    return res.status(200).json({ error: 'BROWSERBASE_API_KEY not configured', steps: [] });
  }

  let browser;
  const steps = [];
  const log = (label, ok, detail = '') => {
    steps.push({ label, ok: !!ok, detail });
    console.log(`${tag} ${ok ? 'OK' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  try {
    const sess = await createSession(apiKey, process.env.BROWSERBASE_PROJECT_ID);
    browser = sess.browser;
    const page = sess.page;

    // Capture the actual webhook POST so we can report what was sent.
    let webhookCall = null;
    page.on('request', r => {
      const u = r.url();
      if (r.method() === 'POST' && /\/api\/(webhooks?|leads?|book|submit|inquir|forms?)|webhook/i.test(u)) {
        if (!webhookCall) webhookCall = { url: u, body: r.postData() };
      }
    });

    const base = websiteUrl.replace(/\/+$/, '');
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    log('home loaded', true, base);

    const svc = SERVICE_HINTS[bizType] || SERVICE_HINTS.house_cleaning;

    // ── Step: service type ──
    const svcChosen = await page.evaluate(({ tile, selectValue, text }) => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const selects = [...document.querySelectorAll('select')].filter(visible);
      for (const s of selects) {
        const opt = [...s.options].find(o =>
          o.value.toLowerCase() === selectValue ||
          o.text.toLowerCase().includes(text)
        );
        if (opt) {
          s.value = opt.value;
          s.dispatchEvent(new Event('change', { bubbles: true }));
          return { via: 'select', label: opt.text };
        }
      }
      const btns = [...document.querySelectorAll('button')].filter(b => visible(b) && !b.disabled);
      const m = btns.find(b => {
        const t = (b.innerText || '').trim().toLowerCase();
        return t.length < 30 && (t === tile.toLowerCase() || t.includes(text));
      });
      if (m) { m.click(); return { via: 'tile', label: m.innerText.trim() }; }
      return null;
    }, svc);
    log('service type', !!svcChosen, svcChosen ? `${svcChosen.via}: ${svcChosen.label}` : 'not found');
    await page.waitForTimeout(400);

    // ── Step: bed/bath (house_cleaning) or sqft (window_cleaning) ──
    if (bizType === 'house_cleaning') {
      const bb = await page.evaluate(({ bed, bath }) => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const numBtns = [...document.querySelectorAll('button')].filter(b =>
          visible(b) && !b.disabled && /^[0-9]+\+?$/.test(b.innerText.trim())
        );
        if (!numBtns.length) return { bedClicked: null, bathClicked: null, rows: [] };
        // Group by visual row (Y coord).
        numBtns.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return Math.abs(ra.top - rb.top) > 5 ? ra.top - rb.top : ra.left - rb.left;
        });
        const rows = [];
        let curY = null;
        for (const b of numBtns) {
          const y = b.getBoundingClientRect().top;
          if (curY === null || Math.abs(y - curY) > 10) { rows.push([b]); curY = y; }
          else rows[rows.length - 1].push(b);
        }
        const pick = (row, n) => {
          if (!row?.length) return null;
          let m = row.find(b => parseInt(b.innerText, 10) === n);
          if (!m) m = row[Math.min(row.length - 1, n - 1)];
          if (m) { m.click(); return parseInt(m.innerText, 10); }
          return null;
        };
        return {
          bedClicked: pick(rows[0], bed),
          bathClicked: pick(rows[1], bath),
          rows: rows.map(r => r.length),
        };
      }, { bed: TEST_DATA.bedrooms, bath: TEST_DATA.bathrooms });
      log('bedrooms', bb.bedClicked != null, bb.bedClicked != null ? `clicked ${bb.bedClicked} (rows: ${bb.rows.join(',')})` : 'no bedroom row found');
      log('bathrooms', bb.bathClicked != null, bb.bathClicked != null ? `clicked ${bb.bathClicked}` : 'no bathroom row found');
      await page.waitForTimeout(400);
    } else {
      const sqftFilled = await page.evaluate((sqft) => {
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, String(v));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')].filter(i => visible(i) && i.type !== 'hidden');
        const m = inputs.find(i => {
          const lbl = i.id ? (document.querySelector(`label[for="${i.id}"]`)?.innerText || '') : '';
          const hint = (i.id + ' ' + i.name + ' ' + i.placeholder + ' ' + lbl).toLowerCase();
          return /sq.?ft|square|footage/.test(hint);
        });
        if (m) { setVal(m, sqft); return m.id || m.name || 'unnamed'; }
        return null;
      }, TEST_DATA.sqft);
      log('square footage', !!sqftFilled, sqftFilled || 'no sqft input found');
      await page.waitForTimeout(400);
    }

    // ── Step: frequency ──
    const freqClicked = await page.evaluate((freq) => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const want = freq.toLowerCase();
      const btns = [...document.querySelectorAll('button')].filter(b => visible(b) && !b.disabled);
      const m = btns.find(b => {
        const t = (b.innerText || '').trim().toLowerCase().split('\n')[0];
        return t === want || t.includes(want);
      });
      if (m) { m.click(); return m.innerText.trim().split('\n')[0]; }
      return null;
    }, TEST_DATA.frequency);
    log('frequency', !!freqClicked, freqClicked || 'not found');
    await page.waitForTimeout(400);

    // ── Step: advance to contact form ("Get My Quote", "Continue", etc.) ──
    const advanced = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const want = ['get my quote', 'see my price', 'see price', 'get quote', 'next', 'continue'];
      const btns = [...document.querySelectorAll('button')].filter(b =>
        visible(b) && !b.disabled && b.type !== 'submit'
      );
      for (const w of want) {
        const m = btns.find(b => (b.innerText || '').trim().toLowerCase() === w);
        if (m) { m.scrollIntoView({ block: 'center' }); m.click(); return m.innerText.trim(); }
      }
      return null;
    });
    log('advance to contact form', !!advanced, advanced || 'no advance button (single-step form)');
    if (advanced) await page.waitForTimeout(1000);

    // ── Step: fill name / phone / email / address ──
    const filled = await page.evaluate((data) => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const setVal = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const labelFor = (i) => (i.id && document.querySelector(`label[for="${i.id}"]`)?.innerText) || '';
      const hint = (i) => (i.id + ' ' + i.name + ' ' + i.placeholder + ' ' + labelFor(i)).toLowerCase();
      const inputs = [...document.querySelectorAll('input')].filter(i => visible(i) && i.type !== 'hidden');
      const out = {};
      const matchOne = (regex, value, key) => {
        const m = inputs.find(i => regex.test(hint(i)) && !i.value);
        if (m) { setVal(m, value); out[key] = m.id || m.name || '?'; }
      };
      matchOne(/\bname\b/, data.name, 'name');
      matchOne(/phone|tel/, data.phone, 'phone');
      matchOne(/email|e-mail/, data.email, 'email');
      matchOne(/address|street/, data.address, 'address');
      return out;
    }, TEST_DATA);
    const detail = Object.entries(filled).map(([k, v]) => `${k}→${v}`).join(', ') || 'NONE';
    log('contact fields', !!filled.name && !!filled.phone, `filled: ${detail}`);
    await page.waitForTimeout(500);

    let preSubmitShot = null;
    try {
      const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
      preSubmitShot = ss.toString('base64');
    } catch {}

    // ── Step: submit ──
    const submitAt = new Date().toISOString();
    const submitted = await page.evaluate(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const want = ['book my cleaning', 'book now', 'get your free quote', 'submit', 'send', 'book'];
      const btns = [...document.querySelectorAll('button')].filter(b => visible(b) && !b.disabled);
      for (const w of want) {
        const m = btns.find(b => b.type === 'submit' && (b.innerText || '').trim().toLowerCase() === w);
        if (m) { m.scrollIntoView({ block: 'center' }); m.click(); return m.innerText.trim(); }
      }
      const anySubmit = btns.find(b => b.type === 'submit');
      if (anySubmit) { anySubmit.scrollIntoView({ block: 'center' }); anySubmit.click(); return anySubmit.innerText.trim(); }
      return null;
    });
    log('submit clicked', !!submitted, submitted || 'no submit button found');

    if (!submitted) {
      await browser.close().catch(() => {});
      return res.status(200).json({
        passed: false, steps, webhookCall: null,
        preSubmitShot, postSubmitShot: null, submitAt,
        error: 'Could not find submit button',
        businessName,
      });
    }

    // Wait for the network call to land.
    const deadline = Date.now() + 12000;
    while (!webhookCall && Date.now() < deadline) {
      await page.waitForTimeout(250);
    }

    let postSubmitShot = null;
    try {
      const ss = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 50 });
      postSubmitShot = ss.toString('base64');
    } catch {}
    log('webhook posted', !!webhookCall, webhookCall ? webhookCall.url : 'no POST seen within 12s');

    await browser.close().catch(() => {});

    return res.status(200).json({
      passed: !!webhookCall,
      steps,
      webhookCall,
      preSubmitShot,
      postSubmitShot,
      submitAt,
      businessName,
    });
  } catch (e) {
    console.error(`${tag} FAILED:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return res.status(200).json({ passed: false, error: e.message, steps });
  }
};
