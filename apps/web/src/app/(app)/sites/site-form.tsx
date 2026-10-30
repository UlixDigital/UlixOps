// Spec screen 4: add / edit site. WP Engine fills SSH from install conventions (A107);
// Other hosts still ask for host/user/port/path. Vault key is chosen by name.
"use client";

import type { EnvironmentView, SiteView } from "@ulixops/shared";
import { useState } from "react";
import { ActionForm, type ActionState } from "@/components/action-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";

type Action = (prev: ActionState, form: FormData) => Promise<ActionState>;

function CredentialSelect({
  id,
  name,
  current,
  credentials,
  required,
}: {
  id: string;
  name: string;
  current?: string;
  credentials: string[] | null;
  required?: boolean;
}) {
  const keys =
    credentials && current && !credentials.includes(current)
      ? [current, ...credentials]
      : credentials;
  if (keys) {
    return (
      <Select id={id} name={name} defaultValue={current ?? ""} required={required}>
        <option value="" disabled>
          Choose a key
        </option>
        {keys.map((keyName) => (
          <option key={keyName} value={keyName}>
            {keyName}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      id={id}
      name={name}
      placeholder="CLIENT_SSH_KEY"
      autoComplete="off"
      spellCheck={false}
      defaultValue={current}
      required={required}
    />
  );
}

function ManualSshFields({ prefix, env }: { prefix: string; env: EnvironmentView | undefined }) {
  const id = (name: string) => `${prefix}${name}`;
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={id("sshHost")}>SSH host</Label>
        <Input
          id={id("sshHost")}
          name={id("sshHost")}
          placeholder="example.com"
          autoComplete="off"
          spellCheck={false}
          defaultValue={env?.sshHost}
          required
        />
      </div>
      <div className="grid grid-cols-[1fr_6rem] gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={id("sshUser")}>SSH user</Label>
          <Input
            id={id("sshUser")}
            name={id("sshUser")}
            placeholder="deploy"
            autoComplete="off"
            spellCheck={false}
            defaultValue={env?.sshUser}
            required
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("sshPort")}>Port</Label>
          <Input
            id={id("sshPort")}
            name={id("sshPort")}
            type="number"
            min={1}
            max={65535}
            defaultValue={env?.sshPort ?? 22}
            required
          />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={id("wpPath")}>WordPress path</Label>
        <Input
          id={id("wpPath")}
          name={id("wpPath")}
          placeholder="/var/www/html"
          autoComplete="off"
          spellCheck={false}
          defaultValue={env?.wpPath}
          required
        />
      </div>
    </>
  );
}

function EnvironmentBlock({
  prefix,
  title,
  env,
  credentials,
  host,
  perEnvKeys,
  urlRequired,
}: {
  prefix: string;
  title: string;
  env: EnvironmentView | undefined;
  credentials: string[] | null;
  host: "WPENGINE" | "OTHER";
  perEnvKeys: boolean;
  urlRequired: boolean;
}) {
  const id = (name: string) => `${prefix}${name}`;
  const wpEngine = host === "WPENGINE";
  return (
    <fieldset className="grid gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor={id("url")}>Site URL</Label>
          <Input
            id={id("url")}
            name={id("url")}
            type="url"
            placeholder="https://example.com"
            defaultValue={env?.url}
            required={urlRequired}
          />
        </div>
        {wpEngine && (
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={id("installHint")}>
              WP Engine install name{" "}
              <span className="font-normal text-muted-foreground">
                (needed when the URL is not on *.wpengine.com)
              </span>
            </Label>
            <Input
              id={id("installHint")}
              name={id("installHint")}
              placeholder="clientinstall"
              autoComplete="off"
              spellCheck={false}
              defaultValue={env?.sshUser}
            />
          </div>
        )}
        {!wpEngine && <ManualSshFields prefix={prefix} env={env} />}
        {perEnvKeys && (
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor={id("credentialRef")}>SSH key (from the vault)</Label>
            <CredentialSelect
              id={id("credentialRef")}
              name={id("credentialRef")}
              current={env?.credentialRef}
              credentials={credentials}
              required
            />
          </div>
        )}
      </div>
    </fieldset>
  );
}

export function SiteForm({
  action,
  site,
  credentials,
  submitLabel,
}: {
  action: Action;
  site?: SiteView;
  /** Key names in the vault, or null if the runner couldn't list them. */
  credentials: string[] | null;
  submitLabel: string;
}) {
  const production = site?.environments.find((e) => e.kind === "PRODUCTION");
  const staging = site?.environments.find((e) => e.kind === "STAGING");
  const [host, setHost] = useState<"WPENGINE" | "OTHER">(site?.host ?? "WPENGINE");
  const [hasStaging, setHasStaging] = useState(Boolean(staging));
  const [perEnvKeys, setPerEnvKeys] = useState(
    Boolean(production && staging && production.credentialRef !== staging.credentialRef),
  );
  const defaultShared =
    production?.credentialRef && (!staging || production.credentialRef === staging.credentialRef)
      ? production.credentialRef
      : (production?.credentialRef ?? "");

  return (
    <ActionForm action={action} submitLabel={submitLabel} className="gap-6">
      {site && <input type="hidden" name="siteId" value={site.id} />}
      {!credentials && (
        <Notice tone="error">
          The vault&apos;s key list couldn&apos;t be loaded, so type the key name. Test connection
          will tell you if it&apos;s wrong.
        </Notice>
      )}
      {credentials?.length === 0 && (
        <Notice>The vault has no SSH keys yet. Create one in Settings → Credentials first.</Notice>
      )}
      {host === "WPENGINE" && (
        <Notice>
          For WP Engine, UlixOps fills SSH host, user, port and WordPress path from the install name
          (from a *.wpengine.com URL, or the install field). You choose which vault key to use.
        </Notice>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" maxLength={100} required defaultValue={site?.name} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="host">Host</Label>
          <Select
            id="host"
            name="host"
            value={host}
            onChange={(e) => setHost(e.target.value === "OTHER" ? "OTHER" : "WPENGINE")}
          >
            <option value="WPENGINE">WP Engine</option>
            <option value="OTHER">Other</option>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="tags">Client / tags (comma-separated)</Label>
          <Input
            id="tags"
            name="tags"
            placeholder="acme, retail"
            defaultValue={site?.tags.join(", ")}
          />
        </div>
      </div>

      {!perEnvKeys && (
        <div className="grid gap-1.5 max-w-md">
          <Label htmlFor="sharedCredentialRef">SSH key (from the vault)</Label>
          <CredentialSelect
            id="sharedCredentialRef"
            name="sharedCredentialRef"
            current={defaultShared || undefined}
            credentials={credentials}
            required
          />
          <p className="text-sm text-muted-foreground">
            Used for production{hasStaging ? " and staging" : ""}.{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => setPerEnvKeys(true)}
            >
              Use different keys per environment
            </button>
          </p>
        </div>
      )}
      {perEnvKeys && (
        <p className="text-sm text-muted-foreground">
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setPerEnvKeys(false)}
          >
            Use one SSH key for both environments
          </button>
        </p>
      )}

      <EnvironmentBlock
        prefix="prod_"
        title="Production"
        env={production}
        credentials={credentials}
        host={host}
        perEnvKeys={perEnvKeys}
        urlRequired
      />

      <fieldset className="grid gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-semibold">Staging</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="staging"
            checked={hasStaging}
            onChange={(e) => setHasStaging(e.target.checked)}
            className="size-4"
          />
          This site has a staging environment
        </label>
        {hasStaging && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="stg_url">Site URL</Label>
              <Input
                id="stg_url"
                name="stg_url"
                type="url"
                placeholder="https://clientstg.wpengine.com"
                defaultValue={staging?.url}
                required
              />
            </div>
            {host === "WPENGINE" && (
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="stg_installHint">
                  WP Engine install name{" "}
                  <span className="font-normal text-muted-foreground">
                    (needed when the URL is not on *.wpengine.com)
                  </span>
                </Label>
                <Input
                  id="stg_installHint"
                  name="stg_installHint"
                  placeholder="clientstg"
                  autoComplete="off"
                  spellCheck={false}
                  defaultValue={staging?.sshUser}
                />
              </div>
            )}
            {host === "OTHER" && <ManualSshFields prefix="stg_" env={staging} />}
            {perEnvKeys && (
              <div className="grid gap-1.5 sm:col-span-2">
                <Label htmlFor="stg_credentialRef">SSH key (from the vault)</Label>
                <CredentialSelect
                  id="stg_credentialRef"
                  name="stg_credentialRef"
                  current={staging?.credentialRef}
                  credentials={credentials}
                  required
                />
              </div>
            )}
          </div>
        )}
      </fieldset>

      {site && (
        <p className="text-sm text-muted-foreground">
          A new SSH key, server, port or user waits for another Admin to approve it. Name, tags,
          URLs and the WordPress path change straight away.
        </p>
      )}
    </ActionForm>
  );
}
