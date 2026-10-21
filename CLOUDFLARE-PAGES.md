# Cloudflare Pages + private RackNerd worker (production guide)

This app contains **two independent components**:

- **Cloudflare Pages:** the mobile/desktop HTML/CSS/JS dashboard and a minimal `/api/*` Pages Function. It holds no DataForSEO/Gmail credentials, cannot run the Python worker, and cannot trigger paid DataForSEO requests directly.
- **RackNerd VPS:** the authenticated FastAPI API and persistent Python Backlink Finder worker, both using one private SQLite database. Paid requests/outbound sending start disabled.

Cloudflare Pages does **not** run Docker, Python FastAPI, or persistent SQLite. A successful Pages build is **not** proof that the private backend and autonomous jobs are online. The login screen explicitly identifies an unconnected backend.

## 1. GitHub-connected Cloudflare Pages deployment

1. In Cloudflare **Workers & Pages → Create → Pages → Connect to Git**, select `douphealth/backlink-command-center`, production branch `main`.
2. Root directory: `/` (repository root).
3. Framework preset: **None**.
4. Build command: `npm run build` (no third-party JavaScript packages required).
5. Build output directory: `public`.
6. Verify the Pages deployment includes `functions/api/[[path]].js` as a **Pages Function**. The function returns HTTP 503 until you configure the private API; this is intentional.
7. Restrict the admin interface with Cloudflare Access when available. Set `noindex` headers for both HTML and API. Never use public environment variables for credentials.

A `wrangler.toml` is supplied with `pages_build_output_dir = "./public"`. Keep its project name aligned with your actual Cloudflare Pages project slug, or adjust before deploying.

## 2. Protect the backend and establish a private tunnel

On the VPS, clone the repo into a private path. Neither real `.env` values nor the DataForSEO credential belong in GitHub, Cloudflare Pages static assets, or your build logs.

Create a strong admin password, a distinct 32+ character dashboard session secret, and a distinct 32+ character **proxy shared secret** using a CSPRNG. In your VPS `.env` set:

```dotenv
DASHBOARD_ADMIN_PASSWORD=<generate_a_unique_long_password>
DASHBOARD_SESSION_SECRET=<generate_a_unique_32_plus_character_secret>
DASHBOARD_COOKIE_SECURE=true
DASHBOARD_PROXY_SECRET=<generate_a_distinct_random_32_plus_character_secret>
CLOUDFLARE_TUNNEL_TOKEN=<your_private_cloudflare_tunnel_token>
```

Configure the separate `.env.worker` file from `.env.worker.example`, keeping `DATAFORSEO_PAID_ENABLED=NO`, `DATAFORSEO_AUTO_GAP=NO`, and `PR_SEND_ENABLED=NO` until independent health checks pass. Use separate Gmail OAuth if desired; ChatGPT connector credentials are NOT available to the VPS. Do not re-use an uploaded credential file that may have been exposed: rotate the DataForSEO API password first.

In Cloudflare **Zero Trust → Networks → Tunnels**, create a remotely managed tunnel. Add a public hostname on a domain you control, e.g. `backlink-api.yourdomain.example`, with service URL `http://dashboard:8080` (the Compose service, **not** `http://127.0.0.1:8080` inside the tunnel container).

```bash
# From the repository root on the VPS; private .env and .env.worker already configured
chmod 600 .env .env.worker
# Add '-f compose.dataforseo.yaml' only after configuring DATAFORSEO_AUTH_HOST_FILE safely.
docker compose -f compose.full.yaml -f compose.tunnel.yaml up -d --build
docker compose -f compose.full.yaml -f compose.tunnel.yaml ps
```

Without `DASHBOARD_PROXY_SECRET`, the backend is NOT ready to be served through a public tunnel. The deployed FastAPI middleware rejects any direct request lacking the shared secret; even the origin's static index cannot be read through that public hostname without the secret.

