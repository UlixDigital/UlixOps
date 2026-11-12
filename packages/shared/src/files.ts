// Site file manager over SSH/SFTP (A179). Paths are relative to the environment's wpPath.
import { z } from "zod";

/** Max entries returned by one directory listing. */
export const FILES_MAX_LIST = 500;
/** Max bytes for read / write / upload through the hub (1 MiB). */
export const FILES_MAX_BYTES = 1_048_576;
/** Base64 of FILES_MAX_BYTES, with a little headroom. */
export const FILES_MAX_BASE64 = Math.ceil((FILES_MAX_BYTES * 4) / 3) + 8;

/**
 * One path segment under wpPath: letters/digits/`_`/`.`/`-`, optional leading `.` for
 * `.env` / `.htaccess`. Never `.` or `..` alone.
 */
const SEG = /^(?:\.[A-Za-z0-9_-][A-Za-z0-9._-]*|[A-Za-z0-9_][A-Za-z0-9._-]*)$/;

/**
 * Relative path under wpPath: empty = the WordPress root; otherwise slash-separated
 * segments. No `..`, absolute paths, spaces, or empty segments.
 */
export const RelPath = z
  .string()
  .max(400)
  .refine((p) => p === "" || p.split("/").every((s) => SEG.test(s)), {
    message: "Invalid relative path",
  });
export type RelPath = z.infer<typeof RelPath>;

/** One path segment for create / rename targets. */
export const FileName = z.string().min(1).max(200).regex(SEG);
export type FileName = z.infer<typeof FileName>;

export const FileEntryKind = z.enum(["file", "dir", "other"]);
export type FileEntryKind = z.infer<typeof FileEntryKind>;

export const FileEntry = z.object({
  name: FileName,
  kind: FileEntryKind,
  size: z.number().int().nonnegative(),
  /** Unix seconds; null when the host did not report one. */
  mtime: z.number().int().nonnegative().nullable(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** Soft warning in the UI: editing these may expose or change secrets. Still allowed (A179). */
export function isSecretRelPath(rel: string): boolean {
  const base = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
  if (!base) return false;
  const lower = base.toLowerCase();
  if (lower === "wp-config.php" || lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower.endsWith(".pem") || lower.endsWith(".key")) return true;
  if (lower === "id_rsa" || lower.startsWith("id_rsa.") || lower === "id_ed25519") return true;
  if (lower === "authorized_keys" || lower === "known_hosts") return true;
  return false;
}

export const SiteFilesListResult = z.object({
  path: RelPath,
  entries: z.array(FileEntry).max(FILES_MAX_LIST),
  truncated: z.boolean(),
  durationMs: z.number(),
});
export type SiteFilesListResult = z.infer<typeof SiteFilesListResult>;

export const SiteFilesReadResult = z.object({
  path: RelPath,
  size: z.number().int().nonnegative(),
  /** true when the bytes are not valid UTF-8 (or contain NUL). */
  binary: z.boolean(),
  secret: z.boolean(),
  /** UTF-8 text when binary is false; otherwise base64 of the raw bytes. */
  content: z.string().max(FILES_MAX_BASE64),
  encoding: z.enum(["utf8", "base64"]),
  durationMs: z.number(),
});
export type SiteFilesReadResult = z.infer<typeof SiteFilesReadResult>;

export const SiteFilesOkResult = z.object({
  ok: z.literal(true),
  path: RelPath,
  bytes: z.number().int().nonnegative().optional(),
  durationMs: z.number(),
});
export type SiteFilesOkResult = z.infer<typeof SiteFilesOkResult>;

export const SiteFilesFailResult = z.object({
  ok: z.literal(false),
  detail: z.string().max(500),
  durationMs: z.number(),
});
export type SiteFilesFailResult = z.infer<typeof SiteFilesFailResult>;

export const SiteFilesMutateResult = z.discriminatedUnion("ok", [
  SiteFilesOkResult,
  SiteFilesFailResult,
]);
export type SiteFilesMutateResult = z.infer<typeof SiteFilesMutateResult>;

/** API list response (success or a redacted failure). */
export const SiteFilesListResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).merge(SiteFilesListResult),
  SiteFilesFailResult,
]);
export type SiteFilesListResponse = z.infer<typeof SiteFilesListResponse>;

/** API read response. */
export const SiteFilesReadResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).merge(SiteFilesReadResult),
  SiteFilesFailResult,
]);
export type SiteFilesReadResponse = z.infer<typeof SiteFilesReadResponse>;

/** Runner job op (A179). Content never goes into AuditLog. */
export const SiteFilesOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), path: RelPath }),
  z.object({ kind: z.literal("read"), path: RelPath }),
  z.object({
    kind: z.literal("write"),
    path: RelPath,
    contentBase64: z.string().max(FILES_MAX_BASE64),
  }),
  z.object({ kind: z.literal("mkdir"), path: RelPath }),
  z.object({
    kind: z.literal("delete"),
    path: RelPath,
    /** When true, remove a non-empty directory tree. */
    recursive: z.boolean(),
  }),
  z.object({ kind: z.literal("rename"), from: RelPath, to: RelPath }),
]);
export type SiteFilesOp = z.infer<typeof SiteFilesOp>;

/** API request bodies (web → API). */
export const FilesListQuery = z.object({ path: RelPath.default("") });
export const FilesWriteBody = z.object({
  path: RelPath,
  /** Prefer utf8 for text edits; base64 for binary uploads. */
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  content: z.string().max(FILES_MAX_BASE64),
});
export const FilesMkdirBody = z.object({ path: RelPath });
export const FilesDeleteBody = z.object({ path: RelPath, recursive: z.boolean().default(false) });
export const FilesRenameBody = z.object({ from: RelPath, to: RelPath });
