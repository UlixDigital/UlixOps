import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/**
 * Rebuilds the disposable test database from the committed migrations before integration tests
 * run. Only when TEST_DATABASE_URL is set, and only for a database named *_test.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const dbName = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(dbName)) {
    throw new Error("TEST_DATABASE_URL must point at a database whose name ends in _test");
  }

  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: maintenance.toString() });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  const migrations = path.resolve(import.meta.dirname, "../prisma/migrations");
  const names = (await readdir(migrations)).filter((name) => /^\d+_/.test(name)).sort();
  for (const name of names) {
    await client.query(await readFile(path.join(migrations, name, "migration.sql"), "utf8"));
  }
  await client.end();
}
