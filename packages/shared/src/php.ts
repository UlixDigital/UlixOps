// PHP version tracker (Phase 2 step 1, A130).
// Support dates from https://www.php.net/supported-versions.php — add a row when a new branch ships.

/** Days before end of life that a branch counts as "ending". */
export const PHP_ENDING_DAYS = 180;

interface PhpBranch {
  branch: string;
  /** Last day of active support (bug fixes). */
  activeUntil: string;
  /** Last day of security fixes; after this the branch is end of life. */
  securityUntil: string;
}

/** Oldest first. Anything older than the first row is end of life. */
export const PHP_BRANCHES: readonly PhpBranch[] = [
  { branch: "7.4", activeUntil: "2021-11-28", securityUntil: "2022-11-28" },
  { branch: "8.0", activeUntil: "2022-11-26", securityUntil: "2023-11-26" },
  { branch: "8.1", activeUntil: "2023-11-25", securityUntil: "2025-12-31" },
  { branch: "8.2", activeUntil: "2024-12-31", securityUntil: "2026-12-31" },
  { branch: "8.3", activeUntil: "2025-12-31", securityUntil: "2027-12-31" },
  { branch: "8.4", activeUntil: "2026-12-31", securityUntil: "2028-12-31" },
  { branch: "8.5", activeUntil: "2027-12-31", securityUntil: "2029-12-31" },
];

export type PhpSupportStatus = "supported" | "security" | "ending" | "eol" | "unknown";

export interface PhpSupport {
  status: PhpSupportStatus;
  /** "8.2", or null when the version could not be read. */
  branch: string | null;
  /** Last day of security fixes (YYYY-MM-DD), when known. */
  securityUntil: string | null;
}

const VERSION = /^(\d{1,2})\.(\d{1,2})(?:\D|$)/;

function compareBranch(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** End of a YYYY-MM-DD day in UTC. */
function endOfDay(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}

/** Support status of a PHP version string such as "8.2.27" or "7.4.33-1+ubuntu". */
export function phpSupport(version: string | null | undefined, now: Date = new Date()): PhpSupport {
  const match = version ? VERSION.exec(version.trim()) : null;
  if (!match) return { status: "unknown", branch: null, securityUntil: null };
  const parsed: [number, number] = [Number(match[1]), Number(match[2])];
  const branch = `${parsed[0]}.${parsed[1]}`;
  const row = PHP_BRANCHES.find((b) => b.branch === branch);
  if (!row) {
    const first = PHP_BRANCHES[0];
    const older =
      first && compareBranch(parsed, first.branch.split(".").map(Number) as [number, number]) < 0;
    // Older than the table is end of life; newer means a release this table predates.
    return { status: older ? "eol" : "supported", branch, securityUntil: null };
  }
  const t = now.getTime();
  const securityEnd = endOfDay(row.securityUntil);
  let status: PhpSupportStatus;
  if (t > securityEnd) status = "eol";
  else if (securityEnd - t <= PHP_ENDING_DAYS * 86_400_000) status = "ending";
  else if (t > endOfDay(row.activeUntil)) status = "security";
  else status = "supported";
  return { status, branch, securityUntil: row.securityUntil };
}

/** True when the version needs attention: end of life or ending within PHP_ENDING_DAYS. */
export function phpNeedsUpgrade(
  version: string | null | undefined,
  now: Date = new Date(),
): boolean {
  const { status } = phpSupport(version, now);
  return status === "eol" || status === "ending";
}
