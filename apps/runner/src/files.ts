// Site file manager over SFTP (A179). Every path is resolved under the environment's wpPath;
// file bodies are never logged.
import {
  FILES_MAX_BYTES,
  FILES_MAX_LIST,
  FileName,
  isSecretRelPath,
  RelPath,
  type SiteFilesListResult,
  type SiteFilesMutateResult,
  type SiteFilesOp,
  type SiteFilesReadResult,
  type SshTarget,
} from "@ulixops/shared";
import { redact } from "./redact";
import type { SftpSession, SshSession } from "./ssh";

export type FilesJobResult =
  | ({ hostKeyMismatch: false; hostKey: string } & (
      | ({ kind: "list" } & SiteFilesListResult)
      | ({ kind: "read" } & SiteFilesReadResult)
      | ({ kind: "mutate" } & SiteFilesMutateResult)
    ))
  | { hostKeyMismatch: true; expected: string; presented: string };

function clean(message: string): string {
  return redact(message).slice(0, 500);
}

/** Join wpPath + relative path; RelPath already forbids `..` and absolute segments. */
export function resolveUnderWp(wpPath: string, rel: string): string {
  const root = wpPath.replace(/\/$/, "");
  const parsed = RelPath.parse(rel);
  return parsed ? `${root}/${parsed}` : root;
}

function entryKind(e: { isDirectory: boolean; isFile: boolean }): "file" | "dir" | "other" {
  if (e.isDirectory) return "dir";
  if (e.isFile) return "file";
  return "other";
}

function isBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true;
  try {
    const text = buf.toString("utf8");
    // eslint-disable-next-line no-control-regex -- detect non-text control bytes
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) return true;
    return Buffer.from(text, "utf8").equals(buf) === false;
  } catch {
    return true;
  }
}

export async function runSiteFiles(
  session: SshSession,
  target: SshTarget,
  op: SiteFilesOp,
  now: () => number = Date.now,
): Promise<FilesJobResult> {
  const started = now();
  const duration = () => now() - started;
  const fail = (detail: string): FilesJobResult => ({
    hostKeyMismatch: false,
    hostKey: session.hostKey,
    kind: "mutate",
    ok: false,
    detail: clean(detail),
    durationMs: duration(),
  });

  let sftp: SftpSession;
  try {
    sftp = await session.sftp();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  try {
    switch (op.kind) {
      case "list":
        return await listFiles(sftp, target, op.path, session.hostKey, duration);
      case "read":
        return await readFile(sftp, target, op.path, session.hostKey, duration);
      case "write":
        return await writeFile(sftp, target, op.path, op.contentBase64, session.hostKey, duration);
      case "mkdir":
        return await mkdir(sftp, target, op.path, session.hostKey, duration);
      case "delete":
        return await remove(sftp, target, op.path, op.recursive, session.hostKey, duration);
      case "rename":
        return await rename(sftp, target, op.from, op.to, session.hostKey, duration);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    sftp.close();
  }
}

async function listFiles(
  sftp: SftpSession,
  target: SshTarget,
  rel: string,
  hostKey: string,
  duration: () => number,
): Promise<FilesJobResult> {
  const full = resolveUnderWp(target.wpPath, rel);
  // One SFTP round trip: readdir itself proves the path is a directory (A183).
  let raw: Awaited<ReturnType<SftpSession["listDir"]>>;
  try {
    raw = await sftp.listDir(full);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    const message = error instanceof Error ? error.message : String(error);
    const missing =
      code === "ENOENT" ||
      code === "2" ||
      /no such file|not found/i.test(message);
    const notDir =
      code === "ENOTDIR" ||
      code === "20" ||
      /not a directory/i.test(message);
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: clean(notDir ? "Not a directory." : missing ? "Directory not found." : message),
      durationMs: duration(),
    };
  }
  const sorted = [...raw].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const truncated = sorted.length > FILES_MAX_LIST;
  const slice = truncated ? sorted.slice(0, FILES_MAX_LIST) : sorted;
  const entries = [];
  let skipped = 0;
  for (const e of slice) {
    const cleaned = e.name.replace(/\r/g, "").trim();
    const name = FileName.safeParse(cleaned);
    if (!name.success) {
      skipped += 1;
      continue; // skip names the hub cannot open later
    }
    entries.push({
      name: name.data,
      kind: entryKind(e),
      size: e.size,
      mtime: e.mtime,
    });
  }
  // Directory had entries but none were addressable — treat as a listing failure, not "empty".
  if (entries.length === 0 && (sorted.length > 0 || skipped > 0)) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: clean(
        `Found ${sorted.length} item${sorted.length === 1 ? "" : "s"} but none had names the hub can open.`,
      ),
      durationMs: duration(),
    };
  }
  return {
    hostKeyMismatch: false,
    hostKey,
    kind: "list",
    path: RelPath.parse(rel),
    entries,
    truncated,
    durationMs: duration(),
  };
}

