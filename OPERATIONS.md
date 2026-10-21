# LinkForge Operations — Cloudflare version

- Frontend and API: GitHub-connected Cloudflare Pages + Pages Functions.
- Database: one Cloudflare D1 binding named `DB` (no SQLite on a VPS).
- Login: Cloudflare Access OTP; no in-app admin password.
- Background automation: one Cloudflare Cron Worker deployed with the same D1 database. Jobs are durable and deduplicated. It produces a real heartbeat and logs results; it does not claim unperformed work.
- DataForSEO: billed calls only from the Cron Worker after an authenticated user_data free check, worst-case pre-reservation, spend ceiling and double opt-in. Zero requests happen by default.
- Gmail: no automated sender until OAuth and anti-duplicate history import are configured and proven. Existing ChatGPT outreach schedules are separate; avoid parallel sending.
- Links: only inspected anchor hrefs on live pages are confirmed. A sent email or a gap domain is not an earned backlink.

Deploy requirements and source-level security controls are documented in README.md and CLOUDFLARE-PAGES.md.
