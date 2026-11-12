// Google Drive for full backups (Phase 2 step 5, A145), with plain HTTPS (no SDK). Scope
// drive.file: UlixOps sees and manages only the files and folders it created. Sign-in is the
// normal "Sign in with Google" redirect with PKCE (A146).
import { createHash } from "node:crypto";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
/** Resumable upload chunks must be multiples of 256 KiB. */
export const UPLOAD_CHUNK = 16 * 256 * 1024 * 4; // 16 MiB

/** Access was revoked or the refresh token expired: someone has to connect Drive again. */
export class DriveAuthError extends Error {}
export class DriveError extends Error {}

type Fetch = typeof fetch;

export interface DriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  md5Checksum: string | null;
  webViewLink: string | null;
}

const sleepFor = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

// ---- "Sign in with Google" (authorization code + PKCE) ------------------------------------------

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's consent page. `prompt=consent` + offline access always returns a refresh token. */
export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** Trades the one-time code for a refresh token. */
export async function exchangeCode(
  opts: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    verifier: string;
  },
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await json(res);
  if (res.ok && typeof body.refresh_token === "string") return body.refresh_token;
  if (res.ok)
    throw new DriveError(
      "Google didn't return a long-lived sign-in. Remove UlixOps from the Google account's third-party access and connect again.",
    );
  throw new DriveError(
    body.error === "redirect_uri_mismatch"
      ? "Google says the redirect address doesn't match: add the exact address shown on this page to the OAuth client."
      : body.error === "invalid_client"
        ? "Google doesn't accept the client ID or secret. Check them, and that the client type is Web application."
        : `Google sign-in failed (${String(body.error ?? res.status)}).`,
  );
}

// ---- Drive client --------------------------------------------------------------------------

