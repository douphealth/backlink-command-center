# Independent scheduled execution watchdog (ChatGPT integration)

The owner's **Portfolio Backlink Finder Watchdog** is a separate ChatGPT automation configured on 2026-10-21 to check actual CRM/Gmail execution progress daily at approximately 19:00 Athens time. It is NOT a file executed by Docker and it is NOT a substitute for production uptime instrumentation on RackNerd.

Its checks:

1. Main all-ten-site PR task actually ran, not merely scheduled/enabled; flag no real Run Log/source research for >30 hours.
2. Hourly Gmail reply monitor remains enabled; include delivery failures, manual paid-link holds and opt-outs.
3. Sourcing accounts for every eligible brand on a rolling week without forcing low-quality placements.
4. No fake backlinks, form receipts, traffic/DR, or unapproved DataForSEO spend.
5. If source-of-truth Google Sheet write is blocked, report the failure honestly without bypass; avoid claiming synchronization.
6. Alert only on a meaningful actual pipeline stall or safety issue. A week with zero earned backlinks is NOT necessarily technical failure because publishers control placement.

The native task cadence is 3 research/outreach cycles/day, hourly response checks, weekly outcome review, plus this daily audit. ChatGPT scheduled tasks do not run 24/7 outside their scheduled executions. Notifications are configured through the platform UI and may currently be disabled.
