// File transfer over SSH exec when the SFTP subsystem is unavailable (WP Engine SSH Gateway, A99).
// Uses path-validated argv only: test/mkdir/mv/rm/cat/head/tail/dd/tar — never a free-form shell string.
import type { Client } from "ssh2";
import {
  MAX_SFTP_FILE_BYTES,
  MAX_SFTP_FILES,
  MAX_SFTP_TOTAL_BYTES,
  shellQuote,
  type SftpDirEntry,
  type SftpFile,
  type SftpSession,
} from "./ssh";
import { packTar, unpackTar } from "./tar";

export class ShellFs implements SftpSession {
  constructor(private readonly client: Client) {}

  async stat(remotePath: string): Promise<{ isDirectory: boolean; size: number } | null> {
    const path = safePath(remotePath);
    const isDir = await this.runOk(["test", "-d", path]);
    if (isDir) return { isDirectory: true, size: 0 };
    const isFile = await this.runOk(["test", "-f", path]);
    if (!isFile) return null;
    const sizeOut = await this.execText(["wc", "-c", path]);
    const size = Number.parseInt(sizeOut.stdout.trim().split(/\s+/)[0] ?? "", 10);
    return { isDirectory: false, size: Number.isFinite(size) ? size : 0 };
  }

  async readFile(remotePath: string, maxBytes = MAX_SFTP_FILE_BYTES): Promise<Buffer> {
    const path = safePath(remotePath);
    const result = await this.execBinary(["cat", "--", path], { maxStdout: maxBytes });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(result.stderr || `cat exit ${result.exitCode}`), {
        code: "ENOENT",
      });
    }
    if (result.stdout.length > maxBytes) throw new Error(`Remote file exceeds ${maxBytes} bytes`);
    return result.stdout;
  }

  async readFileHead(remotePath: string, maxBytes = MAX_SFTP_FILE_BYTES): Promise<Buffer> {
    const path = safePath(remotePath);
    // `head -c` reads the first N bytes; available on WP Engine's sandbox (A170).
    const result = await this.execBinary(["head", "-c", String(maxBytes), path], {
      maxStdout: maxBytes,
    });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(result.stderr || `head exit ${result.exitCode}`), {
        code: "ENOENT",
      });
    }
    return result.stdout;
  }

  async readFileTail(remotePath: string, maxBytes = MAX_SFTP_FILE_BYTES): Promise<Buffer> {
    const path = safePath(remotePath);
    // `tail -c` reads the last N bytes; available on WP Engine's sandbox.
    const result = await this.execBinary(["tail", "-c", String(maxBytes), path], {
      maxStdout: maxBytes,
    });
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(result.stderr || `tail exit ${result.exitCode}`), {
        code: "ENOENT",
      });
    }
    return result.stdout;
  }

  async writeFile(remotePath: string, data: Buffer): Promise<void> {
    if (data.length > MAX_SFTP_FILE_BYTES)
      throw new Error(`Upload exceeds ${MAX_SFTP_FILE_BYTES} bytes`);
    const path = safePath(remotePath);
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) await this.mkdirp(parent);
    const result = await this.execBinary(["dd", `of=${path}`, "bs=1M", "status=none"], {
      stdin: data,
      maxStdout: 1024,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || `dd exit ${result.exitCode}`);
  }

  async mkdirp(remotePath: string): Promise<void> {
    const path = safePath(remotePath);
    const result = await this.execText(["mkdir", "-p", "--", path]);
    if (result.exitCode !== 0) throw new Error(result.stderr || `mkdir exit ${result.exitCode}`);
  }

  async listDir(remotePath: string): Promise<SftpDirEntry[]> {
    const path = safePath(remotePath);
    // One argv round trip only — never `sh -c` (WP Engine wraps exec and breaks $1) (A180).
    let listed = await this.execText([
      "/bin/ls",
      "-la",
      "--time-style=+%s",
      "--color=never",
      "--",
      path,
    ]);
    if (listed.exitCode !== 0)
      listed = await this.execText(["/bin/ls", "-la", "--color=never", "--", path]);
    if (listed.exitCode !== 0) listed = await this.execText(["/bin/ls", "-la", "--", path]);
    if (listed.exitCode !== 0) listed = await this.execText(["ls", "-la", "--", path]);
    if (listed.exitCode !== 0) throw new Error(listed.stderr || `ls exit ${listed.exitCode}`);
    const parsed = parseLsLong(listed.stdout);
    if (parsed.length > 0 || /\btotal\s+0\b/i.test(listed.stdout)) return parsed;
    const namesOnly = await this.execText(["/bin/ls", "-1A", "--color=never", "--", path]);
    const names =
      namesOnly.exitCode === 0
        ? namesOnly
        : await this.execText(["/bin/ls", "-1A", "--", path]);
    if (names.exitCode !== 0) throw new Error(names.stderr || `ls exit ${names.exitCode}`);
    const out: SftpDirEntry[] = [];
    for (const raw of names.stdout.split("\n")) {
      const name = cleanListingName(raw);
      if (!name) continue;
      if (name.includes("..") || name.includes("/") || name.includes("\0"))
        throw new Error(`Refused remote name: ${name}`);
      out.push({ name, isDirectory: false, isFile: true, size: 0, mtime: null });
    }
    return out;
  }

  async readTree(remoteDir: string): Promise<SftpFile[]> {
    const path = safePath(remoteDir);
    const exists = await this.stat(path);
    if (!exists?.isDirectory) return [];
    let result: { exitCode: number; stdout: Buffer; stderr: string };
    try {
      result = await this.execBinary(["tar", "-C", path, "-cf", "-", "."], {
        maxStdout: MAX_SFTP_TOTAL_BYTES + BLOCK_SLACK,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Remote output exceeds ")) {
        throw new Error(
          `Plugin folder exceeds size limit (${MAX_SFTP_TOTAL_BYTES} bytes uncompressed tar cap)`,
          { cause: error },
        );
      }
      throw error;
    }
    if (result.exitCode !== 0) throw new Error(result.stderr || `tar exit ${result.exitCode}`);
    return unpackTar(result.stdout, MAX_SFTP_FILES, MAX_SFTP_TOTAL_BYTES);
  }

  async writeTree(remoteDir: string, files: readonly SftpFile[]): Promise<void> {
    const path = safePath(remoteDir);
    // Replace the tree atomically from the caller's point of view: never merge into leftovers
    // from a previous truncated extract (A102).
    await this.rmTree(path).catch(() => undefined);
    await this.mkdirp(path);
    const tar = packTar(files);
    if (tar.length > MAX_SFTP_TOTAL_BYTES + BLOCK_SLACK) {
      throw new Error("Plugin folder exceeds size limit");
    }
    const result = await this.execBinary(["tar", "-C", path, "-xf", "-"], {
      stdin: tar,
      maxStdout: 1024,
    });
    if (result.exitCode !== 0)
      throw new Error(result.stderr || `tar extract exit ${result.exitCode}`);
  }

  async rename(from: string, to: string): Promise<void> {
    const result = await this.execText(["mv", "-f", "--", safePath(from), safePath(to)]);
    if (result.exitCode !== 0) throw new Error(result.stderr || `mv exit ${result.exitCode}`);
  }

  async unlink(remotePath: string): Promise<void> {
    const path = safePath(remotePath);
    const result = await this.execText(["rm", "-f", "--", path]);
    if (result.exitCode !== 0) {
      const dir = await this.execText(["rmdir", "--", path]);
      if (dir.exitCode !== 0) throw new Error(result.stderr || `rm exit ${result.exitCode}`);
    }
  }

  async rmTree(remotePath: string): Promise<void> {
    const path = safePath(remotePath);
    if (!(await this.runOk(["test", "-e", path]))) return;
    const result = await this.execText(["rm", "-rf", "--", path]);
    if (result.exitCode !== 0) throw new Error(result.stderr || `rm -rf exit ${result.exitCode}`);
  }

  close(): void {
    // Uses the parent SSH session; nothing to end.
  }

  private async runOk(argv: string[]): Promise<boolean> {
    const result = await this.execText(argv);
    return result.exitCode === 0;
  }

  private execText(argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.execBinary(argv, { maxStdout: 1_000_000 }).then((r) => ({
      exitCode: r.exitCode,
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr,
    }));
  }

  private execBinary(
    argv: string[],
    opts: { stdin?: Buffer; maxStdout: number },
  ): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      this.client.exec(shellQuote(argv), (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        let stderr = "";
        const timer = setTimeout(() => {
          stream.close();
          reject(new Error("Remote file command timed out"));
        }, 120_000);
        stream.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > opts.maxStdout) {
            stream.close();
            clearTimeout(timer);
            reject(new Error(`Remote output exceeds ${opts.maxStdout} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < 50_000) stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ exitCode: code ?? -1, stdout: Buffer.concat(chunks), stderr });
        });
        stream.on("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
        if (opts.stdin) {
          stream.end(opts.stdin);
        } else {
          stream.end();
        }
      });
    });
  }
}

const BLOCK_SLACK = 64_000;

/** Absolute paths only; no traversal or shell metacharacters (argv is still POSIX-quoted). */
function safePath(remotePath: string): string {
  if (
    !remotePath.startsWith("/") ||
    remotePath.includes("..") ||
    remotePath.includes("\0") ||
    /[\s;|&$`<>"'\\]/.test(remotePath)
  ) {
    throw new Error(`Refused remote path: ${remotePath}`);
  }
  return remotePath;
}

/** Strip ANSI colour and CR so aliased/coloured ls output still yields real names. */
function cleanListingName(line: string): string {
  return line
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trim();
}

/**
 * Parse `ls -la` / `ls -la --time-style=+%s` lines into directory entries.
 * Exported for unit tests.
 */
export function parseLsLong(stdout: string): SftpDirEntry[] {
  const out: SftpDirEntry[] = [];
  // perm links owner group size [mtime-or-date…] name
  // With --time-style=+%s, mtime is one integer field; without it, date can be 2–3 fields —
  // so take size as field 5 and name as everything after the last size match via regex.
  const epochLine =
    /^([dl\-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d+)\s+(\S.*)$/;
  const dateLine =
    /^([dl\-])\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(?:\d{4}|\d{1,2}:\d{2})\s+(\S.*)$/;
  for (const raw of stdout.split("\n")) {
    const line = cleanListingName(raw);
    if (!line || line.startsWith("total ")) continue;
    let kindChar = "";
    let size = 0;
    let mtime: number | null = null;
    let name = "";
    const withEpoch = epochLine.exec(line);
    if (withEpoch) {
      kindChar = withEpoch[1] ?? "";
      size = Number.parseInt(withEpoch[2] ?? "0", 10);
      mtime = Number.parseInt(withEpoch[3] ?? "", 10);
      name = withEpoch[4] ?? "";
    } else {
      const withDate = dateLine.exec(line);
      if (!withDate) continue;
      kindChar = withDate[1] ?? "";
      size = Number.parseInt(withDate[2] ?? "0", 10);
      name = withDate[3] ?? "";
    }
    name = name.replace(/ -> .*$/, ""); // symlink target
    if (!name || name === "." || name === "..") continue;
    if (name.includes("/") || name.includes("\0") || name.includes(".."))
      throw new Error(`Refused remote name: ${name}`);
    const isDirectory = kindChar === "d";
    const isFile = kindChar === "-";
    out.push({
      name,
      isDirectory,
      isFile,
      size: Number.isFinite(size) ? size : 0,
      mtime: mtime !== null && Number.isFinite(mtime) ? mtime : null,
    });
  }
  return out;
}
