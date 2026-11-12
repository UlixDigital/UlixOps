import type {
  AuthContext,
  AuthErrorCode,
  ChallengeResponse,
  EnrollStartResponse,
  PasskeyView,
  SessionInfo,
  SessionResponse,
} from "@ulixops/shared";
import { raiseAlert } from "../alerts";
import { audit } from "../audit";
import type { Db } from "../db";
import type { ChallengeKind, User } from "../generated/prisma/client";
import type { SecurityAlertEvent, SecurityNotifier } from "../notify";
import type { LoginGuard } from "./limits";
import { hashPassword, isAcceptablePassword, verifyPassword } from "./password";
import { POLICY } from "./policy";
import { decryptSecret, encryptSecret, newToken, tokenHash } from "./tokens";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

export type Result<T> = { ok: true; value: T } | { ok: false; error: AuthErrorCode };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T>(error: AuthErrorCode): Result<T> => ({ ok: false, error });

export interface AuthDeps {
  db: Db;
  guard: LoginGuard;
  notifier: SecurityNotifier;
  now: () => Date;
  /** Keys the token hashes (SESSION_SECRET). */
  sessionSecret: string;
  /** AES-256 key (hex) for TOTP secrets at rest (TOTP_ENCRYPTION_KEY). */
  totpKey: string;
  issuer: string;
  /** A real argon2id hash, checked when the email is unknown so timing matches a wrong password. */
  dummyPasswordHash: string;
  /** WebAuthn relying party: the hub's own hostname and origin (from PUBLIC_URL). */
  webauthn: { rpID: string; rpName: string; origin: string };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** One-time link token for setting a password (CLI bootstrap now, invites in step 4). */
export async function issueSetupToken(
  db: Db,
  userId: string,
  sessionSecret: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + POLICY.setupTokenMs);
  await db.setupToken.create({
    data: { tokenHash: tokenHash(token, sessionSecret), userId, expiresAt, createdAt: now },
  });
  return { token, expiresAt };
}

export class AuthService {
  constructor(private readonly deps: AuthDeps) {}

  // ---- Password step --------------------------------------------------------------------

  async login(
    rawEmail: string,
    password: string,
    ctx: AuthContext,
  ): Promise<Result<ChallengeResponse>> {
    const { db, guard } = this.deps;
    const email = normalizeEmail(rawEmail);
    if (!(await guard.allow(ctx.ip, email))) {
      await this.audit({ action: "auth.login", result: "rate_limited", ip: ctx.ip });
      return fail("rate_limited");
    }
    const user = await db.user.findUnique({ where: { email } });
    const passwordOk = await verifyPassword(
      password,
      user?.passwordHash ?? this.deps.dummyPasswordHash,
    );
    if (!user || !user.active || !user.passwordHash || !passwordOk) {
      await this.failedAttempt(email, user, ctx, "auth.login");
      return fail("invalid_credentials");
    }
    return ok(await this.createChallenge(user, user.twoFactorEnabled ? "TOTP" : "ENROLL"));
  }

  // ---- Second factor --------------------------------------------------------------------

  async verifyLoginTotp(
    challengeToken: string,
    code: string,
    ctx: AuthContext,
  ): Promise<Result<SessionResponse>> {
    const challenge = await this.findChallenge(challengeToken, "TOTP");
    if (!challenge) return fail("challenge_expired");
    const { user } = challenge;
    if (!(await this.deps.guard.allow(ctx.ip, user.email))) return fail("rate_limited");

    const step = this.checkCode(user, code);
    if (step === null || !(await this.consumeStep(user.id, step, challenge.id))) {
      await this.codeFailed(challenge.id, user, ctx, "auth.login.totp");
      return fail("invalid_code");
    }
    return ok(await this.startSession(user, ctx));
  }

  // ---- First-time setup -----------------------------------------------------------------

  async inspectSetup(setupToken: string): Promise<Result<{ email: string }>> {
    const token = await this.findSetupToken(setupToken);
    return token ? ok({ email: token.user.email }) : fail("setup_invalid");
  }

