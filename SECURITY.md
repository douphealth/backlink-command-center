# Security model - Backlink Command Center

The dashboard is a **private operator tool**, not a public SaaS product. The only supported default exposure is a localhost port via an SSH tunnel. Exposing the service to the internet requires HTTPS, a trusted reverse proxy and additional access protection (Cloudflare Access or an equivalent gate).

## Credentials

- **Never** put DataForSEO API credentials, Gmail OAuth refresh tokens, GitHub PATs, or administrator passwords into the repository, UI, issue tracker, Docker image, logs, or source ZIP.
- The DataForSEO file is Base64 HTTP Basic credentials, **not encryption**. Store it privately on the VPS and mount as a read-only Docker secret. Rotate credentials after sharing them in any chat or file-sharing location.
- The worker reads provider secrets. The dashboard process receives no provider API secrets. Session cookies are HTTP-only, SameSite=Strict; set DASHBOARD_COOKIE_SECURE=true behind HTTPS.
- All mutation endpoints require a logged-in operator and an X-CSRF-Token header. Brute-force login attempts are limited in-process. Add an edge or reverse-proxy rate limit in production.

## Data integrity

- A sent Gmail ID is not a delivered email. A submitted form requires a receipt. A backlink requires inspection of a live linking page.
- Paid DataForSEO calls have account-rate validation, hard daily/monthly/per-call ceilings, transactional reservation, cached reuse and a fail-closed timeout policy. The dashboard has no direct DataForSEO request capability.
- Default operator settings: research enabled, outreach PAUSED, DataForSEO paid work PAUSED. Releasing a hold in the dashboard never overrides the worker's independent environment flags or limits.
- All user-triggered worker commands go into SQLite; only the single process holding the worker lock consumes jobs. A queued job is never displayed as completed until it is recorded by the worker.
- Exported CSV fields are explicitly allowlisted, bounded and spreadsheet-formula safe. Exports require authentication. Message bodies and credentials are excluded.

## Running safely

Before enabling live mail from the VPS, disable the unrelated ChatGPT outreach sender. Those two workers have separate databases and **no distributed send lock**. The engine must import historical suppressions and possess appropriately scoped Gmail OAuth first.

Do not publish your local SQLite database: it may contain unpublished contacts and private editorial correspondence. `.gitignore` excludes `state`, `.env` and secret paths. Verify that the project repository is **Private** before uploading code.

If running behind a public endpoint, consult your hosting provider's security settings, enable backups, monitoring and alerts, and never expose Docker 8080 directly.

## Cloudflare Pages remote access
The Cloudflare Pages `/api/*` Function acts as the ONLY authorized gateway to the private HTTPS tunnel origin. `BACKLINK_PROXY_SECRET` is encrypted in Cloudflare, and its matching `DASHBOARD_PROXY_SECRET` is stored in the RackNerd VPS environment. FastAPI denies every direct request to the origin when that secret is set. See `CLOUDFLARE-PAGES.md`.
