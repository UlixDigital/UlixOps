// SSL certificate and domain registration expiry (Phase 3 step 1, A148). Runs on the runner
// because only it has egress. Read-only: a TLS handshake (no HTTP request) for the certificate
// and the registry's public RDAP service for the domain. No credentials are involved.
import tls from "node:tls";
import {
  type DomainCheckResult,
  domainCandidates,
  type ExpiryCheckRequest,
  guessRegisteredDomain,
  type ExpiryJobResult,
  type SslCheckResult,
} from "@ulixops/shared";
import { z } from "zod";

const TLS_TIMEOUT_MS = 10_000;
const RDAP_TIMEOUT_MS = 10_000;
const MAX_RDAP_BYTES = 512_000;
const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 60 * 60_000;
const PARALLEL = 4;

/** What the TLS handshake tells us about the server's certificate. */
export interface PeerCertificate {
  validFrom: string | null;
  validTo: string | null;
  issuer: string | null;
  subject: string | null;
  altNames: string[];
  /** The chain is trusted by Node's CA store. */
  authorized: boolean;
  authorizationError: string | null;
  /** The certificate doesn't cover the host name. */
  identityError: string | null;
}

export type TlsProbe = (host: string, port: number, timeoutMs: number) => Promise<PeerCertificate>;

export interface ExpiryDeps {
  probe?: TlsProbe;
  fetch?: typeof fetch;
  now?: () => number;
  /** Pause before retrying a failed handshake (tests pass 0). */
  retryDelayMs?: number;
}

export async function runExpiryChecks(
  checks: ExpiryCheckRequest[],
  deps: ExpiryDeps = {},
): Promise<ExpiryJobResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const rdap = new RdapClient(deps.fetch ?? fetch, now);
  const results: ExpiryJobResult["results"] = new Array(checks.length);
  let next = 0;
  const worker = async () => {
    while (next < checks.length) {
      const i = next++;
      const check = checks[i];
      if (!check) continue;
      results[i] = {
        host: check.host,
        ssl: check.ssl ? await checkCertificate(check.host, check.port, deps, now) : null,
        domain: check.domain ? await rdap.lookup(check.host) : null,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, checks.length) }, worker));
  return { results, durationMs: now() - started };
}

// ---- Certificates --------------------------------------------------------------------------

export async function checkCertificate(
  host: string,
  port: number,
  deps: ExpiryDeps,
  now: () => number,
): Promise<SslCheckResult> {
  const probe = deps.probe ?? tlsProbe;
  let peer: PeerCertificate;
  try {
    peer = await probe(host, port, TLS_TIMEOUT_MS);
  } catch {
    // One retry: a single dropped handshake shouldn't raise an alert.
    await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 3_000));
    try {
      peer = await probe(host, port, TLS_TIMEOUT_MS);
    } catch (error) {
      return {
        ok: false,
        validFrom: null,
        validTo: null,
        issuer: null,
        subject: null,
        altNames: [],
        error: `Couldn't connect over HTTPS: ${networkMessage(error)}`,
      };
    }
  }
  const t = now();
  const from = peer.validFrom ? Date.parse(peer.validFrom) : NaN;
  const to = peer.validTo ? Date.parse(peer.validTo) : NaN;
  let error: string | null = null;
  if (Number.isFinite(to) && to < t) error = "The certificate has expired.";
  else if (Number.isFinite(from) && from > t) error = "The certificate isn't valid yet.";
  else if (!peer.authorized) error = trustMessage(peer.authorizationError);
  else if (peer.identityError) error = `The certificate doesn't cover ${host}.`;
  else if (!Number.isFinite(to)) error = "The certificate has no readable expiry date.";
  return {
    ok: error === null,
    validFrom: Number.isFinite(from) ? new Date(from).toISOString() : null,
    validTo: Number.isFinite(to) ? new Date(to).toISOString() : null,
    issuer: peer.issuer?.slice(0, 300) ?? null,
    subject: peer.subject?.slice(0, 300) ?? null,
    altNames: peer.altNames.slice(0, 100).map((n) => n.slice(0, 253)),
    error,
  };
}

