// execStream must never hang (A142): stopping early or timing out has to settle the promise,
// even with a channel that only reports "close" after its data has been read.
import { PassThrough, Readable } from "node:stream";
import type { Client } from "ssh2";
import { describe, expect, it } from "vitest";
import { Ssh2Session } from "./ssh";

/** A channel like ssh2's: a Readable that closes only once fully consumed. */
function fakeClient(chunks: Buffer[] | "endless") {
  const client = {
    exec(_cmd: string, cb: (err: Error | undefined, stream: unknown) => void) {
      let i = 0;
      const channel = new Readable({
        emitClose: false,
        read() {
          if (chunks === "endless") {
            setTimeout(() => this.push(Buffer.alloc(512)), 5);
            return;
          }
          this.push(i < chunks.length ? chunks[i++] : null);
        },
      });
      const extra = channel as Readable & {
        stderr: PassThrough;
        close: () => void;
        end: () => void;
      };
      extra.stderr = new PassThrough();
      extra.end = () => undefined;
      // Asking the remote side to stop does nothing by itself, like a gateway that ignores it.
      extra.close = () => undefined;
      channel.on("end", () => setImmediate(() => channel.emit("close", 0)));
      setImmediate(() => cb(undefined, channel));
    },
  };
  return new Ssh2Session(client as unknown as Client, "SHA256:x");
}

describe("Ssh2Session.execStream", () => {
  it("settles when the reader stops early while data is still buffered", async () => {
    const session = fakeClient(Array.from({ length: 50 }, () => Buffer.alloc(1024, 1)));
    let seen = 0;
    const result = await session.execStream(
      ["tar"],
      async () => (++seen >= 2 ? "stop" : "more"),
      5_000,
    );
    expect(result.stopped).toBe(true);
    expect(seen).toBe(2);
  });

  it("reads everything when the reader never stops", async () => {
    const session = fakeClient([Buffer.from("a"), Buffer.from("b"), Buffer.from("c")]);
    const got: string[] = [];
    const result = await session.execStream(
      ["tar"],
      async (chunk) => {
        got.push(chunk.toString());
        return "more";
      },
      5_000,
    );
    expect(got.join("")).toBe("abc");
    expect(result).toMatchObject({ exitCode: 0, stopped: false });
  });

  it("fails on time instead of waiting for a close that never comes", async () => {
    const started = Date.now();
    await expect(
      fakeClient("endless").execStream(["tar"], async () => "more", 100),
    ).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
