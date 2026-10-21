# LinkForge security and cost gates

## Architecture and authentication

The production deployment is exactly one Cloudflare Worker with a D1 database and Cron Trigger. The dashboard is delivered as static assets but every `/api/*` route runs the Worker first. No private prospect, mailbox or payment records are embedded in public JavaScript. All data routes require a cryptographically signed, short-lived (7-day) HttpOnly/Secure/SameSite=Strict session cookie and CSRF confirmation for writes.

The `npm run deploy` command generates a high-entropy operator access code and session-signing key using Node.js `crypto.randomBytes`. Both are uploaded only as Worker encrypted secrets with Wrangler's `--secrets-file` option; its temporary upload file is deleted. A local copy is written to `.linkforge/operator-credentials.json` (gitignored; mode `0600` on POSIX). Deploying from a new checkout rotates the operator credentials, so store this recovery file securely. Failed logins are tracked in D1 with a 15-minute lockout after six failures; raw IPs are not stored.

Never paste access codes or API passwords into ChatGPT, a public GitHub issue, or `.env` tracked files. The previously uploaded DataForSEO credential should be rotated before use in production.

## Billing and outbound safety

`DATAFORSEO_PAID_ENABLED=NO` is hardwired into `wrangler.jsonc` default vars, and the D1 operator hold `dataforseo_paused=true` also blocks paid calls. When later deliberately enabled, the backend checks actual account pricing and balance and reserves the maximum projected cost before each request. Caps are $0.06/request, $0.12/day, $1/month; request rows and number of daily calls are separately limited. Unknown charges, timeouts, conflicting requests, or external account expenditure fail closed. **Other agents can still spend on the same DataForSEO account**, so coordinate all consumers.

`outreach_paused=true` by default, and the unified Worker has **no autonomous Gmail sender** without a separate OAuth and suppressions import. A prospect or draft is not a real link. Link placement only counts after independently checking a linking anchor element.

## Operational limits

This implementation has automated local tests for API auth, D1, cost pauses, scheduling and single-Worker routing, but production Cloudflare account access and third-party API authentication must be verified separately. Do not claim paid-data research or live email sending works until observed. Keep GitHub Actions test-only; no plaintext provider keys in Actions logs.
