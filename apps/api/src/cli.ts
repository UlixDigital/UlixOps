// Admin CLI. Locally:   pnpm --filter @ulixops/api cli create-admin --email you@example.com
//            On the VPS: docker compose exec api node dist/cli.js create-admin --email you@example.com
// Super Admin (A134):  ... cli grant-super-admin --email you@example.com (server only)
import { parseArgs } from "node:util";
import { z } from "zod";
import { issueSetupToken, normalizeEmail } from "./auth/service";
import { createPrisma, type Db } from "./db";
import { loadCliEnv } from "./env";

const USAGE = `Usage:
  create-admin --email <email> [--name <name>]
      Creates an Admin (or reuses one that has not set a password yet) and prints a
      one-time setup link, valid for 24 hours. The password is chosen in the browser.
  grant-super-admin --email <email>
      Makes an active Admin with 2FA a Super Admin: their risky actions are approved at once
      and every other Admin is alerted (A134). Only possible here, never in the UI.
  revoke-super-admin --email <email>
      Turns a Super Admin back into an Admin.`;

const COMMANDS = ["create-admin", "grant-super-admin", "revoke-super-admin"] as const;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: "string" }, name: { type: "string" } },
  });
  const command = COMMANDS.find((c) => c === positionals[0]);
  if (!command) {
    console.error(USAGE);
    return 2;
  }
  const email = z.email().safeParse(normalizeEmail(values.email ?? ""));
  if (!email.success) {
    console.error(`A valid --email is required.\n\n${USAGE}`);
    return 2;
  }

  const env = loadCliEnv();
  const db = createPrisma(env.DATABASE_URL);
  if (command !== "create-admin") {
    try {
      return await setSuperAdmin(db, email.data, command === "grant-super-admin");
    } finally {
      await db.$disconnect();
    }
  }
  try {
    const existing = await db.user.findUnique({ where: { email: email.data } });
    if (existing?.passwordHash) {
      console.error(`${email.data} has already set a password; nothing to do.`);
      return 1;
    }
    const user =
      existing ??
      (await db.user.create({
        data: { email: email.data, name: values.name ?? null, role: "ADMIN" },
      }));
    const now = new Date();
    const { token, expiresAt } = await issueSetupToken(db, user.id, env.SESSION_SECRET, now);
    await db.auditLog.create({
      data: {
        action: existing ? "user.setup_link" : "user.create_admin",
        userId: user.id,
        siteIds: [],
        result: "success",
        meta: { via: "cli" },
        createdAt: now,
      },
    });
    const link = new URL("/setup", env.PUBLIC_URL);
    link.searchParams.set("token", token);
    console.log(`Admin: ${user.email}`);
    console.log(`Setup link (single use, expires ${expiresAt.toISOString()}):`);
    console.log(link.toString());
    return 0;
  } finally {
    await db.$disconnect();
  }
}

/** Grant or revoke Super Admin (A134), with an audit row and an alert to the other Admins. */
async function setSuperAdmin(db: Db, email: string, grant: boolean): Promise<number> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.active) {
    console.error(`${email} is not an active user.`);
    return 1;
  }
  if (grant && (user.role !== "ADMIN" || !user.twoFactorEnabled)) {
    console.error(`${email} must be an Admin with two-factor authentication set up first.`);
    return 1;
  }
  if (!grant && user.role !== "SUPER_ADMIN") {
    console.error(`${email} is not a Super Admin; nothing to do.`);
    return 1;
  }
  const now = new Date();
  await db.user.update({
    where: { id: user.id },
    data: { role: grant ? "SUPER_ADMIN" : "ADMIN" },
  });
  await db.auditLog.create({
    data: {
      action: grant ? "user.super_admin.grant" : "user.super_admin.revoke",
      userId: null,
      siteIds: [],
      result: "success",
      meta: { via: "cli", targetUserId: user.id, email: user.email },
      createdAt: now,
    },
  });
  const others = await db.user.findMany({
    where: { role: { in: ["SUPER_ADMIN", "ADMIN"] }, active: true, id: { not: user.id } },
    select: { id: true },
  });
  if (others.length > 0)
    await db.notification.createMany({
      data: others.map((o) => ({
        kind: "security.ADMIN_ROLE_GRANTED",
        title: grant ? "Super Admin granted" : "Super Admin removed",
        body: grant
          ? `${user.email} is now a Super Admin: their risky actions are approved without a second Admin. Set on the server.`
          : `${user.email} is an Admin again.`,
        severity: grant ? "critical" : "info",
        userId: o.id,
        siteIds: [],
        createdAt: now,
      })),
    });
  console.log(`${user.email} is now ${grant ? "a Super Admin" : "an Admin"}.`);
  return 0;
}

process.exitCode = await main();
