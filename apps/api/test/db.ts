import type { RoleName } from "@ulixops/shared";
import pg from "pg";
import { tokenHash } from "../src/auth/tokens";
import { newToken } from "../src/auth/tokens";
import type { Db } from "../src/db";

/** Owner (superuser) connection to the disposable test database, if configured. */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** The same database, acting as the API's restricted role for the whole connection. */
export function asAppRole(url: string): string {
  const appUrl = new URL(url);
  appUrl.searchParams.set("options", "-c role=ulixops_app");
  return appUrl.toString();
}

/** Empties every table as the owner. TRUNCATE is the one way past the audit-log row trigger. */
export async function resetData(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
    );
    if (rows.length > 0) {
      await client.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(", ")} CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** A user with 2FA done and a live session, skipping the sign-in flow (tested elsewhere). */
export async function userWithSession(
  db: Db,
  role: RoleName,
  opts: { sessionSecret: string; now: Date; email?: string; viewTag?: string | null },
) {
  const user = await db.user.create({
    data: {
      email: opts.email ?? `${role.toLowerCase()}@example.test`,
      role,
      viewTag: opts.viewTag ?? null,
      passwordHash: "argon2id$unused-in-these-tests",
      twoFactorEnabled: true,
    },
  });
  const token = newToken();
  await db.session.create({
    data: {
      tokenHash: tokenHash(token, opts.sessionSecret),
      userId: user.id,
      createdAt: opts.now,
      lastSeenAt: opts.now,
      expiresAt: new Date(opts.now.getTime() + 12 * 60 * 60 * 1000),
    },
  });
  return { user, token };
}
