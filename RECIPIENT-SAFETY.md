# Recipient safety repair

## Outbound hold (lifted 2026-11-05 by the owner)

The unconditional hold was lifted by the owner after the recipient-verification gate passed production checks: Verifalia authenticated, and 5 queued inboxes were verified Deliverable within 24 h. Sending now follows the dashboard's outreach mode, still subject to every rule below.

**Emergency brake:** set repository variable `OUTREACH_HOLD=YES` (GitHub → Settings → Secrets and variables → Actions → Variables). The next cycle forces `OUTREACH_MODE=off`, and research, reply reading and backlink checks keep running. The dashboard's ■ Stop button pauses the whole schedule. Previously accepted messages may still be retried by Gmail; the brake only controls new Autopilot sends.

## Recipient eligibility

The built-in Gmail sender requires all of the following before opening SMTP:

1. The address is literally published on a current first-party publisher page. It is never constructed from a name, role or guessed address pattern.
2. The published context identifies an editorial route or matching author. Rank a named author first, an editorial inbox next, an explicitly designated generic editorial route after that. **Owner decision (Nov 2026):** as a last resort, when none of those exist, a general inbox (`hello`, `hi`, `contact`, `info`, `team`, `mail`, `office`, `enquiries`) on the publisher's own domain that is published on its own contact or about page may be used (rank 60), still subject to every rule below (mailbox check must be Deliverable; catch-all never passes). Do not use support, sales, privacy, feedback, free-webmail or unrelated third-party addresses.
3. The destination domain passes the DNS check. Null MX, unresolved DNS and absent explicit MX are held, not treated as mailbox existence. Some domains can receive mail without explicit MX; the conservative policy deliberately holds them.
4. A real mailbox verifier gives a complete positive verdict for that exact email, checked within 24 hours. Catch-all, unknown, pending, blocked, disposable, malformed and error responses never authorize a send.
5. The address and publisher are not suppressed, and the reply scan completed successfully with a current cursor. A backlog is a reason to hold, not to ignore old opt-outs.
6. The recipient is checked again for every follow-up. Do not silently change contacts in an existing conversation.

The `RecipientVerifier` uses bounded first-party page fetches and at most three verified contact candidates per prospect. It does not scrape a third-party contact directory or probe mailbox permutations.

## Provider configuration (not enabled by this repair)

Set these in GitHub Actions settings, never in public files or issues:

| Type | Name | Requirement |
| --- | --- | --- |
| Secret | `HUNTER_API_KEY` | Real Hunter account key; the public dummy test key is rejected. |
| Variable | `EMAIL_VERIFICATION_ENABLED` | `YES` only after the owner authorizes verification requests. Default `NO`. |
| Variable | `EMAIL_VERIFY_DAILY_LIMIT` | Owner-approved positive integer attempt cap; maximum 100. Default `0`. |

### Verifalia (primary, free) and Hunter (fallback)

| Type | Name | Requirement |
| --- | --- | --- |
| Secret | `VERIFALIA_USERNAME` / `VERIFALIA_PASSWORD` | A Verifalia user (preferably a dedicated sub-user). HTTP Basic auth header; never in URLs. |
| Variable | `VERIFALIA_QUALITY` | `Standard` (1 credit), `High` (2, default) or `Extreme` (4). |
| Variable | `VERIFALIA_ALLOW_PAID` | `YES` lets checks use purchased credit packs. Default: free daily credits only, read from `/credits/balance` before any submission, so verification cannot cost money. |

A send needs `classification=Deliverable`, `status=Success` and no disposable flag, for the exact address. `ServerIsCatchAll`, `Risky` and `Unknown` hold; `Undeliverable` suppresses the address. Each finished job is deleted from Verifalia right after it is read. A submission is never re-sent after an uncertain network error. Credit savers: catch-all domains are remembered for 90 days and skipped (no provider can prove an inbox there), inconclusive answers are not re-bought for 3 days, and checks happen only at send time for the highest-ranked prospect inside its send window. Hunter is called only when Verifalia has no free credits left that day or is unavailable. The owner's daily cap covers both providers.

The dashboard (⚙ Connect) can store the key as the `HUNTER_API_KEY` secret and the daily limit in the encrypted `LINKFORGE_SETTINGS` secret. A limit above 0 records the owner's opt-in (`EMAIL_VERIFICATION_ENABLED=YES`), and 0 turns it off. Dashboard settings take precedence over repository variables. Without a usable verifier the outreach stage is skipped and reports why: no page fetches, no provider calls, no mail. This does not lift the workflow's outbound hold.

The adapter uses the official `https://api.hunter.io/v2/email-verifier` endpoint with `X-API-KEY`. API keys do not go into URLs or logs. A provider response is not an inbox-placement guarantee. Provider costs are separate from DataForSEO costs; no paid calls are made without the opt-in and budget. Attempts are counted even on timeout; uncertain requests are not automatically retried. Usage is stored with the encrypted state at the normal cycle checkpoint, so the counter is not a crash-proof transactional billing ledger.

## Replies and recovery

The reader uses Gmail's All Mail special-use mailbox when exposed, falling back to INBOX. It processes bounded oldest-first batches with a mailbox/UIDVALIDITY-scoped cursor; it excludes the sender's own messages. Incomplete scans hold new sends until caught up. It reads a bounded body and handles common plain-text, HTML, base64, quoted-printable and multipart messages; this remains a bounded parser, not a claim to support every possible MIME message.

Historical bounce records restore address suppression. Queues previously switched to an alternate inbox are quarantined. A delivery failure never starts outreach to another person automatically. Temporary delay is recorded separately from a hard failure. A later `no` or unsubscribe reply remains actionable even when the sender and subject repeat or a placement was already marked won.

Initial messages and follow-ups share the daily limit. Transport errors with an uncertain delivery outcome become held records rather than automatic retries. SMTP acceptance does not prove recipient delivery.

## Production release checklist

- Full repository build, Node tests, Python GSC tests and secret guards must pass.
- Keep the separate workflow safety hold after merging this repair.
- Verify a real provider response for an owner-approved address, without sending outreach.
- Review the existing queued contacts and recorded hard failures through the new policy; keep unknown/catch-all addresses held.
- Verify the mailbox scan is complete and old suppressions are present.
- Only then explicitly approve a small controlled sending release and removal of the workflow hold.

No live messages or paid verification calls were performed to develop these tests. In-memory mailer injection is used by unit tests; the default production Gmail transport independently checks recipient proof before calling SMTP. Direct use of low-level `smtpSend` is not an authorized application sending path.

## Rollback

Revert the recipient-safety PR to restore the previous implementation, but retain commit `c260b8e20734a9c717dec2beebb118934504c0a6` (the separate outbound hold). Do not reset the vault, remove suppressions, rotate credentials or re-enable sending as part of rollback. PR #25 contains separate dashboard/backlink changes and must be reconciled rather than blindly merged over these files.
