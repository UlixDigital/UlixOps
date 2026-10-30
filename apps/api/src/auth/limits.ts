import type { Redis } from "ioredis";
import { POLICY } from "./policy";
import { tokenHash } from "./tokens";

/** Fixed-window counter: the first hit starts a window of `windowSec`. */
export interface Counter {
  incr(key: string, windowSec: number): Promise<number>;
  get(key: string): Promise<number>;
  reset(key: string): Promise<void>;
}

export class RedisCounter implements Counter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "ulx:auth:",
  ) {}

  async incr(key: string, windowSec: number): Promise<number> {
    const fullKey = this.prefix + key;
    const count = await this.redis.incr(fullKey);
    if (count === 1) await this.redis.expire(fullKey, windowSec);
    return count;
  }

  async get(key: string): Promise<number> {
    return Number((await this.redis.get(this.prefix + key)) ?? 0);
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}

/** In-process counter for tests, driven by the same clock as the code under test. */
export class MemoryCounter implements Counter {
  private readonly entries = new Map<string, { count: number; until: number }>();

  constructor(private readonly now: () => Date) {}

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.until <= this.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async incr(key: string, windowSec: number): Promise<number> {
    const entry = this.live(key);
    if (entry) return ++entry.count;
    this.entries.set(key, { count: 1, until: this.now().getTime() + windowSec * 1000 });
    return 1;
  }

  async get(key: string): Promise<number> {
    return this.live(key)?.count ?? 0;
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * Login rate limiting (per IP) and lockout (per email address). Lockout is keyed by the
 * address whether or not an account exists, so the responses never reveal which emails are real.
 */
export class LoginGuard {
  constructor(
    private readonly counter: Counter,
    private readonly keySecret: string,
  ) {}

  private emailKey(email: string) {
    return `fail:${tokenHash(email, this.keySecret)}`;
  }

  async allow(ip: string, email: string): Promise<boolean> {
    const ipHits = await this.counter.incr(`ip:${ip}`, POLICY.ipWindowSec);
    if (ipHits > POLICY.ipAttempts) return false;
    return (await this.counter.get(this.emailKey(email))) < POLICY.lockAfterFailures;
  }

  /** `locked` is true only on the failure that triggers the lock, so it is reported once. */
  async recordFailure(email: string): Promise<{ locked: boolean }> {
    const failures = await this.counter.incr(this.emailKey(email), POLICY.lockWindowSec);
    return { locked: failures === POLICY.lockAfterFailures };
  }

  async recordSuccess(email: string): Promise<void> {
    await this.counter.reset(this.emailKey(email));
  }
}
