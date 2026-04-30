/**
 * Seeds a job for a discovered technician so the crew test has something
 * to inspect (job card → status buttons → checklist → payment → tip).
 *
 * Strategy: probe the schema by fetching one existing row from each table
 * (customers / jobs / cleaner_assignments), then template a new row from
 * that, substituting only the fields we care about (test phone, today's
 * date, target technician). Service-role Supabase REST is used directly —
 * the same key the website itself uses — so we bypass portal API contracts
 * we don't have source access to.
 *
 * The seeded customer + job both carry phone_number = TEST_PHONE
 * (+14246771145), so the existing resetTestData() flow on index.html
 * deletes them automatically with no extra cleanup wiring needed.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://kcmbwstjmdrjkhxhkkjt.supabase.co';
// Service-role key required for direct REST inserts. Pull from env so we
// don't leak the JWT into source. Set SUPABASE_SERVICE_KEY in Vercel project
// env (and in your local shell or .env if running local-browser-server).
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '';
const REST = `${SUPABASE_URL}/rest/v1`;
const TEST_PHONE = '+14246771145';

function assertConfigured() {
  if (!SUPABASE_KEY) {
    throw new Error(
      'SUPABASE_SERVICE_KEY env var not set — seedCrewJob needs the service-role key ' +
      'to insert into customers/jobs/cleaner_assignments. ' +
      'Locally: copy the key from local-browser-server.js and `export SUPABASE_SERVICE_KEY=<key>` ' +
      'before `node local-browser-server.js`. ' +
      'On Vercel: add SUPABASE_SERVICE_KEY to the jaspergrenager-langs-projects project env vars.'
    );
  }
}

function baseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };
}

async function supaGet(path) {
  const r = await fetch(`${REST}${path}`, { headers: baseHeaders() });
  if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function supaPost(path, body) {
  const r = await fetch(`${REST}${path}`, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status} ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return null; }
}

// Drop fields that are server-managed (auto-generated PKs, timestamps),
// so they don't conflict on insert. Anything else from the template comes
// along — that gives us the best chance of satisfying NOT NULL constraints
// on columns we don't know about.
function stripServerFields(row) {
  const out = { ...row };
  for (const k of ['id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at']) {
    delete out[k];
  }
  return out;
}

// Find the column on this table that points at users/technicians. The exact
// name varies (user_id / technician_id / cleaner_id / member_id), so we
// just look for whichever is in the example row.
function findUserColumn(exampleRow) {
  if (!exampleRow) return null;
  const keys = Object.keys(exampleRow);
  return keys.find(k => /^(user_id|technician_id|cleaner_id|member_id|assignee_id|assigned_user_id)$/i.test(k))
    || keys.find(k => /user|technician|cleaner|member|assignee/i.test(k))
    || null;
}

function todayDateString() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Replace anything that looks like a scheduled-date field with today, both
// for ISO-date columns (YYYY-MM-DD) and ISO-datetime columns.
function replaceScheduledFields(row) {
  const out = { ...row };
  const today = todayDateString();
  const todayIso = new Date().toISOString();
  for (const k of Object.keys(out)) {
    if (!/scheduled|service[_-]?date|appointment|start_at|start_time|date$/i.test(k)) continue;
    const v = out[k];
    if (typeof v !== 'string') continue;
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) out[k] = todayIso;          // ISO datetime
    else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) out[k] = today;        // ISO date
  }
  return out;
}

/**
 * Try to find a technician's user_id by phone, by probing tables that
 * commonly link phone → user. We don't know the exact schema (no portal
 * source access) so we walk a few candidates and return the first match.
 * Returns the user_id string or null.
 */
