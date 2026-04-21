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

If env vars need updating, tell the user to update them in the Vercel dashboard under the `jaspergrenager-langs-projects` team.

## Workflow

1. Make code changes
2. `git add`, `git commit`, `git push origin main`
3. Vercel auto-deploys from GitHub — no manual deploy needed
4. Test at `osiris-testing-button-website.vercel.app`

## Test Phone Number

All tests use **Twilio number `+14246771145`** for SMS and voice (via VAPI import). This number is NOT in any Quo CRM contact, so webhooks fire correctly.
