import { describe, expect, it } from "vitest";
import { loadCliEnv, loadEnv } from "./env";

const VALID = {
  DATABASE_URL: "postgresql://u:p@db:5432/ulixops",
  REDIS_URL: "redis://:p@redis:6379",
  SESSION_SECRET: "s".repeat(64),
  TOTP_ENCRYPTION_KEY: "ab".repeat(32),
};

describe("loadEnv", () => {
  it("applies defaults", () => {
    expect(loadEnv(VALID)).toMatchObject({
      NODE_ENV: "development",
      API_PORT: 4000,
      PUBLIC_URL: "http://localhost:3000",
      PLUGIN_STORE_DIR: "/data/plugins",
      SNAPSHOT_STORE_DIR: "/data/snapshots",
      SNAPSHOT_RETENTION_DAYS: 7,
    });
  });

  it("requires an absolute plugin store path", () => {
    for (const dir of ["relative/dir", "/data/../etc", "/data/plugins; id"]) {
      expect(() => loadEnv({ ...VALID, PLUGIN_STORE_DIR: dir })).toThrow(/PLUGIN_STORE_DIR/);
    }
  });

  it("requires an absolute snapshot store path", () => {
    for (const dir of ["relative/dir", "/data/../etc"]) {
      expect(() => loadEnv({ ...VALID, SNAPSHOT_STORE_DIR: dir })).toThrow(/SNAPSHOT_STORE_DIR/);
    }
  });

  it("rejects an invalid port", () => {
    expect(() => loadEnv({ ...VALID, API_PORT: "99999" })).toThrow(/API_PORT/);
  });

  it("requires the auth secrets and names them without echoing values", () => {
    const shortSecret = "too-short";
    expect(() => loadEnv({ ...VALID, SESSION_SECRET: shortSecret })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...VALID, SESSION_SECRET: shortSecret })).not.toThrow(shortSecret);
    expect(() => loadEnv({ ...VALID, TOTP_ENCRYPTION_KEY: "abc" })).toThrow(/TOTP_ENCRYPTION_KEY/);
  });

  it("lets the CLI run without Redis or the TOTP key", () => {
    const { DATABASE_URL, SESSION_SECRET } = VALID;
    expect(loadCliEnv({ DATABASE_URL, SESSION_SECRET }).DATABASE_URL).toBe(DATABASE_URL);
  });
});
