import { describe, expect, it } from "vitest";
import { redact } from "./redact";
import { fingerprint, shellQuote } from "./ssh";

describe("shellQuote", () => {
  it("single-quotes every argument", () => {
    expect(shellQuote(["wp", "--path=/var/www/html", "core", "version"])).toBe(
      "'wp' '--path=/var/www/html' 'core' 'version'",
    );
  });

  it("leaves nothing for a shell to interpret", () => {
    const hostile = ["$(id)", "`id`", "a; rm -rf /", "it's", "x\ny", "*", "$HOME"];
    const quoted = shellQuote(hostile);
    // Every argument stays one literal word: quotes close only around escaped single quotes.
    expect(quoted).toBe(`'$(id)' '\`id\`' 'a; rm -rf /' 'it'\\''s' 'x\ny' '*' '$HOME'`);
  });
});

describe("fingerprint", () => {
  it("matches the OpenSSH SHA256 format", () => {
    expect(fingerprint(Buffer.from("key"))).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe("redact", () => {
  const key =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----";

  it("removes private key blocks and known secrets, line by line", () => {
    expect(redact(`oops ${key} done`)).toBe("oops [redacted private key] done");
    expect(redact("token=abcdefghijklmnopqrstuvwxyz", ["abcdefghijklmnopqrstuvwxyz"])).toBe(
      "token=[redacted]",
    );
    expect(redact("leaked b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ here", [key])).toBe(
      "leaked [redacted] here",
    );
  });

  it("caps long output", () => {
    expect(redact("x".repeat(50), [], 10)).toBe("xxxxxxxxxx… (truncated)");
  });
});
