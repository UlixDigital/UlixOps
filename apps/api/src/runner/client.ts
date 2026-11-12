// The API's only way to reach sites or the vault: a job on the queue, answered by the runner.
import { MONITOR_QUEUE, queueForJob, REMOTE_QUEUE, RunnerJob, VISUAL_QUEUE } from "@ulixops/shared";
import { Queue, QueueEvents } from "bullmq";
import type { Redis } from "ioredis";

export interface RunOptions {
  /** Progress the runner reports while the job runs (validate before use), A143. */
  onProgress?: (data: unknown) => void;
}

export interface RunnerClient {
  run(job: RunnerJob, timeoutMs?: number, options?: RunOptions): Promise<unknown>;
}

/** The runner didn't answer in time (down, or busy). */
export class RunnerUnavailableError extends Error {}
/** The runner answered with a failure; the message is already redacted by the runner. */
export class RunnerJobFailedError extends Error {}

export class BullRunnerClient implements RunnerClient {
  /** remote-ops, monitor-ops (A149), visual-ops (A163). */
  private readonly queues: Map<string, { queue: Queue; events: QueueEvents }>;

  /** `connect` must return a fresh connection with maxRetriesPerRequest: null each time. */
  constructor(connect: () => Redis) {
    this.queues = new Map(
      [REMOTE_QUEUE, MONITOR_QUEUE, VISUAL_QUEUE].map((name) => [
        name,
        {
          queue: new Queue(name, { connection: connect() }),
          events: new QueueEvents(name, { connection: connect() }),
        },
      ]),
    );
  }

  async run(job: RunnerJob, timeoutMs = 45_000, options: RunOptions = {}): Promise<unknown> {
    const target = this.queues.get(queueForJob(job.type));
    if (!target) throw new Error("No queue for this job");
    const { queue, events } = target;
    const added = await queue.add(job.type, RunnerJob.parse(job), {
      attempts: 1,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 24 * 3600, count: 1000 },
    });
    const onProgress = options.onProgress;
    const listener = ({ jobId, data }: { jobId: string; data: unknown }) => {
      if (jobId === added.id) onProgress?.(data);
    };
    if (onProgress) events.on("progress", listener);
    try {
      return await added.waitUntilFinished(events, timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      // Only BullMQ's waitUntilFinished TTL — not a WP-CLI "Command timed out after N s"
      // from a finished failed job (that was misreported as runner_unavailable — A115).
      if (/timed out before finishing/i.test(message))
        throw new RunnerUnavailableError("The runner did not answer in time");
      throw new RunnerJobFailedError(message.slice(0, 500));
    } finally {
      if (onProgress) events.off("progress", listener);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.queues.values()].flatMap(({ queue, events }) => [events.close(), queue.close()]),
    );
  }
}
