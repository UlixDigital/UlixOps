// One-time setup of a fresh self-hosted Infisical for UlixOps (agent decision A46):
//   1. claims the instance admin account (password generated here, written only to --admin-out),
//   2. creates the "UlixOps" project and the /ssh-keys folder in its prod environment,
//   3. (custom roles need Infisical Enterprise, so the runner gets the built-in "member" role),
//   4. creates the runner's machine identity with Universal Auth (5-minute access tokens),
//   5. appends INFISICAL_PROJECT_ID / INFISICAL_CLIENT_ID / INFISICAL_CLIENT_SECRET to --env-out.
// The bootstrap admin token lives only in this process. Nothing secret is printed.
//
//   node dist/vault-setup.js --url http://infisical:8080 --email admin@example.com \
//     --env-out /out/ulixops.env --admin-out /out/infisical-admin.txt
import { randomBytes } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";

const ENVIRONMENT = "prod";
const FOLDER = "ssh-keys";
// Custom roles need Infisical Enterprise; the owner chose the built-in "member" role on this
// dedicated project (agent decision A46): the runner can read and add keys.
const ROLE_SLUG = "member";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    email: { type: "string" },
    organization: { type: "string", default: "Ulix Digital" },
    "env-out": { type: "string" },
    "admin-out": { type: "string" },
  },
});
const url = z.url().parse(values.url);
const email = z.email().parse(values.email);
const envOut = z.string().min(1).parse(values["env-out"]);
const adminOut = z.string().min(1).parse(values["admin-out"]);

async function call<T>(
  schema: z.ZodType<T>,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = z.object({ message: z.string() }).safeParse(json);
    throw new Error(
      `${method} ${path} failed (${res.status}): ${message.success ? message.data.message : "no details"}`,
    );
  }
  return schema.parse(json);
}

const adminPassword = `${randomBytes(18).toString("base64url")}-Aa1`;
const boot = await call(
  z.object({
    identity: z.object({ credentials: z.object({ token: z.string() }) }),
    organization: z.object({ id: z.string() }),
  }),
  "POST",
  "/api/v1/admin/bootstrap",
  null,
  { email, password: adminPassword, organization: values.organization },
);
// The password is needed for the Infisical UI and the break-glass kit; it goes to a private file.
writeFileSync(adminOut, `Infisical admin\nemail: ${email}\npassword: ${adminPassword}\n`, {
  mode: 0o600,
});
const token = boot.identity.credentials.token;
const organizationId = boot.organization.id;

const { project } = await call(
  z.object({ project: z.object({ id: z.string() }) }),
  "POST",
  "/api/v1/projects",
  token,
  {
    projectName: "UlixOps",
    projectDescription: "SSH keys for the sites UlixOps manages",
    type: "secret-manager",
    shouldCreateDefaultEnvs: true,
  },
);

await call(z.unknown(), "POST", "/api/v2/folders", token, {
  projectId: project.id,
  environment: ENVIRONMENT,
  name: FOLDER,
  path: "/",
});

const { identity } = await call(
  z.object({ identity: z.object({ id: z.string() }) }),
  "POST",
  "/api/v1/identities",
  token,
  { name: "ulixops-runner", organizationId, role: "no-access" },
);

const { identityUniversalAuth } = await call(
  z.object({ identityUniversalAuth: z.object({ clientId: z.string() }) }),
  "POST",
  `/api/v1/auth/universal-auth/identities/${identity.id}`,
  token,
  { accessTokenTTL: 300, accessTokenMaxTTL: 3600, lockoutEnabled: true },
);

const { clientSecret } = await call(
  z.object({ clientSecret: z.string() }),
  "POST",
  `/api/v1/auth/universal-auth/identities/${identity.id}/client-secrets`,
  token,
  { description: "UlixOps runner", ttl: 0, numUsesLimit: 0 },
);

await call(
  z.unknown(),
  "POST",
  `/api/v1/projects/${project.id}/memberships/identities/${identity.id}`,
  token,
  {
    role: ROLE_SLUG,
  },
);

appendFileSync(
  envOut,
  [
    `INFISICAL_PROJECT_ID=${project.id}`,
    `INFISICAL_CLIENT_ID=${identityUniversalAuth.clientId}`,
    `INFISICAL_CLIENT_SECRET=${clientSecret}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

console.log("vault-setup: done");
console.log(`vault-setup: project "UlixOps" created; runner identity is a member of it only`);
console.log(`vault-setup: runner credentials appended to ${envOut}`);
console.log(
  `vault-setup: Infisical admin sign-in written to ${adminOut} (store it, then delete the file)`,
);
