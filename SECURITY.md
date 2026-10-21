# Security and data truth — LinkForge Cloudflare Pages

## Zero-configuration browser mode

No administrator password is requested, and no persistent campaign records are placed on Cloudflare's public static hosting. Browser records live in origin-scoped IndexedDB and are accessible to JavaScript executing on that origin. They may be lost if the browser profile is cleared or storage is disabled. A browser backup contains private publisher/contact information if such information was imported; handle it as sensitive and do not check it into a public repository.

The Pages site is publicly reachable. **Browser-only storage is not a substitute for multi-user access control** and does not constitute a secure online CRM for shared teams. Site operators who need shared confidential campaign data must deploy server-side authentication and private storage.

No DataForSEO API key, Gmail token or arbitrary provider credential is accepted or transmitted by browser mode. Public health checking fetches only a small allowlist of preconfigured site URLs; no user-supplied hosts, no redirects followed, at most three HEAD requests per site, 7-second request timeout. Observed HTTP 200s are not treated as earned backlinks.

The `/api/setup` endpoint returns no secrets. Unconfigured `/api/*` routes return a JSON 503 instead of exposing D1 data or falling through to a cached HTML SPA response. The client never blindly calls `.json()` on a `text/html` response.

## Optional Worker mode

Strong generated operator credentials are installed as Worker secrets from an authorized workstation, never committed to Git. Sessions are signed, HttpOnly and Secure; writes require CSRF confirmation; rate limiting is durable in D1. Worker paid queries and outgoing emails remain disabled until independently authorized. Do not use a DataForSEO credential that has appeared in chat without rotating it.

Separate Cloudflare Pages deployments and Worker deployments are separate data origins. Never imply they share data without a correctly configured and authenticated synchronization mechanism. Do not expose an unprotected D1-backed Pages Function.

## Claims and outcomes

Imported publishers are marked `research`, not `verified_ready`. Browser-only task plans never show as completed work, never send email and never incur DataForSEO charges. HTTP site checks are observations and cannot count as backlinks. Empty performance metrics are displayed as zero or unknown, never fabricated.
