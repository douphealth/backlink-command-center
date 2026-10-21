# LINKFORGE | Backlink Command Center (v2)

A **private, data-grounded operations dashboard** for the existing Portfolio Backlink Finder v4.1 workflow. Responsive SPA frontend and authenticated FastAPI API; the built-in Python research engine uses the **same SQLite database** as the interface. It does **not** display fictional charts or imply an email earned a backlink.


## Cloudflare Pages deployment (GitHub-connected)

**New in v2.1:** Deploy the responsive `public/` dashboard through Cloudflare Pages with a protected `functions/api/[[path]].js` reverse proxy. Use `npm run build` and output directory `public`; both require no runtime npm dependencies. The **Python/SQLite worker and authenticated FastAPI API must run privately on RackNerd**, reached through a secure Cloudflare Tunnel. Configure `BACKLINK_API_ORIGIN` and encrypted `BACKLINK_PROXY_SECRET` only in the Pages project settings, with a matching `DASHBOARD_PROXY_SECRET` in the VPS environment. The Pages Function refuses to connect until securely configured. Full setup and security test plan: [CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md).

The repository can be public **only because it contains source code, not secrets**. No DataForSEO costs were incurred by creating the dashboard. Cloudflare Pages alone cannot run continuous Python jobs or store the existing SQLite state. Never claim live autonomy from a successful static Pages deployment.

## What is inside

- **Operations control room:** durable, authenticated job queue, live/stale heartbeat, explicit pause/resume safeguards, command outcomes; no fake "success" from merely queueing.
- **Learn & Improve:** real editor responses, outcome evidence, search yield and imported referral/engagement metrics; no fabricated traffic.
- **Evidence exports:** authenticated, bounded, spreadsheet-safe CSV downloads for the six essential campaign datasets.

- **Overview:** genuine pipeline counts, published backlink proofs, actual DataForSEO cost ledger, recent recorded events.
- **Prospects:** searchable and filterable publisher evidence, linked asset, status, contact verification, score, actual or explicitly missing organic metrics. Safe administrative HOLD action.
- **Outreach:** actual locally recorded draft and sent messages with Gmail evidence. No unverified one-click mass sending.
- **Placements:** exact published source URL, target asset, observed rel attribute and checked timestamp.
- **Submissions:** form, blockers, requirements and independent confirmation receipts.
- **DataForSEO:** daily and monthly reserved and actual costs, uncertain requests, account spend alerts and live gap-domain data. The dashboard itself **cannot** make billable DataForSEO calls.
- **Portfolio sites:** all ten domains from the supplied engine configuration; live asset verification results when present.
- **Activity:** immutable per-action log from the worker and administrative status changes.
- **Suppression:** real persistent publisher/email exclusion that prevents contact across all sites.

The API uses a single private operator password (required, no defaults), HttpOnly `SameSite=Strict` session cookie, server-validated CSRF token, rate-limited sign-in and read/write authentication. It does not need or expose the DataForSEO key, Gmail OAuth, or an admin API key in frontend assets.

## Local run (without Docker)

Install dependencies:

```bash
python -m venv .venv
source .venv/bin/activate # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
```

Set the following **in your own terminal** (never in GitHub), use a fresh random secret:

```bash
export DASHBOARD_ADMIN_PASSWORD='replace-with-your-own-long-password'
export DASHBOARD_SESSION_SECRET='replace-with-a-random-secret-32-or-more-characters'
export DASHBOARD_COOKIE_SECURE=false # Local HTTP only
export PR_DB_PATH="$PWD/state/outreach.sqlite3"
uvicorn server:app --host 127.0.0.1 --port 8080
```

Open http://127.0.0.1:8080. An empty database honestly displays zero results. When you point `PR_DB_PATH` to a DB created and used by the engine, the records become real.

## Recommended: deploy both worker and dashboard together on your private VPS

