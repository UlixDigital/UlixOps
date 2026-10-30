// Detect and clear WordPress's `.maintenance` lock file (A111).
// Core writes this during plugin/theme updates; a timed-out update can leave it behind.
// WP-CLI `maintenance-mode is-active` only reports true for ~10 minutes, so we also
// treat the file's presence as maintenance-on for inventory / Emergency recovery.
import { WpPath } from "@ulixops/shared";
import type { SftpSession } from "./ssh";

/** Absolute path to the install's `.maintenance` file (wpPath already allowlist-validated). */
export function maintenanceFilePath(wpPath: string): string {
  const root = WpPath.parse(wpPath).replace(/\/$/, "");
  return `${root}/.maintenance`;
}

export async function maintenanceFilePresent(sftp: SftpSession, wpPath: string): Promise<boolean> {
  const info = await sftp.stat(maintenanceFilePath(wpPath));
  return Boolean(info && !info.isDirectory);
}

/** Removes a leftover `.maintenance` file. Returns true when a file was deleted. */
export async function clearMaintenanceFile(sftp: SftpSession, wpPath: string): Promise<boolean> {
  const path = maintenanceFilePath(wpPath);
  const info = await sftp.stat(path);
  if (!info || info.isDirectory) return false;
  await sftp.unlink(path);
  return true;
}
