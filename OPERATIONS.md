# Operations — LinkForge v5

## Browser workspace (automatically available on Cloudflare Pages)

The dashboard opens without a backend and stores records in IndexedDB. Use Overview for actual portfolio counts, Prospects for manually sourced publishers and evidence links, Suppression for exclusions, and Portfolio sites for bounded public HTTP observations. Use **Import data**, **Export CSV**, and **Back up** to move or preserve records. No data is synchronized automatically to another device.

A local **Save plan** action records an action with status `planned`, not `completed` or `queued for autonomous execution`. The browser cannot verify backlinks or send emails while unattended. The DataForSEO and outreach controls remain disabled in browser mode to prevent unintended charges or outreach.

## Optional secured Cloudflare backend

The Worker entry in `src/index.js` still combines static assets, authenticated D1 API, and an hourly Cron Trigger. This is a separate deployment triggered by `npm run deploy`, not an ordinary Pages build. A Cloudflare-hosted service with durable data still needs Cloudflare account authorization and secrets. Do not assume the Pages origin shares D1 with the Workers origin.

- Verify the secure session and D1 before enabling worker commands.
- Observe a real worker heartbeat before concluding scheduled tasks run.
- Keep DataForSEO paid requests disabled until free account endpoint, pricing and ledger ceilings are checked.
- Keep email sending disabled pending independent Gmail OAuth, suppression import and duplicate-sender prevention.
- Treat an unverified publisher or any uploaded CSV as a lead only. Only independently checked source-page links count as verified placements.

## Cost rules

No paid DataForSEO calls originate from the Cloudflare Pages browser workspace or public site-check Function. Optional Worker hard caps: $0.06/request, $0.12/day, $1/month, 3 calls/day, 2 per site/day, no automatic retry of uncertain charges. Spending by other scripts in the same provider account lies outside this worker's caps.
