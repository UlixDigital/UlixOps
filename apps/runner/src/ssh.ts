// SSH to managed sites. The only place UlixOps opens a connection to a site (spec section 4).
import { createHash } from "node:crypto";
import type { ExecResult, SshTarget } from "@ulixops/shared";
import { Client, type SFTPWrapper } from "ssh2";

const MAX_OUTPUT_BYTES = 1_000_000;
/** Cap for a single SFTP file download/upload (quick snapshots of one plugin). */
export const MAX_SFTP_FILE_BYTES = 80_000_000;
export const MAX_SFTP_FILES = 8_000;
/** Total unpacked plugin/theme tree (Elementor and similar often exceed 80 MB — A109). */
export const MAX_SFTP_TOTAL_BYTES = 200_000_000;

/**
 * POSIX single-quoting. Every argument is already validated against the command allowlist;
 * quoting is a second barrier so nothing a remote shell might interpret survives.
 */
export function shellQuote(argv: readonly string[]): string {
  return argv.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}

/** OpenSSH-style fingerprint of a host key blob: SHA256:<base64 without padding>. */
export function fingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export class HostKeyMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly presented: string,
  ) {
    super(`Host key changed: expected ${expected}, server presented ${presented}`);
  }
}

export interface SftpFile {
  /** Path relative to the directory that was requested (forward slashes). */
  path: string;
  data: Buffer;
}

export interface SshSession {
  readonly hostKey: string;
  exec(argv: readonly string[], timeoutMs?: number): Promise<ExecResult>;
  /**
   * Run argv and hand stdout to `onChunk` as it arrives, pausing the remote side until each
   * chunk is handled (large transfers to disk, A138). Optional so test fakes can skip it.
   */
  execStream?(
    argv: readonly string[],
    onChunk: (chunk: Buffer) => Promise<"more" | "stop">,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stderr: string; stopped: boolean }>;
  /**
   * Run argv with `source` as its stdin, waiting for the remote side to take each piece
   * (restore, A152). `consumed` is false when the command ended before reading it all (tar
   * --occurrence stops once it has the file). Optional so test fakes can skip it.
   */
  execUpload?(
    argv: readonly string[],
    source: AsyncIterable<Buffer>,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stderr: string; consumed: boolean }>;
  /** Open an SFTP channel (ssh2 built-in; no extra dependency). */
  sftp(): Promise<SftpSession>;
  close(): void;
}

export interface SftpDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  /** Unix seconds; null when unknown. */
  mtime: number | null;
}

export interface SftpSession {
  /** Stat a path; null when it does not exist. */
  stat(remotePath: string): Promise<{ isDirectory: boolean; size: number } | null>;
  readFile(remotePath: string, maxBytes?: number): Promise<Buffer>;
  /** Read up to `maxBytes` from the start of a file (does not require the whole file to fit). */
  readFileHead(remotePath: string, maxBytes?: number): Promise<Buffer>;
  /** Read up to `maxBytes` from the end of a file (for log tails). */
  readFileTail(remotePath: string, maxBytes?: number): Promise<Buffer>;
  writeFile(remotePath: string, data: Buffer): Promise<void>;
  mkdirp(remotePath: string): Promise<void>;
  /** Non-recursive directory listing (A179 file manager). */
  listDir(remotePath: string): Promise<SftpDirEntry[]>;
  /** Recursively list and read every regular file under `remoteDir`. */
  readTree(remoteDir: string): Promise<SftpFile[]>;
  /** Write files under `remoteDir` (relative paths). Creates directories as needed. */
  writeTree(remoteDir: string, files: readonly SftpFile[]): Promise<void>;
  /** Rename; fails if the destination exists. */
  rename(from: string, to: string): Promise<void>;
  /** Remove a file or an empty directory. */
  unlink(remotePath: string): Promise<void>;
  /** Recursively delete a directory tree (only after path checks in the caller). */
  rmTree(remotePath: string): Promise<void>;
  close(): void;
}

export interface SshConnector {
  /** `secret` is a private key (default) or an SFTP password when `target.authMode === "password"` (A182). */
  connect(target: SshTarget, secret: string): Promise<SshSession>;
}