async function readFile(
  sftp: SftpSession,
  target: SshTarget,
  rel: string,
  hostKey: string,
  duration: () => number,
): Promise<FilesJobResult> {
  if (!rel) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Choose a file, not the WordPress root.",
      durationMs: duration(),
    };
  }
  const full = resolveUnderWp(target.wpPath, rel);
  const info = await sftp.stat(full);
  if (!info || info.isDirectory) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: clean(info ? "That path is a directory." : "File not found."),
      durationMs: duration(),
    };
  }
  if (info.size > FILES_MAX_BYTES) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: `File is ${info.size} bytes; the hub only opens files up to ${FILES_MAX_BYTES} bytes. Download is not available for larger files yet.`,
      durationMs: duration(),
    };
  }
  const data = await sftp.readFile(full, FILES_MAX_BYTES);
  const binary = isBinary(data);
  const result: SiteFilesReadResult = {
    path: RelPath.parse(rel),
    size: data.length,
    binary,
    secret: isSecretRelPath(rel),
    content: binary ? data.toString("base64") : data.toString("utf8"),
    encoding: binary ? "base64" : "utf8",
    durationMs: duration(),
  };
  return { hostKeyMismatch: false, hostKey, kind: "read", ...result };
}

async function writeFile(
  sftp: SftpSession,
  target: SshTarget,
  rel: string,
  contentBase64: string,
  hostKey: string,
  duration: () => number,
): Promise<FilesJobResult> {
  if (!rel) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Cannot overwrite the WordPress root.",
      durationMs: duration(),
    };
  }
  let data: Buffer;
  try {
    data = Buffer.from(contentBase64, "base64");
  } catch {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Invalid file content encoding.",
      durationMs: duration(),
    };
  }
  if (data.length > FILES_MAX_BYTES) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: `Upload exceeds ${FILES_MAX_BYTES} bytes.`,
      durationMs: duration(),
    };
  }
  const full = resolveUnderWp(target.wpPath, rel);
  const parent = full.slice(0, full.lastIndexOf("/"));
  if (parent.length >= target.wpPath.replace(/\/$/, "").length) await sftp.mkdirp(parent);
  const existing = await sftp.stat(full);
  if (existing?.isDirectory) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "A directory already exists at that path.",
      durationMs: duration(),
    };
  }
  await sftp.writeFile(full, data);
  return {
    hostKeyMismatch: false,
    hostKey,
    kind: "mutate",
    ok: true,
    path: RelPath.parse(rel),
    bytes: data.length,
    durationMs: duration(),
  };
}

async function mkdir(
  sftp: SftpSession,
  target: SshTarget,
  rel: string,
  hostKey: string,
  duration: () => number,
): Promise<FilesJobResult> {
  if (!rel) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Cannot create the WordPress root.",
      durationMs: duration(),
    };
  }
  const full = resolveUnderWp(target.wpPath, rel);
  const existing = await sftp.stat(full);
  if (existing) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: existing.isDirectory
        ? "That folder already exists."
        : "A file already exists at that path.",
      durationMs: duration(),
    };
  }
  await sftp.mkdirp(full);
  return {
    hostKeyMismatch: false,
    hostKey,
    kind: "mutate",
    ok: true,
    path: RelPath.parse(rel),
    durationMs: duration(),
  };
}

async function remove(
  sftp: SftpSession,
  target: SshTarget,
  rel: string,
  recursive: boolean,
  hostKey: string,
  duration: () => number,
): Promise<FilesJobResult> {
  if (!rel) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Refused to delete the WordPress root.",
      durationMs: duration(),
    };
  }
  const full = resolveUnderWp(target.wpPath, rel);
  const info = await sftp.stat(full);
  if (!info) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Path not found.",
      durationMs: duration(),
    };
  }
  if (info.isDirectory && recursive) await sftp.rmTree(full);
  else await sftp.unlink(full);
  return {
    hostKeyMismatch: false,
    hostKey,
    kind: "mutate",
    ok: true,
    path: RelPath.parse(rel),
    durationMs: duration(),
  };
}

async function rename(
  sftp: SftpSession,
  target: SshTarget,
  from: string,
  to: string,
  hostKey: string,
  duration: () => number,
): Promise<FilesJobResult> {
  if (!from || !to) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Both paths are required.",
      durationMs: duration(),
    };
  }
  if (from === to) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: true,
      path: RelPath.parse(to),
      durationMs: duration(),
    };
  }
  const src = resolveUnderWp(target.wpPath, from);
  const dest = resolveUnderWp(target.wpPath, to);
  const info = await sftp.stat(src);
  if (!info) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Source not found.",
      durationMs: duration(),
    };
  }
  if (await sftp.stat(dest)) {
    return {
      hostKeyMismatch: false,
      hostKey,
      kind: "mutate",
      ok: false,
      detail: "Destination already exists.",
      durationMs: duration(),
    };
  }
  const parent = dest.slice(0, dest.lastIndexOf("/"));
  if (parent.length >= target.wpPath.replace(/\/$/, "").length) await sftp.mkdirp(parent);
  await sftp.rename(src, dest);
  return {
    hostKeyMismatch: false,
    hostKey,
    kind: "mutate",
    ok: true,
    path: RelPath.parse(to),
    durationMs: duration(),
  };
}