  async setPassword(
    setupToken: string,
    password: string,
    ctx: AuthContext,
  ): Promise<Result<ChallengeResponse>> {
    const { db } = this.deps;
    const token = await this.findSetupToken(setupToken);
    if (!token) return fail("setup_invalid");
    if (!isAcceptablePassword(password, token.user.email)) return fail("weak_password");

    const passwordHash = await hashPassword(password);
    const used = await db.$transaction(async (tx) => {
      const claimed = await tx.setupToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: this.deps.now() },
      });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      // A new password ends every existing session (matters for password-reset links).
      await tx.session.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: this.deps.now() },
      });
      return true;
    });
    if (!used) return fail("setup_invalid");

    await this.audit({
      userId: token.userId,
      action: "auth.setup.password",
      result: "success",
      ip: ctx.ip,
    });
    const user = await db.user.findUniqueOrThrow({ where: { id: token.userId } });
    return ok(await this.createChallenge(user, user.twoFactorEnabled ? "TOTP" : "ENROLL"));
  }

  async startEnrollment(challengeToken: string): Promise<Result<EnrollStartResponse>> {
    const challenge = await this.findChallenge(challengeToken, "ENROLL");
    if (!challenge) return fail("challenge_expired");
    const { user } = challenge;
    if (user.twoFactorEnabled) return fail("already_enrolled");

    // Reuse a pending secret, so reloading the page never invalidates an already scanned QR
    // code. An Admin 2FA reset (step 4) clears it.
    let secret: string;
    if (user.totpSecretEnc) {
      secret = decryptSecret(user.totpSecretEnc, this.deps.totpKey, user.id);
    } else {
      secret = generateTotpSecret();
      await this.deps.db.user.update({
        where: { id: user.id },
        data: {
          totpSecretEnc: encryptSecret(secret, this.deps.totpKey, user.id),
          totpLastStep: null,
        },
      });
    }
    return ok({ secret, otpauthUri: otpauthUri(this.deps.issuer, user.email, secret) });
  }

  async confirmEnrollment(
    challengeToken: string,
    code: string,
    ctx: AuthContext,
  ): Promise<Result<SessionResponse>> {
    const challenge = await this.findChallenge(challengeToken, "ENROLL");
    if (!challenge) return fail("challenge_expired");
    const { user } = challenge;
    if (user.twoFactorEnabled) return fail("already_enrolled");

    const step = this.checkCode(user, code);
    if (step === null || !(await this.consumeStep(user.id, step, challenge.id))) {
      await this.codeFailed(challenge.id, user, ctx, "auth.2fa.enroll");
      return fail("invalid_code");
    }
    await this.deps.db.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
    await this.audit({ userId: user.id, action: "auth.2fa.enroll", result: "success", ip: ctx.ip });
    return ok(await this.startSession(user, ctx));
  }

  // ---- Sessions -------------------------------------------------------------------------

  /**
   * `touch: false` checks without extending the idle timer: background polling (the
   * notification bell) must not keep an unattended session alive (A158).
   */
  async validateSession(
    sessionToken: string,
    opts: { touch?: boolean } = {},
  ): Promise<Result<SessionInfo>> {
    const { db } = this.deps;
    const now = this.deps.now();
    const session = await db.session.findUnique({
      where: { tokenHash: this.hash(sessionToken) },
      include: { user: true },
    });
    if (!session || session.revokedAt || !session.user.active || !session.user.twoFactorEnabled) {
      return fail("session_invalid");
    }
    const expired =
      session.expiresAt <= now
        ? "session_expired_absolute"
        : session.lastSeenAt.getTime() + POLICY.idleMs <= now.getTime()
          ? "session_expired_idle"
          : null;
    if (expired) {
      await db.session.update({ where: { id: session.id }, data: { revokedAt: now } });
      await this.audit({ userId: session.userId, action: "auth.session.expire", result: expired });
      return fail(expired);
    }

    let lastSeen = session.lastSeenAt;
    if (opts.touch !== false && now.getTime() - lastSeen.getTime() >= POLICY.touchMs) {
      await db.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
      lastSeen = now;
    }
    const idleExpiresAt = Math.min(lastSeen.getTime() + POLICY.idleMs, session.expiresAt.getTime());
    const { id, email, name, role, viewTag } = session.user;
    return ok({
      user: { id, email, name, role, viewTag },
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
      idleExpiresAt: new Date(idleExpiresAt).toISOString(),
    });
  }

  async logout(sessionToken: string, ctx: AuthContext): Promise<void> {
    const { db } = this.deps;
    const session = await db.session.findUnique({ where: { tokenHash: this.hash(sessionToken) } });
    if (!session || session.revokedAt) return;
    await db.session.update({ where: { id: session.id }, data: { revokedAt: this.deps.now() } });
    await this.audit({
      userId: session.userId,
      action: "auth.logout",
      result: "success",
      ip: ctx.ip,
    });
  }

  // ---- Passkeys (WebAuthn), agent decision A45 ------------------------------------------

  async passkeyLoginOptions(
    challengeToken: string,
  ): Promise<Result<PublicKeyCredentialRequestOptionsJSON>> {
    const challenge = await this.findChallenge(challengeToken, "TOTP");
    if (!challenge) return fail("challenge_expired");
    const passkeys = await this.deps.db.passkey.findMany({ where: { userId: challenge.userId } });
    if (passkeys.length === 0) return fail("not_found");
    const options = await generateAuthenticationOptions({
      rpID: this.deps.webauthn.rpID,
      allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })),
      userVerification: "preferred",
    });
    await this.deps.db.webAuthnChallenge.create({
      data: {
        userId: challenge.userId,
        purpose: "LOGIN",
        challenge: options.challenge,
        loginChallengeId: challenge.id,
        expiresAt: challenge.expiresAt,
        createdAt: this.deps.now(),
      },
    });
    return ok(options);
  }

  async verifyLoginPasskey(
    challengeToken: string,
    credential: AuthenticationResponseJSON,
    ctx: AuthContext,
  ): Promise<Result<SessionResponse>> {
    const { db } = this.deps;
    const challenge = await this.findChallenge(challengeToken, "TOTP");
    if (!challenge) return fail("challenge_expired");
    const { user } = challenge;
    if (!(await this.deps.guard.allow(ctx.ip, user.email))) return fail("rate_limited");

    const ceremony = await db.webAuthnChallenge.findFirst({
      where: {
        loginChallengeId: challenge.id,
        purpose: "LOGIN",
        usedAt: null,
        expiresAt: { gt: this.deps.now() },
      },
      orderBy: { createdAt: "desc" },
    });
    const passkey = await db.passkey.findUnique({ where: { credentialId: credential.id } });
    const verified =
      ceremony && passkey?.userId === user.id
        ? await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: ceremony.challenge,
            expectedOrigin: this.deps.webauthn.origin,
            expectedRPID: this.deps.webauthn.rpID,
            credential: {
              id: passkey.credentialId,
              publicKey: new Uint8Array(passkey.publicKey),
              counter: Number(passkey.counter),
              transports: passkey.transports,
            },
            requireUserVerification: false,
          }).catch(() => null)
        : null;
    if (!ceremony || !passkey || !verified?.verified) {
      await this.codeFailed(challenge.id, user, ctx, "auth.login.passkey");
      return fail("invalid_code");
    }
    const claimed = await db.$transaction([
      db.webAuthnChallenge.updateMany({
        where: { id: ceremony.id, usedAt: null },
        data: { usedAt: this.deps.now() },
      }),
      db.authChallenge.updateMany({
        where: { id: challenge.id, usedAt: null },
        data: { usedAt: this.deps.now() },
      }),
    ]);
    if (claimed.some((result) => result.count !== 1)) return fail("invalid_code");
    await db.passkey.update({
      where: { id: passkey.id },
      data: {
        counter: BigInt(verified.authenticationInfo.newCounter),
        lastUsedAt: this.deps.now(),
      },
    });
    return ok(await this.startSession(user, ctx));
  }

  /** Step-up: the current authenticator code proves it's really the account owner. */
  async passkeyRegistrationOptions(
    userId: string,
    code: string,
    ctx: AuthContext,
  ): Promise<Result<PublicKeyCredentialCreationOptionsJSON>> {
    const { db } = this.deps;
    const user = await db.user.findUnique({ where: { id: userId }, include: { passkeys: true } });
    if (!user?.twoFactorEnabled) return fail("session_invalid");
    if (!(await this.deps.guard.allow(ctx.ip, user.email))) return fail("rate_limited");
    const step = this.checkCode(user, code);
    if (step === null || !(await this.consumeStep(user.id, step))) {
      await this.failedAttempt(user.email, user, ctx, "account.passkey.step_up");
      return fail("invalid_code");
    }
    const options = await generateRegistrationOptions({
      rpName: this.deps.webauthn.rpName,
      rpID: this.deps.webauthn.rpID,
      userName: user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: user.passkeys.map((p) => ({
        id: p.credentialId,
        transports: p.transports,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    await db.webAuthnChallenge.create({
      data: {
        userId,
        purpose: "REGISTER",
        challenge: options.challenge,
        expiresAt: new Date(this.deps.now().getTime() + POLICY.totpChallengeMs),
        createdAt: this.deps.now(),
      },
    });
    return ok(options);
  }

  async addPasskey(
    userId: string,
    name: string,
    credential: RegistrationResponseJSON,
    ip: string | null,
  ): Promise<Result<PasskeyView>> {
    const { db } = this.deps;
    const ceremony = await db.webAuthnChallenge.findFirst({
      where: { userId, purpose: "REGISTER", usedAt: null, expiresAt: { gt: this.deps.now() } },
      orderBy: { createdAt: "desc" },
    });
    if (!ceremony) return fail("challenge_expired");
    const claimed = await db.webAuthnChallenge.updateMany({
      where: { id: ceremony.id, usedAt: null },
      data: { usedAt: this.deps.now() },
    });
    if (claimed.count !== 1) return fail("challenge_expired");
    const verified = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: this.deps.webauthn.origin,
      expectedRPID: this.deps.webauthn.rpID,
      requireUserVerification: false,
    }).catch(() => null);
    if (!verified?.verified) return fail("invalid_code");
    const { credential: registered, credentialBackedUp } = verified.registrationInfo;
    if (await db.passkey.findUnique({ where: { credentialId: registered.id } }))
      return fail("invalid_code");
    const passkey = await db.passkey.create({
      data: {
        userId,
        credentialId: registered.id,
        publicKey: Buffer.from(registered.publicKey),
        counter: BigInt(registered.counter),
        transports: registered.transports ?? [],
        name,
        backedUp: credentialBackedUp,
        createdAt: this.deps.now(),
      },
    });
    await this.audit({
      userId,
      action: "account.passkey.add",
      result: "success",
      ip,
      meta: { passkeyId: passkey.id, name },
    });
    return ok(toPasskeyView(passkey));
  }

  async removePasskey(
    userId: string,
    passkeyId: string,
    ip: string | null,
  ): Promise<Result<{ ok: true }>> {
    const removed = await this.deps.db.passkey.deleteMany({ where: { id: passkeyId, userId } });
    if (removed.count === 0) return fail("not_found");
    await this.audit({
      userId,
      action: "account.passkey.remove",
      result: "success",
      ip,
      meta: { passkeyId },
    });
    return ok({ ok: true });
  }

  async listPasskeys(userId: string): Promise<PasskeyView[]> {
    const passkeys = await this.deps.db.passkey.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return passkeys.map(toPasskeyView);
  }

  // ---- Internals ------------------------------------------------------------------------

  private hash(token: string) {
    return tokenHash(token, this.deps.sessionSecret);
  }

  private audit(entry: Parameters<typeof audit>[1]) {
    return audit(this.deps.db, entry, this.deps.now());
  }

  private async createChallenge(user: User, kind: ChallengeKind): Promise<ChallengeResponse> {
    const token = newToken();
    const ttl = kind === "TOTP" ? POLICY.totpChallengeMs : POLICY.enrollChallengeMs;
    const expiresAt = new Date(this.deps.now().getTime() + ttl);
    await this.deps.db.authChallenge.create({
      data: { tokenHash: this.hash(token), userId: user.id, kind, expiresAt },
    });
    return {
      next: kind === "TOTP" ? "totp" : "enroll",
      challengeToken: token,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async findChallenge(token: string, kind: ChallengeKind) {
    const challenge = await this.deps.db.authChallenge.findUnique({
      where: { tokenHash: this.hash(token) },
      include: { user: true },
    });
    if (
      !challenge ||
      challenge.kind !== kind ||
      challenge.usedAt ||
      challenge.expiresAt <= this.deps.now() ||
      challenge.attempts >= POLICY.maxCodeAttempts ||
      !challenge.user.active
    ) {
      return null;
    }
    return challenge;
  }

  private async findSetupToken(token: string) {
    const setup = await this.deps.db.setupToken.findUnique({
      where: { tokenHash: this.hash(token) },
      include: { user: true },
    });
    if (!setup || setup.usedAt || setup.expiresAt <= this.deps.now() || !setup.user.active) {
      return null;
    }
    return setup;
  }

  private checkCode(user: User, code: string): number | null {
    if (!user.totpSecretEnc) return null;
    const secret = decryptSecret(user.totpSecretEnc, this.deps.totpKey, user.id);
    return verifyTotp(secret, code, this.deps.now(), user.totpLastStep);
  }

  /** Marks the TOTP step and the challenge as used, atomically; false if either already was. */
  private async consumeStep(userId: string, step: number, challengeId?: string): Promise<boolean> {
    const now = this.deps.now();
    try {
      await this.deps.db.$transaction(async (tx) => {
        const stepClaimed = await tx.user.updateMany({
          where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
          data: { totpLastStep: step },
        });
        const challengeClaimed = challengeId
          ? (
              await tx.authChallenge.updateMany({
                where: { id: challengeId, usedAt: null },
                data: { usedAt: now },
              })
            ).count
          : 1;
        if (stepClaimed.count !== 1 || challengeClaimed !== 1) throw new AlreadyUsed();
      });
      return true;
    } catch (error) {
      if (error instanceof AlreadyUsed) return false;
      throw error;
    }
  }

  private async codeFailed(challengeId: string, user: User, ctx: AuthContext, action: string) {
    await this.deps.db.authChallenge.update({
      where: { id: challengeId },
      data: { attempts: { increment: 1 } },
    });
    await this.failedAttempt(user.email, user, ctx, action);
  }

  private async failedAttempt(email: string, user: User | null, ctx: AuthContext, action: string) {
    const { locked } = await this.deps.guard.recordFailure(email);
    await this.audit({ userId: user?.id, action, result: "failure", ip: ctx.ip });
    if (locked && user) await this.raiseAlert("ACCOUNT_LOCKED", user, ctx);
  }

  private async startSession(user: User, ctx: AuthContext): Promise<SessionResponse> {
    const { db } = this.deps;
    const now = this.deps.now();
    const token = newToken();
    const expiresAt = new Date(now.getTime() + POLICY.absoluteMs);
    await db.session.create({
      data: {
        tokenHash: this.hash(token),
        userId: user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      },
    });
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    await this.deps.guard.recordSuccess(user.email);
    await this.rememberDevice(user, ctx);
    await this.audit({ userId: user.id, action: "auth.login", result: "success", ip: ctx.ip });
    return { sessionToken: token, expiresAt: expiresAt.toISOString() };
  }

  /** New-device alert for every unknown device except the very first one (the setup device). */
  private async rememberDevice(user: User, ctx: AuthContext) {
    const { db } = this.deps;
    const now = this.deps.now();
    const deviceHash = this.hash(`device:${ctx.deviceId}`);
    const known = await db.knownDevice.findUnique({
      where: { userId_deviceHash: { userId: user.id, deviceHash } },
    });
    if (known) {
      await db.knownDevice.update({
        where: { id: known.id },
        data: { lastSeenAt: now, ip: ctx.ip, userAgent: ctx.userAgent },
      });
      return;
    }
    const firstDevice = (await db.knownDevice.count({ where: { userId: user.id } })) === 0;
    await db.knownDevice.create({
      data: {
        userId: user.id,
        deviceHash,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    });
    if (!firstDevice) await this.raiseAlert("NEW_DEVICE_LOGIN", user, ctx);
  }

  private raiseAlert(kind: SecurityAlertEvent["kind"], user: User, ctx: AuthContext) {
    return raiseAlert(
      this.deps.db,
      this.deps.notifier,
      { kind, userId: user.id, ip: ctx.ip, userAgent: ctx.userAgent },
      this.deps.now(),
    );
  }
}

class AlreadyUsed extends Error {}

function toPasskeyView(p: {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  backedUp: boolean;
}): PasskeyView {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
    backedUp: p.backedUp,
  };
}
