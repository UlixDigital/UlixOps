// Run by the migrate service right after `prisma migrate deploy`, connected as the database owner.
// Lets the API's restricted role (created by the migrations) log in with APP_DB_PASSWORD.
import { parseEnv } from "@ulixops/shared";
import pg from "pg";
import { z } from "zod";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    APP_DB_PASSWORD: z.string().regex(/^[0-9a-f]{64}$/i, "64 hex characters"),
  }),
  process.env,
);

const client = new pg.Client({ connectionString: env.DATABASE_URL });
await client.connect();
try {
  // ALTER ROLE takes no bind parameters. The password is validated hex and escaped anyway.
  await client.query(
    `ALTER ROLE ulixops_app WITH LOGIN PASSWORD ${client.escapeLiteral(env.APP_DB_PASSWORD)}`,
  );
  console.log("db-roles: ulixops_app can log in");
} finally {
  await client.end();
}
