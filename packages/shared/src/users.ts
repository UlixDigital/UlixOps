// Contracts for user management (Admins), My account and settings.
import { z } from "zod";
import { Role } from "./auth";
import { NotificationPrefs } from "./notifications";
import { PasskeyView } from "./passkeys";

const id = z.string().regex(/^[a-z0-9]{1,64}$/);
const iso = z.iso.datetime();
export const RecordId = id;

export const SessionSummary = z.object({
  id,
  createdAt: iso,
  lastSeenAt: iso,
  expiresAt: iso,
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const UserSummary = z.object({
  id,
  email: z.string(),
  name: z.string().nullable(),
  role: Role,
  active: z.boolean(),
  twoFactorEnabled: z.boolean(),
  /** Invited, but the setup link has not been used yet. */
  setupPending: z.boolean(),
  lastLoginAt: iso.nullable(),
  createdAt: iso,
  activeSessions: z.number().int(),
});
export type UserSummary = z.infer<typeof UserSummary>;

export const UserList = z.object({ users: z.array(UserSummary) });
export const UserDetail = z.object({ user: UserSummary, sessions: z.array(SessionSummary) });
export type UserDetail = z.infer<typeof UserDetail>;

const name = z.string().trim().max(100);

export const InviteUserRequest = z.object({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  name: name.optional(),
  role: Role,
});
export const SetupLinkResponse = z.object({ setupLink: z.url(), expiresAt: iso });
export const InviteUserResponse = SetupLinkResponse.extend({ user: UserSummary });

export const UpdateUserRequest = z
  .object({
    role: Role.optional(),
    active: z.boolean().optional(),
    name: name.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Nothing to change");

export const AccountInfo = z.object({
  user: z.object({ id, email: z.string(), name: z.string().nullable(), role: Role }),
  twoFactorEnabled: z.boolean(),
  sessions: z.array(SessionSummary),
  passkeys: z.array(PasskeyView),
});
export type AccountInfo = z.infer<typeof AccountInfo>;
export const UpdateAccountRequest = z.object({ name: name.nullable() });

export const Ok = z.object({ ok: z.literal(true) });

// ---- Settings ---------------------------------------------------------------------------

export const IpRule = z.object({
  cidr: z.string().trim().max(64),
  label: z.string().trim().max(80).default(""),
});
export const IpAllowlistSetting = z.object({
  enabled: z.boolean(),
  entries: z.array(IpRule).max(100),
});
export type IpAllowlistSetting = z.infer<typeof IpAllowlistSetting>;

export const Integration = z.object({
  key: z.string(),
  name: z.string(),
  status: z.enum(["configured", "not_configured", "planned"]),
  note: z.string(),
});

export const SettingsView = z.object({
  ipAllowlist: IpAllowlistSetting,
  /** ALLOWED_IPS from the server environment: always allowed, edited only on the server. */
  envAllowedIps: z.array(z.string()),
  currentIp: z.string().nullable(),
  policy: z.object({
    idleMinutes: z.number(),
    absoluteHours: z.number(),
    lockAfterFailures: z.number(),
    lockMinutes: z.number(),
  }),
  /** Quick-snapshot retention in days (spec §6.5); Admins may change it. */
  snapshotRetentionDays: z.number().int().min(1).max(90),
  /** Health-check paths and threshold (spec §6.6); Admins may change it. */
  healthCheck: z.object({
    extraPaths: z.array(z.string()),
    thresholdMs: z.number().int(),
    checkErrorLog: z.boolean(),
  }),
  /** Which events go to email / Slack (spec §6.8 / screen 19); in-app is always on. */
  notificationPrefs: NotificationPrefs,
  integrations: z.array(Integration),
});
export type SettingsView = z.infer<typeof SettingsView>;

/** What the web proxy needs to enforce the allowlist (internal network only). */
export const AllowlistPolicy = z.object({ enabled: z.boolean(), cidrs: z.array(z.string()) });

export const SecurityAlertView = z.object({
  id,
  kind: z.string(),
  createdAt: iso,
  ip: z.string().nullable(),
  user: z.object({ id, email: z.string() }).nullable(),
});
export const AlertList = z.object({ alerts: z.array(SecurityAlertView) });
export type SecurityAlertView = z.infer<typeof SecurityAlertView>;