/** ssh2 with strict host key checking: the pinned key must match; unpinned keys are recorded. */
export const ssh2Connector: SshConnector = {
  connect(target, secret) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let presented: string | null = null;
      const auth =
        target.authMode === "password" ? { password: secret } : { privateKey: secret };
      client
        .on("ready", () =>
          resolve(new Ssh2Session(client, presented ?? "", Boolean(target.nativeSftpOnly))),
        )
        .on("error", (error) => {
          client.end();
          if (presented && target.hostKey && presented !== target.hostKey) {
            reject(new HostKeyMismatchError(target.hostKey, presented));
          } else {
            reject(error);
          }
        })
        .connect({
          host: target.host,
          port: target.port,
          username: target.user,
          ...auth,
          readyTimeout: 15_000,
          // Keep pooled Files sessions alive across folder clicks (A183); 0 used to drop idle sockets.
          keepaliveInterval: 15_000,
          hostVerifier: (key: Buffer) => {
            presented = fingerprint(key);
            return target.hostKey === null || presented === target.hostKey;
          },
        });
    });
  },
};

export class Ssh2Session implements SshSession {
  constructor(
    private readonly client: Client,
    readonly hostKey: string,
    private readonly nativeSftpOnly = false,
  ) {}

  exec(argv: readonly string[], timeoutMs = 60_000): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(shellQuote(argv), (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stdout = "";
        let stderr = "";
        const cap = (current: string, chunk: Buffer) =>
          current.length >= MAX_OUTPUT_BYTES
            ? current
            : (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
        const timer = setTimeout(() => {
          stream.close();
          reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
        stream
          .on("data", (chunk: Buffer) => {
            stdout = cap(stdout, chunk);
          })
          .on("close", (code: number | null) => {
            clearTimeout(timer);
            resolve({ exitCode: code ?? -1, stdout, stderr });
          });
        stream.stderr.on("data", (chunk: Buffer) => {
          stderr = cap(stderr, chunk);
        });
      });
    });
  }

  execStream(
    argv: readonly string[],
    onChunk: (chunk: Buffer) => Promise<"more" | "stop">,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stderr: string; stopped: boolean }> {
    return new Promise((resolve, reject) => {
      this.client.exec(shellQuote(argv), (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stderr = "";
        let stopped = false;
        let settled = false;
        let pending = Promise.resolve();
        const finish = (outcome: { code: number } | { error: Error }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(grace);
          if ("error" in outcome) reject(outcome.error);
          else
            resolve({
              exitCode: outcome.code,
              stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
              stopped,
            });
        };
        // Stop reading but keep draining: a paused channel never reports "close" (A142).
        const halt = () => {
          stream.resume();
          stream.close();
        };
        let grace: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          halt();
          finish({ error: new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} s`) });
        }, timeoutMs);
        stream.on("data", (chunk: Buffer) => {
          if (stopped || settled) return; // draining after stop: discard the rest
          stream.pause();
          pending = pending
            .then(() => onChunk(chunk))
            .then((next) => {
              if (next !== "stop") {
                stream.resume();
                return;
              }
              stopped = true;
              halt();
              // Some servers never send "close" once we stop reading; don't wait for it forever.
              grace = setTimeout(() => finish({ code: -1 }), 15_000);
            })
            .catch((err: unknown) => {
              halt();
              finish({ error: err instanceof Error ? err : new Error(String(err)) });
            });
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
        });
        stream.on("close", (code: number | null) => {
          void pending.then(() => finish({ code: code ?? -1 }));
        });
        stream.end();
      });
    });
  }

  execUpload(
    argv: readonly string[],
    source: AsyncIterable<Buffer>,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stderr: string; consumed: boolean }> {
    return new Promise((resolve, reject) => {
      this.client.exec(shellQuote(argv), (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        let stderr = "";
        let exitCode = -1;
        let closed = false;
        let wake: (() => void) | null = null;
        const exited = new Promise<void>((done) => {
          stream.on("close", (code: number | null) => {
            closed = true;
            exitCode = code ?? -1;
            wake?.();
            done();
          });
        });
        stream.on("data", () => undefined); // stdout isn't used; keep it flowing
        stream.on("drain", () => wake?.());
        stream.on("error", () => undefined); // writes after the remote end closed
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          stream.close();
        }, timeoutMs);
        const pump = async (): Promise<boolean> => {
          try {
            for await (const chunk of source) {
              if (closed) return false;
              if (!stream.write(chunk) && !closed)
                await new Promise<void>((go) => {
                  wake = go;
                });
              wake = null;
            }
          } catch (err) {
            stream.close();
            await exited;
            throw err;
          }
          if (!closed) stream.end();
          await exited;
          return true;
        };
        pump().then(
          (consumed) => {
            clearTimeout(timer);
            if (timedOut)
              reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} s`));
            else resolve({ exitCode, stderr: stderr.slice(0, MAX_OUTPUT_BYTES), consumed });
          },
          (err: unknown) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    });
  }