const TRUST_MESSAGES: Record<string, string> = {
  CERT_HAS_EXPIRED: "The certificate has expired.",
  DEPTH_ZERO_SELF_SIGNED_CERT: "The certificate is self-signed (browsers won't trust it).",
  SELF_SIGNED_CERT_IN_CHAIN: "The chain contains a self-signed certificate (not trusted).",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    "The server doesn't send its intermediate certificate, so the chain can't be verified.",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY:
    "The certificate's issuer isn't trusted (or the intermediate is missing).",
  CERT_REVOKED: "The certificate was revoked.",
  ERR_TLS_CERT_ALTNAME_INVALID: "The certificate doesn't cover this host name.",
};

function trustMessage(code: string | null): string {
  if (!code) return "The certificate isn't trusted.";
  return TRUST_MESSAGES[code] ?? `The certificate isn't trusted (${code.slice(0, 80)}).`;
}

function networkMessage(error: unknown): string {
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  const known: Record<string, string> = {
    ENOTFOUND: "the host name doesn't resolve",
    ECONNREFUSED: "connection refused on the HTTPS port",
    ECONNRESET: "the server closed the connection",
    ETIMEDOUT: "timed out",
    EHOSTUNREACH: "host unreachable",
  };
  if (code && known[code]) return known[code];
  const message = error instanceof Error ? error.message : "unknown error";
  return message.replace(/\s+/g, " ").slice(0, 200);
}

/** Real handshake. The certificate is read even when untrusted, then judged above. */
export const tlsProbe: TlsProbe = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      socket.destroy();
      fn();
    };
    socket.setTimeout(timeoutMs, () =>
      finish(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }))),
    );
    socket.once("error", (error) => finish(() => reject(error)));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0) {
        finish(() => reject(new Error("the server sent no certificate")));
        return;
      }
      const identity = tls.checkServerIdentity(host, cert);
      const authError = socket.authorizationError;
      const peer: PeerCertificate = {
        validFrom: dateOf(cert.valid_from),
        validTo: dateOf(cert.valid_to),
        issuer: nameOf(cert.issuer),
        subject: nameOf(cert.subject),
        altNames: (cert.subjectaltname ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.startsWith("DNS:"))
          .map((s) => s.slice(4)),
        authorized: socket.authorized,
        authorizationError: authError
          ? typeof authError === "string"
            ? authError
            : ((authError as { code?: string }).code ?? authError.message)
          : null,
        identityError: identity ? identity.message.slice(0, 200) : null,
      };
      finish(() => resolve(peer));
    });
  });

function dateOf(value: string | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function nameOf(name: tls.PeerCertificate["issuer"] | undefined): string | null {
  if (!name) return null;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const org = pick(name.O);
  const cn = pick(name.CN);
  return [org, cn].filter(Boolean).join(" · ") || null;
}

// ---- Domains (RDAP) --------------------------------------------------------------------------

const Bootstrap = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())])),
});

const RdapEvent = z.object({ eventAction: z.string(), eventDate: z.string() });
const RdapDomain = z.object({
  ldhName: z.string().optional(),
  events: z.array(z.unknown()).optional(),
  entities: z.array(z.unknown()).optional(),
});

let bootstrapCache: { at: number; services: Promise<Map<string, string>> } | null = null;

/** Test hook: forget the cached IANA bootstrap file. */
export function resetRdapBootstrap(): void {
  bootstrapCache = null;
}

