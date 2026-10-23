# LinkForge v7 — Autopilot

**An autonomous backlink and organic-growth engine for the 10-site portfolio.** It runs twice a day in GitHub Actions, publishes its results to the existing Cloudflare Pages dashboard, and needs **no Cloudflare setup, no server, and no database**.

```
crawl every owned page ─► measure real demand ─► rank the best URLs ─► plan internal links
        │                                                                     │
        └─► find link prospects in Google ─► qualify each page ─► find the editor's email
                 │
                 └─► write a page-specific pitch ─► Gmail draft or send ─► one follow-up
                          │
                          └─► read replies, bounces & opt-outs ─► re-check pages ─► verified backlinks
```

| | Before (v5/v6) | Autopilot (v7) |
| --- | --- | --- |
| Pages audited per run | 124 (12 per site, HTTP status only) | ~1,900 (all sitemaps, 300/site, full on-page features), ~20 s incremental |
| "Best URL" ranking | URL keyword heuristics | Content depth, tools/quizzes, data tables, citations, freshness, internal inlinks, **GSC or DataForSEO demand**, de-duplicated templates |
| Internal links | none | ~300 concrete "add this anchor on this page" fixes |
| Prospecting | paused, $1/month cap | Intent + resource-page searches per asset, platform/gov/UGC filters, live page qualification |
| Contacts | none | Editor emails from page, contact/about pages, Cloudflare-obfuscated addresses, author names |
| Outreach | disabled | Claude-written or template pitch, Gmail Drafts or hands-free sending, warm-up ramp, one follow-up |
| Results | none | Replies, opt-outs, bounces handled automatically; won links verified on the live page |
| Deployment | Worker + D1 + Access + secrets | **GitHub Actions + Cloudflare Pages only** (each run's commit redeploys Pages) |

## Turn it on (one time, ~5 minutes)

```powershell
npm install
gh auth login          # once, if the GitHub CLI isn't signed in
npm run autopilot:setup
```

The setup script stores everything as **encrypted GitHub Actions secrets** (values are piped to `gh`, never written to disk) and starts the first run. It asks for:

| Secret / variable | Needed for | Where to get it |
| --- | --- | --- |
| `LINKFORGE_DATA_KEY` | Encrypting prospects & outreach history (repo is public) | Generated automatically; saved to `.linkforge/autopilot-unlock-key.txt` |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Google prospect searches, page-traffic estimates | DataForSEO dashboard → API Access |
| `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD` | Drafts, sending, reply & bounce detection | myaccount.google.com/apppasswords (2-Step Verification required) |
| `SENDER_NAME` (variable) | Signing pitches | Your name, e.g. "Alex from GearUpToFit" |
| `OUTREACH_MODE` (variable) | `draft` (default) or `send` for hands-free | — |
| `ANTHROPIC_API_KEY` *(optional)* | Unique, page-specific pitches written by Claude | console.anthropic.com |
| `GSC_SERVICE_ACCOUNT_JSON` *(optional)* | Exact impressions/positions → striking-distance targeting | Google Cloud service account with Search Console access |
| `SENDER_POSTAL_ADDRESS` *(optional)* | CAN-SPAM footer | — |

You can also add them by hand under **GitHub → Settings → Secrets and variables → Actions**. The dashboard's Autopilot page shows exactly which ones are still missing.

Without any secrets the engine still runs: it crawls, ranks the best URLs and produces the internal-link plan. Each connected credential unlocks the next stage.

## Dashboard

Open your Pages URL (for example `https://backlink-command-center.pages.dev`). **Autopilot** is the first view: last/next run, setup checklist, funnel, best URLs with reasons, internal-link plan, verified backlinks and stage health.

Prospect details (emails, conversations) are decrypted **in your browser** after you paste `LINKFORGE_DATA_KEY` once. You can also bookmark `https://…pages.dev/#key=YOUR_KEY`; the part after `#` is never sent to a server.

Run a cycle on demand: **Actions → LinkForge Autopilot → Run workflow** (tick *dry run* to preview without sending or committing).

## Guardrails (built in, not optional)

- **Spend:** DataForSEO daily/monthly caps (`DATAFORSEO_DAILY_USD`, default $0.50; `DATAFORSEO_MONTHLY_USD`, default $10), provider-reported cost ledger, endpoints the account can't access are parked for 7 days.
- **Deliverability:** warm-up ramp (5/day, +2/day) up to `OUTREACH_DAILY_LIMIT` (default 12), 15–45 s spacing, `List-Unsubscribe` header, plain-text mail.
- **Respect:** one contact per publisher domain per 90 days, one follow-up only, follow-ups stop on any reply, opt-out replies suppress the domain permanently, bounces switch to an alternate address or stop.
- **Honesty:** pitches only state facts from the crawled asset; Claude output is rejected if it adds URLs, placeholders or runs long. A backlink counts only when the anchor is found on the live page.
- **Privacy:** the public summary is checked in CI to contain no email addresses; private state is AES-256-GCM (PBKDF2-SHA256, 210k iterations).

## How "best URL" is decided

`promotion = 0.55 × linkability + 0.45 × demand` (linkability alone when no demand data), plus a bonus for flagship assets and under-linked pages.

- **Linkability:** page type (tool, methodology, data, comparison, guide), depth, structure, tables, embedded tools/quizzes, authoritative citations, rich schema, freshness. Thin pages are penalised, and templated siblings (e.g. `/compare/x-vs-y`) are capped at two per template.
- **Demand:** Search Console impressions with a striking-distance bonus (positions 4–20), or DataForSEO estimated traffic and keyword counts.

## Development

```bash
npm test                # 64 tests: Pages routing, legacy Worker, Autopilot engine (mocked network, SMTP/IMAP fakes)
npm run build
npm run autopilot:dry   # full cycle locally, nothing sent or written
```

Engine code is in `scripts/autopilot/` (`run.mjs` orchestrates; `crawl`, `score`, `demand`, `prospect`, `pitch`, `mail`, `outreach`, `dataforseo`, `vault`). The workflow is in `.github/workflows/autopilot.yml`.

## Legacy optional Worker

The earlier single-Worker + D1 backend (`src/`, `functions/_lib/`, `worker.wrangler.jsonc`, `npm run deploy`) still builds and is still tested, but Autopilot does not need it. See `DEPLOYMENT.md`, `SECURITY.md` and `OPERATIONS.md`.
