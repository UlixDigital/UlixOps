import type { SshTarget } from "@ulixops/shared";
import { describe, expect, it, vi } from "vitest";
import { FilesSessionPool } from "./files-pool";
import type { SshConnector, SshSession } from "./ssh";
import { MemoryVault } from "./vault";

const target: SshTarget = {
  host: "sftp.example.com",
  port: 2222,
  user: "site",
  wpPath: "/sites/site",
  credentialRef: "FILES_SFTP_TEST",
  hostKey: null,
  nativeSftpOnly: true,
  authMode: "password",
};

function fakeSession(): SshSession {
  return {
    hostKey: "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    sftp: async () => {
      throw new Error("unused");
    },
    close: vi.fn(),
  };
}

describe("FilesSessionPool", () => {
  it("reuses one SSH connection across calls", async () => {
    const vault = new MemoryVault();
    await vault.create("FILES_SFTP_TEST", "secret-pass");
    const connect = vi.fn(async () => fakeSession());
    const ssh: SshConnector = { connect };
    const pool = new FilesSessionPool(ssh, vault);

    await pool.withSession(target, async () => "a");
    await pool.withSession(target, async () => "b");
    await pool.withSession(target, async () => "c");

    expect(connect).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(1);
    pool.closeAll();
    expect(pool.size()).toBe(0);
  });

  it("reconnects after a failed op drops the slot", async () => {
    const vault = new MemoryVault();
    await vault.create("FILES_SFTP_TEST", "secret-pass");
    const connect = vi.fn(async () => fakeSession());
    const ssh: SshConnector = { connect };
    const pool = new FilesSessionPool(ssh, vault);

    await expect(
      pool.withSession(target, async () => {
        throw new Error("socket dead");
      }),
    ).rejects.toThrow("socket dead");
    expect(pool.size()).toBe(0);

    await pool.withSession(target, async () => "ok");
    expect(connect).toHaveBeenCalledTimes(2);
    pool.closeAll();
  });
});