1. Copy `.env.example` to `.env` and `.env.worker.example` to `.env.worker` **on the VPS** (do not commit them). Set strong `DASHBOARD_ADMIN_PASSWORD` and `DASHBOARD_SESSION_SECRET`. Keep `DATAFORSEO_PAID_ENABLED=NO` and `PR_SEND_ENABLED=NO` until authentication and quotas are verified.
2. Run `docker compose -f compose.full.yaml up -d --build`. This uses a single named `backlink-state` volume, shared by worker and dashboard. Database access is SQLite WAL with serialized writes.
3. Access privately with an SSH tunnel: `ssh -L 8080:127.0.0.1:8080 your-vps-user@your-vps-host`, then open http://127.0.0.1:8080.
4. To expose through a public hostname, **first** configure HTTPS, login protection, reverse-proxy access controls and set `DASHBOARD_COOKIE_SECURE=true` (also in the `compose.full.yaml` override). Never open port 8080 publicly.
5. The original DataForSEO auth file MUST be on the VPS in a private location, not in a git checkout. To mount a Docker secret, use `docker compose -f compose.full.yaml -f compose.dataforseo.yaml up -d` with the private `DATAFORSEO_AUTH_HOST_FILE` path. Check the *free* account endpoint before enabling any paid request.
6. **Disable outgoing email in the separate ChatGPT scheduled outreach task before enabling the VPS engine sender**. The two schedulers have no shared atomic send lock; independently sending from both risks duplicate mail.
7. The dashboard's **Operations** tab starts with paid DataForSEO and outgoing outreach *paused*. Even after releasing those holds, actual API costs need the worker environment flags, validated provider pricing, cached results and code-enforced limits. The dashboard cannot call the provider directly.
8. To import old campaign suppression via authenticated Sheets OAuth, configure the worker's separate Google OAuth and run `portfolio-pr --db /app/state/outreach.sqlite3 --config config/sites.json sync-crm`. No connection credentials are inferred from ChatGPT.

Note: The default Docker engine user is nonroot. The dashboard uses its own default image user. The data volume must remain writable to the worker, and in-container SQLite WAL/read access must be verified with `docker compose ... exec worker ...` and `docker compose ... exec dashboard ...`.

## Background worker accountability

The worker's actual SQLite heartbeat is written approximately every 12 seconds while running. The dashboard shows "Worker online" only for a sufficiently fresh heartbeat, and marks a graceful worker stop offline. The worker polls an idempotent command queue and records success, failure or absence of verifiable work. The user may queue research, source audits, candidate verification, link checks, reply scans and weekly follow-ups from the dashboard; **queued is not completed**.

All these actions require a *deployed* worker. The v2 package is fully built and locally tested but is not proof that the user's RackNerd VPS is already hosting it or that its separate Gmail and DataForSEO credentials are working. See `OPERATIONS.md` for deployment phases and `SECURITY.md` for risks.

## Dashboard security and limitations

- **Private by default:** binds to localhost only. The password and session key never go into source control.
- **No paid queries from the UI:** the dashboard can only report the worker's DataForSEO cost ledger. Limits remain $1/month, $0.12/day, $0.06/request in the standalone engine.
- **No false proof:** database sent-mail records are NOT live backlink placements; `verified_links` is the only source for backlink count.
- **No fake integration status:** worker heartbeat and authenticated Gmail/DataForSEO connectivity remain "unverified" until real operational logs support those claims.
- **No replica source of truth:** one shared SQLite database; there is no pretend synchronization with the Google Sheets CRM. Real CRM history requires explicit OAuth import.
- **No remote repo or VPS deployment verified:** GitHub connector can modify existing repositories but does not expose repository creation. The intended private repo is `douphealth/backlink-command-center`, which must be created through a supported authenticated mechanism. The project includes a `.github/workflows/ci.yml` test workflow ready for that repository.
- **No mass mail or purchases.** Administrative actions can put prospects on hold or add publisher suppressions; source verification and outbound messages remain in the audited engine.

## Tests

```bash
pip install pytest httpx
python -m pytest tests -q
PYTHONPATH=engine/src python -m pytest engine/tests -q
node --check public/app.js
```

**The `engine/` folder contains a copy of the previously built v4.1 Python worker source, without personal data or API credentials.** The original externally supplied skill is not redistributed. The original worker regression tests are included under `engine/tests/`. v2 tests additionally validate controls, immutable cost totals, idempotent commands, CSRF, suppressions, heartbeat, safe exports and worker send pauses.
