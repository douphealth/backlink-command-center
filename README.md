# LINKFORGE — One Cloudflare deployment

One Cloudflare **Worker** serves the premium dashboard, private JSON API, automatically provisioned D1 database, and hourly research scheduler. No VPS, Docker, Cloudflare Pages bindings, separate scheduler deployment, manual D1 creation, or Cloudflare Access app is required.

## ONE-COMMAND DEPLOYMENT

**Windows 11 / PowerShell or macOS / Linux** (requires Node.js 22+ and a Cloudflare account):

```bash
git clone https://github.com/douphealth/backlink-command-center.git
cd backlink-command-center
npm run deploy
```

The final command takes care of the rest: installs the official Wrangler CLI if needed, opens Cloudflare sign-in if needed, provisions and binds **D1** (binding `DB`), uploads static assets and the API, registers the hourly Cron Trigger, creates two random **Worker Secrets**, and prints your **workers.dev URL and private sign-in code**. Use that URL, **not the old Pages URL**.

You do **not** need to create D1, set up Zero Trust, paste three Access identifiers, configure a Pages Function, set environment variables, or choose an administrator password. A secure randomly generated sign-in code replaces those manual steps. It is stored locally at `.linkforge/operator-credentials.json` (gitignored, protected file permissions) so repeat deployments reuse it; **never share or commit it**.

Cloudflare's Wrangler automatic D1 provisioning requires Wrangler >=4.45.0. The project uses `wrangler ^4.149.0`. `wrangler.jsonc` declares the DB binding without a hard-coded account-specific ID. [Cloudflare resource provisioning](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/).

**Already deployed with the old Cloudflare Pages project?** Leave it for now. The new single Worker will have its own `*.workers.dev` URL. You can delete the obsolete Pages project after you verify this new app; do not delete any live D1 databases in the meantime. The new D1 database starts empty and does not silently import data from previous Sheets or Workers.

## Architecture

- `src/index.js`: one Worker HTTP + scheduled entry point. Serves `public/` static UI, API, and Cron Trigger.
- `src/scheduler.js`: bounded hourly source checks and evidence-oriented research; dormant paid API calls until explicitly enabled.
- `functions/_lib/api.js`: authenticated management API, D1 query, CSV export and operator controls.
- `functions/_lib/operator-auth.js`: stateless signed Secure+HttpOnly session cookies and CSRF; login attempt throttling in D1.
- `functions/_lib/db.js`: D1 schema, operation queue, cost ledger, suppression and worker heartbeat.
- `wrangler.jsonc`: **single deployment config**, auto-provisioned `DB`, static assets and hourly Cron Trigger.
- `scripts/deploy-one-cloudflare.mjs`: **one command**. Never uploads DataForSEO credentials, Gmail OAuth tokens or private contacts.

## Important operating safeguards

- **DataForSEO paid calls start OFF.** Additional Worker secret `DATAFORSEO_BASIC_AUTH` is optional; credentials uploaded to previous chats should be rotated before configuring production. Never add secrets to public GitHub.
- Hard budget caps are **$0.06/request, $0.12/day, $1/month**, with a request/row limit, cache, no automatic retry after uncertain charges, and separate operator pause. The app does **not** control spending by other scripts sharing the same DataForSEO account.
- Email sending is **not implemented** in the Cloudflare Worker without separate Gmail OAuth/deliverability authorization; outbound messaging remains paused. This single deployment enables the dashboard and free autonomous site checks, **not an independently verified live Gmail campaign**.
- Zero fabricated backlinks, traffic, publisher replies or placements. Empty D1 data remains empty; existing Google Sheets campaign history must be explicitly imported with authenticated authorization.
- Source code is intentionally public, but **operator code, sessions, private records and all provider credentials** are kept out of the repository. UI requests are same-origin; management endpoints require the signed session and CSRF confirmation.
- GitHub Actions runs tests **only**. It does not have permission to modify your Cloudflare account. To publish code updates, rerun `npm run deploy` or connect this Worker to GitHub using Cloudflare Workers Builds after the initial setup.

## Run tests (no Cloudflare API calls and no billable activity)

```bash
npm test
npm run build
```

For deployment troubleshooting: [DEPLOYMENT.md](DEPLOYMENT.md). For safety controls: [SECURITY.md](SECURITY.md). The former Cloudflare Pages architecture can be viewed in this repo's Git history but is no longer the active deploy target.
