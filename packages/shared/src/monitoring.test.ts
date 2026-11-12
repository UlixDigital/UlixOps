import { describe, expect, it } from "vitest";
import {
  alertLevel,
  daysLeft,
  domainCandidates,
  expiryAlertDue,
  expiryTargetOf,
  expiryTone,
  guessRegisteredDomain,
  isProviderHost,
  isPublicHostname,
  nextUptimeState,
  PublicHostname,
  UPTIME_DOWN_AFTER,
  uptimePercent,
  uptimeStatusOk,
} from "./monitoring";
import { MONITOR_QUEUE, queueForJob, REMOTE_QUEUE, RunnerJob } from "./queue";

const NOW = new Date(Date.UTC(2026, 9, 31, 12, 0, 0));
const inDays = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60_000);

describe("public host names", () => {
  it("accepts real names and refuses dev, private and IP hosts", () => {
    expect(isPublicHostname("www.example.com")).toBe(true);
    expect(isPublicHostname("shop.example.co.uk")).toBe(true);
    for (const h of [
      "localhost",
      "test-wp",
      "127.0.0.1",
      "10.0.0.8",
      "site.local",
      "wp.test",
      "a.example",
      "vault.internal",
      "x..com",
      "-bad.com",
      "under_score.com",
    ])
      expect(isPublicHostname(h), h).toBe(false);
  });

  it("schema refuses upper case and shell characters", () => {
    expect(PublicHostname.safeParse("Example.com").success).toBe(false);
    expect(PublicHostname.safeParse("example.com;id").success).toBe(false);
    expect(PublicHostname.safeParse("example.com").success).toBe(true);
  });

  it("spots hosting provider names", () => {
    expect(isProviderHost("mysite.wpengine.com")).toBe(true);
    expect(isProviderHost("mysite.wpenginepowered.com")).toBe(true);
    expect(isProviderHost("wpengine.com.evil.com")).toBe(false);
    expect(isProviderHost("example.com")).toBe(false);
  });
});

