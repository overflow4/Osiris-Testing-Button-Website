# Osiris Testing Button Website (Jack's Tester)

## Deployment

**IMPORTANT: This repo auto-deploys via GitHub integration to the `jaspergrenager-langs-projects` Vercel team.**

- **Production URL:** `osiris-testing-button-website.vercel.app`
- **Vercel Team:** `jaspergrenager-langs-projects` (overflow4's GitHub account)
- **Deploy method:** Push to `main` branch → GitHub auto-deploys to Vercel

### DO NOT use `vercel --prod` or `vercel deploy` from the CLI

The CLI is logged into `mrspotlessonemils-projects`, which is a **different Vercel account**. Running `vercel --prod` creates duplicate deployments on the wrong account. Just push to `main` and let the GitHub integration handle deployment.

### Environment Variables

Env vars must be set on the **`jaspergrenager-langs-projects`** Vercel dashboard (not via CLI):
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER` (+14246771145)
- `ANTHROPIC_API_KEY`
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`
- `BROWSERBASE_API_KEY` (for browser-based invoice and portal testing)
- `BROWSERBASE_PROJECT_ID` (Browserbase project ID)
- `SUPABASE_SERVICE_KEY` (service-role JWT used by the crew-job seeder to insert customer/job/cleaner_assignment rows so the Crew App test has a job to click into)

### Local setup for the crew-job seeder

The seeder reads `SUPABASE_SERVICE_KEY` from `process.env`. Before running the local browser server, export the key in the same shell:

```
export SUPABASE_SERVICE_KEY=<service-role JWT — same value as SUPABASE_KEY in local-browser-server.js>
node local-browser-server.js
```

If unset, the Crew App test will still log in successfully but the seed step will report a clear "SUPABASE_SERVICE_KEY env var not set" detail and the 7 job-detail checks will skip with no card to click.

If env vars need updating, tell the user to update them in the Vercel dashboard under the `jaspergrenager-langs-projects` team.

## Workflow

1. Make code changes
2. `git add`, `git commit`, `git push origin main`
3. Vercel auto-deploys from GitHub — no manual deploy needed
4. Test at `osiris-testing-button-website.vercel.app`

## Test Phone Number

All tests use **Twilio number `+14246771145`** for SMS and voice (via VAPI import). This number is NOT in any Quo CRM contact, so webhooks fire correctly.

## Test Data Cleanup (resetTestData)

After every test, the following Supabase tables are cleaned for the test phone:
- **By phone_number:** `messages`, `calls`, `call_tasks`, `system_events`, `followup_queue`
- **By customer_id:** `conversation_outcomes`, `conversation_state`, `customer_message_log`, `sms_outreach_queue`, `customer_memory`, `customer_scores`, `customer_state_transitions`, `customer_tags`, `customer_memberships`, `scheduled_tasks` (via payload->>customerId)
- **By quote_id:** `quote_line_items`, `quote_service_plans`, `quote_cleaner_preconfirms`
- **By job_id:** `cleaner_assignments`, `visits`, `visit_line_items`, `visit_checklists`, `job_checklist_items`, `service_plan_jobs`
- **Direct:** `quotes`, `jobs`, `leads`, `customers`

Reset runs in proper FK order (leaf records → quotes/jobs/visits → customers).
A 30s wait + double-reset runs after the final test to catch late webhooks.

**External services NOT cleaned (logs remain):**
- Twilio: SMS message logs
- OpenPhone: notification SMS history
- VAPI: call recordings and transcripts
- Gmail: sent emails in Sent folder, replies in inbox
- Stripe: checkout sessions (auto-expire in 24 hrs)
