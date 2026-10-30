#!/usr/bin/env bash
# Encrypted daily backup of the UlixOps Postgres database (SPEC §5 break-glass, A93).
# Run from cron on the VPS (see docs/BREAK-GLASS.md). Never prints secrets.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${HUB_BACKUP_DIR:?HUB_BACKUP_DIR is required (e.g. /var/backups/ulixops)}"
: "${HUB_BACKUP_PASSPHRASE:?HUB_BACKUP_PASSPHRASE is required}"

mkdir -p "$HUB_BACKUP_DIR"
chmod 700 "$HUB_BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# pg_dump via URL; openssl AES-256-CBC with a passphrase from the break-glass kit.
pg_dump --no-owner --format=custom "$DATABASE_URL" >"$tmp"
openssl enc -aes-256-cbc -pbkdf2 -salt \
  -in "$tmp" \
  -out "$HUB_BACKUP_DIR/ulixops-${stamp}.dump.enc" \
  -pass "env:HUB_BACKUP_PASSPHRASE"
chmod 600 "$HUB_BACKUP_DIR/ulixops-${stamp}.dump.enc"

# Keep the last 14 encrypted dumps.
ls -1t "$HUB_BACKUP_DIR"/ulixops-*.dump.enc 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "hub backup written: ulixops-${stamp}.dump.enc"
