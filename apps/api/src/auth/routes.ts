import {
  type AuthErrorCode,
  EnrollStartRequest,
  LoginRequest,
  LogoutRequest,
  PasskeyLoginOptionsRequest,
  PasskeyLoginRequest,
  SessionRequest,
  SetupInspectRequest,
  SetupPasswordRequest,
  TotpRequest,
} from "@ulixops/shared";
import { type Request, type Response, Router } from "express";
import type { z } from "zod";
import type { AuthService, Result } from "./service";

const STATUS: Record<AuthErrorCode, number> = {
  bad_request: 400,
  invalid_credentials: 401,
  invalid_code: 401,
  rate_limited: 429,
  challenge_expired: 401,
  setup_invalid: 410,
  weak_password: 422,
  already_enrolled: 409,
  session_invalid: 401,
  session_expired_idle: 401,
  session_expired_absolute: 401,
  forbidden: 403,
  not_found: 404,
  email_taken: 409,
  cannot_change_self: 409,
  last_admin: 409,
  invalid_entries: 422,
  would_lock_you_out: 409,
  already_pending: 409,
  bulk_update_active: 409,
  runner_unavailable: 504,
  runner_failed: 502,
  url_taken: 409,
  name_taken: 409,
  out_of_date: 409,
  own_request: 409,
  already_decided: 409,
  connection_untested: 409,
  site_busy: 409,
  site_archived: 409,
  no_snapshot: 404,
  snapshot_missing: 409,
  plugin_not_in_inventory: 404,
  theme_not_in_inventory: 404,
  no_update_available: 409,
  no_updates_available: 409,
  no_inventory: 409,
  google_drive_unavailable: 409,
  version_exists: 409,
  upload_expired: 410,
  upload_invalid: 422,
};

/** Validates the body with Zod, then maps a service Result to JSON. Errors carry only a code. */
function route<S extends z.ZodType, T>(schema: S, run: (body: z.output<S>) => Promise<Result<T>>) {
  return async (req: Request, res: Response) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request" });
      return;
    }
    const result = await run(parsed.data);
    if (result.ok) res.json(result.value);
    else res.status(STATUS[result.error]).json({ error: result.error });
  };
}

// Tokens travel in POST bodies, never in URLs, so they stay out of logs.
export function authRouter(auth: AuthService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.post(
    "/login",
    route(LoginRequest, (b) => auth.login(b.email, b.password, b.context)),
  );
  router.post(
    "/login/totp",
    route(TotpRequest, (b) => auth.verifyLoginTotp(b.challengeToken, b.code, b.context)),
  );
  router.post(
    "/login/passkey/options",
    route(PasskeyLoginOptionsRequest, (b) => auth.passkeyLoginOptions(b.challengeToken)),
  );
  router.post(
    "/login/passkey",
    route(PasskeyLoginRequest, (b) =>
      auth.verifyLoginPasskey(b.challengeToken, b.credential, b.context),
    ),
  );
  router.post(
    "/setup/inspect",
    route(SetupInspectRequest, (b) => auth.inspectSetup(b.setupToken)),
  );
  router.post(
    "/setup/password",
    route(SetupPasswordRequest, (b) => auth.setPassword(b.setupToken, b.password, b.context)),
  );
  router.post(
    "/2fa/enroll/start",
    route(EnrollStartRequest, (b) => auth.startEnrollment(b.challengeToken)),
  );
  router.post(
    "/2fa/enroll/confirm",
    route(TotpRequest, (b) => auth.confirmEnrollment(b.challengeToken, b.code, b.context)),
  );
  router.post(
    "/session",
    route(SessionRequest, (b) => auth.validateSession(b.sessionToken)),
  );
  router.post(
    "/logout",
    route(LogoutRequest, async (b) => {
      await auth.logout(b.sessionToken, b.context);
      return { ok: true, value: { ok: true } };
    }),
  );
  return router;
}
