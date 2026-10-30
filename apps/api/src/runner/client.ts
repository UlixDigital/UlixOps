// The API's only way to reach sites or the vault: a job on the queue, answered by the runner.
import { REMOTE_QUEUE, RunnerJob } from "@ulixops/shared";
import { Queue, QueueEvents } from "bullmq";
import type { Redis } from "ioredis";

export interface RunnerClient {
  run(job: RunnerJob, timeoutMs?: number): Promise<unknown>;
}

/** The runner didn't answer in time (down, or busy). */
export class RunnerUnavailableError extends Error {}
/** The runner answered with a failure; the message is already redacted by the runner. */
export class RunnerJobFailedError extends Error {}

export class BullRunnerClient implements RunnerClient {
  private readonly queue: Queue;
  private readonly events: QueueEvents;

  /** `connect` must return a fresh connection with maxRetriesPerRequest: null each time. */
  constructor(connect: () => Redis) {
    this.queue = new Queue(REMOTE_QUEUE, { connection: connect() });
    this.events = new QueueEvents(REMOTE_QUEUE, { connection: connect() });
  }

  async run(job: RunnerJob, timeoutMs = 45_000): Promise<unknown> {
    const added = await this.queue.add(job.type, RunnerJob.parse(job), {
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });
    try {
      return await added.waitUntilFinished(this.events, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Only BullMQ's waitUntilFinished TTL — not a WP-CLI "Command timed out after N s"
      // from a finished failed job (that was misreported as runner_unavailable — A115).
      if (/timed out before finishing/i.test(message))
        throw new RunnerUnavailableError("The runner did not answer in time");
      throw new RunnerJobFailedError(message.slice(0, 500));
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.events.close(), this.queue.close()]);
  }
}
