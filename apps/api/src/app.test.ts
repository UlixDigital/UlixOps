import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";

describe("api app", () => {
  const app = createApp();

  it("answers the health check", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("sends security headers and hides the framework", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["strict-transport-security"]).toMatch(/max-age=\d+/);
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
  });

  it("returns JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("rejects malformed JSON with 400 and no details", async () => {
    const res = await request(app)
      .post("/healthz")
      .set("content-type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_request" });
  });

  it("rejects oversized bodies", async () => {
    const res = await request(app)
      .post("/healthz")
      .set("content-type", "application/json")
      .send(JSON.stringify({ data: "x".repeat(200_000) }));
    expect(res.status).toBe(413);
  });
});
