const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/**
 * Makes text safe to leave the runner (job results, logs): removes private key blocks and any
 * known secret (and each of its lines), then caps the length.
 */
export function redact(text: string, secrets: readonly string[] = [], maxLength = 2000): string {
  let out = text.replace(PEM_BLOCK, "[redacted private key]");
  for (const secret of secrets) {
    if (!secret) continue;
    const pieces = [
      secret,
      ...secret
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= 16),
    ];
    for (const piece of pieces) out = out.split(piece).join("[redacted]");
  }
  return out.length > maxLength ? `${out.slice(0, maxLength)}… (truncated)` : out;
}
