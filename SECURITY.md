# Cloudflare-native security

The dashboard is private: Cloudflare Access email login and a signed RS256 JWT verified by Pages Functions (issuer, AUD, expiry, allowed email). There is no static dashboard administrator password. Requests lacking a valid identity fail closed. State changes require an additional CSRF token. Database is a server-side Cloudflare D1 binding.

No DataForSEO secret is present in Pages or GitHub. If configured later, it is stored as a Worker encrypted secret. Paid calls remain opt-in and budget-limited. Exact Gmail send/receive is not active without a separately authorized OAuth integration; sending is paused by default. Historical publisher suppression and opt-outs must be imported before enabling any sending mechanism.

Never deploy a public unauthenticated D1 API, include real secret values in build logs, store OAuth refresh tokens in GitHub, or claim a queued job sent an email. Frontend shows evidence-only counts and blocks access to D1 without Access validation.
