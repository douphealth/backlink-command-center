# Deploy LinkForge without a Cloudflare setup maze

## Normal / required path: Cloudflare Pages

Your existing Cloudflare Pages project is the app home. Keep the Git integration pointing to `douphealth/backlink-command-center`, production branch `main`, output directory `public`, build command `npm run build`, framework None, root `/`.

You **do not** need to create a D1 database, Access organization, API secret, RackNerd service, Docker container or administrator password merely to open the dashboard and work with on-device records.

1. Push or merge code to `main`.
2. Wait for the existing Pages deployment to succeed.
3. Open the same Pages URL and use the dashboard. It automatically enters a browser workspace if cloud credentials or D1 aren't provisioned.

Each subsequent Pages Git deployment follows these exact steps. Avoid a root `wrangler.toml` / `wrangler.jsonc` with Worker-only settings: it may override or confuse Pages configuration. The optional Worker configuration is named `worker.wrangler.jsonc` deliberately.

## If `/api/setup` shows HTML or 404

An old Pages SPA route may still return HTML for an unknown `/api/*` URL. LinkForge v5 checks the MIME type and does **not** JSON-parse HTML; it starts browser mode. For a Git-connected Pages build, `functions/api/[[path]].js` will make `/api/setup` return correct JSON after deployment. For static-only direct uploads, Pages Functions aren't included; import/export and core dashboard still work, while public HTTP site checks are disabled.

## If the dashboard is empty

This is not an error. LinkForge only shows actual recorded work. Create a prospect, import a compatible CSV, or restore an on-device JSON backup. There are no fabricated backlinks, sends, GSC rankings or DataForSEO charges.

## Browser storage scope

IndexedDB is tied to your browser profile and Pages origin. Records will persist across normal reloads and Pages redeployments at the **same hostname** as long as you retain that browser's site data. Export a backup before changing to a custom domain, clearing site data or switching devices. No cross-device sync is promised by a storage-free Pages deployment.

## Unattended or cross-device operation (separate feature)

Cloudflare Pages Git build cannot independently provision a secure shared database, background Cron Trigger and authenticated paid integrations in an account with no bindings or secrets. To enable these capabilities, deploy the optional secure Worker after authenticating to Cloudflare once (`npm install && npm run deploy`) or attach D1 and verified operator credentials using established Cloudflare configuration. This is **not** required for the core Pages dashboard.

Paid DataForSEO queries and Gmail sending always start disabled. A saved browser task is a plan, **not** an executed job. Do not upload passwords or DataForSEO Basic Auth to your public repository.
