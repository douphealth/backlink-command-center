# Operational setup and safety runbook

## Deployment phases

**Phase 0 - verified local package:** All code, tests, and local browser QA complete. No remote GitHub repository or RackNerd deployment is implied.

**Phase 1 - private VPS container:** Install Docker Compose, copy the project to a locked-down directory on the existing RackNerd VPS, place administrator secrets only in `.env` and `.env.worker` from the provided examples, then run:

```bash
# From the project root on the VPS
docker compose -f compose.full.yaml up -d --build
docker compose -f compose.full.yaml ps
```

Use `ssh -L 8080:127.0.0.1:8080 user@your-vps-host` to access the dashboard locally. The dashboard listens on loopback, not the public interface. An operator sees actual heartbeat state in **Operations**; if missing, inspect `docker compose ... logs --tail 80 worker`.

**Phase 2 - DataForSEO credentials (free authentication only):** Place a freshly rotated API credential file outside the repository, set `DATAFORSEO_AUTH_HOST_FILE` in the private `.env`, and mount it via `compose.dataforseo.yaml`. Keep both `DATAFORSEO_PAID_ENABLED=NO` and `DATAFORSEO_AUTO_GAP=NO`, and the dashboard's DataForSEO hold PAUSED. Execute the CLI's `dfs-account` **free** endpoint to check account balance/pricing. Network or authentication failure means DO NOT enable paid work.

**Phase 3 - bounded paid calibration:** Only after the free account check succeeds, enable the two worker environment gates and release the dashboard hold. The DataForSEO gateway has hard caps of $0.12/day, $1.00/month and $0.06/request, and no blind retries. The dashboard reports only this worker's ledger; **other scripts using the same account can spend independently**, which may trigger an external-spend alert. Verify the first actual request and charged amount, then permit the usual cached multi-site cycles.

**Phase 4 - Gmail and legacy CRM:** Configure independently authorized Gmail OAuth and Sheets read-only OAuth on the VPS, import prior campaign contacts/suppressions, and verify drafts and reply checks. Do **not** copy tokens from ChatGPT connectors: connector sessions are not shared with the VPS. Keep `PR_SEND_ENABLED=NO` until the separate ChatGPT automated sender is disabled and outbound policy/duplicate checks are demonstrated. Forms requiring login, legal attestations, CAPTCHA or a purchase remain blocked until valid prerequisites are satisfied.

**Phase 5 - ongoing evidence:** Monitor worker heartbeat, queued action status, send evidence, zero/positive responses, published link checks, and imported referral analytics. Use the Learn & Improve view to assess outcomes each week. Missing data must stay unknown, not become zeros implying successful execution.

## Dashboard controls

- **Research pause/resume:** Stops scheduled and manual research cycles, but does not block separate inbound reply monitoring.
- **DataForSEO pause/resume:** Releases only the *operator hold*. It cannot override the separate provider credentials, env flags, account pricing checks or code-enforced spend ceilings.
- **Outreach pause/resume:** Releases only the *operator hold*. Independent Gmail OAuth, server PR_SEND_ENABLED and historical deduplication remain mandatory.
- **Queue research / asset check / prospect verification / link check / reply scan / weekly check:** Writes a durable SQLite job. A job is marked completed or failed by the running worker; the dashboard itself performs no paid network requests.
- **CSV exports:** Authenticated snapshots of allowlisted nonsecret operational tables, max 5000 rows each.

## Alert escalation

If a paid request is uncertain, budget is exhausted, the DataForSEO balance falls unexpectedly, or reply verification is unavailable, **pause** the relevant operation and review the actual server and provider logs. Never auto-retry uncertain billable calls or ambiguous email sends.

## GitHub publication

The connected GitHub app supports writes to **existing** repositories but has no repository-creation action. The intended private repo is `douphealth/backlink-command-center`. Create this new private repository through an authenticated GitHub browser, then push the tested source. Do not publish this as a public repo without reviewing that decision. The source ZIP must not include `.env`, the credential text, mail/CRM data or local SQLite files.

## Cloudflare Pages deployment
`npm run build` builds the deployable static UI, **not** the Python worker. Install `compose.tunnel.yaml` only on RackNerd and configure the matching Pages secret and VPS proxy secret. See [CLOUDFLARE-PAGES.md](CLOUDFLARE-PAGES.md).