export class GoogleDrive {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: DriveCredentials,
    private readonly fetchImpl: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = sleepFor,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await json(res);
    if (body.error === "invalid_grant" || body.error === "invalid_client" || res.status === 401)
      throw new DriveAuthError(
        "Google Drive access was revoked or has expired. Connect Google Drive again on the Backups page.",
      );
    if (!res.ok || typeof body.access_token !== "string")
      throw new DriveError(`Google token request failed (HTTP ${res.status}).`);
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }

  /** An API call with the bearer token; retries 429/5xx a few times. */
  private async call(url: string, init: RequestInit = {}, attempts = 4): Promise<Response> {
    for (let i = 0; ; i++) {
      let res: Response | null = null;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.accessToken()}` },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        if (error instanceof DriveAuthError || i + 1 >= attempts) throw error;
      }
      if (res && res.status === 401 && i === 0) {
        this.token = null;
        continue;
      }
      if (res && !(res.status === 429 || res.status >= 500)) return res;
      if (i + 1 >= attempts) {
        if (res) return res;
        throw new DriveError("Google Drive could not be reached.");
      }
      await this.sleep(1000 * 2 ** i);
    }
  }

  async about(): Promise<{ email: string | null; limit: number | null; usage: number | null }> {
    const res = await this.call(`${API}/about?fields=user(emailAddress),storageQuota(limit,usage)`);
    const body = await json(res);
    if (!res.ok) throw new DriveError(`Drive account check failed (HTTP ${res.status}).`);
    const user = body.user as { emailAddress?: string } | undefined;
    const quota = body.storageQuota as { limit?: string; usage?: string } | undefined;
    return {
      email: user?.emailAddress ?? null,
      limit: quota?.limit ? Number(quota.limit) : null,
      usage: quota?.usage ? Number(quota.usage) : null,
    };
  }

  /** A folder UlixOps made earlier (found by its app property), or a new one. */
  async ensureFolder(name: string, parentId: string | null, appKey: string): Promise<string> {
    const q = [
      `mimeType='${FOLDER}'`,
      "trashed=false",
      `appProperties has { key='ulixops' and value='${appKey.replace(/[^A-Za-z0-9_-]/g, "")}' }`,
    ].join(" and ");
    const found = await this.call(
      `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
    );
    const list = await json(found);
    if (!found.ok) throw new DriveError(`Drive folder lookup failed (HTTP ${found.status}).`);
    const first = (list.files as { id: string }[] | undefined)?.[0];
    if (first) return first.id;
    const res = await this.call(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER,
        appProperties: { ulixops: appKey },
        ...(parentId ? { parents: [parentId] } : {}),
      }),
    });
    const created = await json(res);
    if (!res.ok || typeof created.id !== "string")
      throw new DriveError(`Drive folder could not be created (HTTP ${res.status}).`);
    return created.id;
  }

  async startUpload(name: string, parentId: string): Promise<ResumableUpload> {
    const res = await this.call(`${UPLOAD}?uploadType=resumable&fields=id`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "application/octet-stream",
      },
      body: JSON.stringify({ name, parents: [parentId], appProperties: { ulixops: "backup" } }),
    });
    const location = res.headers.get("location");
    if (!res.ok || !location)
      throw new DriveError(`Drive upload could not start (HTTP ${res.status}).`);
    return new ResumableUpload(location, () => this.accessToken(), this.fetchImpl, this.sleep);
  }

  async getFile(id: string): Promise<DriveFile | null> {
    const res = await this.call(
      `${API}/files/${encodeURIComponent(id)}?fields=id,name,size,md5Checksum,webViewLink`,
    );
    if (res.status === 404) return null;
    const body = await json(res);
    if (!res.ok) throw new DriveError(`Drive file check failed (HTTP ${res.status}).`);
    return {
      id: String(body.id),
      name: String(body.name ?? ""),
      size: Number(body.size ?? 0),
      md5Checksum: typeof body.md5Checksum === "string" ? body.md5Checksum : null,
      webViewLink: typeof body.webViewLink === "string" ? body.webViewLink : null,
    };
  }

  /**
   * Streams a file's bytes (restore, A152). A dropped connection is resumed from the last byte
   * received with a Range request, a few times. Stopping early (break) cancels the download.
   */
  async *download(id: string, timeoutMs = 6 * 60 * 60_000): AsyncGenerator<Buffer> {
    const url = `${API}/files/${encodeURIComponent(id)}?alt=media`;
    let received = 0;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 6) throw new DriveError("The download from Google Drive kept failing.");
      if (attempt > 0) await this.sleep(1000 * 2 ** Math.min(attempt, 5));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            headers: {
              authorization: `Bearer ${await this.accessToken()}`,
              ...(received > 0 ? { range: `bytes=${received}-` } : {}),
            },
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof DriveAuthError || error instanceof DriveError) throw error;
          continue;
        }
        if (res.status === 401 && attempt === 0) {
          this.token = null;
          continue;
        }
        if (res.status === 404)
          throw new DriveError("The backup file is no longer on Google Drive.");
        if (res.status === 429 || res.status >= 500) continue;
        if (!(res.status === 200 || res.status === 206) || !res.body)
          throw new DriveError(`Drive download failed (HTTP ${res.status}).`);
        if (received > 0 && res.status !== 206)
          throw new DriveError("Google Drive couldn't resume the download.");
        try {
          for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
            const data = Buffer.from(piece);
            received += data.length;
            yield data;
          }
          return;
        } catch {
          if (controller.signal.aborted)
            throw new DriveError("The download from Google Drive took too long.");
          // A dropped connection: resume from `received`.
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
  }

  /** Deletes permanently (it does not go to Trash). A file already gone counts as deleted. */
  async deleteFile(id: string): Promise<boolean> {
    const res = await this.call(`${API}/files/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  }
}

/**
 * One resumable upload of unknown length: write() buffers and sends full chunks, finish() sends
 * the rest with the total size. A chunk is dropped from memory only once Drive confirms it, so a
 * failed request is resumed from what Drive actually received.
 */
export class ResumableUpload {
  private buffer: Buffer[] = [];
  private buffered = 0;
  private sent = 0;
  readonly md5 = createHash("md5");
  total = 0;

  constructor(
    private readonly url: string,
    private readonly token: () => Promise<string>,
    private readonly fetchImpl: Fetch,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly chunk = UPLOAD_CHUNK,
  ) {}

  async write(data: Buffer): Promise<void> {
    if (data.length === 0) return;
    this.md5.update(data);
    this.total += data.length;
    this.buffer.push(data);
    this.buffered += data.length;
    while (this.buffered >= this.chunk) {
      const all = Buffer.concat(this.buffer);
      await this.send(all.subarray(0, this.chunk), false);
      const rest = all.subarray(this.chunk);
      this.buffer = rest.length ? [rest] : [];
      this.buffered = rest.length;
    }
  }

  /** Sends the rest; resolves to the Drive file id. */
  async finish(): Promise<string> {
    const id = await this.send(Buffer.concat(this.buffer), true);
    if (!id) throw new DriveError("Drive didn't return the uploaded file.");
    return id;
  }

  /** Sends `data` starting at this.sent; on errors, asks Drive what it has and resumes. */
  private async send(data: Buffer, last: boolean): Promise<string | null> {
    const start = this.sent;
    let offset = 0;
    for (let attempt = 0; ; attempt++) {
      if (attempt > 30) throw new DriveError("The upload to Google Drive made no progress.");
      const piece = data.subarray(offset);
      const from = start + offset;
      const range = piece.length
        ? `bytes ${from}-${from + piece.length - 1}/${last ? start + data.length : "*"}`
        : `bytes */${start + data.length}`;
      let res: Response | null;
      try {
        res = await this.fetchImpl(this.url, {
          method: "PUT",
          headers: { authorization: `Bearer ${await this.token()}`, "content-range": range },
          body: piece,
          signal: AbortSignal.timeout(300_000),
        });
      } catch {
        res = null;
      }
      if (res && (res.status === 200 || res.status === 201)) {
        this.sent = start + data.length;
        const body = await json(res);
        return typeof body.id === "string" ? body.id : null;
      }
      if (res && res.status === 308) {
        const got = rangeEnd(res.headers.get("range"));
        offset = Math.max(0, got - start);
        if (offset >= data.length && !last) {
          this.sent = start + data.length;
          return null;
        }
        if (!last || offset < data.length) continue;
      }
      if (res && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
        throw new DriveError(`Drive refused the upload (HTTP ${res.status}).`);
      if (attempt >= 6) throw new DriveError("The upload to Google Drive kept failing.");
      await this.sleep(1000 * 2 ** attempt);
      offset = Math.max(0, (await this.received()) - start);
    }
  }

  /** How many bytes Drive has (the next byte to send). */
  private async received(): Promise<number> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: "PUT",
        headers: { authorization: `Bearer ${await this.token()}`, "content-range": "bytes */*" },
        signal: AbortSignal.timeout(60_000),
      });
      return res.status === 308 ? rangeEnd(res.headers.get("range")) : this.sent;
    } catch {
      return this.sent;
    }
  }
}

/** "bytes=0-1048575" → 1048576 (bytes received); none → 0. */
function rangeEnd(header: string | null): number {
  const m = /bytes=0-(\d+)/.exec(header ?? "");
  return m?.[1] ? Number(m[1]) + 1 : 0;
}
