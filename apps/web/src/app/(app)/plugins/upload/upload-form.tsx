"use client";
// Screen 7: drop a ZIP → UlixOps checks it and shows the checksum and every check → add the
// changelog and the "changes database" flag → save. Nothing is kept unless every check passes.
import { MAX_PLUGIN_ZIP_BYTES, PluginUploadResult, type UploadCheck } from "@ulixops/shared";
import { CircleCheck, CircleX, FileArchive, Info, TriangleAlert } from "lucide-react";
import { type DragEvent, type FormEvent, useId, useRef, useState } from "react";
import { z } from "zod";
import { ActionForm, CopyField } from "@/components/action-form";
import { BusyOverlay } from "@/components/pending-ui";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { savePluginVersionAction } from "../actions";

interface CheckState {
  error?: string;
  result?: PluginUploadResult;
}

const UploadAnswer = z.union([
  z.object({ result: PluginUploadResult }),
  z.object({ error: z.string() }),
]);

/**
 * Sends the raw ZIP to /api/plugins/upload. Not a Server Action: Cloudflare's managed rule for
 * CVE-2025-55183 blocks Server Action requests with a large binary body (A141).
 */
async function checkZip(file: File): Promise<CheckState> {
  try {
    const res = await fetch(`/api/plugins/upload?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: file,
      credentials: "same-origin",
    });
    const parsed = UploadAnswer.safeParse(await res.json().catch(() => null));
    if (parsed.success) return parsed.data;
    return {
      error:
        res.status === 403
          ? "The upload was blocked before it reached UlixOps (HTTP 403). Refresh the page and try again."
          : `The upload failed (HTTP ${res.status}). Refresh the page and try again.`,
    };
  } catch {
    return { error: "The upload didn't go through. Check your connection and try again." };
  }
}

const CHECK_LABELS: Record<UploadCheck["name"], string> = {
  file: "File: size and ZIP content",
  archive: "Archive structure",
  paths: "File paths",
  layout: "Plugin folder",
  plugin: "Plugin header and version",
  contents: "Contents scan",
};

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function UploadForm() {
  const [state, setState] = useState<CheckState>({});
  const [checking, setChecking] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const tooBig = file !== null && file.size > MAX_PLUGIN_ZIP_BYTES;
  const result = state.result;

  async function onCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || tooBig || checking) return;
    setChecking(true);
    setState({});
    setState(await checkZip(file));
    setChecking(false);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files;
    if (input.current && dropped.length > 0) {
      input.current.files = dropped;
      setFile(dropped[0] ?? null);
    }
  }

  return (
    <div className="grid gap-4">
      <form onSubmit={onCheck} className="grid gap-3">
        <BusyOverlay pending={checking} label="Checking ZIP…" />
        <label
          htmlFor={`${id}-zip`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "grid cursor-pointer justify-items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center text-sm transition-colors duration-150 focus-within:ring-2 focus-within:ring-ring",
            dragging ? "border-primary bg-primary/5" : "hover:bg-muted/40",
          )}
        >
          <FileArchive aria-hidden className="size-6 text-muted-foreground" />
          {file ? (
            <span>
              <span className="font-medium">{file.name}</span>{" "}
              <span className="text-muted-foreground">({megabytes(file.size)})</span>
            </span>
          ) : (
            <span>
              <span className="font-medium">Drop a plugin ZIP here</span> or click to choose one
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            One folder named after the plugin, up to {megabytes(MAX_PLUGIN_ZIP_BYTES)}
          </span>
          <input
            ref={input}
            id={`${id}-zip`}
            name="zip"
            type="file"
            accept=".zip,application/zip"
            required
            className="sr-only"
            onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
          />
        </label>
        {tooBig && (
          <p role="alert" className="text-sm text-destructive">
            That file is larger than {megabytes(MAX_PLUGIN_ZIP_BYTES)}.
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <div>
          <Button type="submit" disabled={!file || tooBig || checking}>
            {checking ? "Checking…" : "Check ZIP"}
          </Button>
        </div>
      </form>

      {result && (
        <section
          aria-label="Check result"
          role="status"
          className="grid gap-3 rounded-lg border p-4 text-sm"
        >
          <p className="font-medium">
            {result.ok
              ? `${result.name} ${result.version} passed every check.`
              : "This ZIP can't be added. Nothing was kept."}
          </p>
          <ul className="grid gap-1.5">
            {result.checks.map((check, i) => (
              <li key={`${check.name}-${i}`} className="flex items-start gap-2">
                {check.ok ? (
                  <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <CircleX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <span>
                  <span className="font-medium">{CHECK_LABELS[check.name]}</span>
                  <span className="sr-only">{check.ok ? ": passed" : ": failed"}</span>
                  <span className="block text-xs break-words text-muted-foreground">
                    {check.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {result.warnings.length > 0 && (
            <ul className="grid gap-1 rounded-md bg-warning/10 px-3 py-2 text-warning">
              {result.warnings.map((warning, i) => (
                <li key={i} className="flex items-start gap-2">
                  <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                  <span className="break-words">{warning}</span>
                </li>
              ))}
            </ul>
          )}
          {result.notes.length > 0 && (
            <ul className="grid gap-1 rounded-md bg-muted/50 px-3 py-2">
              {result.notes.map((note, i) => (
                <li key={i} className="flex items-start gap-2">
                  <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="break-words">{note}</span>
                </li>
              ))}
            </ul>
          )}
          <CopyField
            value={result.sha256}
            note={
              result.uploadedSha256
                ? "SHA-256 checksum of the ZIP UlixOps keeps (without the macOS metadata)"
                : "SHA-256 checksum of the uploaded file"
            }
            label="SHA-256"
          />
          {result.uploadedSha256 && (
            <p className="text-xs break-all text-muted-foreground">
              Uploaded file: <span className="font-mono">{result.uploadedSha256}</span>
            </p>
          )}
          {result.slug && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Plugin</dt>
              <dd>
                {result.name ?? "—"} <span className="font-mono text-xs">({result.slug})</span>{" "}
                {result.pluginExists ? (
                  <span className="text-muted-foreground">
                    · in the registry, latest {result.latestVersion ?? "—"}
                  </span>
                ) : (
                  <span className="text-muted-foreground">· new to the registry</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Files</dt>
              <dd>
                {result.fileCount} · {megabytes(result.sizeBytes)}
              </dd>
              <dt className="text-muted-foreground">Requires</dt>
              <dd>
                WordPress {result.requiresWp ?? "—"} · PHP {result.requiresPhp ?? "—"}
              </dd>
            </dl>
          )}
        </section>
      )}

      {result?.ok && result.uploadId && (
        <ActionForm action={savePluginVersionAction} submitLabel="Add to the registry">
          <input type="hidden" name="uploadId" value={result.uploadId} />
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-version`}>Version</Label>
            <input
              id={`${id}-version`}
              readOnly
              value={result.version ?? ""}
              className="h-9 w-40 rounded-md border bg-muted/40 px-3 font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              From the plugin&apos;s Version header, so it matches what WordPress reports.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-changelog`}>Changelog</Label>
            <textarea
              id={`${id}-changelog`}
              name="changelog"
              required
              maxLength={5000}
              rows={6}
              className="rounded-md border bg-background px-3 py-2 text-sm"
              placeholder="What changed, and anything to check after deploying"
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="dbChanging" className="mt-1" />
            <span>
              <span className="font-medium">Changes the database</span>
              <span className="block text-muted-foreground">
                Tick when this version alters tables or stored data. Pre-update snapshots (Build
                Order step 8) then include a database export before it is deployed.
              </span>
            </span>
          </label>
        </ActionForm>
      )}
    </div>
  );
}
