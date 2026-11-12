// Short-lived SSH session reuse for site.files (A183).
// FileZilla feels fast because it keeps one connection open; without a pool every list/read
// paid a full TCP + auth + SFTP handshake through the job queue.
import type { SshTarget } from "@ulixops/shared";
import type { SshConnector, SshSession } from "./ssh";
import type { Vault } from "./vault";

const IDLE_MS = 90_000;
const MAX_SESSIONS = 12;
const SWEEP_MS = 15_000;

interface Slot {
  session: SshSession;
  lastUsed: number;
}

function poolKey(target: SshTarget): string {
  return [
    target.host,
    String(target.port),
    target.user,
    target.credentialRef,
    target.authMode ?? "key",
    target.hostKey ?? "tofu",
  ].join("|");
}

export class FilesSessionPool {
  private readonly slots = new Map<string, Slot>();
  /** Tail of the per-key serial chain so overlapping ops on one socket never interleave. */
  private readonly tails = new Map<string, Promise<unknown>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ssh: SshConnector,
    private readonly vault: Vault,
    private readonly now: () => number = Date.now,
  ) {}

  /** Run `use` on a pooled SSH session; connects on miss, keeps the socket for IDLE_MS. */
  async withSession<T>(target: SshTarget, use: (session: SshSession) => Promise<T>): Promise<T> {
    this.ensureSweep();
    const key = poolKey(target);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      key,
      prev.then(
        () => gate,
        () => gate,
      ),
    );
    await prev.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await this.runOnSlot(key, target, use);
    } finally {
      release();
    }
  }

  private async runOnSlot<T>(
    key: string,
    target: SshTarget,
    use: (session: SshSession) => Promise<T>,
  ): Promise<T> {
    let slot = this.slots.get(key);
    if (!slot) {
      const secret = await this.vault.read(target.credentialRef);
      const session = await this.ssh.connect(target, secret);
      this.evictIfFull();
      slot = { session, lastUsed: this.now() };
      this.slots.set(key, slot);
    }
    slot.lastUsed = this.now();
    try {
      return await use(slot.session);
    } catch (error) {
      this.drop(key);
      throw error;
    }
  }

  /** Test helper: how many live pooled sessions. */
  size(): number {
    return this.slots.size;
  }

  closeAll(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const key of [...this.slots.keys()]) this.drop(key);
    this.tails.clear();
  }

  private drop(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    try {
      slot.session.close();
    } catch {
      // already closed
    }
  }

  private evictIfFull(): void {
    while (this.slots.size >= MAX_SESSIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, slot] of this.slots) {
        if (slot.lastUsed < oldestAt) {
          oldestAt = slot.lastUsed;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      this.drop(oldestKey);
    }
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const cutoff = this.now() - IDLE_MS;
      for (const [key, slot] of this.slots) {
        if (slot.lastUsed < cutoff) this.drop(key);
      }
    }, SWEEP_MS);
    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }
}
