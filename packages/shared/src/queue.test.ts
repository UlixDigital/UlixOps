import { describe, expect, it } from "vitest";
import { CredentialRef, queueForJob, RunnerJob, SshTarget, VISUAL_QUEUE } from "./queue";

const target = {
  host: "clientsite.ssh.wpengine.net",
  port: 22,
  user: "clientsite",
  wpPath: "/home/wpe-user/sites/clientsite",
  credentialRef: "SSH_KEY_CLIENTSITE",
  hostKey: null,
};

describe("runner jobs", () => {
  it("accepts every job type with a valid target", () => {
    for (const job of [
      { type: "credentials.list" },
      { type: "credentials.create", name: "SSH_KEY_NEW" },
      { type: "site.test", target },
      { type: "site.inventory", target },
      { type: "site.inventory", target, checkUpdates: true },
      { type: "site.inventory", target, checkUpdates: false },
      { type: "remote.command", target, command: { op: "core.version" } },
      {
        type: "remote.command",
        target,
        command: { op: "plugin.deactivate", slug: "x", safe: true },
      },
    ]) {
      expect(RunnerJob.safeParse(job).success).toBe(true);
    }
  });

  it.each([
    { type: "shell", cmd: "id" },
    { type: "site.test" },
    { type: "site.inventory" },
    { type: "remote.command", target, command: { op: "plugin.activate", slug: "--all" } },
    { type: "remote.command", target, command: { op: "eval", code: "x" } },
    { type: "credentials.create", name: "ssh-key; rm -rf /" },
  ])("rejects %j", (job) => {
    expect(RunnerJob.safeParse(job).success).toBe(false);
  });

  it.each([
    ["host", "evil.com; id"],
    ["host", "-oProxyCommand=id"],
    ["host", "256.1.1.1"],
    ["user", "root;id"],
    ["user", ""],
    ["port", 0],
    ["port", 70000],
    ["wpPath", "/var/www/../../etc"],
    ["wpPath", "relative"],
    ["credentialRef", "lowercase"],
    ["hostKey", "MD5:aa:bb"],
  ])("rejects a target with a bad %s (%j)", (field, value) => {
    expect(SshTarget.safeParse({ ...target, [field]: value }).success).toBe(false);
  });

  it("accepts IPv4 hosts, single-label hosts and pinned keys", () => {
    expect(SshTarget.safeParse({ ...target, host: "203.0.113.7" }).success).toBe(true);
    expect(SshTarget.safeParse({ ...target, host: "test-wp" }).success).toBe(true);
    const pinned = { ...target, hostKey: `SHA256:${"A".repeat(43)}` };
    expect(SshTarget.safeParse(pinned).success).toBe(true);
  });

  it("names credentials in capitals", () => {
    expect(CredentialRef.safeParse("SSH_KEY_ULIX_FORMS").success).toBe(true);
    expect(CredentialRef.safeParse("ssh_key").success).toBe(false);
    expect(CredentialRef.safeParse("X").success).toBe(false);
  });

  it("routes visual captures to visual-ops", () => {
    const job = {
      type: "site.visual.capture" as const,
      checkId: "abc123",
      mode: "before" as const,
      pages: [{ path: "/", url: "https://example.com/", role: "home" as const }],
      sshHost: "example.com",
      viewportWidth: 1280,
      viewportHeight: 720,
      maxDiffPercent: 1,
      pixelThreshold: 0.1,
    };
    expect(RunnerJob.safeParse(job).success).toBe(true);
    expect(queueForJob(job.type)).toBe(VISUAL_QUEUE);
  });
});
