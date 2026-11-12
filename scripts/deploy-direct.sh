#!/bin/sh
# Deploy the local working tree straight to the UlixOps AWS VPS over SSH — no git required.
#   DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy-direct.sh
#
# Syncs the project (excluding secrets, node_modules, build output, .git) via rsync/SSH,
# then builds/restarts the production compose stack. Runtime secrets stay only in
# ~/ulixops.env on the server. Use this when there is no GitHub remote / local .git.
set -eu

: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. DEPLOY_HOST=ulixops@18.218.128.255}"
key="${DEPLOY_KEY:-$HOME/.ssh/ulixops_deploy_ed25519}"
root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

if [ ! -f "$key" ]; then
  echo "deploy-direct: missing deploy key at $key" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "deploy-direct: rsync is required on this machine" >&2
  exit 1
fi

remote() { ssh -i "$key" -o IdentitiesOnly=yes "$DEPLOY_HOST" "$@"; }
rsync_ssh() { ssh -i "$key" -o IdentitiesOnly=yes "$@"; }

rev="direct-$(date -u +%Y%m%dT%H%M%SZ)"

echo "deploy-direct: checking the server env file (missing secrets are generated on the server)"
remote 'set -eu; umask 077; touch ~/ulixops.env
  add() { if ! grep -q "^$1=." ~/ulixops.env; then echo "$1=$2" >> ~/ulixops.env; echo "deploy: generated $1"; fi; }
  for name in POSTGRES_PASSWORD APP_DB_PASSWORD REDIS_PASSWORD TEST_WP_DB_PASSWORD SESSION_SECRET \
    TOTP_ENCRYPTION_KEY SNAPSHOT_ENCRYPTION_KEY INFISICAL_DB_PASSWORD INFISICAL_REDIS_PASSWORD; do
    add "$name" "$(openssl rand -hex 32)"
  done
  add INFISICAL_ENCRYPTION_KEY "$(openssl rand -hex 16)"
  add INFISICAL_AUTH_SECRET "$(openssl rand -base64 32)"'

if ! remote 'grep -q "^CLOUDFLARE_TUNNEL_TOKEN=." ~/ulixops.env'; then
  token_file="$root/.dev/cloudflare-tunnel-token"
  if [ ! -s "$token_file" ]; then
    echo "deploy-direct: needs the Cloudflare tunnel token in .dev/cloudflare-tunnel-token" >&2
    exit 1
  fi
  echo "deploy-direct: adding the Cloudflare tunnel token to the server env file"
  remote 'set -eu; umask 077; token="$(tr -d "[:space:]")"
    echo "CLOUDFLARE_TUNNEL_TOKEN=$token" >> ~/ulixops.env' < "$token_file"
fi

echo "deploy-direct: syncing local tree → $DEPLOY_HOST ($rev) [no git]"
remote 'rm -rf ~/ulixops.next; mkdir -p ~/ulixops.next'
rsync -a --delete \
  -e "ssh -i $key -o IdentitiesOnly=yes" \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '.next/' \
  --exclude 'coverage/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.dev/' \
  --exclude 'apps/api/src/generated/' \
  --exclude '.cursor/' \
  --exclude 'agent-transcripts/' \
  --exclude '*.pem' \
  --exclude '*.key' \
  --exclude '*_ed25519' \
  --exclude '*_ed25519.pub' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  "$root/" "$DEPLOY_HOST:ulixops.next/"

remote "set -eu
  rm -rf ~/ulixops.old
  if [ -d ~/ulixops ]; then mv ~/ulixops ~/ulixops.old; fi
  mv ~/ulixops.next ~/ulixops
  echo $rev > ~/ulixops/REVISION
  cd ~/ulixops
  docker compose --env-file ~/ulixops.env -f docker-compose.yml -f docker-compose.prod.yml \
    up -d --build --remove-orphans
  # Runner/API run as uid 1000 (node). Named volumes are root-owned on first create;
  # without this, snapshot writes and visual checks fail with EACCES (A100, A163).
  # Must use a plain container: the runner service drops CAP_CHOWN.
  proj=\"\$(basename \"\$PWD\")\"
  docker run --rm \
    -v \"\${proj}_snapshot-store:/data/snapshots\" \
    -v \"\${proj}_plugin-store:/data/plugins\" \
    -v \"\${proj}_visual-work:/visual-work\" \
    -v \"\${proj}_visual-store:/data/visual\" \
    alpine:3.20 \
    sh -c 'chown -R 1000:1000 /data/snapshots /data/plugins /visual-work /data/visual && chmod 750 /data/snapshots /data/plugins /visual-work /data/visual'
  docker compose --env-file ~/ulixops.env -f docker-compose.yml -f docker-compose.prod.yml ps"

if ! remote 'grep -q "^INFISICAL_CLIENT_ID=." ~/ulixops.env'; then
  : "${VAULT_ADMIN_EMAIL:?first deploy: set VAULT_ADMIN_EMAIL to the vault admin's email}"
  case "$VAULT_ADMIN_EMAIL" in
    *[!A-Za-z0-9@._+-]* | *@*@* | @* | *@) echo "deploy-direct: VAULT_ADMIN_EMAIL is not a plain email address" >&2; exit 1 ;;
    *@*) ;;
    *) echo "deploy-direct: VAULT_ADMIN_EMAIL is not a plain email address" >&2; exit 1 ;;
  esac
  echo "deploy-direct: setting up the vault (first deploy)"
  remote "set -eu; umask 077; cd ~/ulixops
    rm -rf ~/vault-setup; mkdir ~/vault-setup
    docker compose --env-file ~/ulixops.env -f docker-compose.yml -f docker-compose.prod.yml \
      run --rm --no-deps --user \"\$(id -u):\$(id -g)\" -v ~/vault-setup:/out runner \
      node dist/vault-setup.js --url http://infisical:8080 --email '$VAULT_ADMIN_EMAIL' \
      --env-out /out/runner.env --admin-out /out/infisical-admin.txt
    cat ~/vault-setup/runner.env >> ~/ulixops.env
    mv ~/vault-setup/infisical-admin.txt ~/infisical-admin.txt
    rm -rf ~/vault-setup
    docker compose --env-file ~/ulixops.env -f docker-compose.yml -f docker-compose.prod.yml \
      up -d runner"
  echo "deploy-direct: vault ready. Move ~/infisical-admin.txt on the server to the password manager."
fi

echo "deploy-direct: $rev is running on $DEPLOY_HOST. Open https://ulixops.ulixdigital.com"
