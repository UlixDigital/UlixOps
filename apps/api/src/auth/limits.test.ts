import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { type Counter, LoginGuard, MemoryCounter, RedisCounter } from "./limits";
import { POLICY } from "./policy";

function clock(start = Date.UTC(2026, 9, 29, 9, 0)) {
  let now = start;
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

describe("LoginGuard", () => {
  it("locks an email after 5 failures for 15 minutes, reporting the lock once", async () => {
    const c = clock();
    const guard = new LoginGuard(new MemoryCounter(c.now), "k".repeat(32));
    const results = [];
    for (let i = 0; i < POLICY.lockAfterFailures; i++) {
      expect(await guard.allow(`10.0.0.${i}`, "a@example.test")).toBe(true);
      results.push((await guard.recordFailure("a@example.test")).locked);
    }
    expect(results).toEqual([false, false, false, false, true]);
    expect(await guard.allow("10.0.1.1", "a@example.test")).toBe(false);
    expect(await guard.allow("10.0.1.1", "b@example.test")).toBe(true);

    c.advance(POLICY.lockWindowSec * 1000);
    expect(await guard.allow("10.0.1.1", "a@example.test")).toBe(true);
  });

  it("clears failures after a successful sign-in", async () => {
    const guard = new LoginGuard(new MemoryCounter(clock().now), "k".repeat(32));
    for (let i = 0; i < 4; i++) await guard.recordFailure("a@example.test");
    await guard.recordSuccess("a@example.test");
    expect((await guard.recordFailure("a@example.test")).locked).toBe(false);
  });

  it("limits attempts per IP across different emails", async () => {
    const guard = new LoginGuard(new MemoryCounter(clock().now), "k".repeat(32));
    for (let i = 0; i < POLICY.ipAttempts; i++) {
      expect(await guard.allow("10.0.0.1", `user${i}@example.test`)).toBe(true);
    }
    expect(await guard.allow("10.0.0.1", "another@example.test")).toBe(false);
    expect(await guard.allow("10.0.0.2", "another@example.test")).toBe(true);
  });
});

// Runs where a disposable Redis is available (CI and local dev: TEST_REDIS_URL).
describe.runIf(process.env.TEST_REDIS_URL)("RedisCounter", () => {
  const redis = new Redis(process.env.TEST_REDIS_URL ?? "", { lazyConnect: true });
  const counter: Counter = new RedisCounter(redis, `ulx:test:${Date.now()}:`);
  afterAll(() => redis.quit());

  it("counts within a window that expires", async () => {
    expect(await counter.incr("k", 1)).toBe(1);
    expect(await counter.incr("k", 1)).toBe(2);
    expect(await counter.get("k")).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await counter.get("k")).toBe(0);
    await counter.incr("k", 60);
    await counter.reset("k");
    expect(await counter.get("k")).toBe(0);
  });
});
