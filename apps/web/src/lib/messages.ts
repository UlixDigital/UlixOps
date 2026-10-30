import type { AuthErrorCode } from "@ulixops/shared";

const MESSAGES: Partial<Record<AuthErrorCode, string>> = {
  forbidden: "Your role can't do that.",
  not_found: "That no longer exists. Refresh the page.",
  email_taken: "Someone with that email already has an account.",
  cannot_change_self: "You can't change your own role or access. Ask another Admin.",
  last_admin: "UlixOps needs at least one active Admin.",
  invalid_entries: "Some entries aren't valid IP addresses or ranges.",
  would_lock_you_out:
    "That list doesn't include your current IP address, so saving it would lock you out. Add your IP first.",
  session_invalid: "Your session ended. Sign in again.",
  session_expired_idle: "Your session ended after 30 minutes without activity. Sign in again.",
  session_expired_absolute: "Your session reached its 12-hour limit. Sign in again.",
  url_taken: "Another site already uses that production URL.",
  name_taken: "The vault already has a key with that name. Choose another name.",
  already_pending: "That change is already waiting for an Admin's decision.",
  bulk_update_active:
    "That bulk update was already approved (or is still running) for the same plugins/themes. Wait for it to finish, or refresh the inventory. Use single Update to retry one item.",
  runner_unavailable: "The runner didn't answer in time. Check that it's running, then try again.",
  runner_failed: "The runner couldn't finish that. Try again, or check the runner logs.",
  out_of_date: "The site changed after this was requested, so the request was closed. Ask again.",
  own_request: "You made this request, so another Admin must decide it.",
  already_decided: "Someone already decided this request.",
  connection_untested:
    "Run Test connection first: UlixOps only runs commands once the server's host key is pinned.",
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
