import type { z } from "zod";

/**
 * Parses environment variables with a Zod schema. Empty values count as unset, so a copied
 * .env.example falls back to defaults. Errors name the variables but never their values.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.output<T> {
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid or missing environment variables: ${names.join(", ")}`);
  }
  return parsed.data;
}
