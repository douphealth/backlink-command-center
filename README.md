# LinkForge — Cloudflare-only Backlink Command Center

A private dashboard for your ten websites. **No RackNerd, Docker, Python host, or administrator password is needed to run the current dashboard.** Cloudflare Pages Functions handle the API, Cloudflare D1 holds verified records and controls, Cloudflare Access provides email-based sign-in, and one Cloudflare Worker runs scheduled jobs.

> Production safety: the public GitHub repository contains **code only**. DataForSEO credentials, Gmail credentials and actual campaign contacts are never committed. The initial D1 database is empty and truthful. **Autonomous Gmail outreach is NOT connected until a separate OAuth authorization and deliverability checks are completed.** No unverified backlinks or costs are displayed.

## Do this once in Cloudflare

Your Pages site already deploys from `douphealth/backlink-command-center`. A push to `main` updates the interface automatically.

**1. Create a Cloudflare D1 database named `linkforge-db`.** Open Cloudflare Dashboard → Workers & Pages → D1 SQL Databases → Create. Open your existing Pages project → Settings → Bindings → Add → D1 database → Variable name **`DB`** → select `linkforge-db`. Deploy again after saving. The API initializes its tables on first authenticated request.

**2. Enable Cloudflare Access** for your Pages project (Settings → Enable access policy), allow only your own email address, and use the One-time PIN email login. In Pages → Settings → Variables and Secrets, set three **plain-text** variables:

| Variable | Value |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | `<your-team>.cloudflareaccess.com` from Zero Trust |
| `CF_ACCESS_AUD` | your Access application AUD tag (from Access app settings) |
| `ADMIN_EMAIL` | your email address allowed into the dashboard |

These are non-secret identifiers. Configure them for production and any intentionally accessible preview separately; preview sites must also have an Access policy. **There is no `DASHBOARD_ADMIN_PASSWORD` in the Cloudflare-only app.** No DataForSEO secret is added to Pages.

**3. For scheduled background checks**, deploy the included Worker once. Copy `workers/scheduler/wrangler.example.toml` to `workers/scheduler/wrangler.toml`, replace the D1 database ID with the actual ID from Cloudflare, then run `npm exec -- wrangler login` and `sh scripts/deploy-cloudflare-worker.sh` (Windows: `scripts/deploy-cloudflare-worker.ps1`). The Worker runs hourly and only performs automatic research/audits on its bounded cadence. The dashboard immediately shows whether the Worker has really run.

The private Worker has separate optional `DATAFORSEO_BASIC_AUTH` secret (the Base64 `login:password` credential from DataForSEO). Add with `npx wrangler secret put DATAFORSEO_BASIC_AUTH --config workers/scheduler/wrangler.toml` **only after rotating credentials that were ever uploaded to a chat**. Paid requests remain disabled even with a secret until both the Worker variable `DATAFORSEO_PAID_ENABLED=YES` and authenticated dashboard control `dataforseo_paused=false` are set. Configure the first test carefully. Gmail is disabled pending OAuth setup; research and link verification can run without Gmail.

## Safety and DataForSEO budgets

- Maximum reserved charge **$0.06 per API call, $0.12 per day, $1.00 per month** inside the Worker; maximum 3 paid calls/day, 2/site/day, 25 rows/request.
- Free account/rate endpoint is checked before every paid lookup. No fallback price assumptions, and each request is tracked in D1 before sending.
- Uncertain network responses, unexpected rate changes and unexplained provider account balance changes **stop** further paid calls. The Worker never retries a possibly billed operation automatically.
- The dashboard itself cannot request the DataForSEO paid API. Account-wide spend by other scripts is not controlled by this application's local budgets.
- Outreach email sending is not auto-enabled. Imported historical suppression and independently authorized Gmail OAuth are prerequisites for any sender.
- Cloudflare Workers Cron Triggers, unlike Pages Functions alone, can run recurring jobs. The Worker is part of the same Cloudflare platform and shares D1. There is no VPS.

## Cloudflare Pages build settings

- Git repo: `douphealth/backlink-command-center`
- Branch: `main`
- Framework: None
- Build command: `npm run build`
- Output directory: `public`
- Root directory: repository root
- Pages Functions: `functions/api/[[path]].js` and `functions/_lib/*`
- **No root `wrangler.toml` committed**, so Cloudflare dashboard bindings remain authoritative. Avoid adding it without a real D1 binding ID.

If Pages shows the setup screen, the **live two-step wizard** identifies missing D1 and Access configuration and identifies which of the three Access variables are still unset. `/api/setup` returns safe booleans only and never reveals secrets or email values. Configure the production Access **policy** separately: three present variables alone do not prove that private sign-in is active. Password login has been removed; Access handles it.

## Application sections

Overview; Operations (pause controls and durable queue); Prospects; Outreach; Live backlinks; Submissions; DataForSEO spending; Portfolio sites; Learn & improve; Activity log; Suppression. Verified events only. All sections read actual D1 data; empty tables are not simulated.

## Build and test

```bash
npm test
npm run build
```

Tests use built-in `node:sqlite` for an accurate, local D1 emulator and generated test-only signed Cloudflare Access tokens. There are no runtime npm dependencies. The original Python worker and its historical tests remain in `engine/` only as a **legacy reference, not the deployment runtime**.

See [CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md) for the exact security model, worker deployment and verification checklist.
