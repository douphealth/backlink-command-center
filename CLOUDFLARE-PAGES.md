# Cloudflare Pages — no setup required for the browser workspace

Use your existing Git-connected Pages project and build settings: framework **None**, root `/`, command `npm run build`, output `public`, branch `main`. There is no password field or D1 setup requirement for the default Pages dashboard.

The app automatically uses IndexedDB on the current device and imports/export files. `functions/api/[[path]].js` ensures Pages API routes return JSON, and the browser handles legacy HTML SPA fallback without crashing. `public/_routes.json` limits Functions to `/api/*`.

**All 11 management views work locally**, but no DataForSEO billing, email sending, scheduled execution or cross-device sync occurs without an explicitly authorized cloud service. Browser-local plans are not autonomous jobs. For a separately deployed Worker with real D1 state, see `DEPLOYMENT.md`.

After the update, open the *same* `pages.dev` URL. To confirm that Pages Functions deployed, visit `/api/setup` and check for JSON `mode: browser_workspace`. If the endpoint still serves HTML on a legacy direct upload, the app itself will remain functional locally; Git-connected Pages deployments are required for the live HTTP site-check API.
