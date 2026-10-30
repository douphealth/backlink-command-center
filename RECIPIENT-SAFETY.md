# Recipient safety repair

## Current containment

The production Autopilot workflow forces `OUTREACH_MODE=off` inside `LINKFORGE_SETTINGS`. This takes precedence over older repository variables and dashboard settings. Research, reply reading and backlink checks remain available. Do not remove this hold merely because tests are green. Previously accepted messages may still be retried by Gmail; this hold only controls new Autopilot sends.

## Recipient eligibility

The built-in Gmail sender requires all of the following before opening SMTP:

1. The address is literally published on a current first-party publisher page. It is never constructed from a name, role or guessed address pattern.
2. The published context identifies an editorial route or matching author. Rank a named author first, an editorial inbox next, and an explicitly designated generic editorial route last. Do not use support, sales, privacy, feedback or unrelated third-party addresses.
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
