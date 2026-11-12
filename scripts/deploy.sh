#!/bin/sh
# Deploys the committed code (HEAD) to the UlixOps VPS and (re)starts the production stack.
#   DEPLOY_HOST=ulixops@18.218.128.255 sh scripts/deploy.sh
# The first run also sets up the vault and needs VAULT_ADMIN_EMAIL (the vault's admin account).
# Uses the deploy key ~/.ssh/ulixops_deploy_ed25519 unless DEPLOY_KEY points elsewhere.
#
# Only committed files are sent (git archive), so .env files, keys and editor settings never leave
# this machine (agent decision A20). On the first run the server env file is created on the
# server with freshly generated passwords; the Cloudflare tunnel token is read from the
# git-ignored .dev/cloudflare-tunnel-token and sent over SSH stdin, never on a command line.
set -eu

: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. DEPLOY_HOST=ulixops@18.218.128.255}"
key="${DEPLOY_KEY:-$HOME/.ssh/ulixops_deploy_ed25519}"
root="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"

remote() { ssh -i "$key" -o IdentitiesOnly=yes "$DEPLOY_HOST" "$@"; }

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy: commit your changes first (only committed code is deployed)" >&2
  exit 1
fi
rev="$(git rev-parse --short HEAD)"

# Agent decision A19: the hub's own runtime secrets live only in this server-side file (mode 600);
# site SSH keys live in the vault (A46). Each one is generated on the server the first time it
# is needed, so later steps can add secrets without touching existing ones. TEST_WP_DB_PASSWORD
# only lets compose parse the test-site services; the test site never runs on the server.
echo "deploy: checking the server env file (missing secrets are generated on the server)"
remote 'set -eu; umask 077; touch ~/ulixops.env
  add() { if ! grep -q "^$1=." ~/ulixops.env; then echo "$1=$2" >> ~/ulixops.env; echo "deploy: generated $1"; fi; }
  for name in POSTGRES_PASSWORD APP_DB_PASSWORD REDIS_PASSWORD TEST_WP_DB_PASSWORD SESSION_SECRET \
    TOTP_ENCRYPTION_KEY SNAPSHOT_ENCRYPTION_KEY INFISICAL_DB_PASSWORD INFISICAL_REDIS_PASSWORD; do
    add "$name" "$(openssl rand -hex 32)"
  done
  # Infisical wants a 128-bit hex key and a base64 secret.
  add INFISICAL_ENCRYPTION_KEY "$(openssl rand -hex 16)"
  add INFISICAL_AUTH_SECRET "$(openssl rand -base64 32)"'

if ! remote 'grep -q "^CLOUDFLARE_TUNNEL_TOKEN=." ~/ulixops.env'; then
  token_file="$root/.dev/cloudflare-tunnel-token"
  if [ ! -s "$token_file" ]; then
    echo "deploy: needs the Cloudflare tunnel token in .dev/cloudflare-tunnel-token" >&2
    exit 1
  fi
  echo "deploy: adding the Cloudflare tunnel token to the server env file"
  remote 'set -eu; umask 077; token="$(tr -d "[:space:]")"
    echo "CLOUDFLARE_TUNNEL_TOKEN=$token" >> ~/ulixops.env' < "$token_file"
fi

echo "deploy: sending $rev to $DEPLOY_HOST"
git archive --format=tar HEAD | remote \
  'set -eu; rm -rf ~/ulixops.next; mkdir -p ~/ulixops.next; tar -x -C ~/ulixops.next'

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
  # Must use a plain container: the runner service drops CAP_CHOWN and mounts plugins :ro.
  proj=\"\$(basename \"\$PWD\")\"
  docker run --rm \
    -v \"\${proj}_snapshot-store:/data/snapshots\" \
    -v \"\${proj}_plugin-store:/data/plugins\" \
    -v \"\${proj}_visual-work:/visual-work\" \
    -v \"\${proj}_visual-store:/data/visual\" \
    alpine:3.20 \
    sh -c 'chown -R 1000:1000 /data/snapshots /data/plugins /visual-work /data/visual && chmod 750 /data/snapshots /data/plugins /visual-work /data/visual'
  docker compose --env-file ~/ulixops.env -f docker-compose.yml -f docker-compose.prod.yml ps"

# First deploy only: claim the fresh vault and give the runner its machine identity. The vault
# admin password goes to ~/infisical-admin.txt (mode 600): move it to the password manager and
# delete the file. The runner's login is appended to the server env file; nothing is printed.
if ! remote 'grep -q "^INFISICAL_CLIENT_ID=." ~/ulixops.env'; then
  : "${VAULT_ADMIN_EMAIL:?first deploy: set VAULT_ADMIN_EMAIL to the vault admin's email}"
  # It is placed in a remote command line, so allow only plain address characters.
  case "$VAULT_ADMIN_EMAIL" in
    *[!A-Za-z0-9@._+-]* | *@*@* | @* | *@) echo "deploy: VAULT_ADMIN_EMAIL is not a plain email address" >&2; exit 1 ;;
    *@*) ;;
    *) echo "deploy: VAULT_ADMIN_EMAIL is not a plain email address" >&2; exit 1 ;;
  esac
  echo "deploy: setting up the vault (first deploy)"
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
  echo "deploy: vault ready. Move ~/infisical-admin.txt on the server to the password manager."
fi

echo "deploy: $rev is running. Open https://ulixops.ulixdigital.com (Cloudflare Access login first)."
