import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "./env";

const Schema = z.object({
  PORT: z.coerce.number().int().default(4000),
  SECRET_TOKEN: z.string().min(8),
});

describe("parseEnv", () => {
  it("treats empty values as unset so defaults apply", () => {
    expect(parseEnv(Schema, { PORT: "", SECRET_TOKEN: "abcdefgh" })).toEqual({
      PORT: 4000,
      SECRET_TOKEN: "abcdefgh",
    });
  });

  it("names invalid variables without echoing their values", () => {
    const secret = "short";
    expect(() => parseEnv(Schema, { SECRET_TOKEN: secret })).toThrow(/SECRET_TOKEN/);
    try {
      parseEnv(Schema, { SECRET_TOKEN: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
