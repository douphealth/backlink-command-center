$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
$conf = "workers/scheduler/wrangler.toml"
if (-not (Test-Path $conf)) { throw "Copy workers/scheduler/wrangler.example.toml to wrangler.toml and enter the real D1 ID." }
if (Select-String -Path $conf -Pattern "PASTE_REAL_D1_DATABASE_ID_HERE" -Quiet) { throw "The worker D1 database ID is not configured." }
npx wrangler deploy --config $conf
if ($LASTEXITCODE -ne 0) { throw "Cloudflare Worker deployment failed." }
