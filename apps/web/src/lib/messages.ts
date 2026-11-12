import type { AuthErrorCode } from "@ulixops/shared";

const MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  forbidden: "Your role can't do that.",
  not_found: "That no longer exists. Refresh the page.",
  email_taken: "Someone with that email already has an account.",
  cannot_change_self: "You can't change your own role or access. Ask another Admin.",
  last_admin: "UlixOps needs at least one active Admin.",
  needs_admin_2fa: "Only an Admin with two-factor authentication set up can become a Super Admin.",
  invalid_entries: "Some entries aren't valid IP addresses or ranges.",
  would_lock_you_out:
    "That list doesn't include your current IP address, so saving it would lock you out. Add your IP first.",
  session_invalid: "Your session ended. Sign in again.",
  session_expired_idle: "Your session ended after 30 minutes without activity. Sign in again.",
  session_expired_absolute: "Your session reached its 12-hour limit. Sign in again.",
  url_taken: "Another site already uses that production URL.",
  name_taken: "The vault already has a key with that name. Choose another name.",
  already_pending:
    "That change is already waiting on Approvals. Open Approvals to approve or reject it (a Super Admin can approve their own).",
  already_enabled: "Scheduled updates are already on for the chosen sites.",
  bulk_update_active:
    "That bulk update was already approved (or is still running) for the same plugins/themes. Wait for it to finish, or refresh the inventory. Use single Update to retry one item.",
  runner_unavailable: "The runner didn't answer in time. Check that it's running, then try again.",
  runner_failed: "The runner couldn't finish that. Try again, or check the runner logs.",
  out_of_date: "The site changed after this was requested, so the request was closed. Ask again.",
  own_request: "You made this request, so another Admin must decide it.",
  already_decided: "Someone already decided this request.",
  connection_untested:
    "Run Test connection first: UlixOps only runs commands once the server's host key is pinned.",
  approval_required:
    "This key change needs a second Admin's approval first, or the approval has expired or was already used. Request it again.",
  invalid_key:
    "That doesn't look like an API key: use 16–300 letters, digits, dots, dashes or underscores, with no spaces.",
  vault_unavailable: "The vault couldn't be reached, so nothing was saved. Try again in a minute.",
  backup_pending: "This site is already queued or being backed up.",
  backup_finished: "That backup has already finished.",
  drive_not_connected:
    "Google Drive isn't connected yet. Connect it on Backups → Full backups first.",
  backup_not_ready:
    "That backup is no longer on Google Drive (a newer one replaced it, or it expired). Refresh the page and pick another.",
  confirm_mismatch: "The name you typed doesn't match the site's name, so nothing was started.",
  restore_pending:
    "A restore of this site is already waiting for approval, queued or running. Wait for it to finish.",
  logging_not_managed:
    "UlixOps isn't managing error logging on this site, so there's nothing to switch off. Use Switch logging on first.",
  site_address_invalid:
    "One of the two environments has a URL UlixOps can't use to change the site address. Check both URLs on the site's page.",
  restore_started: "That restore has already started or finished, so it can't be cancelled.",
  dns_token_missing:
    "No Cloudflare API token yet. An Admin adds it in Settings → Credentials (another Admin approves).",
  dns_busy: "Another change to this domain is still running. Wait a moment, then try again.",
  dns_failed: "Cloudflare refused that. Its reason is in the domain's change history below.",
  record_outside_zone:
    "That name isn't inside this domain. Use @, a subdomain like www, or a full name ending in the domain.",
  record_not_managed:
    "UlixOps only edits A, AAAA, CNAME, TXT and MX records. Change other types in Cloudflare.",
  check_running:
    "A file integrity check is already running on this site. It takes a minute or two.",
  expiry_running:
    "A certificate and domain check is already running. It takes under a minute; the page updates on its own.",
  uptime_running:
    "An uptime check is already running. It takes a few seconds; the page updates on its own.",
  uptime_paused:
    "Uptime monitoring is paused for this site. An Admin can resume it on the site's Uptime & SSL tab.",
  scan_finished: "That scan has already finished.",
  alert_state:
    "Someone else already moved this alert on (or it was closed). Refresh to see where it is now.",
  scan_pending: "This site is already queued or being scanned.",
  scan_running:
    "A malware scan is already running (one at a time across all sites). Try again when it finishes.",
  still_active:
    "Only inactive plugins and themes can be deleted. Deactivate the plugin (or switch theme in WordPress) first, then refresh the inventory.",
  sync_running:
    "A vulnerability feed sync is already running. Its result appears here when it ends.",
  site_busy: "Another command is still running on this environment. Wait for it, then try again.",
  site_archived: "This site is archived. Restore it before running commands on it.",
  no_snapshot: "There is no quick snapshot to roll back to yet. Take one before an update.",
  snapshot_missing: "That snapshot's file is gone from the store. It may have expired.",
  plugin_not_in_inventory: "Refresh the inventory first so UlixOps knows that plugin is installed.",
  theme_not_in_inventory: "Refresh the inventory first so UlixOps knows that theme is installed.",
  no_update_available: "No update is available for that plugin on this site.",
  no_updates_available: "Nothing in this environment has an update available.",
  no_inventory: "Read the inventory first so UlixOps knows what is installed.",
  google_drive_unavailable:
    "Google Drive full backups are not configured yet. Use Snapshots, or set up Drive later.",
  version_exists:
    "That version is already in the registry. Raise the Version header and upload again.",
  upload_expired: "That upload expired or isn't yours. Check the ZIP again.",
  upload_invalid:
    "The checked file changed before it was saved, so nothing was saved. Upload it again.",
};

export function errorMessage(error: AuthErrorCode): string {
  return MESSAGES[error] ?? "Something went wrong. Try again.";
}
