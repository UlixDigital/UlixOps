// Live malware scan progress (A143). The percentage is real: files copied (estimated against the
// site's last scan), then files ClamAV has checked.
import type { MalwareScanView } from "@ulixops/shared";
import { timeAgo } from "@/lib/format";

const PHASE_LABEL: Record<NonNullable<MalwareScanView["phase"]>, string> = {
  copying: "Copying the site's code",
  clamav: "ClamAV is checking files",
  yara: "Checking for webshells and backdoors",
};

const mb = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

export function ScanProgress({ scan }: { scan: MalwareScanView }) {
  const percent = scan.status === "RUNNING" ? scan.progress : 0;
  const phase = scan.phase ?? "copying";
  const line =
    phase === "copying"
      ? `${scan.files.toLocaleString()} files copied (${mb(scan.bytes)})`
      : phase === "clamav"
        ? `${scan.scannedFiles.toLocaleString()} of ${scan.files.toLocaleString()} files checked`
        : `Final check of ${scan.files.toLocaleString()} files`;
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{PHASE_LABEL[phase]}…</span>
        <span className="font-mono text-sm tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={`Malware scan of ${scan.siteName}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-150"
          style={{ width: `${Math.max(2, percent)}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {line} · started {timeAgo(scan.startedAt)}
      </p>
    </div>
  );
}
