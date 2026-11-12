// Copy a site's code to local disk for the malware scanner (A138). `tar` streams from the site
// over SSH (argv only, read-only there) into TarToDisk, which writes regular files only, under
// one directory, within size limits. Links, devices and odd paths are never created.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Media, archives, fonts and logs the scanner skips anyway; leaving them out keeps copies small. */
const SKIP_EXTENSIONS = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "psd",
  "mp4",
  "m4v",
  "mov",
  "avi",
  "wmv",
  "webm",
  "mkv",
  "mp3",
  "m4a",
  "wav",
  "ogg",
  "flac",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  "tar",
  "sql",
  "wpress",
  "log",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
];
/** Caches and backup folders: large, regenerated, not site code. */
const SKIP_DIRS = [
  "./wp-content/cache",
  "./wp-content/uploads/cache",
  "./wp-content/updraft",
  "./wp-content/ai1wm-backups",
  "./wp-content/backups-dup-pro",
  "./wp-content/backup-db",
  "./wp-content/uploads/backwpup*",
  "*/node_modules",
  "*/.git",
];

/** argv for `tar` on the site: the WordPress root, minus the skips above. */
export function scanTarArgv(wpPath: string): string[] {
  return [
    "tar",
    "-C",
    wpPath,
    "-cf",
    "-",
    ...SKIP_DIRS.map((d) => `--exclude=${d}`),
    ...SKIP_EXTENSIONS.flatMap((ext) => [`--exclude=*.${ext}`, `--exclude=*.${ext.toUpperCase()}`]),
    ".",
  ];
}

export interface CopyLimits {
  maxFiles: number;
  maxTotalBytes: number;
  /** Bigger files are skipped (not copied), and counted. */
  maxFileBytes: number;
}

export const SCAN_COPY_LIMITS: CopyLimits = {
  maxFiles: 150_000,
  maxTotalBytes: 1_500_000_000,
  maxFileBytes: 20_000_000,
};

const BLOCK = 512;

/** A relative path we are willing to create, or null. */
export function safeRelativePath(raw: string): string | null {
  const name = raw
    .replace(/\0.*$/s, "")
    .replace(/^\.\/+/, "")
    .replace(/\\/g, "/");
  if (!name || name.startsWith("/") || name.length > 1000) return null;
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

function octal(field: Buffer): number {
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function paxPath(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Streaming ustar/GNU/pax reader that writes regular files under `root`. Feed chunks with
 * `push`; it answers "stop" once a limit is reached (the rest of the site is left out).
 */
export class TarToDisk {
  files = 0;
  bytes = 0;
  skippedLarge = 0;
  truncated = false;

  private buffer: Buffer = Buffer.alloc(0);
  private entry: {
    remaining: number;
    padding: number;
    kind: "file" | "longname" | "pax" | "skip";
    target: string | null;
    chunks: Buffer[];
    size: number;
  } | null = null;
  private longName: string | null = null;
  private ended = false;

  constructor(
    private readonly root: string,
    private readonly limits: CopyLimits = SCAN_COPY_LIMITS,
  ) {}

  async push(chunk: Buffer): Promise<"more" | "stop"> {
    if (this.ended || this.truncated) return "stop";
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.ended && !this.truncated) {
      if (this.entry) {
        if (this.entry.remaining > 0) {
          if (this.buffer.length === 0) break;
          const take = Math.min(this.entry.remaining, this.buffer.length);
          if (this.entry.kind !== "skip") this.entry.chunks.push(this.buffer.subarray(0, take));
          this.buffer = this.buffer.subarray(take);
          this.entry.remaining -= take;
          if (this.entry.remaining > 0) break;
        }
        if (this.buffer.length < this.entry.padding) break;
        this.buffer = this.buffer.subarray(this.entry.padding);
        await this.finishEntry(this.entry);
        this.entry = null;
        continue;
      }
      if (this.buffer.length < BLOCK) break;
      const header = this.buffer.subarray(0, BLOCK);
      this.buffer = this.buffer.subarray(BLOCK);
      if (header.every((b) => b === 0)) {
        this.ended = true;
        break;
      }
      this.entry = this.startEntry(header);
    }
    return this.ended || this.truncated ? "stop" : "more";
  }

  private startEntry(header: Buffer) {
    const size = octal(header.subarray(124, 136));
    const type = header[156] ?? 0;
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    const base = { remaining: size, padding, chunks: [] as Buffer[], size };
    if (type === 76 /* L */) return { ...base, kind: "longname" as const, target: null };
    if (type === 120 /* x */ || type === 88 /* X */)
      return { ...base, kind: "pax" as const, target: null };
    const nameRaw =
      this.longName ??
      `${header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "")}${
        header.subarray(345, 500)[0] ? "/" : ""
      }${header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "")}`;
    this.longName = null;
    // Regular files only: links, devices, fifos and directories are never created.
    const regular = type === 0 || type === 48; /* '0' */
    if (!regular) return { ...base, kind: "skip" as const, target: null };
    const rel = safeRelativePath(nameRaw);
    if (!rel || size > this.limits.maxFileBytes) {
      if (rel) this.skippedLarge++;
      return { ...base, kind: "skip" as const, target: null };
    }
    if (this.files + 1 > this.limits.maxFiles || this.bytes + size > this.limits.maxTotalBytes) {
      this.truncated = true;
      return { ...base, kind: "skip" as const, target: null };
    }
    return { ...base, kind: "file" as const, target: rel };
  }

  private async finishEntry(entry: NonNullable<TarToDisk["entry"]>) {
    const data = Buffer.concat(entry.chunks);
    if (entry.kind === "longname") {
      this.longName = data.toString("utf8").replace(/\0.*$/s, "");
      return;
    }
    if (entry.kind === "pax") {
      this.longName = paxPath(data.toString("utf8"));
      return;
    }
    if (entry.kind !== "file" || !entry.target) return;
    const full = path.resolve(this.root, entry.target);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) return;
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, data, { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
      // A duplicate entry (tar can list a file twice) keeps the first copy.
      if ((error as { code?: string }).code !== "EEXIST") throw error;
    });
    this.files++;
    this.bytes += data.length;
  }
}