async function lookupTechUserIdByPhone(phone) {
  if (!phone) return null;
  // Strip non-digits for comparison; try multiple stored formats.
  const digits = phone.replace(/[^0-9]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.slice(-10);
  const variants = [
    phone,
    `+1${ten}`,
    `+${ten}`,
    ten,
    `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`,
  ];

  const candidates = [
    { table: 'team_members', phoneCol: 'phone', idCol: 'user_id' },
    { table: 'team_members', phoneCol: 'phone_number', idCol: 'user_id' },
    { table: 'cleaners', phoneCol: 'phone', idCol: 'user_id' },
    { table: 'cleaners', phoneCol: 'phone', idCol: 'id' },
    { table: 'technicians', phoneCol: 'phone', idCol: 'user_id' },
    { table: 'technicians', phoneCol: 'phone', idCol: 'id' },
    { table: 'profiles', phoneCol: 'phone', idCol: 'user_id' },
    { table: 'profiles', phoneCol: 'phone_number', idCol: 'user_id' },
    { table: 'users', phoneCol: 'phone', idCol: 'id' },
    { table: 'users', phoneCol: 'phone_number', idCol: 'id' },
  ];

  for (const { table, phoneCol, idCol } of candidates) {
    for (const v of variants) {
      try {
        const rows = await supaGet(`/${table}?${phoneCol}=eq.${encodeURIComponent(v)}&select=${idCol}&limit=1`);
        if (rows?.[0]?.[idCol]) {
          console.log(`[seedCrewJob] lookup hit: ${table}.${idCol}=${rows[0][idCol]} via ${phoneCol}=${v}`);
          return rows[0][idCol];
        }
      } catch {
        // Table or column may not exist — keep walking.
      }
    }
  }
  return null;
}

/**
 * Seed a customer + job + cleaner_assignment for the given technician,
 * scheduled for today. Returns { customerId, jobId, assignmentId }.
 *
 * If `technicianUserId` is missing but `technicianPhone` is provided, will
 * attempt a Supabase-side lookup as fallback before throwing.
 */
async function seedCrewJob({ technicianUserId, technicianBusinessId, technicianPhone }) {
  assertConfigured();
  if (!technicianUserId && technicianPhone) {
    technicianUserId = await lookupTechUserIdByPhone(technicianPhone);
  }
  if (!technicianUserId) {
    throw new Error(
      `seedCrewJob: technicianUserId not provided and lookup by phone "${technicianPhone || ''}" found nothing. ` +
      `The /api/teams response probably doesn't expose user_id under a known field name; check the discover log.`
    );
  }

  // 1. Reuse existing test customer if present, else clone a real one.
  const existingCustomers = await supaGet(`/customers?phone_number=eq.${encodeURIComponent(TEST_PHONE)}&select=*&limit=1`);
  let customer = existingCustomers?.[0];
  if (!customer) {
    // Pick a customer template from the same business if possible; otherwise
    // any customer works as long as we can satisfy NOT NULL constraints.
    let template;
    if (technicianBusinessId) {
      const sameBiz = await supaGet(`/customers?business_id=eq.${technicianBusinessId}&select=*&limit=1`);
      template = sameBiz?.[0];
    }
    if (!template) {
      const any = await supaGet(`/customers?select=*&limit=1`);
      template = any?.[0];
    }
    if (!template) throw new Error('No example customer in DB to template from');

    const newCustomer = stripServerFields(template);
    newCustomer.phone_number = TEST_PHONE;
    if ('name' in newCustomer) newCustomer.name = 'Crew Test Customer';
    if ('first_name' in newCustomer) newCustomer.first_name = 'Crew';
    if ('last_name' in newCustomer) newCustomer.last_name = 'Test';
    if ('email' in newCustomer) newCustomer.email = 'crew-test@example.com';
    if (technicianBusinessId && 'business_id' in newCustomer) newCustomer.business_id = technicianBusinessId;

    const inserted = await supaPost(`/customers`, newCustomer);
    customer = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!customer?.id) throw new Error('Failed to create test customer');
    console.log(`[seedCrewJob] created customer ${customer.id} (phone=${TEST_PHONE})`);
  } else {
    console.log(`[seedCrewJob] reusing existing test customer ${customer.id}`);
  }

  // 2. Reuse today's job for this customer if present, else clone a real one.
  const existingJobs = await supaGet(
    `/jobs?customer_id=eq.${customer.id}&phone_number=eq.${encodeURIComponent(TEST_PHONE)}&select=*&limit=1`
  );
  let job = existingJobs?.[0];
  if (!job) {
    // Job template from the same business if available
    let template;
    if (technicianBusinessId) {
      const sameBiz = await supaGet(`/jobs?business_id=eq.${technicianBusinessId}&select=*&order=created_at.desc.nullslast&limit=1`);
      template = sameBiz?.[0];
    }
    if (!template) {
      const any = await supaGet(`/jobs?select=*&order=created_at.desc.nullslast&limit=1`);
      template = any?.[0];
    }
    if (!template) throw new Error('No example job in DB to template from');

    let newJob = stripServerFields(template);
    newJob.customer_id = customer.id;
    newJob.phone_number = TEST_PHONE;
    if (technicianBusinessId && 'business_id' in newJob) newJob.business_id = technicianBusinessId;
    // Ensure status is something the crew portal will render as a clickable
    // job card (not "completed"/"cancelled").
    if ('status' in newJob) newJob.status = 'scheduled';
    newJob = replaceScheduledFields(newJob);

    const inserted = await supaPost(`/jobs`, newJob);
    job = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!job?.id) throw new Error('Failed to create test job');
    console.log(`[seedCrewJob] created job ${job.id} for ${todayDateString()}`);
  } else {
    console.log(`[seedCrewJob] reusing existing test job ${job.id}`);
  }

  // 3. Probe cleaner_assignments schema, then insert / reuse.
  const exampleAssignment = (await supaGet(`/cleaner_assignments?select=*&limit=1`).catch(() => []))?.[0];
  const userColumn = findUserColumn(exampleAssignment) || 'user_id';

  // Reuse if assignment already exists for this job + tech
  const filter = `${userColumn}=eq.${technicianUserId}&job_id=eq.${job.id}`;
  const existingAssignments = await supaGet(`/cleaner_assignments?${filter}&select=*&limit=1`).catch(() => []);
  let assignment = existingAssignments?.[0];
  if (!assignment) {
    let newAssignment;
    if (exampleAssignment) {
      newAssignment = stripServerFields(exampleAssignment);
    } else {
      newAssignment = {};
    }
    newAssignment.job_id = job.id;
    newAssignment[userColumn] = technicianUserId;
    if (technicianBusinessId && 'business_id' in newAssignment) newAssignment.business_id = technicianBusinessId;
    if ('status' in newAssignment) newAssignment.status = 'assigned';

    const inserted = await supaPost(`/cleaner_assignments`, newAssignment);
    assignment = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!assignment?.id) throw new Error('Failed to create cleaner assignment');
    console.log(`[seedCrewJob] created assignment ${assignment.id} (${userColumn}=${technicianUserId})`);
  } else {
    console.log(`[seedCrewJob] reusing existing assignment ${assignment.id}`);
  }

  return { customerId: customer.id, jobId: job.id, assignmentId: assignment.id };
}

module.exports = { seedCrewJob, TEST_PHONE };