  sftp(): Promise<SftpSession> {
    return new Promise((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (!error && sftp) {
          resolve(new Ssh2Sftp(sftp));
          return;
        }
        if (this.nativeSftpOnly) {
          reject(
            new Error(
              error?.message ||
                "SFTP is not available on this host. Check the dedicated SFTP host/port (FileZilla settings), or clear Files SFTP and use SSH.",
            ),
          );
          return;
        }
        // WP Engine SSH Gateway (and some hosts) refuse the SFTP subsystem; fall back to
        // argv-only tar/cat/dd over the same SSH session (agent decision A99).
        void import("./shell-fs")
          .then(({ ShellFs }) => resolve(new ShellFs(this.client)))
          .catch(reject);
      });
    });
  }

  close() {
    this.client.end();
  }
}

class Ssh2Sftp implements SftpSession {
  constructor(private readonly sftp: SFTPWrapper) {}

  stat(remotePath: string): Promise<{ isDirectory: boolean; size: number } | null> {
    return new Promise((resolve, reject) => {
      this.sftp.stat(remotePath, (error, stats) => {
        if (error) {
          // ssh2 may use a numeric POSIX code or a Node string code.
          if (isMissing(error)) resolve(null);
          else reject(error);
          return;
        }
        resolve({ isDirectory: stats.isDirectory(), size: stats.size });
      });
    });
  }

  readFile(remotePath: string, maxBytes = MAX_SFTP_FILE_BYTES): Promise<Buffer> {
    return this.readFileRange(remotePath, 0, undefined, maxBytes);
  }

  async readFileHead(remotePath: string, maxBytes = MAX_SFTP_FILE_BYTES): Promise<Buffer> {
    const info = await this.stat(remotePath);
    if (!info) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    if (info.size === 0 || maxBytes <= 0) return Buffer.alloc(0);
    const length = Math.min(info.size, maxBytes);
    return this.readFileRange(remotePath, 0, length - 1, maxBytes);
  }

  async readFileTail(remotePath: string, maxBytes = MAX_SFTP_FILE_BYTES): Promise<Buffer> {
    const info = await this.stat(remotePath);
    if (!info) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const start = info.size > maxBytes ? info.size - maxBytes : 0;
    return this.readFileRange(remotePath, start, undefined, maxBytes);
  }

