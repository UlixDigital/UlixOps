"use server";
// Site Files tab actions (A179). File bodies are never written to the audit log (API side).
import {
  FilesDeleteBody,
  FilesMkdirBody,
  FilesRenameBody,
  FilesSftpConnectionUpdate,
  FilesSftpConnectionView,
  FilesWriteBody,
  RelPath,
  SiteFilesListResponse,
  SiteFilesMutateResult,
  SiteFilesReadResponse,
  type FilesSftpConnection,
} from "@ulixops/shared";
import { apiGet, apiSend } from "@/lib/api";
import { apiAuth } from "@/lib/auth";
import { revalidatePath } from "next/cache";

function envPath(siteId: string, kind: "PRODUCTION" | "STAGING", suffix = "") {
  const k = kind === "STAGING" ? "staging" : "production";
  return `/sites/${siteId}/environments/${k}/files${suffix}`;
}

export async function listFilesAction(input: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  path: string;
}) {
  const path = RelPath.safeParse(input.path);
  if (!path.success) return { ok: false as const, error: "bad_request" as const };
  const q = path.data ? `?path=${encodeURIComponent(path.data)}` : "";
  return apiGet(
    `${envPath(input.siteId, input.kind)}${q}`,
    SiteFilesListResponse,
    await apiAuth(),
    { timeoutMs: 120_000 },
  );
}

export async function readFileAction(input: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  path: string;
}) {
  const path = RelPath.safeParse(input.path);
  if (!path.success || !path.data) return { ok: false as const, error: "bad_request" as const };
  return apiGet(
    `${envPath(input.siteId, input.kind, "/content")}?path=${encodeURIComponent(path.data)}`,
    SiteFilesReadResponse,
    await apiAuth(),
    { timeoutMs: 120_000 },
  );
}

export async function writeFileAction(input: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}) {
  const body = FilesWriteBody.safeParse({
    path: input.path,
    content: input.content,
    encoding: input.encoding ?? "utf8",
  });
  if (!body.success) return { ok: false as const, error: "bad_request" as const };
  return apiSend(
    "PUT",
    envPath(input.siteId, input.kind, "/content"),
    body.data,
    SiteFilesMutateResult,
    await apiAuth(),
    { timeoutMs: 120_000 },
  );
}

export async function mkdirAction(input: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  path: string;
}) {
  const body = FilesMkdirBody.safeParse({ path: input.path });
  if (!body.success) return { ok: false as const, error: "bad_request" as const };
  return apiSend(
    "POST",
    envPath(input.siteId, input.kind, "/mkdir"),
    body.data,
    SiteFilesMutateResult,
    await apiAuth(),
    { timeoutMs: 120_000 },
  );
}

export async function renameFileAction(input: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  from: string;
  to: string;
}) {
  const body = FilesRenameBody.safeParse({ from: input.from, to: input.to });
  if (!body.success) return { ok: false as const, error: "bad_request" as const };
  return apiSend(
    "POST",
    envPath(input.siteId, input.kind, "/rename"),
    body.data,
    SiteFilesMutateResult,
    await apiAuth(),
    { timeoutMs: 120_000 },
  );
}

export async function deleteFileAction(input: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  path: string;
  recursive: boolean;
}) {
  const body = FilesDeleteBody.safeParse({
    path: input.path,
    recursive: input.recursive,
  });
  if (!body.success) return { ok: false as const, error: "bad_request" as const };
  return apiSend(
    "POST",
    envPath(input.siteId, input.kind, "/delete"),
    body.data,
    SiteFilesMutateResult,
    await apiAuth(),
    { timeoutMs: 120_000 },
  );
}

export async function saveFilesSftpAction(input: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  connection: FilesSftpConnection | null;
}) {
  const body = FilesSftpConnectionUpdate.safeParse(input.connection);
  if (!body.success) return { ok: false as const, error: "bad_request" as const };
  const res = await apiSend(
    "PUT",
    envPath(input.siteId, input.kind, "/sftp"),
    body.data,
    FilesSftpConnectionView,
    await apiAuth(),
    { timeoutMs: 15_000 },
  );
  if (res.ok) {
    revalidatePath(`/sites/${input.siteId}/files`);
  }
  return res;
}