class RdapClient {
  /** Per job: candidate name → registry answer, so hosts sharing a domain ask once. */
  private readonly answers = new Map<string, Promise<RdapAnswer>>();

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly now: () => number,
  ) {}

  async lookup(host: string): Promise<DomainCheckResult> {
    let services: Map<string, string>;
    try {
      services = await this.bootstrap();
    } catch (error) {
      return failure("error", `Couldn't load the RDAP directory: ${networkMessage(error)}`);
    }
    const candidates = domainCandidates(host);
    let sawError: string | null = null;
    let sawServer = false;
    for (const name of candidates) {
      const base = serverFor(name, services);
      if (!base) continue;
      sawServer = true;
      let answer = this.answers.get(name);
      if (!answer) {
        answer = this.ask(base, name);
        this.answers.set(name, answer);
      }
      const got = await answer;
      if (got.kind === "missing") continue;
      if (got.kind === "error") {
        sawError = got.message;
        continue;
      }
      if (!got.expiresAt)
        return {
          domain: name,
          status: "unsupported",
          expiresAt: null,
          registrar: got.registrar,
          error: "The registry doesn't publish an expiry date for this domain.",
        };
      return {
        domain: name,
        status: "found",
        expiresAt: got.expiresAt,
        registrar: got.registrar,
        error: null,
      };
    }
    if (sawError) return failure("error", sawError);
    if (!sawServer)
      return {
        ...failure("unsupported", "This domain's registry has no RDAP service (no public expiry)."),
        domain: guessRegisteredDomain(host),
      };
    return failure("not_found", "The registry doesn't know this domain.");
  }

  private bootstrap(): Promise<Map<string, string>> {
    if (bootstrapCache && this.now() - bootstrapCache.at < BOOTSTRAP_TTL_MS)
      return bootstrapCache.services;
    // Cache the request itself so parallel lookups share one download; a failure isn't kept.
    const at = this.now();
    const services = this.loadBootstrap();
    bootstrapCache = { at, services };
    services.catch(() => {
      if (bootstrapCache?.services === services) bootstrapCache = null;
    });
    return services;
  }

  private async loadBootstrap(): Promise<Map<string, string>> {
    const res = await this.get(BOOTSTRAP_URL);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const parsed = Bootstrap.parse(JSON.parse(res.body));
    const services = new Map<string, string>();
    for (const [tlds, urls] of parsed.services) {
      const url = urls.find((u) => u.startsWith("https://"));
      if (!url) continue;
      for (const tld of tlds) services.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
    }
    return services;
  }

  private async ask(base: string, name: string): Promise<RdapAnswer> {
    let res: { status: number; body: string };
    try {
      res = await this.get(`${base}domain/${encodeURIComponent(name)}`);
    } catch (error) {
      return { kind: "error", message: `The registry didn't answer: ${networkMessage(error)}` };
    }
    if (res.status === 404 || res.status === 400 || res.status === 422) return { kind: "missing" };
    if (res.status === 429)
      return { kind: "error", message: "The registry is rate limiting lookups; retried later." };
    if (res.status !== 200)
      return { kind: "error", message: `The registry answered HTTP ${res.status}.` };
    let json: unknown;
    try {
      json = JSON.parse(res.body);
    } catch {
      return { kind: "error", message: "The registry sent an unreadable answer." };
    }
    const domain = RdapDomain.safeParse(json);
    if (!domain.success)
      return { kind: "error", message: "The registry sent an unexpected answer." };
    return {
      kind: "found",
      expiresAt: expirationOf(domain.data.events ?? []),
      registrar: registrarOf(domain.data.entities ?? []),
    };
  }

  /** GET over HTTPS only, following at most 3 redirects, with a size cap. */
  private async get(url: string): Promise<{ status: number; body: string }> {
    let current = url;
    for (let hop = 0; hop <= 3; hop++) {
      if (!current.startsWith("https://")) throw new Error("refused a non-HTTPS RDAP address");
      const res = await this.fetchFn(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
        headers: { Accept: "application/rdap+json, application/json", "User-Agent": "UlixOps/1" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) return { status: res.status, body: "" };
        current = new URL(location, current).toString();
        continue;
      }
      return { status: res.status, body: await readCapped(res, MAX_RDAP_BYTES) };
    }
    throw new Error("too many redirects");
  }
}

type RdapAnswer =
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "found"; expiresAt: string | null; registrar: string | null };

function failure(status: DomainCheckResult["status"], error: string): DomainCheckResult {
  return { domain: null, status, expiresAt: null, registrar: null, error: error.slice(0, 300) };
}

/** Bootstrap entries are TLDs (sometimes multi-label); the longest match wins. */
function serverFor(name: string, services: Map<string, string>): string | null {
  const labels = name.split(".");
  for (let i = 1; i < labels.length; i++) {
    const url = services.get(labels.slice(i).join("."));
    if (url) return url;
  }
  return null;
}

function expirationOf(events: unknown[]): string | null {
  for (const raw of events) {
    const event = RdapEvent.safeParse(raw);
    if (!event.success || !/expiration/i.test(event.data.eventAction)) continue;
    const t = Date.parse(event.data.eventDate);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

function registrarOf(entities: unknown[]): string | null {
  for (const raw of entities) {
    if (!raw || typeof raw !== "object") continue;
    const entity = raw as { roles?: unknown; vcardArray?: unknown };
    if (!Array.isArray(entity.roles) || !entity.roles.includes("registrar")) continue;
    const card = Array.isArray(entity.vcardArray) ? entity.vcardArray[1] : null;
    if (!Array.isArray(card)) continue;
    for (const prop of card) {
      if (Array.isArray(prop) && prop[0] === "fn" && typeof prop[3] === "string")
        return prop[3].slice(0, 200);
    }
  }
  return null;
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("answer too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
