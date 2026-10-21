#!/bin/sh
# Run as root ON THE AUTHORIZED VPS. Never prints or stores the secret in logs.
set -eu
if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this provisioning step with sudo on your VPS' >&2
  exit 1
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '%s\n' 'Usage: sudo sh provision-dataforseo-secret.sh SOURCE_TXT [DEST_TXT]' >&2
  exit 2
fi
source_file=$1
secret_file=${2:-/srv/portfolio-pr/secrets/dataforseo-auth.txt}
if [ ! -f "$source_file" ]; then
  printf '%s\n' 'Source credential file missing' >&2
  exit 3
fi
secret_dir=$(dirname -- "$secret_file")
install -d -m 0700 -o root -g root -- "$secret_dir"
install -m 0640 -o root -g 65534 -- "$source_file" "$secret_file"
printf '%s\n' 'DataForSEO secret provisioned (contents not printed); paid calls remain disabled.'
