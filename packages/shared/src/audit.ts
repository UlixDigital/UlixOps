// Contract for the read-only audit log API (GET /audit).
import { z } from "zod";

const date = z.iso.date();

export const AuditQuery = z.object({
  /** Prefix match, e.g. "auth." for every sign-in event. */
  action: z.string().trim().max(100).optional(),
  email: z.string().trim().max(254).optional(),
  result: z.string().trim().max(50).optional(),
  /** Whole days in UTC, inclusive. */
  from: date.optional(),
  to: date.optional(),
  cursor: z
    .string()
    .regex(/^[a-z0-9]{1,64}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditEntry = z.object({
  id: z.string(),
  createdAt: z.iso.datetime(),
  action: z.string(),
  result: z.string(),
  ip: z.string().nullable(),
  siteIds: z.array(z.string()),
  meta: z.unknown(),
  user: z.object({ id: z.string(), email: z.string() }).nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditPage = z.object({
  entries: z.array(AuditEntry),
  nextCursor: z.string().nullable(),
});
export type AuditPage = z.infer<typeof AuditPage>;
