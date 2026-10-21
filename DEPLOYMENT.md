# One-Worker deployment guide

Use **one** Cloudflare Workers deployment, not a Cloudflare Pages deployment.

From an interactive computer with Node.js 22+:

```powershell
git clone https://github.com/douphealth/backlink-command-center.git
cd backlink-command-center
npm run deploy
```

The command automatically installs Wrangler if missing; Cloudflare sign-in opens in your browser if necessary. It creates the D1 database (binding `DB`), attaches the database, deploys the UI and API, configures the hourly Cron Trigger, and uploads two randomly generated secrets in the **same Worker deployment**.

At the end it prints the `https://...workers.dev` app URL and your 40-character sign-in code. Store the code safely. A local recovery copy is at `.linkforge/operator-credentials.json`; this path is gitignored. No Cloudflare Access settings, D1 binding settings or separate scheduler project is needed.

## Verification

1. Open the newly printed `workers.dev` URL. The page should say **Welcome back to LinkForge** and ask for **Private access code**, not show a D1/Access configuration checklist.
2. Paste your generated code **only into your app**. The overview should open even with zero imported prospects.
3. Open `/api/setup`; `database_bound`, `admin_login_ready`, and `auth_ready` should be `true`. This public readiness response does not show credentials.
4. The first Cron Trigger runs hourly. Until that first run, Operations correctly shows the worker offline; a queued task is not a completed task.
5. Check authenticated Operations/Activity for real D1 events and the heartbeat. No DataForSEO charges or emails should occur by default.

## If something fails

| Symptom | Action |
|---|---|
| Still seeing “Finish Cloudflare connection” | You opened the **old Cloudflare Pages URL**. Use the new `workers.dev` URL printed by `npm run deploy`. |
| `wrangler whoami` not authorized | The deploy command opens Cloudflare login; select the account that should own this app. |
| D1 auto-provision error | Check Cloudflare D1 availability/permissions in your account. The deployment stops safely; no substitute empty data is fabricated. |
| No sign-in code | Retrieve it from local `.linkforge/operator-credentials.json`; never paste it in chat. |
| Worker deployed, overview empty | D1 starts with no historical campaign records. This is expected until real campaigns run or history is securely imported. |
| Worker offline immediately after deploy | Scheduled job has not run. Wait up to one hour for its first Cron Trigger. |
| Paid DataForSEO requests not running | Paid calls are **deliberately disabled** and require separate explicit verification/opt-in. |
| Cloudflare Pages keeps redeploying the old app | The old Pages project is separate and not used by LinkForge v4. Disable/delete it **after** the new Worker works. |

### Recover access safely

The local `.linkforge/operator-credentials.json` file is your recovery record. Re-running `npm run deploy` from that same checkout reuses the code and retains operator sessions. To rotate your code after losing the local file, re-run the deployment from an authenticated Cloudflare account on a fresh checkout: that generates new secrets and invalidates old sessions. Do not send the code over email, chat or public GitHub issues.

### Continuous GitHub deployment (optional)

After first setup, Cloudflare **Workers & Pages → your Worker → Settings → Builds → Connect** can link it to `douphealth/backlink-command-center` for future Git pushes. Cloudflare stores Worker secrets separately and does not need them in Git. This optional convenience does not require changing the one-Worker architecture.