  private readFileRange(
    remotePath: string,
    start: number,
    end: number | undefined,
    maxBytes: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const stream = this.sftp.createReadStream(remotePath, {
        start,
        ...(end !== undefined ? { end } : {}),
      });
      stream.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          stream.destroy();
          reject(new Error(`Remote file exceeds ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

  writeFile(remotePath: string, data: Buffer): Promise<void> {
    if (data.length > MAX_SFTP_FILE_BYTES) {
      return Promise.reject(new Error(`Upload exceeds ${MAX_SFTP_FILE_BYTES} bytes`));
    }
    return new Promise((resolve, reject) => {
      const stream = this.sftp.createWriteStream(remotePath);
      stream.on("error", reject);
      stream.on("close", () => resolve());
      stream.end(data);
    });
  }

  async mkdirp(remotePath: string): Promise<void> {
    const parts = remotePath.split("/").filter(Boolean);
    let current = remotePath.startsWith("/") ? "" : ".";
    for (const part of parts) {
      current = `${current}/${part}`;
      const existing = await this.stat(current);
      if (existing?.isDirectory) continue;
      if (existing) throw new Error(`Not a directory: ${current}`);
      await new Promise<void>((resolve, reject) => {
        this.sftp.mkdir(current, (error) => {
          if (error) {
            // Another call may have created it.
            if (isExists(error)) resolve();
            else reject(error);
          } else resolve();
        });
      });
    }
  }

  async listDir(remotePath: string): Promise<SftpDirEntry[]> {
    const entries = await new Promise<
      {
        filename: string;
        attrs: { mode?: number; size?: number; mtime?: number };
      }[]
    >((resolve, reject) => {
      this.sftp.readdir(remotePath, (error, list) => (error ? reject(error) : resolve(list)));
    });
    const out: SftpDirEntry[] = [];
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      if (
        entry.filename.includes("..") ||
        entry.filename.includes("/") ||
        entry.filename.includes("\\") ||
        entry.filename.includes("\0")
      ) {
        throw new Error(`Refused remote name: ${entry.filename}`);
      }
      const mode = entry.attrs.mode ?? 0;
      const isDirectory = (mode & 0o170000) === 0o040000;
      const isFile = (mode & 0o170000) === 0o100000;
      out.push({
        name: entry.filename,
        isDirectory,
        isFile,
        size: entry.attrs.size ?? 0,
        mtime: typeof entry.attrs.mtime === "number" ? entry.attrs.mtime : null,
      });
    }
    return out;
  }

  async readTree(remoteDir: string): Promise<SftpFile[]> {
    const files: SftpFile[] = [];
    let totalBytes = 0;
    const walk = async (dir: string, prefix: string) => {
      const entries = await this.listDir(dir);
      for (const entry of entries) {
        const full = `${dir}/${entry.name}`;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          await walk(full, rel);
          continue;
        }
        if (!entry.isFile) continue; // skip symlinks and specials
        if (files.length >= MAX_SFTP_FILES) throw new Error("Too many files in plugin folder");
        const data = await this.readFile(full);
        totalBytes += data.length;
        if (totalBytes > MAX_SFTP_TOTAL_BYTES) throw new Error("Plugin folder exceeds size limit");
        files.push({ path: rel, data });
      }
    };
    await walk(remoteDir, "");
    return files;
  }

  async writeTree(remoteDir: string, files: readonly SftpFile[]): Promise<void> {
    await this.mkdirp(remoteDir);
    for (const file of files) {
      if (!file.path || file.path.includes("..") || file.path.startsWith("/")) {
        throw new Error(`Refused upload path: ${file.path}`);
      }
      const full = `${remoteDir}/${file.path}`;
      const parent = full.slice(0, full.lastIndexOf("/"));
      if (parent.length > remoteDir.length) await this.mkdirp(parent);
      await this.writeFile(full, file.data);
    }
  }

  rename(from: string, to: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
    });
  }

  unlink(remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.unlink(remotePath, (error) => {
        if (error) {
          // Try rmdir for empty directories.
          this.sftp.rmdir(remotePath, (err2) => (err2 ? reject(error) : resolve()));
        } else resolve();
      });
    });
  }

  async rmTree(remotePath: string): Promise<void> {
    const info = await this.stat(remotePath);
    if (!info) return;
    if (!info.isDirectory) {
      await this.unlink(remotePath);
      return;
    }
    const entries = await new Promise<{ filename: string }[]>((resolve, reject) => {
      this.sftp.readdir(remotePath, (error, list) => (error ? reject(error) : resolve(list)));
    });
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      if (entry.filename.includes("..") || entry.filename.includes("/")) {
        throw new Error(`Refused remote name: ${entry.filename}`);
      }
      await this.rmTree(`${remotePath}/${entry.filename}`);
    }
    await new Promise<void>((resolve, reject) => {
      this.sftp.rmdir(remotePath, (error) => (error ? reject(error) : resolve()));
    });
  }

  close() {
    this.sftp.end();
  }
}

function errCode(error: unknown): string | number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errCode(error);
  return code === 2 || code === "ENOENT" || code === "NO_SUCH_FILE";
}

function isExists(error: unknown): boolean {
  const code = errCode(error);
  return code === 4 || code === "EEXIST" || code === "FAILURE";
}
