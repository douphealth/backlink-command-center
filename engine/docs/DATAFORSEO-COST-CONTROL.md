# DataForSEO Live Backlinks API — Cost-First Operations

This engine uses the **DataForSEO API**, not DataWise, Ahrefs, a fictional backlink dataset, or LLM tokens. DataForSEO Backlinks API bills in **US dollars per completed request plus returned row**, under the actual authenticated account's pricing rules. The vendor's public Backlinks pricing page in October 2026 lists **$0.024/request plus $0.000036/row**. Actual current prices are not assumed: before every billable POST the worker fetches `GET /v3/appendix/user_data` and reads `result[0].price.backlinks.<endpoint>.live.priority_normal`, never `rates` (which contains usage limits). If rates are missing, invalid, unexpected, or account balance cannot be verified, the request **is not sent**.

Official documentation: https://docs.dataforseo.com/v3/appendix-user-data/ and https://dataforseo.com/pricing/backlinks/backlinks and https://docs.dataforseo.com/v3/backlinks-domain_intersection-live/ . Prices may change; the API's own account-specific price is authoritative.

## Actual integration, not a mock-only CLI

The independent `portfolio_pr.worker` calls CLI `run`, which now invokes `run_dataforseo_cycle` when `DATAFORSEO_AUTO_GAP=YES`. The cycle rotates portfolio sites based on real previous paid research, validates that the target resource is live, checks relevant competitor sites for free, then executes narrowly bounded live API queries **only when** `DATAFORSEO_PAID_ENABLED=YES` and both valid credentials are available. Otherwise it logs `blocked` or `disabled`, without a paid POST, and continues free/source research.

DataForSEO endpoint allowlist:

1. `backlinks/competitors/live` — only when two verified comparable competitors aren't already configured. This is **not** a topical-similarity proof; inspect the actual peer sites.
2. `backlinks/domain_intersection/live` — a single request with two relevant peers, excludes the owned site server-side, retrieves at most 60 shared referring domains (globally 75 max). These are **candidate domains**, not live linking pages, and certainly not acquired backlinks.
3. `backlinks/backlinks/live` — **only after** a potential publisher is filtered and their site is checked. Fetch at most three exact competitor-link page candidates; independently inspect each live page, editorial policies and attribution before outreach.

No organic traffic estimate is inferred from backlink rank. Spam/nofollow metrics only appear if actually supplied. Historical links to a competitor and current hyperlinks to your site are verified separately.

## Spending guardrails — audited hard maximums

| Gate | Default hard ceiling |
|---|---|
| Monthly billable requests | **$1.00 USD** across this worker |
| UTC daily billable requests | **$0.12 USD** across this worker |
| Any one task, reserved worst case | **$0.06 USD** |
| Paid tasks/day | **3** across all portfolio websites |
| Paid tasks/site/day | **2** |
| Rows requested per task | **75**, with 60 domain-gap and 3 page samples normally |
| Cache freshness | **21 days** for gap/page results, 30 days for competitor suggestions |
| Reserve | Actual account-specific rate × max requested rows × **1.25** safety factor |
| Sender | OFF until independent Gmail OAuth and anti-spam checks are verified |

These maximum values are coded in `Limits` and cannot be increased with `.env` alone. Environment variables can only **lower** audited values. The gateway records `request ID, site, endpoint, reservation, actual provider cost, task ID, status, UTC day/month` in a private persisted SQLite volume. `dfs-budget` and the local HTML report display actual **local** spend/reservations and cache use. No tokens are inferred or billed locally for free browser checks.

A paid request that times out or returns an unparseable charge is logged **uncertain**: it is never automatically repeated, and all new billable requests stop pending reconciliation. A provider charge greater than its reservation also trips a persistent spending stop. The system does not retry HTTP 429/500 or swap accounts to bypass limits.

## Detect unexpected use of the DataForSEO account

`DFS_MONITOR_EXTERNAL_SPEND=YES` uses **free** account-balance checks before paid calls and compares changes against the worker's own recorded spending. An unexplained drop exceeding **$0.005** creates a persistent `dfs_spend_alerts` incident and stops new paid requests until an authorized operator audits it. This also catches possible token/credit use from other unknown scripts **when an account check is performed**.

