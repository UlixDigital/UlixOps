// In-memory fake of the Google Drive / OAuth HTTP API, for tests only (A145).
import { createHash } from "node:crypto";

/** Minimal Drive: tokens, folders with appProperties, resumable uploads, get, delete. */
export class FakeDrive {
  files = new Map<
    string,
    { name: string; data: Buffer; parents: string[]; folder: boolean; appKey?: string }
  >();
  sessions = new Map<
    string,
    { name: string; parents: string[]; data: Buffer[]; received: number }
  >();
  failNextPuts = 0;
  /** Accept only this many bytes of the next PUT (a partial chunk). */
  acceptOnly: number | null = null;
  revoked = false;
  /** The redirect URI registered on the OAuth client. */
  redirectUri = "https://hub.example.test/oauth/google/callback";
  codeExchanges: Record<string, string>[] = [];
  /** Cut the next download's connection after this many bytes (A152 resume). */
  dropDownloadAfter: number | null = null;
  /** Range headers of every download request. */
  downloads: (string | null)[] = [];
  private n = 0;

  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
      new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
    if (url.href.startsWith("https://oauth2.googleapis.com/token")) {
      const form = new URLSearchParams(String(init.body));
      if (form.get("grant_type") === "authorization_code") {
        this.codeExchanges.push(Object.fromEntries(form));
        if (form.get("redirect_uri") !== this.redirectUri)
          return reply(400, { error: "redirect_uri_mismatch" });
        if (form.get("code") !== "4/valid-code") return reply(400, { error: "invalid_grant" });
        return reply(200, { access_token: "at", refresh_token: "1//refresh-token-value" });
      }
      if (this.revoked) return reply(400, { error: "invalid_grant" });
      return reply(200, { access_token: "at", expires_in: 3600 });
    }
    if (url.pathname === "/drive/v3/about")
      return reply(200, {
        user: { emailAddress: "ulixdevs@gmail.com" },
        storageQuota: { limit: "214748364800", usage: "1000" },
      });
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const key = /value='([^']+)'/.exec(url.searchParams.get("q") ?? "")?.[1];
      const hit = [...this.files.entries()].find(([, f]) => f.folder && f.appKey === key);
      return reply(200, { files: hit ? [{ id: hit[0] }] : [] });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        name: string;
        parents?: string[];
        appProperties: { ulixops: string };
      };
      const id = `f${++this.n}`;
      this.files.set(id, {
        name: body.name,
        data: Buffer.alloc(0),
        parents: body.parents ?? [],
        folder: true,
        appKey: body.appProperties.ulixops,
      });
      return reply(200, { id });
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; parents: string[] };
      const sid = `s${++this.n}`;
      this.sessions.set(sid, { name: body.name, parents: body.parents, data: [], received: 0 });
      return reply(200, {}, { location: `https://www.googleapis.com/upload/session/${sid}` });
    }
    if (url.pathname.startsWith("/upload/session/") && method === "PUT") {
      const sid = url.pathname.split("/").at(-1) ?? "";
      const s = this.sessions.get(sid);
      if (!s) return reply(404);
      const range = new Headers(init.headers).get("content-range") ?? "";
      const status308 = () =>
        new Response(null, {
          status: 308,
          headers: s.received ? { range: `bytes=0-${s.received - 1}` } : {},
        });
      if (/^bytes \*\//.test(range)) {
        const total = /\/(\d+)$/.exec(range)?.[1];
        if (total && Number(total) === s.received) return this.complete(sid, s);
        return status308();
      }
      if (this.failNextPuts > 0) {
        this.failNextPuts--;
        return reply(503);
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (!m) return reply(400);
      const from = Number(m[1]);
      let piece = Buffer.from(init.body as Uint8Array);
      if (from !== s.received) return reply(400, { error: "bad offset" });
      if (this.acceptOnly !== null) {
        piece = piece.subarray(0, this.acceptOnly);
        this.acceptOnly = null;
        s.data.push(piece);
        s.received += piece.length;
        return status308();
      }
      s.data.push(piece);
      s.received += piece.length;
      if (m[3] !== "*" && Number(m[3]) === s.received) return this.complete(sid, s);
      return status308();
    }
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1] ?? "");
      const f = this.files.get(id);
      if (method === "DELETE") {
        this.files.delete(id);
        return reply(f ? 204 : 404);
      }
      if (!f) return reply(404);
      if (url.searchParams.get("alt") === "media") {
        const range = new Headers(init.headers).get("range");
        this.downloads.push(range);
        const from = Number(/^bytes=(\d+)-$/.exec(range ?? "")?.[1] ?? 0);
        const data = f.data.subarray(from);
        const drop = this.dropDownloadAfter;
        this.dropDownloadAfter = null;
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (drop !== null && sent >= drop) {
              controller.error(new Error("connection reset"));
              return;
            }
            const size = Math.min(64 * 1024, drop !== null ? drop - sent : Infinity);
            const piece = data.subarray(sent, sent + size);
            if (piece.length === 0) {
              controller.close();
              return;
            }
            sent += piece.length;
            controller.enqueue(new Uint8Array(piece));
          },
        });
        return new Response(body, { status: range ? 206 : 200 });
      }
      return reply(200, {
        id,
        name: f.name,
        size: String(f.data.length),
        md5Checksum: createHash("md5").update(f.data).digest("hex"),
        webViewLink: `https://drive.google.com/file/d/${id}/view`,
      });
    }
    return reply(404);
  };

  private complete(sid: string, s: { name: string; parents: string[]; data: Buffer[] }) {
    const id = `file-${sid}`;
    this.files.set(id, {
      name: s.name,
      data: Buffer.concat(s.data),
      parents: s.parents,
      folder: false,
    });
    this.sessions.delete(sid);
    return new Response(JSON.stringify({ id }), { status: 200 });
  }
}