describe("domainCandidates", () => {
  it("lists names longest first, down to two labels", () => {
    expect(domainCandidates("www.example.com")).toEqual(["www.example.com", "example.com"]);
    expect(domainCandidates("example.com")).toEqual(["example.com"]);
    expect(domainCandidates("shop.example.co.uk")).toEqual([
      "shop.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
  });

  it("keeps at most the four shortest names", () => {
    expect(domainCandidates("a.b.c.d.example.com")).toEqual([
      "b.c.d.example.com",
      "c.d.example.com",
      "d.example.com",
      "example.com",
    ]);
  });
});

describe("guessRegisteredDomain", () => {
  it("keeps two labels, or three under common second-level names", () => {
    expect(guessRegisteredDomain("www.example.de")).toBe("example.de");
    expect(guessRegisteredDomain("example.de")).toBe("example.de");
    expect(guessRegisteredDomain("shop.example.com.au")).toBe("example.com.au");
    expect(guessRegisteredDomain("example.co.za")).toBe("example.co.za");
  });
});

describe("expiryTargetOf", () => {
  it("reads host and port from site URLs", () => {
    expect(expiryTargetOf("https://www.example.com/")).toEqual({
      host: "www.example.com",
      port: 443,
      https: true,
    });
    expect(expiryTargetOf("https://example.com:8443")).toEqual({
      host: "example.com",
      port: 8443,
      https: true,
    });
    expect(expiryTargetOf("http://example.com:8080")).toEqual({
      host: "example.com",
      port: 443,
      https: false,
    });
    expect(expiryTargetOf("http://localhost:8080")).toBeNull();
    expect(expiryTargetOf("not a url")).toBeNull();
  });
});

describe("expiry thresholds", () => {
  it("counts whole days left", () => {
    expect(daysLeft(inDays(30), NOW)).toBe(30);
    expect(daysLeft(new Date(NOW.getTime() + 1000), NOW)).toBe(0);
    expect(daysLeft(new Date(NOW.getTime() - 1000), NOW)).toBe(-1);
  });

  it("picks the tightest threshold reached", () => {
    expect(alertLevel(45)).toBeNull();
    expect(alertLevel(31)).toBeNull();
    expect(alertLevel(30)).toBe(30);
    expect(alertLevel(20)).toBe(30);
    expect(alertLevel(14)).toBe(14);
    expect(alertLevel(8)).toBe(14);
    expect(alertLevel(7)).toBe(7);
    expect(alertLevel(2)).toBe(3);
    expect(alertLevel(1)).toBe(1);
    expect(alertLevel(0)).toBe(0);
    expect(alertLevel(-5)).toBe(0);
  });

  it("alerts once per threshold and starts over after a renewal", () => {
    const exp = inDays(20);
    expect(expiryAlertDue(null, { level: null, forDate: null }, exp)).toBe(false);
    expect(expiryAlertDue(30, { level: null, forDate: null }, exp)).toBe(true);
    expect(expiryAlertDue(30, { level: 30, forDate: exp }, exp)).toBe(false);
    expect(expiryAlertDue(14, { level: 30, forDate: exp }, exp)).toBe(true);
    expect(expiryAlertDue(30, { level: 14, forDate: exp }, exp)).toBe(false);
    // Renewed: a different expiry date alerts again from its first threshold.
    expect(expiryAlertDue(30, { level: 7, forDate: inDays(3) }, exp)).toBe(true);
  });

  it("maps days to badge tones", () => {
    expect(expiryTone(null)).toBe("unknown");
    expect(expiryTone(90)).toBe("ok");
    expect(expiryTone(30)).toBe("warning");
    expect(expiryTone(7)).toBe("critical");
    expect(expiryTone(-1)).toBe("expired");
  });
});

describe("monitor.expiry job", () => {
  it("accepts public hosts only", () => {
    const job = (host: string) =>
      RunnerJob.safeParse({
        type: "monitor.expiry",
        checks: [{ host, port: 443, ssl: true, domain: true }],
      }).success;
    expect(job("www.example.com")).toBe(true);
    expect(job("localhost")).toBe(false);
    expect(job("10.0.0.1")).toBe(false);
    expect(job("infisical")).toBe(false);
    expect(RunnerJob.safeParse({ type: "monitor.expiry", checks: [] }).success).toBe(false);
  });
});

describe("uptime", () => {
  it("counts any answer below 500 as up, unless the body is an error page", () => {
    expect(uptimeStatusOk(200, false)).toBe(true);
    expect(uptimeStatusOk(301, false)).toBe(true);
    expect(uptimeStatusOk(401, false)).toBe(true);
    expect(uptimeStatusOk(404, false)).toBe(true);
    expect(uptimeStatusOk(200, true)).toBe(false);
    expect(uptimeStatusOk(500, false)).toBe(false);
    expect(uptimeStatusOk(503, false)).toBe(false);
  });

  it("opens an incident after two failures in a row and closes it on the next good check", () => {
    expect(UPTIME_DOWN_AFTER).toBe(2);
    const up = { failures: 0, down: false };
    const one = nextUptimeState(up, false, false);
    expect(one).toEqual({ failures: 1, down: false, opened: false, closed: false });
    const two = nextUptimeState(one, false, false);
    expect(two).toEqual({ failures: 2, down: true, opened: true, closed: false });
    const three = nextUptimeState(two, false, false);
    expect(three).toEqual({ failures: 3, down: true, opened: false, closed: false });
    expect(nextUptimeState(three, true, false)).toEqual({
      failures: 0,
      down: false,
      opened: false,
      closed: true,
    });
    // A blip: one failure, then fine again, never opens anything.
    expect(nextUptimeState(one, true, false)).toEqual({
      failures: 0,
      down: false,
      opened: false,
      closed: false,
    });
  });

  it("doesn't count failures while a hub job holds the site, but still sees it come back", () => {
    const one = { failures: 1, down: false };
    expect(nextUptimeState(one, false, true)).toEqual({ ...one, opened: false, closed: false });
    expect(nextUptimeState({ failures: 4, down: true }, true, true).closed).toBe(true);
  });

  it("rounds uptime down so a single failure never shows as 100%", () => {
    expect(uptimePercent(0, 0)).toBeNull();
    expect(uptimePercent(288, 0)).toBe(100);
    expect(uptimePercent(8640, 1)).toBe(99.98);
    expect(uptimePercent(4, 1)).toBe(75);
    expect(uptimePercent(3, 3)).toBe(0);
  });

  it("accepts http(s) probes only and routes them to the monitor queue", () => {
    const job = (url: string) => ({
      type: "monitor.uptime",
      probes: [{ id: "env1", url, sshHost: "ssh.example.com" }],
    });
    expect(RunnerJob.safeParse(job("https://www.example.com/")).success).toBe(true);
    expect(RunnerJob.safeParse(job("http://localhost:8080")).success).toBe(true);
    expect(RunnerJob.safeParse(job("file:///etc/passwd")).success).toBe(false);
    expect(RunnerJob.safeParse(job("ftp://example.com/")).success).toBe(false);
    expect(
      RunnerJob.safeParse({
        type: "monitor.uptime",
        probes: [{ id: "env1", url: "https://a.com", sshHost: "bad host; rm" }],
      }).success,
    ).toBe(false);
    expect(RunnerJob.safeParse({ type: "monitor.uptime", probes: [] }).success).toBe(false);
    expect(queueForJob("monitor.uptime")).toBe(MONITOR_QUEUE);
    expect(queueForJob("monitor.expiry")).toBe(REMOTE_QUEUE);
    expect(queueForJob("site.test")).toBe(REMOTE_QUEUE);
  });
});
