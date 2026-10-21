# One Cloudflare account, no extra backend server

## Architecture

Browser → Cloudflare Access (email sign-in) → Cloudflare Pages dashboard & Functions → Cloudflare D1.

Cloudflare Worker (hourly Cron Trigger) → same D1, limited outbound source verification and **opt-in, capped** DataForSEO API requests. The existing Python/RackNerd approach is obsolete for this deployment.

### Where the administrator password went

It was a requirement of the old self-hosted Python backend. That architecture has been replaced. **Cloudflare Access is the login mechanism**, and `/api/login` returns 410 rather than checking a password. The private API requires a cryptographically verified Cloudflare Access JWT with the expected application AUD and an explicitly allowed `ADMIN_EMAIL`.

### Fix the first-run "Finish Cloudflare connection" screen

No administrator password is required. The dashboard uses a public-safe `/api/setup` endpoint to report **boolean configuration checks**; it does not expose the Access audience tag, team domain or email address. The updated onboarding screen shows separate **D1** and **Access** statuses and exactly which Access variable is missing. A green **Settings found** indicator for Access confirms variables are present, **not** that an Access policy is protecting the production hostname. Only a valid signed Access session verifies that.

**Step 1 — D1 database (about 2 minutes)**

1. In your Cloudflare account, open **Workers & Pages → D1 / SQL Databases → Create database**; name it `linkforge-db` (reuse an existing database with that name instead of creating a duplicate).
2. Open the existing **Pages** project connected to `douphealth/backlink-command-center` → **Settings → Bindings** → **Add** → **D1 database**.
3. Set the binding/variable name to **`DB`**, select **`linkforge-db`**, and save for **Production**. The database name and binding are different fields: JavaScript calls `env.DB`.
4. **Redeploy the latest production deployment**. Until it is redeployed, `/api/setup` can still show `database_bound:false`.

Official guide: https://developers.cloudflare.com/pages/functions/bindings/#d1-databases

**Step 2 — Protect the production hostname and set three identifiers (about 4 minutes)**

1. In **Zero Trust → Access controls → Applications**, create or configure a **Self-hosted** web application for the actual production URL, e.g. `<your-project>.pages.dev`. Set an **Allow** policy restricted to your operator email address. Use the **One-time PIN** login method if that is your chosen identity provider. Do **not** rely on the Pages "Enable access policy" toggle alone: it may initially protect only preview deployments. The production `*.pages.dev` hostname must be explicitly protected. Cloudflare's production-domain instructions: https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain
2. In the Access application settings, find **Additional settings → Application Audience (AUD) Tag**. Your Zero Trust team domain is `<your-team>.cloudflareaccess.com` (hostname only; omit `https://`).
3. Open **Pages project → Settings → Variables and Secrets**. In **Production**, add these three **plain-text environment variables** (identifiers, not passwords):

   - `CF_ACCESS_TEAM_DOMAIN`: your real `<your-team>.cloudflareaccess.com` hostname.
   - `CF_ACCESS_AUD`: the actual Access application Audience (AUD) Tag.
   - `ADMIN_EMAIL`: the exact email address you allowed in the Access policy.

4. Save and **redeploy** production. Your Pages site should prompt for Cloudflare Access authentication; after a successful login, `/api/session` should return `authenticated:true` for the approved user.

Check your deployed Pages URL plus `/api/setup` for the configuration booleans. It must show `database_bound:true` and `cloudflare_access_configured:true`. If that URL is protected by Access, sign in first. This **still does not prove** the policy and identity work: `/api/session` must succeed after signing in.

Cloudflare validates your Access JWT before our Pages Function accepts it. Your login and password do not belong in GitHub, D1, or a browser query string. Official JWT documentation: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

### Scheduled jobs — still entirely Cloudflare

- Copy `workers/scheduler/wrangler.example.toml` to `workers/scheduler/wrangler.toml` and fill in `database_id` from `linkforge-db`.
- `npx wrangler login` once; `sh scripts/deploy-cloudflare-worker.sh` (or Windows PowerShell script).
- Cloudflare Workers → linkforge-scheduler → Triggers should show an hourly Cron Trigger.
- Queue `Verify site resources` in Operations. At the next scheduled execution, the activity and heartbeat should update. Before this occurs, the dashboard must show the worker offline; queued is not completed.
- The Worker intentionally does not send emails or perform paid API calls without explicit, separately verified configuration.

### DataForSEO

The only DataForSEO authorization lives in a Worker secret `DATAFORSEO_BASIC_AUTH` (Base64 `login:password`) and is never sent to Pages/static JavaScript. Rotate any credential that was previously attached to a conversation before production use. Set the secret with `npx wrangler secret put DATAFORSEO_BASIC_AUTH --config workers/scheduler/wrangler.toml`; Worker var `DATAFORSEO_PAID_ENABLED` defaults to `NO`, and the DB control defaults paused. Only after a free account check and cost validation should both be released for one bounded test. The API reads DataForSEO's actual account prices before the paid request; it does not guess costs or retry an uncertain request.

Local hard ceilings: $0.06/request, $0.12/day, $1/month, maximum 25 returned rows/request, 3 paid requests/day, 2/site/day. No paid call originates in Pages Functions or the browser.

### Access and security checklist

- Do NOT expose campaign data without Cloudflare Access; the Functions reject unsigned, expired or unauthorized tokens even if a public hostname is misconfigured.
- Protect the Pages production hostname and preview domains with Access. If a custom hostname is attached, add Access protection to that hostname too.
- Store secrets only in Cloudflare Worker Secrets. Public GitHub must not contain `.env`, basic-auth values, OAuth credentials, customer lists or the D1 database export.
- API uses same-origin requests and CSRF verification on state changes. Only the allowed operator can queue actions, suppress publishers or release the built-in safety pauses.
- No Gmail auto-send until explicit independent OAuth, suppression import and anti-duplicate controls are enabled. Existing ChatGPT outreach and a new external sender must never run in parallel without a shared dedupe lock.
- A successful Pages deployment is NOT a verified running hourly Worker. Confirm live logs and a fresh D1 heartbeat.

### Troubleshooting

| What you see | Cause / action |
|---|---|
| No administrator password field; Cloudflare setup guide | Correct v3 frontend, D1 or Access needs its one-time binding |
| `/api/setup` says database_bound: false | Bind D1 as `DB` to Pages and redeploy |
| `/api/setup` says cloudflare_access_configured: false | Configure 3 Access identifiers in Pages and redeploy |
| `/api/session` → 401 | Access JWT missing or invalid; check app protection and login |
| `/api/session` → 403 | Email not in `ADMIN_EMAIL` allowlist |
| `/api/session` → 503 | D1 binding or Access settings missing |
| Dashboard loads but worker offline | Deploy linkforge-scheduler Worker, same D1 ID, verify Cron and logs |
| DataForSEO spend 0 | Paid calls deliberately paused or not configured (safe) |
| Emails not sending | Gmail OAuth sender not implemented in the Cloudflare Worker; no false sent claims |

No VPS is required for any of the above.
