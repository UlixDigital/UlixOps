import { describe, expect, it, vi } from "vitest";
import { InfisicalVault, VaultError } from "./vault";

const CONFIG = {
  url: "http://infisical:8080",
  clientId: "client-id",
  clientSecret: "client-secret",
  projectId: "project-1",
  environment: "prod",
  secretPath: "/ssh-keys",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request ${key}${url.search}`);
    return handler(init);
  });
}

const login = () =>
  json({ accessToken: "token-1", expiresIn: 300, accessTokenMaxTTL: 3600, tokenType: "Bearer" });

describe("InfisicalVault", () => {
  it("signs in once, then reads a secret with the token", async () => {
    const fetch = fakeFetch({
      "POST /api/v1/auth/universal-auth/login": login,
      "GET /api/v4/secrets/SSH_KEY_SITE": () => json({ secret: { secretValue: "PRIVATE" } }),
    });
    const vault = new InfisicalVault(CONFIG, fetch);
    expect(await vault.read("SSH_KEY_SITE")).toBe("PRIVATE");
    expect(await vault.read("SSH_KEY_SITE")).toBe("PRIVATE");
    expect(fetch.mock.calls.filter(([u]) => String(u).includes("/login"))).toHaveLength(1);
    const [url, init] = fetch.mock.calls[1] ?? [];
    expect(String(url)).toContain("projectId=project-1&environment=prod&secretPath=%2Fssh-keys");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("lists names and dates without ever requesting values", async () => {
    const fetch = fakeFetch({
      "POST /api/v1/auth/universal-auth/login": login,
      "GET /api/v4/secrets": () =>
        json({
          secrets: [
            {
              secretKey: "SSH_KEY_B",
              secretValue: "<hidden>",
              createdAt: "2026-01-02T00:00:00.000Z",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
            {
              secretKey: "not-a-credential",
              secretValue: "<hidden>",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              secretKey: "SSH_KEY_A",
              secretValue: "<hidden>",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-03-01T00:00:00.000Z",
            },
          ],
        }),
    });
    const list = await new InfisicalVault(CONFIG, fetch).list();
    expect(list.map((c) => c.name)).toEqual(["SSH_KEY_A", "SSH_KEY_B"]);
    expect(JSON.stringify(list)).not.toContain("hidden");
    expect(String(fetch.mock.calls[1]?.[0])).toContain("viewSecretValue=false");
  });

  it("creates secrets in the configured folder and reports duplicates", async () => {
    let body: unknown;
    const fetch = fakeFetch({
      "POST /api/v1/auth/universal-auth/login": login,
      "POST /api/v4/secrets/SSH_KEY_NEW": (init) => {
        body = JSON.parse(String(init?.body));
        return json({ secret: {} });
      },
      "POST /api/v4/secrets/SSH_KEY_TAKEN": () => json({ message: "exists" }, 400),
    });
    const vault = new InfisicalVault(CONFIG, fetch);
    await vault.create("SSH_KEY_NEW", "PRIVATE", "made by tests");
    expect(body).toEqual({
      projectId: "project-1",
      environment: "prod",
      secretPath: "/ssh-keys",
      secretValue: "PRIVATE",
      secretComment: "made by tests",
      type: "shared",
    });
    await expect(vault.create("SSH_KEY_TAKEN", "x", "")).rejects.toMatchObject({ kind: "exists" });
  });

  it("refuses invalid names before calling the vault, and maps a missing secret", async () => {
    const fetch = fakeFetch({
      "POST /api/v1/auth/universal-auth/login": login,
      "GET /api/v4/secrets/SSH_KEY_GONE": () => json({ message: "not found" }, 404),
    });
    const vault = new InfisicalVault(CONFIG, fetch);
    await expect(vault.read("../../etc/passwd")).rejects.toThrow();
    await expect(vault.read("SSH_KEY_GONE")).rejects.toBeInstanceOf(VaultError);
  });

  it("signs in again when a token is rejected", async () => {
    let reads = 0;
    const fetch = fakeFetch({
      "POST /api/v1/auth/universal-auth/login": login,
      "GET /api/v4/secrets/SSH_KEY_SITE": () =>
        ++reads === 1 ? json({}, 401) : json({ secret: { secretValue: "OK" } }),
    });
    expect(await new InfisicalVault(CONFIG, fetch).read("SSH_KEY_SITE")).toBe("OK");
    expect(fetch.mock.calls.filter(([u]) => String(u).includes("/login"))).toHaveLength(2);
  });
});
