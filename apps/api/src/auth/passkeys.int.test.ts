// Passkeys as a second factor, end to end through the HTTP routes (real Postgres, real crypto).
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asAppRole, resetData, TEST_DATABASE_URL } from "../../test/db";
import { SoftPasskey } from "../../test/webauthn";
import { createApp } from "../app";
import { createPrisma } from "../db";
import { LoginGuard, MemoryCounter } from "./limits";
import { hashPassword } from "./password";
import { AuthService } from "./service";
import { encryptSecret, newToken } from "./tokens";
import { base32Decode, generateTotpSecret, timeStep, totpAt } from "./totp";

const SECRET = "s".repeat(64);
const TOTP_KEY = "ab".repeat(32);
const PASSWORD = "correct horse battery";
const EMAIL = "admin@example.test";
const DEVICE = newToken();

describe.runIf(TEST_DATABASE_URL)("passkeys (Postgres)", () => {
  const ownerUrl = TEST_DATABASE_URL ?? "";
  const db = createPrisma(asAppRole(ownerUrl));
  let now = Date.UTC(2026, 9, 29, 9, 0, 0);
  const clock = () => new Date(now);
  let app: ReturnType<typeof createApp>;
  const ctx = { ip: "203.0.113.10", userAgent: "vitest", deviceId: DEVICE };
  let passwordHash = "";

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
  });
  beforeEach(async () => {
    await resetData(ownerUrl);
    now = Date.UTC(2026, 9, 29, 9, 0, 0);
    const auth = new AuthService({
      db,
      guard: new LoginGuard(new MemoryCounter(clock), SECRET),
      notifier: { alert: async () => undefined },
      now: clock,
      sessionSecret: SECRET,
      totpKey: TOTP_KEY,
      issuer: "UlixOps",
      webauthn: { rpID: "localhost", rpName: "UlixOps", origin: "http://localhost:3000" },
      dummyPasswordHash: "unused",
    });
    app = createApp({ auth, db, now: clock, sessionSecret: SECRET });
  });
  afterAll(() => db.$disconnect());

  /** A set-up Admin with TOTP; returns a session for My account calls. */
  async function admin(email = EMAIL) {
    const user = await db.user.create({
      data: { email, role: "ADMIN", passwordHash, twoFactorEnabled: true },
    });
    const secret = generateTotpSecret();
    await db.user.update({
      where: { id: user.id },
      data: { totpSecretEnc: encryptSecret(secret, TOTP_KEY, user.id) },
    });
    const code = () => totpAt(base32Decode(secret), timeStep(clock()));
    const first = await request(app)
      .post("/auth/login")
      .send({ email, password: PASSWORD, context: ctx });
    const session = await request(app)
      .post("/auth/login/totp")
      .send({ challengeToken: first.body.challengeToken, code: code(), context: ctx });
    now += 30_000; // next code window
    return { user, code, token: session.body.sessionToken as string };
  }
  const account = (token: string) => ({
    post: (path: string, body: object = {}) =>
      request(app).post(`/account${path}`).set("authorization", `Bearer ${token}`).send(body),
    get: () => request(app).get("/account").set("authorization", `Bearer ${token}`),
  });

  async function register(who: Awaited<ReturnType<typeof admin>>, key = new SoftPasskey()) {
    const options = await account(who.token).post("/passkeys/options", {
      code: who.code(),
      context: ctx,
    });
    expect(options.status).toBe(200);
    expect(options.body.rp).toEqual({ name: "UlixOps", id: "localhost" });
    const added = await account(who.token).post("/passkeys", {
      name: "Laptop",
      credential: key.register(options.body.challenge),
    });
    expect(added.status).toBe(201);
    now += 30_000;
    return key;
  }
  async function passwordStep(email = EMAIL) {
    const res = await request(app)
      .post("/auth/login")
      .send({ email, password: PASSWORD, context: ctx });
    expect(res.body.next).toBe("totp");
    return res.body.challengeToken as string;
  }

  it("adding a passkey needs the current authenticator code", async () => {
    const who = await admin();
    expect(
      (await account(who.token).post("/passkeys/options", { code: "000000", context: ctx })).body,
    ).toEqual({
      error: "invalid_code",
    });
    const code = who.code();
    expect(
      (await account(who.token).post("/passkeys/options", { code, context: ctx })).status,
    ).toBe(200);
    // The same code can't be used twice.
    expect(
      (await account(who.token).post("/passkeys/options", { code, context: ctx })).status,
    ).toBe(401);
  });

  it("registers a passkey, lists it, and signs in with it instead of a code", async () => {
    const who = await admin();
    const key = await register(who);
    expect((await account(who.token).get()).body.passkeys).toMatchObject([
      { name: "Laptop", lastUsedAt: null },
    ]);

    const challengeToken = await passwordStep();
    const options = await request(app).post("/auth/login/passkey/options").send({ challengeToken });
    expect(options.body.allowCredentials).toEqual([
      { id: key.credentialId, type: "public-key", transports: ["internal"] },
    ]);
    const signedIn = await request(app)
      .post("/auth/login/passkey")
      .send({ challengeToken, credential: key.authenticate(options.body.challenge), context: ctx });
    expect(signedIn.status).toBe(200);
    expect(
      (await request(app).post("/auth/session").send({ sessionToken: signedIn.body.sessionToken }))
        .status,
    ).toBe(200);
    expect((await db.passkey.findFirstOrThrow()).counter).toBe(1n);
    expect(await db.auditLog.count({ where: { action: "account.passkey.add" } })).toBe(1);
  });

  it("rejects the wrong origin, replays, other people's passkeys and unknown keys", async () => {
    const who = await admin();
    const key = await register(who);
    const other = await admin("other@example.test");
    const otherKey = await register(other);

    const attempt = async (make: (challenge: string) => object) => {
      const challengeToken = await passwordStep();
      const options = await request(app)
        .post("/auth/login/passkey/options")
        .send({ challengeToken });
      const credential = make(options.body.challenge as string);
      return {
        res: await request(app)
          .post("/auth/login/passkey")
          .send({ challengeToken, credential, context: ctx }),
        credential,
        challengeToken,
      };
    };
    expect(
      (await attempt((c) => key.authenticate(c, { origin: "https://evil.example" }))).res.body,
    ).toEqual({ error: "invalid_code" });
    expect((await attempt((c) => otherKey.authenticate(c))).res.body).toEqual({
      error: "invalid_code",
    });
    expect((await attempt((c) => new SoftPasskey().authenticate(c))).res.body).toEqual({
      error: "invalid_code",
    });

    const good = await attempt((c) => key.authenticate(c));
    expect(good.res.status).toBe(200);
    const replay = await request(app)
      .post("/auth/login/passkey")
      .send({ challengeToken: good.challengeToken, credential: good.credential, context: ctx });
    expect(replay.body).toEqual({ error: "challenge_expired" });
  });

  it("refuses a registration made for another site", async () => {
    const who = await admin();
    const options = await account(who.token).post("/passkeys/options", {
      code: who.code(),
      context: ctx,
    });
    const fake = new SoftPasskey("evil.example", "https://evil.example").register(
      options.body.challenge as string,
      {
        origin: "https://evil.example",
        rpID: "evil.example",
      },
    );
    expect(
      (await account(who.token).post("/passkeys", { name: "Evil", credential: fake })).body,
    ).toEqual({ error: "invalid_code" });
    expect(await db.passkey.count()).toBe(0);
  });

  it("offers no passkey sign-in without passkeys, and removing one works", async () => {
    const who = await admin();
    expect(
      (
        await request(app)
          .post("/auth/login/passkey/options")
          .send({ challengeToken: await passwordStep() })
      ).status,
    ).toBe(404);
    await register(who);
    const [passkey] = (await account(who.token).get()).body.passkeys;
    expect((await account(who.token).post(`/passkeys/${passkey.id}/remove`)).body).toEqual({
      ok: true,
    });
    expect(await db.passkey.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: "account.passkey.remove" } })).toBe(1);
  });

  it("an Admin 2FA reset removes passkeys too", async () => {
    const boss = await admin("boss@example.test");
    const who = await admin();
    await register(who);
    const reset = await request(app)
      .post(`/users/${who.user.id}/reset-2fa`)
      .set("authorization", `Bearer ${boss.token}`);
    expect(reset.body).toEqual({ ok: true });
    expect(await db.passkey.count({ where: { userId: who.user.id } })).toBe(0);
  });
});
