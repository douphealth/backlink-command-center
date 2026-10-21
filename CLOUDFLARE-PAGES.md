# This deployment guide is obsolete

LinkForge no longer needs Cloudflare Pages or a separate scheduled Worker. The current app deploys as **one Cloudflare Worker with static assets, D1 and a Cron Trigger**.

Read [README.md](README.md) or [DEPLOYMENT.md](DEPLOYMENT.md) for the **one-command deployment**:

```bash
npm run deploy
```

No manual D1 creation, Pages binding, Cloudflare Zero Trust application, Access audience tag, or administrator password is necessary. The deployment command prints the new `workers.dev` app URL and automatically creates a high-entropy private sign-in code. Use the new URL rather than the old `pages.dev` URL.
