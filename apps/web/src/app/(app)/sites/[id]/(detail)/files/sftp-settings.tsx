"use client";
// Collapsible dedicated SFTP settings for the Files tab (A180/A182).
import type { FilesSftpConnection, FilesSftpConnectionView } from "@ulixops/shared";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import { saveFilesSftpAction } from "./actions";

export function FilesSftpSettings({
  siteId,
  kind,
  canWrite,
  initial,
  credentialNames,
  defaults,
}: {
  siteId: string;
  kind: "PRODUCTION" | "STAGING";
  canWrite: boolean;
  initial: FilesSftpConnectionView;
  credentialNames: string[];
  /** Prefill from the site's SSH settings when enabling. */
  defaults: { host: string; user: string; path: string; credentialRef: string };
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [authKind, setAuthKind] = useState<"key" | "password">(initial.authKind ?? "password");
  const [host, setHost] = useState(initial.host ?? suggestSftpHost(defaults.host));
  const [port, setPort] = useState(String(initial.port ?? 2222));
  const [user, setUser] = useState(initial.user ?? "");
  const [path, setPath] = useState(initial.path ?? defaults.path);
  const [credentialRef, setCredentialRef] = useState(
    initial.credentialRef ?? defaults.credentialRef,
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [current, setCurrent] = useState(initial);

  const save = () => {
    setError(null);
    setSaved(null);
    start(async () => {
      if (!enabled) {
        const res = await saveFilesSftpAction({ siteId, kind, connection: null });
        if (!res.ok) {
          setError("Could not clear SFTP settings.");
          return;
        }
        setCurrent(res.data);
        setPassword("");
        setSaved("Using the site SSH connection again.");
        return;
      }
      const portNum = Number.parseInt(port, 10);
      const base = {
        host: host.trim(),
        port: Number.isFinite(portNum) ? portNum : 2222,
        user: user.trim(),
        path: path.trim(),
      };
      const connection: FilesSftpConnection =
        authKind === "key"
          ? { ...base, authKind: "key", credentialRef }
          : {
              ...base,
              authKind: "password",
              ...(password ? { password } : {}),
            };
      if (authKind === "password" && !password && !current.passwordSet) {
        setError("Enter the SFTP password.");
        return;
      }
      const res = await saveFilesSftpAction({ siteId, kind, connection });
      if (!res.ok) {
        setError("Could not save SFTP settings. Check host, user, path and password/key.");
        return;
      }
      setCurrent(res.data);
      setEnabled(res.data.enabled);
      setAuthKind(res.data.authKind);
      setPassword("");
      setSaved("SFTP settings saved. Open the folder again to use them.");
    });
  };

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="font-medium">
          Faster SFTP connection
          {current.enabled ? (
            <span className="ml-2 text-xs font-normal text-success">
              on · {current.host}
              {current.authKind === "password" ? " · password" : " · key"}
            </span>
          ) : (
            <span className="ml-2 text-xs font-normal text-muted-foreground">off · using SSH</span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="grid gap-3 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Use the same SFTP host / port / user / password as FileZilla (often{" "}
            <span className="font-mono">*.sftp.wpengine.com</span> port{" "}
            <span className="font-mono">2222</span>). The password is sealed into the vault and
            never shown again. SSH vault keys are optional if your host accepts them.
          </p>
          {canWrite ? (
            <>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                Use dedicated SFTP for this environment&apos;s Files tab
              </label>
              {enabled && (
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="grid gap-1.5 md:col-span-2">
                    <Label>Authentication</Label>
                    <div className="flex flex-wrap gap-3 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="files-sftp-auth"
                          checked={authKind === "password"}
                          onChange={() => setAuthKind("password")}
                        />
                        Password (FileZilla)
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="files-sftp-auth"
                          checked={authKind === "key"}
                          onChange={() => setAuthKind("key")}
                        />
                        SSH key in vault
                      </label>
                    </div>
                  </div>
                  <div className="grid gap-1.5 md:col-span-2">
                    <Label htmlFor="files-sftp-host">SFTP host</Label>
                    <Input
                      id="files-sftp-host"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="jpplumbery.sftp.wpengine.com"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="files-sftp-port">Port</Label>
                    <Input
                      id="files-sftp-port"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      inputMode="numeric"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="files-sftp-user">User</Label>
                    <Input
                      id="files-sftp-user"
                      value={user}
                      onChange={(e) => setUser(e.target.value)}
                      placeholder="jpplumbery-anupa"
                      autoComplete="off"
                    />
                  </div>
                  <div className="grid gap-1.5 md:col-span-2">
                    <Label htmlFor="files-sftp-path">Remote path</Label>
                    <Input
                      id="files-sftp-path"
                      value={path}
                      onChange={(e) => setPath(e.target.value)}
                      placeholder="/sites/jpplumbery"
                      className="font-mono text-sm"
                      autoComplete="off"
                    />
                  </div>
                  {authKind === "password" ? (
                    <div className="grid gap-1.5 md:col-span-2">
                      <Label htmlFor="files-sftp-password">
                        Password
                        {current.passwordSet && authKind === "password" ? (
                          <span className="ml-2 font-normal text-muted-foreground">
                            (saved — leave blank to keep)
                          </span>
                        ) : null}
                      </Label>
                      <Input
                        id="files-sftp-password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="new-password"
                        placeholder={current.passwordSet ? "••••••••" : undefined}
                      />
                    </div>
                  ) : (
                    <div className="grid gap-1.5 md:col-span-2">
                      <Label htmlFor="files-sftp-key">SSH key in the vault</Label>
                      <Select
                        id="files-sftp-key"
                        value={credentialRef}
                        onChange={(e) => setCredentialRef(e.target.value)}
                      >
                        {credentialNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                </div>
              )}
              {error && <Notice tone="error">{error}</Notice>}
              {saved && <Notice>{saved}</Notice>}
              <div className="flex flex-wrap gap-2">
                {enabled && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setHost(suggestSftpHost(defaults.host));
                      setPort("2222");
                      setPath(defaults.path);
                      setCredentialRef(defaults.credentialRef);
                      setAuthKind("password");
                      setPassword("");
                      setError(null);
                      setSaved(null);
                    }}
                  >
                    Prefill host from site
                  </Button>
                )}
                <Button type="button" size="sm" disabled={pending} onClick={save}>
                  {pending ? "Saving…" : "Save SFTP settings"}
                </Button>
              </div>
            </>
          ) : (
            <Notice>Only Admins can change SFTP settings.</Notice>
          )}
        </div>
      )}
    </div>
  );
}

function suggestSftpHost(sshHost: string): string {
  // jpplumbery.ssh.wpengine.net → jpplumbery.sftp.wpengine.com
  if (sshHost.includes(".ssh.wpengine."))
    return sshHost
      .replace(".ssh.wpengine.net", ".sftp.wpengine.com")
      .replace(".ssh.wpengine.com", ".sftp.wpengine.com");
  return sshHost;
}
