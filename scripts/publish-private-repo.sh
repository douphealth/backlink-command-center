#!/bin/sh
# This script creates a NEW PRIVATE repository only when an existing gh login is available.
# It never uploads secret files, SQLite data, or previously contacted editorial records.
set -eu
REPO='douphealth/backlink-command-center'
command -v git >/dev/null 2>&1 || { echo 'Git CLI required'; exit 2; }
command -v gh >/dev/null 2>&1 || { echo 'GitHub CLI required'; exit 2; }
gh auth status >/dev/null 2>&1 || { echo 'Sign in privately with gh auth login first'; exit 2; }
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo 'Target repository already exists; refusing to overwrite or merge it automatically.'
  exit 3
fi
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
for secret in .env .env.worker DataforSEO_API.txt state/outreach.sqlite3 secrets/dataforseo-auth.txt; do
  if [ -e "$secret" ]; then
    echo "Private file '$secret' is present. Remove it from the source checkout before publishing."
    exit 4
  fi
done
if [ ! -d .git ]; then git init -b main; fi
git add .
if git diff --cached --name-only | grep -Ei '(^|/)(\.env$|\.env\.worker$|DataforSEO_API\.txt$|secrets/|state/|.*\.sqlite3(-.*)?$)' >/dev/null; then
  echo 'Unsafe staged file; aborting before any upload.'
  exit 5
fi
if ! git diff --cached --quiet; then
  git -c user.name='Portfolio Maintainer' -c user.email='noreply@users.noreply.github.com' commit -m 'Initialize private Backlink Command Center v2'
fi
gh repo create "$REPO" --private --description 'Private evidence-first backlink outreach command center and cost-controlled worker' --source=. --remote=origin --push
gh repo view "$REPO" --json nameWithOwner,visibility,url
