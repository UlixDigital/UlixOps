// Wordfence Intelligence feed (Phase 2 step 2, A132). The production feed is one large JSON
// object keyed by record id, so it is streamed and parsed one record at a time instead of
// being held in memory whole. Only records for software we run leave the runner.
import {
  MAX_VULN_RECORDS,
  softwareKey,
  toVulnRecord,
  VULN_FEED_URL,
  type VulnFeedResult,
  type VulnRecord,
  WordfenceRecord,
  WORDFENCE_KEY_REF,
} from "@ulixops/shared";
import { type Vault, VaultError } from "./vault";

/** A single record far larger than any real one means the stream is not what we expect. */
const MAX_RECORD_CHARS = 2_000_000;
const MAX_FEED_BYTES = 1_500_000_000;
const FEED_TIMEOUT_MS = 8 * 60_000;

export class FeedFormatError extends Error {}

/**
 * Yields each object nested directly inside the top-level JSON value, as text: the records of
 * `{"id": {...}, ...}` or of `[{...}, ...]`. Keys and other top-level values are skipped.
 */
export async function* topLevelObjects(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let capturing = false;
  let buffer = "";
  for await (const chunk of chunks) {
    let start = capturing ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") {
        depth++;
        if (depth === 2 && ch === "{") {
          capturing = true;
          start = i;
        }
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth < 0) throw new FeedFormatError("Unbalanced JSON in the feed");
        if (depth === 1 && capturing) {
          const text = buffer + chunk.slice(start, i + 1);
          buffer = "";
          capturing = false;
          start = -1;
          yield text;
        }
      }
    }
    if (capturing) {
      buffer += chunk.slice(start);
      if (buffer.length > MAX_RECORD_CHARS) throw new FeedFormatError("A feed record is too large");
    }
  }
  if (depth !== 0 || inString) throw new FeedFormatError("The feed ended early");
}

/** Decodes a byte stream to text without splitting multi-byte characters. */
async function* decode(body: AsyncIterable<Uint8Array>, maxBytes: number): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new FeedFormatError("The feed is larger than expected");
    yield decoder.decode(chunk, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

/** Keeps the records that mention software in `wanted`; counts every record in the feed. */
export async function filterFeed(
  chunks: AsyncIterable<string>,
  wanted: ReadonlySet<string>,
): Promise<{ total: number; records: VulnRecord[] }> {
  let total = 0;
  const records: VulnRecord[] = [];
  for await (const text of topLevelObjects(chunks)) {
    total++;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    const raw = WordfenceRecord.safeParse(json);
    if (!raw.success) continue;
    const record = toVulnRecord(raw.data, wanted);
    if (!record) continue;
    if (records.length >= MAX_VULN_RECORDS)
      throw new FeedFormatError(`More than ${MAX_VULN_RECORDS} matching records`);
    records.push(record);
  }
  return { total, records };
}

export interface FeedDeps {
  vault: Vault;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The vuln.feed job: read the API key from the vault, stream the feed, filter it. */
export async function readVulnFeed(
  wanted: { type: "core" | "plugin" | "theme"; slug: string }[],
  deps: FeedDeps,
): Promise<VulnFeedResult> {
  let apiKey: string;
  try {
    apiKey = (await deps.vault.read(WORDFENCE_KEY_REF)).trim();
  } catch (error) {
    if (error instanceof VaultError && error.kind === "not_found")
      return {
        ok: false,
        reason: "not_configured",
        detail: `No Wordfence API key yet: an Admin adds ${WORDFENCE_KEY_REF} in Settings → Credentials.`,
      };
    return { ok: false, reason: "unavailable", detail: "The vault could not be reached." };
  }
  if (!/^[A-Za-z0-9._-]{16,512}$/.test(apiKey))
    return {
      ok: false,
      reason: "not_configured",
      detail: `${WORDFENCE_KEY_REF} in the vault doesn't look like a Wordfence API key.`,
    };

  const fetchImpl = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(VULN_FEED_URL, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unavailable", detail: "Wordfence could not be reached." };
  }
  if (res.status === 401 || res.status === 403)
    return { ok: false, reason: "rejected", detail: "Wordfence rejected the API key." };
  if (!res.ok || !res.body)
    return {
      ok: false,
      reason: "unavailable",
      detail: `Wordfence answered HTTP ${res.status}.`,
    };

  const keys = new Set(wanted.map((w) => softwareKey(w.type, w.slug)));
  try {
    const { total, records } = await filterFeed(
      decode(res.body as unknown as AsyncIterable<Uint8Array>, MAX_FEED_BYTES),
      keys,
    );
    if (total === 0) return { ok: false, reason: "invalid", detail: "The feed had no records." };
    return {
      ok: true,
      fetchedAt: new Date((deps.now ?? Date.now)()).toISOString(),
      total,
      records,
    };
  } catch (error) {
    if (error instanceof FeedFormatError)
      return { ok: false, reason: "invalid", detail: error.message };
    return { ok: false, reason: "unavailable", detail: "The feed download was interrupted." };
  }
}
