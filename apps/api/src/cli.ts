// Admin CLI. Locally:   pnpm --filter @ulixops/api cli create-admin --email you@example.com
//            On the VPS: docker compose exec api node dist/cli.js create-admin --email you@example.com
import { parseArgs } from "node:util";
import { z } from "zod";
import { issueSetupToken, normalizeEmail } from "./auth/service";
import { createPrisma } from "./db";
import { loadCliEnv } from "./env";

const USAGE = `Usage:
  create-admin --email <email> [--name <name>]
      Creates an Admin (or reuses one that has not set a password yet) and prints a
      one-time setup link, valid for 24 hours. The password is chosen in the browser.`;

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { email: { type: "string" }, name: { type: "string" } },
  });
  if (positionals[0] !== "create-admin") {
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

process.exitCode = await main();
