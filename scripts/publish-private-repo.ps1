# Publish only to a NEW private repository after the local GitHub CLI is authenticated.
# No password or token should ever be pasted into chat or committed to Git.
$ErrorActionPreference = 'Stop'
$Repo = 'douphealth/backlink-command-center'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git first.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Install GitHub CLI first.' }
gh auth status 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Sign in privately with gh auth login first.' }
gh repo view $Repo 1>$null 2>$null
if ($LASTEXITCODE -eq 0) { throw 'Target repo already exists. Refusing to overwrite.' }
@('.env','.env.worker','DataforSEO_API.txt','state/outreach.sqlite3','secrets/dataforseo-auth.txt') | ForEach-Object {
  if (Test-Path $_) { throw "Private file exists in source directory: $_" }
}
if (-not (Test-Path .git)) { git init -b main }
git add .
$staged = @(git diff --cached --name-only)
foreach ($file in $staged) {
  if ($file -match '(^|/)(\.env$|\.env\.worker$|DataforSEO_API\.txt$|secrets/|state/|.*\.sqlite3(-.*)?$)') {
    throw "Unsafe staged file; refusing to upload: $file"
  }
}
if ($staged.Count -gt 0) {
  git -c user.name='Portfolio Maintainer' -c user.email='noreply@users.noreply.github.com' commit -m 'Initialize private Backlink Command Center v2'
}
gh repo create $Repo --private --description 'Private evidence-first backlink outreach command center and cost-controlled worker' --source . --remote origin --push
if ($LASTEXITCODE -ne 0) { throw 'GitHub reported a repository creation/push failure.' }
gh repo view $Repo --json nameWithOwner,visibility,url
