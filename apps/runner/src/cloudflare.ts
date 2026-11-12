// Cloudflare API (Phase 3 step 3, A156): zones, DNS records, record changes and cache purge.
// The token is read from the vault per job and only ever sent to api.cloudflare.com; it never
// appears in a result or an error.
import {
  CfZone,
  CLOUDFLARE_TOKEN_REF,
  DnsRecord,
  type DnsApplyResult,
  type DnsChangeOp,
  type DnsPurgeResult,
  type DnsRecordsResult,
  type DnsRecordValue,
  type DnsZonesResult,
  MAX_DNS_RECORDS,
  MAX_DNS_ZONES,
} from "@ulixops/shared";
import { z } from "zod";
import { redact } from "./redact";
import { type Vault, VaultError } from "./vault";

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 20_000;

export interface CloudflareDeps {
  vault: Vault;
  fetchImpl?: typeof fetch;
}

class CfError extends Error {}

const Envelope = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string() })).optional(),
  result: z.unknown(),
  result_info: z.object({ total_pages: z.number().int().optional() }).optional(),
});

const RawZone = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  paused: z.boolean().optional(),
  account: z.object({ name: z.string().nullish() }).nullish(),
  plan: z.object({ name: z.string().nullish() }).nullish(),
  name_servers: z.array(z.string()).nullish(),
  original_name_servers: z.array(z.string()).nullish(),
  original_registrar: z.string().nullish(),
});

const RawRecord = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().optional(),
  ttl: z.number(),
  proxied: z.boolean().optional(),
  priority: z.number().nullish(),
  comment: z.string().nullish(),
});

async function token(vault: Vault): Promise<string | null> {
  try {
    const value = (await vault.read(CLOUDFLARE_TOKEN_REF)).trim();
    return value || null;
  } catch (error) {
    if (error instanceof VaultError && error.kind === "not_found") return null;
    throw new CfError("The vault couldn't be reached.");
  }
}

async function call(
  deps: CloudflareDeps,
  secret: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<z.infer<typeof Envelope>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });
  } catch {
    throw new CfError(
      controller.signal.aborted
        ? "Cloudflare didn't answer in time."
        : "Couldn't reach Cloudflare.",
    );
  } finally {
    clearTimeout(timer);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new CfError(`Cloudflare answered HTTP ${res.status} without JSON.`);
  }
  const parsed = Envelope.safeParse(json);
  if (!parsed.success)
    throw new CfError(`Cloudflare answered HTTP ${res.status} in an unexpected shape.`);
  if (!res.ok || !parsed.data.success) {
    const why = parsed.data.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    const hint =
      res.status === 401 || res.status === 403
        ? " Check the token's permissions (Zone Read, DNS Edit, Cache Purge) and zone list."
        : "";
    throw new CfError(redact(`Cloudflare: ${why}.${hint}`, [secret], 400));
  }
  return parsed.data;
}

/** Runs `use` with the token, turning every failure into { ok: false, error } in plain words. */
async function withToken<T>(
  deps: CloudflareDeps,
  use: (secret: string) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  let secret: string | null = null;
  try {
    secret = await token(deps.vault);
    if (!secret)
      return { ok: false, error: "No Cloudflare API token in the vault (Settings → Credentials)." };
    return await use(secret);
  } catch (error) {
    const message = error instanceof CfError ? error.message : "The Cloudflare request failed.";
    return { ok: false, error: redact(message, secret ? [secret] : [], 400) };
  }
}

export function listZones(deps: CloudflareDeps): Promise<DnsZonesResult> {
  return withToken(deps, async (secret) => {
    const zones: CfZone[] = [];
    for (let page = 1; page <= 10 && zones.length < MAX_DNS_ZONES; page++) {
      const env = await call(deps, secret, "GET", `/zones?per_page=50&page=${page}`);
      const rows = z.array(RawZone).parse(env.result);
      for (const r of rows) {
        const zone = CfZone.safeParse({
          id: r.id,
          name: r.name,
          status: r.status,
          paused: r.paused ?? false,
          accountName: r.account?.name ?? null,
          plan: r.plan?.name ?? null,
          nameServers: r.name_servers ?? [],
          originalNameServers: r.original_name_servers ?? [],
          originalRegistrar: r.original_registrar ?? null,
        });
        if (zone.success) zones.push(zone.data);
      }
      if (page >= (env.result_info?.total_pages ?? 1)) break;
    }
    return { ok: true as const, zones: zones.slice(0, MAX_DNS_ZONES) };
  });
}

export function listRecords(zoneId: string, deps: CloudflareDeps): Promise<DnsRecordsResult> {
  return withToken(deps, async (secret) => {
    const records: DnsRecord[] = [];
    for (let page = 1; page <= 10 && records.length < MAX_DNS_RECORDS; page++) {
      const env = await call(
        deps,
        secret,
        "GET",
        `/zones/${zoneId}/dns_records?per_page=500&page=${page}`,
      );
      for (const r of z.array(RawRecord).parse(env.result)) {
        const record = DnsRecord.safeParse({
          id: r.id,
          type: r.type,
          name: r.name.toLowerCase(),
          content: r.content ?? "",
          ttl: r.ttl,
          proxied: r.proxied ?? false,
          priority: r.priority ?? null,
          comment: r.comment ?? null,
        });
        if (record.success) records.push(record.data);
      }
      if (page >= (env.result_info?.total_pages ?? 1)) break;
    }
    return { ok: true as const, records: records.slice(0, MAX_DNS_RECORDS) };
  });
}

const bodyOf = (r: DnsRecordValue) => ({
  type: r.type,
  name: r.name,
  content: r.content,
  ttl: r.ttl,
  proxied: r.proxied,
  ...(r.priority !== null ? { priority: r.priority } : {}),
  comment: r.comment ?? "",
});

/** Applies changes in order, stopping at the first failure. */
export async function applyChanges(
  zoneId: string,
  changes: DnsChangeOp[],
  deps: CloudflareDeps,
): Promise<DnsApplyResult> {
  const result: DnsApplyResult = { applied: 0, failed: null };
  const outcome = await withToken(deps, async (secret) => {
    for (const [index, change] of changes.entries()) {
      try {
        if (change.op === "create")
          await call(deps, secret, "POST", `/zones/${zoneId}/dns_records`, bodyOf(change.record));
        else if (change.op === "update")
          await call(
            deps,
            secret,
            "PUT",
            `/zones/${zoneId}/dns_records/${change.id}`,
            bodyOf(change.record),
          );
        else await call(deps, secret, "DELETE", `/zones/${zoneId}/dns_records/${change.id}`);
        result.applied++;
      } catch (error) {
        result.failed = {
          index,
          error: error instanceof CfError ? error.message : "The Cloudflare request failed.",
        };
        break;
      }
    }
    return { ok: true as const };
  });
  if (!outcome.ok) return { applied: 0, failed: { index: 0, error: outcome.error } };
  return result;
}

export function purgeCache(
  zoneId: string,
  everything: boolean,
  urls: string[],
  deps: CloudflareDeps,
): Promise<DnsPurgeResult> {
  return withToken(deps, async (secret) => {
    await call(
      deps,
      secret,
      "POST",
      `/zones/${zoneId}/purge_cache`,
      everything ? { purge_everything: true } : { files: urls },
    );
    return { ok: true as const };
  });
}
