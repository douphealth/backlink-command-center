#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
CONF="workers/scheduler/wrangler.toml"
if [ ! -f "$CONF" ]; then
  echo "Copy workers/scheduler/wrangler.example.toml to workers/scheduler/wrangler.toml and set the D1 ID first." >&2
  exit 2
fi
if grep -q 'PASTE_REAL_D1_DATABASE_ID_HERE' "$CONF"; then
  echo "Please set your real D1 database ID in $CONF; no deployment attempted." >&2
  exit 2
fi
npx wrangler deploy --config "$CONF"
