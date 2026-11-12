"use client";
// Interactive file browser for a site environment (A179).
import {
  FILES_MAX_BYTES,
  type FileEntry,
  isSecretRelPath,
  type SiteFilesListResponse,
  type SiteFilesReadResponse,
} from "@ulixops/shared";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { formatBytes } from "@/lib/backups";
import { cn } from "@/lib/utils";
import {
  deleteFileAction,
  listFilesAction,
  mkdirAction,
  readFileAction,
  renameFileAction,
  writeFileAction,
} from "./actions";

function joinPath(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name;
}

function parentPath(path: string) {
  if (!path.includes("/")) return "";
  return path.slice(0, path.lastIndexOf("/"));
}

function basename(path: string) {
  return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
}

export function FilesBrowser({
  siteId,
  kind,
  wpPath,
  canWrite,
  initialListing = null,
  initialError = null,
}: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  wpPath: string;
  canWrite: boolean;
  /** Root listing from the server so the first paint is not empty (A179). */
  initialListing?: Extract<SiteFilesListResponse, { ok: true }> | null;
  initialError?: string | null;
}) {
  const [path, setPath] = useState("");
  const [listing, setListing] = useState<Extract<SiteFilesListResponse, { ok: true }> | null>(
    initialListing,
  );
  const [error, setError] = useState<string | null>(initialError);
  const [pending, start] = useTransition();
  const [editor, setEditor] = useState<{
    path: string;
    content: string;
    secret: boolean;
    binary: boolean;
  } | null>(null);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [newName, setNewName] = useState("");
  const [renameFrom, setRenameFrom] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteTyped, setDeleteTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    (dir: string, opts?: { keepListing?: boolean }) => {
      setError(null);
      setPath(dir);
      if (!opts?.keepListing) setListing(null);
      start(async () => {
        const res = await listFilesAction({ siteId, kind, path: dir });
        if (!res.ok) {
          if (!opts?.keepListing) setListing(null);
          setError(
            res.error === "runner_failed" || res.error === "runner_unavailable"
              ? "Could not reach the server. Check Faster SFTP settings (user + vault key must match Test connection) and try again."
              : "Could not list that folder. Check the connection and try again.",
          );
          return;
        }
        if (!res.data.ok) {
          if (!opts?.keepListing) setListing(null);
          setError(res.data.detail);
          return;
        }
        setListing(res.data);
      });
    },
    [siteId, kind],
  );

  useEffect(() => {
    // Page shell renders immediately; load the root listing on the client (A183).
    if (initialListing || initialError) return;
    refresh("");
  }, [refresh, initialListing, initialError]);

  const openFile = (rel: string) => {
    setError(null);
    setBusy(true);
    void (async () => {
      const res = await readFileAction({ siteId, kind, path: rel });
      setBusy(false);
      if (!res.ok) {
        setError("Could not open that file.");
        return;
      }
      if (!res.data.ok) {
        setError(res.data.detail);
        return;
      }
      const data = res.data as Extract<SiteFilesReadResponse, { ok: true }>;
      if (data.binary) {
        setError(
          `“${basename(rel)}” looks binary (${formatBytes(data.size)}). Download isn’t in the hub yet — use SSH or a Drive backup.`,
        );
        return;
      }
      setEditor({
        path: data.path,
        content: data.content,
        secret: data.secret,
        binary: false,
      });
    })();
  };

  const saveEditor = () => {
    if (!editor || !canWrite) return;
    setBusy(true);
    setError(null);
    void (async () => {
      const res = await writeFileAction({
        siteId,
        kind,
        path: editor.path,
        content: editor.content,
        encoding: "utf8",
      });
      setBusy(false);
      if (!res.ok) {
        setError("Save failed.");
        return;
      }
      if (!res.data.ok) {
        setError(res.data.detail);
        return;
      }
      setEditor(null);
      refresh(path);
    })();
  };

  const createThing = () => {
    if (!canWrite || !creating || !newName.trim()) return;
    const rel = joinPath(path, newName.trim());
    setBusy(true);
    setError(null);
    void (async () => {
      if (creating === "dir") {
        const res = await mkdirAction({ siteId, kind, path: rel });
        setBusy(false);
        if (!res.ok) {
          setError("Could not create the folder.");
          return;
        }
        if (!res.data.ok) {
          setError(res.data.detail);
          return;
        }
      } else {
        const res = await writeFileAction({
          siteId,
          kind,
          path: rel,
          content: "",
          encoding: "utf8",
        });
        setBusy(false);
        if (!res.ok) {
          setError("Could not create the file.");
          return;
        }
        if (!res.data.ok) {
          setError(res.data.detail);
          return;
        }
      }
      setCreating(null);
      setNewName("");
      refresh(path);
      if (creating === "file") openFile(rel);
    })();
  };

  const doRename = () => {
    if (!canWrite || !renameFrom || !renameTo.trim()) return;
    const to = joinPath(path, renameTo.trim());
    setBusy(true);
    setError(null);
    void (async () => {
      const res = await renameFileAction({
        siteId,
        kind,
        from: joinPath(path, renameFrom),
        to,
      });
      setBusy(false);
      if (!res.ok) {
        setError("Rename failed.");
        return;
      }
      if (!res.data.ok) {
        setError(res.data.detail);
        return;
      }
      setRenameFrom(null);
      setRenameTo("");
      refresh(path);
    })();
  };

  const doDelete = () => {
    if (!canWrite || !deleteTarget) return;
    if (deleteTyped !== deleteTarget.name) return;
    const rel = joinPath(path, deleteTarget.name);
    setBusy(true);
    setError(null);
    void (async () => {
      const res = await deleteFileAction({
        siteId,
        kind,
        path: rel,
        recursive: deleteTarget.kind === "dir",
      });
      setBusy(false);
      if (!res.ok) {
        setError("Delete failed.");
        return;
      }
      if (!res.data.ok) {
        setError(res.data.detail);
        return;
      }
      setDeleteTarget(null);
      setDeleteTyped("");
      refresh(path);
    })();
  };

  const onUpload = (file: File | null) => {
    if (!canWrite || !file) return;
    if (file.size > FILES_MAX_BYTES) {
      setError(`Uploads are limited to ${formatBytes(FILES_MAX_BYTES)}.`);
      return;
    }
    const rel = joinPath(path, file.name.replace(/[^A-Za-z0-9._-]/g, "_"));
    setBusy(true);
    setError(null);
    void (async () => {
      const buf = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
      const content = btoa(binary);
      const res = await writeFileAction({
        siteId,
        kind,
        path: rel,
        content,
        encoding: "base64",
      });
      setBusy(false);
      if (!res.ok) {
        setError("Upload failed.");
        return;
      }
      if (!res.data.ok) {
        setError(res.data.detail);
        return;
      }
      refresh(path);
    })();
  };

  const crumbs = path ? path.split("/") : [];

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground font-mono break-all">
        {wpPath}
        {path ? `/${path}` : ""}
      </p>

      <nav aria-label="Path" className="flex flex-wrap items-center gap-1 text-sm">
        <button
          type="button"
          className="text-link hover:underline"
          onClick={() => refresh("", { keepListing: true })}
          disabled={pending || busy}
        >
          root
        </button>
        {crumbs.map((c, i) => {
          const dest = crumbs.slice(0, i + 1).join("/");
          return (
            <span key={dest} className="inline-flex items-center gap-1">
              <span className="text-muted-foreground">/</span>
              <button
                type="button"
                className="text-link hover:underline"
                onClick={() => refresh(dest, { keepListing: true })}
                disabled={pending || busy}
              >
                {c}
              </button>
            </span>
          );
        })}
        {path !== "" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-2"
            disabled={pending || busy}
            onClick={() => refresh(parentPath(path), { keepListing: true })}
          >
            Up
          </Button>
        )}
      </nav>

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setCreating("file");
              setNewName("");
            }}
          >
            New file
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setCreating("dir");
              setNewName("");
            }}
          >
            New folder
          </Button>
          <label className="inline-flex h-8 cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-accent">
            Upload
            <input
              type="file"
              className="sr-only"
              disabled={busy}
              onChange={(e) => {
                onUpload(e.target.files?.[0] ?? null);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {(pending || busy) && !listing && (
        <p className="text-sm text-muted-foreground">Loading folder…</p>
      )}
      {pending && listing && (
        <p className="text-xs text-muted-foreground">Updating…</p>
      )}

      {creating && (
        <div className="grid gap-2 rounded-md border p-3">
          <Label htmlFor="new-name">
            {creating === "dir" ? "Folder name" : "File name"} in this directory
          </Label>
          <Input
            id="new-name"
            value={newName}
            autoComplete="off"
            onChange={(e) => setNewName(e.target.value)}
            placeholder={creating === "dir" ? "uploads-extra" : "note.txt"}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || !newName.trim()}
              onClick={createThing}
            >
              Create
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setCreating(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {renameFrom && (
        <div className="grid gap-2 rounded-md border p-3">
          <Label htmlFor="rename-to">Rename {renameFrom} to</Label>
          <Input
            id="rename-to"
            value={renameTo}
            autoComplete="off"
            onChange={(e) => setRenameTo(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || !renameTo.trim()} onClick={doRename}>
              Rename
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRenameFrom(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-sm font-medium">
            Delete {deleteTarget.kind === "dir" ? "folder" : "file"} “{deleteTarget.name}”
            {deleteTarget.kind === "dir" ? " and everything inside it" : ""}?
          </p>
          <Label htmlFor="delete-confirm">Type the name to confirm</Label>
          <Input
            id="delete-confirm"
            value={deleteTyped}
            autoComplete="off"
            onChange={(e) => setDeleteTyped(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || deleteTyped !== deleteTarget.name}
              onClick={doDelete}
            >
              Delete
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setDeleteTarget(null);
                setDeleteTyped("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {editor && (
        <div className="grid gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-sm break-all">{editor.path}</p>
            <div className="flex gap-2">
              {canWrite && !editor.binary && (
                <Button type="button" size="sm" disabled={busy} onClick={saveEditor}>
                  Save
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                Close
              </Button>
            </div>
          </div>
          {editor.secret && (
            <Notice>
              This file often holds secrets (database password, keys). Edits are audited; the hub
              never stores the file contents in the audit log.
            </Notice>
          )}
          <textarea
            className={cn(
              "min-h-64 w-full rounded-md border bg-background p-3 font-mono text-xs leading-relaxed",
              !canWrite && "opacity-80",
            )}
            value={editor.content}
            readOnly={!canWrite}
            spellCheck={false}
            onChange={(e) => setEditor({ ...editor, content: e.target.value })}
          />
        </div>
      )}

      {listing && !editor && (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {listing.entries.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-muted-foreground">
                    This folder is empty.
                  </td>
                </tr>
              ) : (
                listing.entries.map((e) => {
                  const rel = joinPath(path, e.name);
                  const secret = isSecretRelPath(rel);
                  return (
                    <tr key={e.name} className="hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono">
                        {e.kind === "dir" ? (
                          <button
                            type="button"
                            className="text-link hover:underline"
                            onClick={() => refresh(rel, { keepListing: true })}
                            disabled={pending || busy}
                          >
                            {e.name}/
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="text-link hover:underline"
                            onClick={() => openFile(rel)}
                            disabled={pending || busy}
                          >
                            {e.name}
                            {secret ? " · secret" : ""}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{e.kind}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">
                        {e.kind === "file" ? formatBytes(e.size) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {canWrite && (
                          <span className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className="text-xs text-link hover:underline"
                              disabled={busy}
                              onClick={() => {
                                setRenameFrom(e.name);
                                setRenameTo(e.name);
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="text-xs text-destructive hover:underline"
                              disabled={busy}
                              onClick={() => {
                                setDeleteTarget(e);
                                setDeleteTyped("");
                              }}
                            >
                              Delete
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {listing.truncated && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Listing truncated to the first entries.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
