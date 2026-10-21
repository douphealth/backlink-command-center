# Deployment contract — Portfolio Backlink Finder v4

**No external host was changed while preparing this package.** The executable worker runs only when independently installed, with its own OAuth and search credentials. Passing a unit test, or having ChatGPT scheduled tasks enabled, does not constitute a deployed VPS.

## Safe rollout on an existing RackNerd VPS

1. Copy this ZIP to a **private** new folder (never overwrite running Hermes/WordPress services). Ensure Docker Compose v2 and Docker Engine are available. No Cloudflare DNS change is needed: this worker is internal, with **no inbound web port**.
2. Run local tests: `python -m pip install -e . pytest` then `PYTHONPATH=src python -m pytest -q tests`. Inspect `config/sites.json` and decide whether the verified 10-site registry needs expansion.
3. `cp .env.example .env`, restrict its permissions (`chmod 600 .env`), and provision only the required OAuth keys through your existing Google Cloud OAuth consent flow. Authorize Gmail `gmail.readonly` and `gmail.compose` and Google Sheets `spreadsheets.readonly`. Do not import or reuse ChatGPT connector credentials. Review your sender domain and anti-spam requirements separately.
4. Copy the private historical `config/initial-suppression.csv` to persistent worker state, e.g. `docker compose run --rm --entrypoint sh editorial-pr -c 'true'` is **not** an import and does not do this. Prefer a private bind mount or an authorized `docker cp` into the mounted state volume. Confirm the exact path in `PR_INITIAL_SUPPRESSION_CSV`. Do not deploy the suppression file to any public repo, image layer, artifact server or log.
5. Set `PR_SEND_ENABLED=NO`. Set `BRAVE_API_KEY` only if you approve that service's API usage, or provide real competitor backlink CSV exports. Search is disabled without a key; competitor gap metrics are never inferred from public snippets.
6. `docker compose up -d --build`; verify `docker compose ps` and `docker compose logs --tail=100 editorial-pr`. The health check is intentionally **degraded** without a valid discovery source or real completed research cycle, even though the container is running.
7. Monitor at least 3 bounded research cycles and 3 independent hourly Gmail monitoring cycles; compare actual SQLite state and Google Sheets CRM source history. Run `portfolio-pr ... portfolio`, `report`, `health` with the same config/DB path (or `docker compose exec` for in-container checks). Ensure the worker did not attempt to send or charge any provider.
8. Only after credentials, deduplication, publisher rules and deliverability are independently validated, consider `PR_SEND_ENABLED=YES`. **Before doing so, disable sends by ChatGPT's main scheduled outreach automation**. Otherwise the two systems can race and pitch the same organization twice. A shared Google Sheet is NOT an atomic send lock, and independent SQLite databases do NOT protect across senders.
9. For any confirmed placement, check the actual referring page and link target, `rel` attributes, publication date, and subsequently measured referral traffic. Never conclude backlink success from Gmail Sent.

## Separate ChatGPT automation versus worker

- ChatGPT scheduled research uses its connected Gmail and Sheets integrations; it does not execute source code in this ZIP and does not automatically inherit it. It can operate without a VPS, subject to schedule execution and connector availability.
- Independent worker uses **separately granted Google OAuth**, optional Brave Search, optional strictly paid-opt-in DataForSEO, and a private SQLite volume. It does not write to the connected CRM because its sheet integration is deliberately read-only; its reports are local until explicitly exported.
- Choose ONE sender. Keep ChatGPT automation in **research-only** mode before enabling outbound mail on a VPS, otherwise duplicate suppression cannot be guaranteed across services.

## Service observability / incidents

- Successful process startup != successful discovery. `portfolio-pr health --strict` may return nonzero with no configured discovery provider or stale execution.
- `PR_SEND_ENABLED=NO` is the default. A Gmail timeout after POST is marked **needs reconciliation**; do not retry blindly.
- Any 403, CAPTCHA, required log-in, license waiver, anti-automation policy, or absent editorial invitation blocks corresponding form/contact action.
- DataForSEO: `DATAFORSEO_PAID_ENABLED=NO` by default. Optional `dfs-cycle` is a separate manual command. Default `DATAFORSEO_AUTO_GAP=NO` disables paid gap calls during worker runs; enabling BOTH `DATAFORSEO_AUTO_GAP=YES` and `DATAFORSEO_PAID_ENABLED=YES` with valid credentials activates metered periodic gap research. Maximum audited fees are hard-capped by `src/portfolio_pr/dataforseo.py`; any nonzero spend still needs user approval before activation.
- Delivery bounces and unsubscribes are global suppressions. MX existence validates a domain's mail infrastructure only, not an individual mailbox.
- Real source/traffic metrics require the external provider to be configured; set missing fields to `no data`.

## Do not claim complete without these checks

- Deployment host, container ID, actual VPS uptime and persistent DB confirmed.
- 10-site asset coverage is independently recorded in worker SQLite; all websites receive some fair research attempts as budgets permit.
- Search/gap connector authorized with measured requests, no unapproved costs.
- Gmail OAuth refresh actually works over a 2-hour window, retries and duplicate guards verified.
- First real submission/send has a provider receipt, and next cycle sees it as already processed.
- Publisher placement URLs and GA4 referrals independently corroborated. External link acquisition remains an outcome controlled by publishers.
