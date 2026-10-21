# Direct GSC -> LinkForge URL intelligence (read-only)

This is a **non-GSC-Wizard, non-Windsor** source: the existing Hermes service account uses Google's official Search Console API. The script does not upload your credential, does not use DataForSEO, edit WordPress, discover contacts, or send mail.

## First safe run on Hermes VPS
```bash
cd /path/to/backlink-command-center
python3 -m pip install --user google-api-python-client google-auth
python3 scripts/direct_gsc_opportunities.py --days 90 --per-site 10 --output /home/hermes/.hermes/organic-growth-os/intelligence/linkforge-gsc-targets.json
python3 -m unittest discover -s tests/gsc -p 'test_*.py'
```
To override the credential path (never commit the key), set `GSC_SERVICE_ACCOUNT_FILE` to a local authorized JSON file. Two pre-existing Hermes service-account paths are supported. The service account must be explicitly granted Search Console property access.

## Enable autonomous refresh only after testing a live authenticated read
Use an operator-owned **one** daily cron entry; do not create a second campaign sender. Example cron (UTC):
```cron
15 5 * * * cd /path/to/backlink-command-center && /usr/bin/python3 scripts/direct_gsc_opportunities.py --days 90 --per-site 10 --output /home/hermes/.hermes/organic-growth-os/intelligence/linkforge-gsc-targets.json >> /home/hermes/.hermes/organic-growth-os/intelligence/linkforge-gsc.log 2>&1
```
Keep this collector on the VPS with the service account. Cloudflare Pages and public GitHub have no access to it. Sync the **sanitized opportunities only** into a private, authenticated backend after explicitly wiring durable storage.

## Selection and promotion gates
1. Rank by real page+query impressions, position, CTR gap, historic window and estimated linkability. A high score is **not** proof a URL is ready for promotion.
2. Verify live 200 HTML, canonical target, robots directives, useful original utility and editorial accuracy before selecting one URL.
3. Research a fitting publisher with evidence of relevant editorial resources and accurate editor contact details. Respect opt-outs, suppression, domain cool-down, and prior sent threads in Gmail/CRM.
4. Create individual source-specific drafts; never imply coverage or a link already exists. No bulk-sending, paid links, reciprocal schemes or automated form spam.
5. Require a positive editorial match, an accountable sender, compliance checks and an explicit campaign enablement decision before any outreach occurs. The supplied code sends **nothing**.
6. Verify actual published anchors and referral results independently; never count an email as a backlink.

## Limitations
Search Analytics exports can omit anonymized queries and may be truncated by provider row availability even with pagination; scores are heuristics, not promised ranking improvements. GSC URL ranker does not diagnose indexing/canonicals; those are separate pre-send checks. If API fails, stop and preserve prior snapshot rather than silently treating missing data as zero. Do not automatically stage or deploy this collector where credentials are unavailable.

Rollback: delete the operator-installed cron entry and remove this feature branch. No production changes are made by this read-only code.
