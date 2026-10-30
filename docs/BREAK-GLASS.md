# Break-glass: manual site access when UlixOps is down

Use this only when UlixOps itself is unavailable (VPS down, Zero Trust outage, compromised hub) **and** a site needs urgent action. In every other case, use the hub so the action is audited.

## What must exist beforehand

Owned by an Admin and reviewed every quarter:

1. **Offline credential kit**, sealed and stored in two places (e.g. office safe and a second Admin's safe):
   - An Admin's password-manager and Infisical recovery details: the vault admin password (from `~/infisical-admin.txt` on the first deploy) and the `INFISICAL_ENCRYPTION_KEY` and `INFISICAL_AUTH_SECRET` lines of the server's `~/ulixops.env`. Without the encryption key, a vault backup can't be read.
   - An emergency SSH key pair registered with the WP Engine SSH Gateway (and with each non-WP Engine host), on an encrypted USB drive or hardware token. Its passphrase is stored separately from the drive.
   - WP Engine User Portal login for an Admin, with its 2FA recovery codes.
2. **Site access sheet** (printed, in the kit): for each site, the WP Engine install/environment name, the SSH host and user, and the WordPress path.
3. **Hub and vault database backups:** encrypted daily, stored off the VPS, with the decryption key in the kit. UlixOps's own SSH keys live only in the vault; break-glass uses the emergency key above, not those. On the VPS, schedule `scripts/backup-hub-db.sh` (needs `DATABASE_URL`, `HUB_BACKUP_DIR`, `HUB_BACKUP_PASSPHRASE`) via cron; copy dumps off-box.

## Procedure

1. **Declare it.** Tell the team (Slack, or phone if Slack is down) that break-glass is in use, by whom and why. Two people should be involved whenever possible.
2. **Open the kit** and note the date and time on the kit's log sheet.
3. **Connect to the site** directly with the emergency key:
   - WP Engine: `ssh -i <emergency-key> <environment>@<environment>.ssh.wpengine.net`
   - Other hosts: the SSH or SFTP details from the site access sheet.
4. **Stabilise the site** with the smallest change that works:
   - Broken plugin: `wp plugin deactivate <plugin-slug>`
   - No WP-CLI available: over SFTP, rename `wp-content/plugins/<plugin-slug>` to `<plugin-slug>.disabled` (WordPress then deactivates it).
   - Maintenance page: `wp maintenance-mode activate` (and `deactivate` when done).
   - Object cache: `wp cache flush`. On WP Engine, also clear caches in the User Portal.
   - Larger damage: restore a WP Engine backup point from the User Portal.
5. **Write down every action** as you go: time, site, command or click, result. This is imported into the UlixOps audit log once the hub is back.
6. **Check the site:** the homepage and `/wp-admin/` load without errors.

## Afterwards

1. Import the action log into the UlixOps audit log.
2. Rotate every credential that was taken out of the kit, and re-seal the kit.
3. If the hub was compromised, rotate **all** site keys and API tokens, then restore the hub from a backup taken before the compromise.
4. Hold a short review: why the hub was down, and what would have avoided break-glass.

## Hub SSH (ops, not site break-glass)

Live hub (AWS): `ssh -i ~/.ssh/ulixops_deploy_ed25519 -o IdentitiesOnly=yes ulixops@18.218.128.255`. App + env: `~/ulixops`, `~/ulixops.env`. See docs/DEPLOY.md and CLAUDE.md.

## Restoring the hub itself

1. Provision a fresh VPS (or repair the existing one) and restore Docker Compose from the repo.
2. Restore the latest good encrypted Postgres backup (key from the kit).
3. Reconnect the vault and Cloudflare Zero Trust, then confirm that logins (with 2FA) and the audit log work before resuming deployments.
