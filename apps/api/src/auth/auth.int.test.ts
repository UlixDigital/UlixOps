// End-to-end auth flows through the HTTP routes, against a real Postgres (TEST_DATABASE_URL).
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData } from "../../test/db";
import { createApp } from "../app";
import { createPrisma } from "../db";
import type { SecurityAlertEvent } from "../notify";
import { LoginGuard, MemoryCounter } from "./limits";
import { hashPassword } from "./password";
import { POLICY } from "./policy";
import { AuthService, issueSetupToken } from "./service";
import { newToken } from "./tokens";
import { base32Decode, timeStep, totpAt } from "./totp";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const SECRET = "s".repeat(64);
const TOTP_KEY = "ab".repeat(32);
const START = Date.UTC(2026, 9, 29, 9, 0, 0);
const MINUTE = 60_000;
const DEVICE_A = newToken();
const DEVICE_B = newToken();
const EMAIL = "admin@example.test";
const PASSWORD = "correct horse battery";

describe.runIf(DATABASE_URL)("auth flows (Postgres)", () => {
  // Runs as the API's restricted database role, like production.
  const db = createPrisma(asAppRole(DATABASE_URL ?? ""));
  let now = START;
  const clock = () => new Date(now);
  const advance = (ms: number) => {
    now += ms;
  };
  let alerts: SecurityAlertEvent[] = [];
  let app: ReturnType<typeof createApp>;
  let dummyPasswordHash = "";

  const ctx = (deviceId = DEVICE_A, ip = "203.0.113.10") => ({ ip, userAgent: "vitest", deviceId });
  const post = (path: string, body: object) => request(app).post(`/auth${path}`).send(body);
  const code = (secret: string) => totpAt(base32Decode(secret), timeStep(clock()));

  beforeAll(async () => {
    dummyPasswordHash = await hashPassword(newToken());
  });

  beforeEach(async () => {
    await resetData(DATABASE_URL ?? "");
    now = START;
    alerts = [];
    const auth = new AuthService({
      db,
      guard: new LoginGuard(new MemoryCounter(clock), SECRET),
      notifier: {
        alert: async (event) => {
          alerts.push(event);
        },
      },
      now: clock,
      sessionSecret: SECRET,
      totpKey: TOTP_KEY,
      issuer: "UlixOps",
      webauthn: { rpID: "localhost", rpName: "UlixOps", origin: "http://localhost:3000" },
      dummyPasswordHash,
    });
    app = createApp({ auth });
  });

  afterAll(() => db.$disconnect());

  /** CLI bootstrap → password → 2FA enrollment, as a new Admin would do it. */
  async function enrolledAdmin() {
    const user = await db.user.create({ data: { email: EMAIL, role: "ADMIN" } });
    const { token } = await issueSetupToken(db, user.id, SECRET, clock());
    const password = await post("/setup/password", {
      setupToken: token,
      password: PASSWORD,
      context: ctx(),
    });
    expect(password.status).toBe(200);
    expect(password.body.next).toBe("enroll");
    const start = await post("/2fa/enroll/start", { challengeToken: password.body.challengeToken });
    expect(start.status).toBe(200);
    const secret = start.body.secret as string;
    const confirm = await post("/2fa/enroll/confirm", {
      challengeToken: password.body.challengeToken,
      code: code(secret),
      context: ctx(),
    });
    expect(confirm.status).toBe(200);
    return { user, token, secret, sessionToken: confirm.body.sessionToken as string };
  }

  /** Password + TOTP, 30 s later so the authenticator shows a new code. */
  async function login(secret: string, context = ctx()) {
    advance(30_000);
    const first = await post("/login", { email: EMAIL, password: PASSWORD, context });
    expect(first.body.next).toBe("totp");
    return post("/login/totp", {
      challengeToken: first.body.challengeToken,
      code: code(secret),
      context,
    });
  }

  it("sets up the first admin: setup link → password → 2FA → session", async () => {
    const user = await db.user.create({ data: { email: EMAIL, role: "ADMIN" } });
    const { token } = await issueSetupToken(db, user.id, SECRET, clock());

    expect((await post("/setup/inspect", { setupToken: token })).body).toEqual({ email: EMAIL });
    const password = await post("/setup/password", {
      setupToken: token,
      password: PASSWORD,
      context: ctx(),
    });
    const start = await post("/2fa/enroll/start", { challengeToken: password.body.challengeToken });
    expect(start.body.otpauthUri).toContain("otpauth://totp/UlixOps:admin%40example.test?");
    const secret = start.body.secret as string;
    const reload = await post("/2fa/enroll/start", {
      challengeToken: password.body.challengeToken,
    });
    expect(reload.body.secret).toBe(secret);

    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).toMatch(/^argon2id\$/);
    expect(stored.totpSecretEnc).not.toContain(secret);

    const confirm = await post("/2fa/enroll/confirm", {
      challengeToken: password.body.challengeToken,
      code: code(secret),
      context: ctx(),
    });
    expect(confirm.status).toBe(200);
    const session = await post("/session", { sessionToken: confirm.body.sessionToken });
    expect(session.body.user).toEqual({
      id: user.id,
      email: EMAIL,
      name: null,
      role: "ADMIN",
      viewTag: null,
    });

    expect((await post("/setup/inspect", { setupToken: token })).status).toBe(410);
    expect(alerts).toEqual([]);
    const actions = await db.auditLog.findMany({ select: { action: true, result: true } });
    expect(actions).toHaveLength(3);
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: "auth.setup.password", result: "success" },
        { action: "auth.2fa.enroll", result: "success" },
        { action: "auth.login", result: "success" },
      ]),
    );
  });

  it("rejects weak passwords and expired setup links", async () => {
    const user = await db.user.create({ data: { email: EMAIL, role: "ADMIN" } });
    const { token } = await issueSetupToken(db, user.id, SECRET, clock());
    const weak = await post("/setup/password", {
      setupToken: token,
      password: "too short",
      context: ctx(),
    });
    expect(weak.status).toBe(422);
    expect(weak.body).toEqual({ error: "weak_password" });

    advance(POLICY.setupTokenMs);
    const late = await post("/setup/password", {
      setupToken: token,
      password: PASSWORD,
      context: ctx(),
    });
    expect(late.status).toBe(410);
  });

  it("requires the password and a fresh code, with identical errors for unknown emails", async () => {
    const { secret } = await enrolledAdmin();

    const wrong = await post("/login", {
      email: EMAIL,
      password: "wrong password!",
      context: ctx(),
    });
    const unknown = await post("/login", {
      email: "nobody@example.test",
      password: PASSWORD,
      context: ctx(),
    });
    expect([wrong.status, wrong.body]).toEqual([401, { error: "invalid_credentials" }]);
    expect([unknown.status, unknown.body]).toEqual([401, { error: "invalid_credentials" }]);

    advance(30_000);
    const first = await post("/login", {
      email: ` ${EMAIL.toUpperCase()} `,
      password: PASSWORD,
      context: ctx(),
    });
    expect(first.body.next).toBe("totp");
    const bad = await post("/login/totp", {
      challengeToken: first.body.challengeToken,
      code: "000000",
      context: ctx(),
    });
    expect([bad.status, bad.body]).toEqual([401, { error: "invalid_code" }]);
    const usedCode = code(secret);
    const good = await post("/login/totp", {
      challengeToken: first.body.challengeToken,
      code: usedCode,
      context: ctx(),
    });
    expect(good.status).toBe(200);

    // Same code again, same 30 s window: refused (replay).
    const again = await post("/login", { email: EMAIL, password: PASSWORD, context: ctx() });
    const replay = await post("/login/totp", {
      challengeToken: again.body.challengeToken,
      code: usedCode,
      context: ctx(),
    });
    expect(replay.body).toEqual({ error: "invalid_code" });
  });

  it("expires code challenges after 5 minutes or 5 wrong codes", async () => {
    const { secret } = await enrolledAdmin();
    advance(30_000);
    const slow = await post("/login", { email: EMAIL, password: PASSWORD, context: ctx() });
    advance(POLICY.totpChallengeMs);
    const late = await post("/login/totp", {
      challengeToken: slow.body.challengeToken,
      code: code(secret),
      context: ctx(),
    });
    expect(late.body).toEqual({ error: "challenge_expired" });

    const first = await post("/login", { email: EMAIL, password: PASSWORD, context: ctx() });
    for (let i = 0; i < POLICY.maxCodeAttempts; i++) {
      await post("/login/totp", {
        challengeToken: first.body.challengeToken,
        code: "000000",
        context: ctx(),
      });
    }
    const after = await post("/login/totp", {
      challengeToken: first.body.challengeToken,
      code: code(secret),
      context: ctx(),
    });
    expect(after.body).toEqual({ error: "challenge_expired" });
  });

  it("locks the account after 5 failures, alerts once, and unlocks after 15 minutes", async () => {
    const { secret } = await enrolledAdmin();
    for (let i = 0; i < POLICY.lockAfterFailures; i++) {
      await post("/login", { email: EMAIL, password: "wrong password!", context: ctx() });
    }
    const locked = await post("/login", { email: EMAIL, password: PASSWORD, context: ctx() });
    expect([locked.status, locked.body]).toEqual([429, { error: "rate_limited" }]);
    expect(alerts.map((a) => a.kind)).toEqual(["ACCOUNT_LOCKED"]);
    expect(await db.securityAlert.count({ where: { kind: "ACCOUNT_LOCKED" } })).toBe(1);

    advance(POLICY.lockWindowSec * 1000);
    expect((await login(secret)).status).toBe(200);
  });

  it("ends sessions after 30 minutes idle and after 12 hours in total", async () => {
    const { secret, sessionToken } = await enrolledAdmin();
    advance(29 * MINUTE);
    expect((await post("/session", { sessionToken })).status).toBe(200);
    advance(29 * MINUTE);
    expect((await post("/session", { sessionToken })).status).toBe(200);
    advance(31 * MINUTE);
    expect((await post("/session", { sessionToken })).body).toEqual({
      error: "session_expired_idle",
    });
    expect((await post("/session", { sessionToken })).body).toEqual({ error: "session_invalid" });

    const fresh = (await login(secret)).body.sessionToken as string;
    const deadline = now + POLICY.absoluteMs;
    while (now + 20 * MINUTE < deadline) {
      advance(20 * MINUTE);
      expect((await post("/session", { sessionToken: fresh })).status).toBe(200);
    }
    advance(20 * MINUTE);
    expect((await post("/session", { sessionToken: fresh })).body).toEqual({
      error: "session_expired_absolute",
    });
  });

  it("alerts when someone signs in from a new device, once per device", async () => {
    const { secret } = await enrolledAdmin();
    expect((await login(secret, ctx(DEVICE_A))).status).toBe(200);
    expect(alerts).toEqual([]);

    expect((await login(secret, ctx(DEVICE_B, "198.51.100.7"))).status).toBe(200);
    expect(alerts).toMatchObject([{ kind: "NEW_DEVICE_LOGIN", ip: "198.51.100.7" }]);
    expect(await db.securityAlert.count({ where: { kind: "NEW_DEVICE_LOGIN" } })).toBe(1);

    expect((await login(secret, ctx(DEVICE_B, "198.51.100.7"))).status).toBe(200);
    expect(alerts).toHaveLength(1);
  });

  it("logs out, and blocks deactivated users", async () => {
    const { user, secret, sessionToken } = await enrolledAdmin();
    expect((await post("/logout", { sessionToken, context: ctx() })).body).toEqual({ ok: true });
    expect(await db.auditLog.findFirst({ where: { action: "auth.logout" } })).toMatchObject({
      ip: "203.0.113.10",
    });
    expect((await post("/session", { sessionToken })).body).toEqual({ error: "session_invalid" });

    const other = (await login(secret)).body.sessionToken as string;
    await db.user.update({ where: { id: user.id }, data: { active: false } });
    expect((await post("/session", { sessionToken: other })).body).toEqual({
      error: "session_invalid",
    });
    advance(30_000);
    const blocked = await post("/login", { email: EMAIL, password: PASSWORD, context: ctx() });
    expect(blocked.body).toEqual({ error: "invalid_credentials" });
  });

  it("validates every body and never returns secrets", async () => {
    const { sessionToken } = await enrolledAdmin();
    expect((await post("/session", { sessionToken: "short" })).status).toBe(400);
    expect((await post("/login", { email: EMAIL })).body).toEqual({ error: "bad_request" });

    const session = await post("/session", { sessionToken });
    const body = JSON.stringify(session.body);
    for (const leak of ["argon2id", "passwordHash", "totp", "tokenHash", sessionToken]) {
      expect(body).not.toContain(leak);
    }
    expect(session.headers["cache-control"]).toBe("no-store");
    const meta = JSON.stringify(await db.auditLog.findMany());
    expect(meta).not.toContain(PASSWORD);
    expect(meta).not.toContain(sessionToken);
  });
});
