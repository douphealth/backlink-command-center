# LinkForge v5 — Cloudflare Pages, ready on every Git deployment

**The Git-connected Cloudflare Pages project is the default deployment target.**

LinkForge previously placed a single-Worker API behind a Pages static site. Pages fell back to `index.html` for missing `/api/setup`, and the browser crashed with `Unexpected token '<'`. This release fixes that routing error and makes the dashboard **useful immediately** after an ordinary Cloudflare Pages deployment, including when there is no D1 binding, Cloudflare Access policy, secret, or additional Worker.

## Deploy with Cloudflare Pages (no setup wizard)

Connect `douphealth/backlink-command-center`, branch `main`, to Cloudflare Pages and use:

| Field | Value |
| --- | --- |
| Framework preset | None |
| Root directory | `/` (repository root) |
| Build command | `npm run build` |
| Build output directory | `public` |
| Production branch | `main` |
| Environment variables | **None required for browser mode** |
| Administrator password | **Not used in browser mode** |

**After that, every push to `main` redeploys Pages automatically.** Your current `pages.dev` URL remains the entry point. You should not need to switch to a separate `workers.dev` site to use the browser workspace.

For Git-connected Pages, the `functions/` directory at the repository root is compiled and deployed by Cloudflare automatically. It contains `functions/api/[[path]].js` for JSON API diagnostics and bounded, free public HTTP checks. The `public/_routes.json` file routes only `/api/*` through Functions. A separate `worker.wrangler.jsonc` remains available for an optional, separately deployed Worker, but is **not** interpreted as a Pages config.

## What works immediately, with no manual Cloudflare setup

- All 11 dashboard sections open, even if Cloudflare `/api/setup` still returns an HTML page from an old cached deployment.
- Ten portfolio sites and existing configured resource URLs are available as static reference data.
- Browser IndexedDB saves prospects, manual status holds, notes, suppressions, site HTTP observations, and task **plans** across reloads on **the same device and browser profile**.
- Add publishers, find/filter them, place them on hold, manage suppressions.
- Import validated prospects or suppression lists from CSV. CSV prospects are deliberately downgraded to **research pending**: a user's spreadsheet is not proof that a backlink or publisher has been verified.
- Export six CSV datasets; back up or restore the entire on-device workspace as a JSON file.
- The Pages Function can check HTTP status for a small, fixed allowlist of owned asset URLs. This does not make DataForSEO calls. If the site was uploaded as static files without the Functions layer, the UI still works but reports that live HTTP checks are unavailable.
- Shows no invented contacts, sends, earned backlinks, spend, activity or results.
- The client checks API response Content-Type before JSON parsing; it never attempts to parse a `<!doctype>` response as JSON.

### Limits of a no-setup Pages deployment

**Local browser records are not stored on a shared Cloudflare database.** They are only on the device used. Clearing browser site data or changing browsers can remove access to the local workspace, so use the built-in backup/export button. The publicly deployed HTML/JS source is not access-controlled; private local workspace contents are never uploaded as public assets or committed to GitHub. For confidential datasets on a shared backend, configure real access control.

**Pages alone does not run unattended Cron Triggers or safely authenticate to a paid DataForSEO/Gmail account.** The browser UI therefore never claims saved task plans were executed, and it never sends emails or makes paid DataForSEO calls. The absence of a cloud Worker is disclosed in the UI. If you need 24/7 autonomous checks, durable cross-device D1 state and provider integrations, provision a secure Worker/D1 backend through the separate optional command below or attach an already-provisioned D1/Access connection to Pages. These services require one-time Cloudflare account authorization; source files alone cannot create them securely.

## Optional: a private Cloudflare Worker for unattended tasks and central records

This does not affect the Pages-first deployment. From an authorized workstation with Node.js 22+:

```powershell
npm install
npm run deploy
```

The optional deployment uses `worker.wrangler.jsonc`, generates a private operator access code locally, provisions D1 through Wrangler where supported, and installs an hourly Worker. Keep the locally generated `.linkforge/` credentials out of GitHub, backups intended for public sharing, and chat messages. **This optional Worker has its own `workers.dev` URL; it does not silently synchronize with a separate Pages browser workspace.** To move data, use the browser backup/export functions and a separate authenticated ingestion workflow after verification. Do not assume two copies of the dashboard share state just because they are in Cloudflare.

### DataForSEO hard safety gates

The optional Worker starts with paid DataForSEO disabled and outgoing Gmail disabled. Code ceilings remain $0.06/request, $0.12/day, $1/month, 3 paid calls/day and 2/site/day, with no automatic retry after an uncertain charge. These ceilings only limit LinkForge's own worker, not other applications using the same DataForSEO account. Rotate any API credential previously uploaded into a conversation before storing it as a Cloudflare Worker secret.

## Verify the correct Pages deployment

1. On your Pages site, open `/api/setup`: it should return JSON with `"mode":"browser_workspace"` if the Git-connected Function has deployed and no secure D1 backend is attached.
2. Open the root site: the dashboard should load and show **Ready on Cloudflare Pages · On this device**, not a deployment-needed screen.
3. Add a publisher and refresh: IndexedDB must preserve it in the same browser.
4. Open Portfolio sites and check one site: results are labeled HTTP observations, not verified SEO outcomes.
5. Export a JSON backup and confirm records remain local.

Even if the Functions route is absent temporarily, the root dashboard detects the HTML fallback safely and enters local mode.

## Development and tests

```bash
npm test
npm run build
```

Tests include Pages route JSON shape, legacy HTML fallback compatibility assertions, secure operator auth on the optional Worker, cost/sending gates, no-fabrication rules, prospect import and de-duplication, safe task planning, and CSV handling. Browser QA may need an environment where Chromium can open local development URLs.

See `DEPLOYMENT.md`, `SECURITY.md`, and `OPERATIONS.md` for operating details. The public repository contains no DataForSEO credentials or private outreach records.
