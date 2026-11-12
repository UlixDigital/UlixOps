// The runner is the only component that talks to the vault (spec section 4).
import { type CredentialInfo, CredentialRef } from "@ulixops/shared";
import { z } from "zod";

export interface Vault {
  /** The secret value (an SSH private key). Never log or return it. */
  read(name: string): Promise<string>;
  /** Names and dates only: values are never fetched for a listing. */
  list(): Promise<CredentialInfo[]>;
  create(name: string, value: string, comment: string): Promise<void>;
  /** Overwrites an existing secret's value (integration API keys, A133). */
  replace(name: string, value: string): Promise<void>;
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly kind: "not_found" | "exists" | "unavailable",
  ) {
    super(message);
  }
}

export interface InfisicalConfig {
  url: string;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  secretPath: string;
}

const Login = z.object({ accessToken: z.string(), expiresIn: z.number() });
const Secret = z.object({ secret: z.object({ secretValue: z.string() }) });
const Listing = z.object({
  secrets: z.array(
    z.object({ secretKey: z.string(), createdAt: z.string(), updatedAt: z.string() }),
  ),
});

/** Infisical via Universal Auth. Access tokens are short-lived (5 min) and kept in memory only. */
export class InfisicalVault implements Vault {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: InfisicalConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const res = await this.fetchImpl(new URL(path, this.config.url), {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await this.accessToken()}`,
        ...init.headers,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 && retry) {
      this.token = null;
      return this.request(path, init, false);
    }
    return res;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 30_000 > this.now()) return this.token.value;
    const res = await this.fetchImpl(
      new URL("/api/v1/auth/universal-auth/login", this.config.url),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new VaultError(`Vault sign-in failed (HTTP ${res.status})`, "unavailable");
    const login = Login.parse(await res.json());
    this.token = { value: login.accessToken, expiresAt: this.now() + login.expiresIn * 1000 };
    return login.accessToken;
  }

  private scope(extra: Record<string, string> = {}) {
    const { projectId, environment, secretPath } = this.config;
    return new URLSearchParams({ projectId, environment, secretPath, ...extra });
  }

  async read(name: string): Promise<string> {
    const ref = CredentialRef.parse(name);
    const res = await this.request(
      `/api/v4/secrets/${ref}?${this.scope({ viewSecretValue: "true" })}`,
    );
    if (res.status === 404) throw new VaultError(`"${ref}" is not in the vault`, "not_found");
    if (!res.ok) throw new VaultError(`Vault read failed (HTTP ${res.status})`, "unavailable");
    return Secret.parse(await res.json()).secret.secretValue;
  }

  async list(): Promise<CredentialInfo[]> {
    const res = await this.request(`/api/v4/secrets?${this.scope({ viewSecretValue: "false" })}`);
    if (!res.ok) throw new VaultError(`Vault listing failed (HTTP ${res.status})`, "unavailable");
    return Listing.parse(await res.json())
      .secrets.filter((s) => CredentialRef.safeParse(s.secretKey).success)
      .map((s) => ({
        name: s.secretKey,
        createdAt: new Date(s.createdAt).toISOString(),
        updatedAt: new Date(s.updatedAt).toISOString(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async create(name: string, value: string, comment: string): Promise<void> {
    const ref = CredentialRef.parse(name);
    const { projectId, environment, secretPath } = this.config;
    const res = await this.request(`/api/v4/secrets/${ref}`, {
      method: "POST",
      body: JSON.stringify({
        projectId,
        environment,
        secretPath,
        secretValue: value,
        secretComment: comment,
        type: "shared",
      }),
    });
    if (res.status === 400 || res.status === 409) {
      throw new VaultError(`"${ref}" already exists in the vault`, "exists");
    }
    if (!res.ok) throw new VaultError(`Vault write failed (HTTP ${res.status})`, "unavailable");
  }

  async replace(name: string, value: string): Promise<void> {
    const ref = CredentialRef.parse(name);
    const { projectId, environment, secretPath } = this.config;
    const res = await this.request(`/api/v4/secrets/${ref}`, {
      method: "PATCH",
      body: JSON.stringify({ projectId, environment, secretPath, secretValue: value }),
    });
    if (res.status === 404) throw new VaultError(`"${ref}" is not in the vault`, "not_found");
    if (!res.ok) throw new VaultError(`Vault write failed (HTTP ${res.status})`, "unavailable");
  }
}

/** In-memory vault for tests. */
export class MemoryVault implements Vault {
  readonly secrets = new Map<string, { value: string; at: string }>();

  async read(name: string): Promise<string> {
    const secret = this.secrets.get(name);
    if (!secret) throw new VaultError(`"${name}" is not in the vault`, "not_found");
    return secret.value;
  }

  async list(): Promise<CredentialInfo[]> {
    return [...this.secrets.entries()].map(([name, s]) => ({
      name,
      createdAt: s.at,
      updatedAt: s.at,
    }));
  }

  async create(name: string, value: string): Promise<void> {
    if (this.secrets.has(name))
      throw new VaultError(`"${name}" already exists in the vault`, "exists");
    this.secrets.set(name, { value, at: new Date().toISOString() });
  }

  async replace(name: string, value: string): Promise<void> {
    if (!this.secrets.has(name)) throw new VaultError(`"${name}" is not in the vault`, "not_found");
    this.secrets.set(name, { value, at: new Date().toISOString() });
  }
}
