import "server-only";
import { AuthError, type AuthErrorCode } from "@ulixops/shared";
import type { z } from "zod";

const API_URL = process.env.API_URL || "http://localhost:4000";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: AuthErrorCode };

/** Calls that wait for the runner (vault, SSH) get longer than the default 5 s. */
export interface ApiOptions {
  timeoutMs?: number;
}

function parseResult<S extends z.ZodType>(
  res: Response,
  json: unknown,
  schema: S,
): ApiResult<z.output<S>> {
  if (res.ok) {
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, error: "bad_request" };
  }
  const error = AuthError.safeParse(json);
  return { ok: false, error: error.success ? error.data.error : "bad_request" };
}

/** POSTs JSON to the internal API and validates the answer; unknown errors become bad_request. */
export async function apiPost<S extends z.ZodType>(
  path: string,
  body: unknown,
  schema: S,
): Promise<ApiResult<z.output<S>>> {
  try {
    const res = await fetch(new URL(path, API_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const json: unknown = await res.json().catch(() => null);
    return parseResult(res, json, schema);
  } catch {
    return { ok: false, error: "bad_request" };
  }
}

/** GET for the signed-in user: forwards the session token and the visitor's IP. */
export async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  auth: { sessionToken: string; ip: string },
  options: ApiOptions = {},
): Promise<ApiResult<z.output<S>>> {
  try {
    const res = await fetch(new URL(path, API_URL), {
      headers: { authorization: `Bearer ${auth.sessionToken}`, "x-ulix-client-ip": auth.ip },
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    const json: unknown = await res.json().catch(() => null);
    return parseResult(res, json, schema);
  } catch {
    // Timeouts / network errors must not crash RSC pages (A113 Emergency live check).
    return { ok: false, error: "bad_request" };
  }
}

/** POST/PATCH/PUT for the signed-in user (Server Actions). */
export async function apiSend<S extends z.ZodType>(
  method: "POST" | "PATCH" | "PUT",
  path: string,
  body: unknown,
  schema: S,
  auth: { sessionToken: string; ip: string },
  options: ApiOptions = {},
): Promise<ApiResult<z.output<S>>> {
  try {
    const res = await fetch(new URL(path, API_URL), {
      method,
      headers: {
        authorization: `Bearer ${auth.sessionToken}`,
        "x-ulix-client-ip": auth.ip,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    const json: unknown = await res.json().catch(() => null);
    return parseResult(res, json, schema);
  } catch {
    return { ok: false, error: "bad_request" };
  }
}

/** Sends a file as a raw body (plugin ZIP uploads) for the signed-in user. */
export async function apiUpload<S extends z.ZodType>(
  path: string,
  body: Uint8Array<ArrayBuffer>,
  contentType: "application/zip",
  schema: S,
  auth: { sessionToken: string; ip: string },
  options: ApiOptions = {},
): Promise<ApiResult<z.output<S>>> {
  try {
    const res = await fetch(new URL(path, API_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.sessionToken}`,
        "x-ulix-client-ip": auth.ip,
        "content-type": contentType,
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    const json: unknown = await res.json().catch(() => null);
    return parseResult(res, json, schema);
  } catch {
    return { ok: false, error: "bad_request" };
  }
}

/** Base URL of the internal API, for route handlers that stream a response through. */
export const INTERNAL_API_URL = API_URL;

export async function apiHealthy(): Promise<boolean> {
  try {
    const res = await fetch(new URL("/healthz", API_URL), {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
