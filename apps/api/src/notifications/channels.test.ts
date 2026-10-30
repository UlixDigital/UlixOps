import { describe, expect, it, vi } from "vitest";
import { createSlackPoster, createSmtpMailer, defaultMailFrom } from "./channels";

describe("notification channels", () => {
  it("builds a From address from PUBLIC_URL", () => {
    expect(defaultMailFrom("https://ulixops.example.com")).toBe(
      "UlixOps <noreply@ulixops.example.com>",
    );
  });

  it("accepts smtp and smtps URLs and refuses others", () => {
    expect(createSmtpMailer("smtp://user:pass@mail.example:587", "a@b.test")).not.toBeNull();
    expect(createSmtpMailer("smtps://user:pass@mail.example:465", "a@b.test")).not.toBeNull();
    expect(createSmtpMailer("https://mail.example", "a@b.test")).toBeNull();
    expect(createSmtpMailer("not-a-url", "a@b.test")).toBeNull();
  });

  it("posts JSON to an https Slack webhook", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const poster = createSlackPoster("https://hooks.slack.com/services/T/B/X");
    expect(poster).not.toBeNull();
    if (!poster) throw new Error("expected Slack poster");
    await poster.post("hello");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/T/B/X",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });

  it("refuses non-https Slack webhooks", () => {
    expect(createSlackPoster("http://hooks.slack.com/x")).toBeNull();
  });
});
