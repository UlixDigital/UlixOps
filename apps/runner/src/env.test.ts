import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

const VAULT = {
  INFISICAL_CLIENT_ID: "id",
  INFISICAL_CLIENT_SECRET: "secret",
  INFISICAL_PROJECT_ID: "p1",
};

describe("runner loadEnv", () => {
  it("requires a redis URL and the vault identity", () => {
    expect(() => loadEnv(VAULT)).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ ...VAULT, REDIS_URL: "http://redis:6379" })).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ REDIS_URL: "redis://redis:6379" })).toThrow(/INFISICAL_CLIENT_ID/);
  });

  it("parses a valid environment and never asks for a database", () => {
    expect(
      loadEnv({
        ...VAULT,
        REDIS_URL: "redis://:pw@redis:6379",
        DATABASE_URL: "postgres://x",
        SNAPSHOT_ENCRYPTION_KEY: "ab".repeat(32),
      }),
    ).toEqual({
      ...VAULT,
      REDIS_URL: "redis://:pw@redis:6379",
      RUNNER_CONCURRENCY: 2,
      INFISICAL_URL: "http://infisical:8080",
      INFISICAL_ENVIRONMENT: "prod",
      INFISICAL_SECRET_PATH: "/ssh-keys",
      SNAPSHOT_STORE_DIR: "/data/snapshots",
      SNAPSHOT_ENCRYPTION_KEY: "ab".repeat(32),
      PLUGIN_STORE_DIR: "/data/plugins",
    });
  });

  it("refuses odd vault scopes", () => {
    expect(() =>
      loadEnv({ ...VAULT, REDIS_URL: "redis://r", INFISICAL_SECRET_PATH: "ssh-keys" }),
    ).toThrow();
  });
});
