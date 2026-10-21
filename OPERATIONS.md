# LinkForge operations

The single Cloudflare Worker routes authenticated dashboard API traffic and runs scheduled research on an hourly Cron Trigger. D1 stores the queue, source checks, publisher suppression, verified placements, actual DataForSEO ledger and heartbeat.

**Research** may run autonomously on a bounded schedule with public HTML source checks. It must never invent prospects, contact details, link placements or traffic. `DataForSEO` paid requests are **OFF** by default; billing caps remain in the Worker source. Gmail email sending is **OFF / not connected** pending explicit OAuth, global suppression-history import, sender lock and deliverability checks. The dashboard permits queuing actions but not bypassing independent environment or spending gates.

**Monitor** shows a truthful blocked status until Gmail OAuth is connected. **Backlinks** only count live anchor evidence, not pitches or form submissions. **Spend** shows recorded D1 charges, not unrelated API usage elsewhere.

The first scheduled heartbeat appears after the first hourly Cron execution; an offline status before that is expected. Run `npm run deploy` after changes to deploy the code to your linked Cloudflare account. For optional Git-on-push builds, connect this existing Worker through Cloudflare Workers Builds. Avoid running the former ChatGPT sender concurrently with any new Gmail worker sender.