Keep port 8080 bound to localhost as in the base Compose file. Test that a direct request to the tunnel hostname receives **403**, not the JSON API response or operator dashboard. Only the Pages Function adds the shared secret to upstream requests.

## 3. Connect the Pages Function to the private backend

In Cloudflare **Workers & Pages → your Pages project → Settings → Variables and Secrets**, configure **production and preview separately**:

| Binding | Type | Value |
|---|---|---|
| `BACKLINK_API_ORIGIN` | Plain text | `https://backlink-api.yourdomain.example` |
| `BACKLINK_PROXY_SECRET` | **Encrypted secret** | EXACT SAME strong value as the VPS's `DASHBOARD_PROXY_SECRET` |

Do not add the DataForSEO, Gmail, VPS SSH, or database credentials to Pages. Do not commit `.dev.vars` or `.env` files to Git. Deploy again after the settings are saved. `BACKLINK_API_ORIGIN` MUST be an HTTPS origin without a path; the gateway rejects insecure destinations.

A successful connection allows `/api/session` to return **401** before login (the expected result) rather than **503** (not connected) or **403** (proxy secrets mismatch). After signing in, the Overview and Operations panels should display **real** SQLite records and the actual worker heartbeat.

## 4. Autonomous worker activation without unexpected costs

Only enable the worker after verifying that the VPS dashboard and worker share the same writable SQLite volume. Confirm the worker's fresh heartbeat in Operations. Test the **free** DataForSEO `dfs-account` endpoint, compare actual account pricing, and leave paid research **paused** until budget constraints are independently validated.

**Hard paid-data ceilings:** $0.06/request, $0.12/day, $1.00/month, no automatic retry after an uncertain billable request. All production DataForSEO requests MUST pass through the worker's cost gateway. Other independent tools can spend from the same DataForSEO account, so monitor account balance and stop on unexplained usage. See `engine/docs/DATAFORSEO-COST-CONTROL.md`.

For autonomous Gmail sends, first import historical suppressions and verify independent Gmail OAuth. **Disable the separate ChatGPT automated sender** before enabling a VPS email sender; there is no cross-platform atomic send lock. Keep outbound paused until each safety gate is verified. Do not mark queued tasks complete or count backlinks without actual source-page inspection.

## 5. Cloudflare Pages QA / common failures

| Symptom | Expected interpretation / fix |
|---|---|
| Pages site shows sign-in but reports backend connection unavailable | Static deployment successful; private worker API not connected; configure tunnel and Pages Function secrets |
| `/api/session` → 503 | Pages bindings missing or RackNerd tunnel API unreachable |
| `/api/session` → 403 | Proxy secret mismatch or blocked origin access; verify VPS and Pages secret agree |
| `/api/session` → 401 | Healthy proxy; not signed in yet |
| Sign-in works but zero historical outreach | Backend is connected to empty SQLite; import prior history; a sent email is not an earned backlink |
| Worker offline | Docker worker not running or heartbeat stale; inspect logs, queue and environment |
| DataForSEO spending = $0 | Paid API not authorized/enabled yet, not a failure of the static UI |
| Pages 404 | Check output directory `public`, repo root `/`, Pages Functions folder at repo root |
| Cloudflare deployment lacks Functions | Use Git-connected Pages deployment, confirm Functions routing and `_routes` configuration |

## Security assurance

- Public repository contains **source code only**, never real API credentials, encrypted Basic Auth strings, OAuth refresh tokens, customer/contact exports or SQLite database files.
- All API and CSV export endpoints enforce FastAPI authentication + CSRF; Pages adds only a server-side proxy secret. Admin login uses HttpOnly Secure SameSite=Strict cookies.
- No client-side path can select the backend hostname or secret. Unexpected redirects and upstream error details do not leak the private origin.
- Gateway responses have `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
- For stronger defense, add Cloudflare Access to the Pages admin hostname and Cloudflare rate limits to the login route.
