// Contract between apps/web and the API's /auth routes. Both sides validate with these schemas.
import { z } from "zod";

/** 32 random bytes, base64url without padding: session, challenge, setup and device tokens. */
export const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Who is asking: forwarded by the web app with every auth call. */
export const AuthContext = z.object({
  ip: z.string().min(1).max(64),
  userAgent: z.string().max(512),
  deviceId: Token,
});
export type AuthContext = z.infer<typeof AuthContext>;

export const TotpCode = z.string().regex(/^\d{6}$/);

export const LoginRequest = z.object({
  email: z.string().max(254),
  password: z.string().max(PASSWORD_MAX),
  context: AuthContext,
});
export const TotpRequest = z.object({
  challengeToken: Token,
  code: z.string().max(16),
  context: AuthContext,
});
export const SetupInspectRequest = z.object({ setupToken: Token });
export const SetupPasswordRequest = z.object({
  setupToken: Token,
  password: z.string().max(PASSWORD_MAX),
  context: AuthContext,
});
export const EnrollStartRequest = z.object({ challengeToken: Token });
export const SessionRequest = z.object({ sessionToken: Token });
export const LogoutRequest = z.object({ sessionToken: Token, context: AuthContext });

export const ChallengeResponse = z.object({
  next: z.enum(["totp", "enroll"]),
  challengeToken: Token,
  expiresAt: z.iso.datetime(),
});
export type ChallengeResponse = z.infer<typeof ChallengeResponse>;

export const SessionResponse = z.object({ sessionToken: Token, expiresAt: z.iso.datetime() });
export type SessionResponse = z.infer<typeof SessionResponse>;

/** The only response that ever carries the TOTP secret: during enrollment, before 2FA is on. */
export const EnrollStartResponse = z.object({
  otpauthUri: z.string().startsWith("otpauth://totp/"),
  secret: z.string().regex(/^[A-Z2-7]+$/),
});
export type EnrollStartResponse = z.infer<typeof EnrollStartResponse>;

export const SetupInspectResponse = z.object({ email: z.string() });

export const Role = z.enum(["SUPER_ADMIN", "ADMIN", "DEVELOPER", "VIEWER", "CLIENT_VIEWER"]);

/**
 * Roles Admins may invite or assign (A134). SUPER_ADMIN is never inviteable — only a
 * Super Admin may promote an existing Admin (with 2FA) via role change (A172), or via CLI.
 */
export const AssignableRole = z.enum(["ADMIN", "DEVELOPER", "VIEWER", "CLIENT_VIEWER"]);

/** Roles a Super Admin may set on an existing user (includes promoting/demoting Super Admin). */
export const SuperAssignableRole = z.enum([
  "SUPER_ADMIN",
  "ADMIN",
  "DEVELOPER",
  "VIEWER",
  "CLIENT_VIEWER",
]);

/** Admins and Super Admins: "the team" for alerts, last-Admin protection and approvals. */
export const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN"] as const;
export const isAdminRole = (role: string): boolean =>
  (ADMIN_ROLES as readonly string[]).includes(role);

/** Tag-scoped read-only client (A178). */
export const isClientViewer = (role: string): boolean => role === "CLIENT_VIEWER";

export const SessionInfo = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: Role,
    /** Set only for CLIENT_VIEWER: the single site tag they may see (A178). */
    viewTag: z.string().nullable(),
  }),
  sessionId: z.string(),
  expiresAt: z.iso.datetime(),
  idleExpiresAt: z.iso.datetime(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const AuthErrorCode = z.enum([
  "bad_request",
  "invalid_credentials",
  "invalid_code",
  "rate_limited",
  "challenge_expired",
  "setup_invalid",
  "weak_password",
  "already_enrolled",
  "session_invalid",
  "session_expired_idle",
  "session_expired_absolute",
  "forbidden",
  "not_found",
  "email_taken",
  "cannot_change_self",
  "last_admin",
  "needs_admin_2fa",
  "invalid_entries",
  "would_lock_you_out",
  "already_pending",
  "already_enabled",
  "bulk_update_active",
  "runner_unavailable",
  "runner_failed",
  "url_taken",
  "name_taken",
  "out_of_date",
  "own_request",
  "already_decided",
  "connection_untested",
  "site_busy",
  "site_archived",
  "no_snapshot",
  "snapshot_missing",
  "plugin_not_in_inventory",
  "theme_not_in_inventory",
  "no_update_available",
  "no_updates_available",
  "no_inventory",
  "google_drive_unavailable",
  "version_exists",
  "upload_expired",
  "upload_invalid",
  "sync_running",
  "approval_required",
  "invalid_key",
  "vault_unavailable",
  "still_active",
  "scan_running",
  "scan_pending",
  "scan_finished",
  "check_running",
  "expiry_running",
  "uptime_running",
  "uptime_paused",
  "backup_pending",
  "backup_finished",
  "drive_not_connected",
  "backup_not_ready",
  "confirm_mismatch",
  "restore_pending",
  "restore_started",
  "site_address_invalid",
  "logging_not_managed",
  "dns_token_missing",
  "dns_busy",
  "dns_failed",
  "record_outside_zone",
  "record_not_managed",
  "alert_state",
  "smtp_not_configured",
  "not_ready",
  "no_recipients",
  "send_failed",
]);
export type AuthErrorCode = z.infer<typeof AuthErrorCode>;
export const AuthError = z.object({ error: AuthErrorCode });