**Important limitation:** The hard dollar and call limits apply ONLY to this worker/database. They **cannot** prevent separate bots, dashboards, scripts, people or applications from using the same DataForSEO account. Account-balance comparisons are sampling checks, not a global spending firewall; concurrent requests or account top-ups can complicate the reconciliation. Restrict other API clients and consider account-level limits in DataForSEO's dashboard. Do not assume those settings are enabled unless verified there.

## Secure activation — two explicit switches, zero payment until then

1. Copy `.env.example` to `.env` on your **private VPS** and run `chmod 600 .env`. Never commit `.env` or send login/password through chat.
2. Obtain your DataForSEO **API login/password** from your own authenticated https://app.dataforseo.com/api-access page and supply them as `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` in the secret service environment. This file contains no credentials.
3. Use **free** connectivity test while both paid toggles still say NO:

   ```bash
   portfolio-pr --db state/outreach.sqlite3 dfs-account
   portfolio-pr --db state/outreach.sqlite3 dfs-budget
   ```

   `dfs-account` must return real account balance and three current rate tuples. It never sends a billable POST.
4. Verify server outbound HTTP access and actual source assets. Import the historic suppression list and Gmail/Sheets previous outreach before enabling any sending.
5. After deliberately choosing to spend within the ceilings, enable both `DATAFORSEO_AUTO_GAP=YES` and `DATAFORSEO_PAID_ENABLED=YES` in the private runtime. Run a **single metered cycle** for an initial live smoke test:

   ```bash
   portfolio-pr --db state/outreach.sqlite3 --config config/sites.json audit-sites --max-checks 10
   portfolio-pr --db state/outreach.sqlite3 --config config/sites.json dfs-cycle
   portfolio-pr --db state/outreach.sqlite3 dfs-budget
   ```

6. Confirm a **real provider task ID, result pages, and a cost charged in USD** from `dfs-budget`. Do not call the integration production-verified before that check. In normal operation, `portfolio-pr ... run` already calls the metered cycle; no second cron job should call it again.

## Provider usage review

Query the private SQLite ledger for actual amounts:

```sql
SELECT site, endpoint, status, task_id, reserved_micro / 1000000.0 AS reserved_usd,
       actual_micro / 1000000.0 AS provider_usd, created_at
FROM dfs_requests ORDER BY created_at DESC LIMIT 30;
```

Stop the container or set `DATAFORSEO_PAID_ENABLED=NO` immediately if DataForSEO usage differs from the ledger. Keep sender `PR_SEND_ENABLED=NO` until the independent Gmail sender passes authentication/deduplication tests and the existing ChatGPT outreach task is research-only. A Google Sheet is **not** an atomic mutex between two autonomous senders.

## Existing Base64 credential file (v4.1)

The optional `DATAFORSEO_BASIC_AUTH_FILE` setting allows a read-only mounted
Base64 `login:password` file; the worker decodes only in process memory.
Use `compose.dataforseo.yaml` with `DATAFORSEO_AUTH_HOST_FILE` pointing to a
private host file. This avoids plaintext API login/password environment
variables. A valid file format alone does **not** prove active credentials.
The free `/v3/appendix/user_data` check is necessary before paid operations.
If DNS/network access is unavailable, do not report authentication as successful.
Always keep `DATAFORSEO_PAID_ENABLED=NO` and `DATAFORSEO_AUTO_GAP=NO`
until host networking, live account validation and budget safeguards are verified.

### Linux Compose secret permissions (important)

This worker runs as unprivileged UID/GID 65534. Docker Compose `file` secrets
are bind-mounted and **do not reliably remap file ownership or mode**.
A host root-owned `0600` file may not be readable inside the container.
Provision it as `root:65534`, mode `0640`, inside a root-only `0700` directory
using `scripts/provision-dataforseo-secret.sh`. This permits only the service
group to read it; do not make the host file world-readable. Test the mount with
`test -r /run/secrets/dataforseo_auth` (never `cat` the file to logs).
