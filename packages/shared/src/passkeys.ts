// Contracts for passkeys (WebAuthn), a second factor alongside TOTP.
import { z } from "zod";
import { AuthContext, Token } from "./auth";

const b64url = z.string().regex(/^[A-Za-z0-9_-]*$/);
const TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;
// Unknown transports from newer browsers are dropped rather than failing the ceremony.
const transports = z.array(z.enum(TRANSPORTS)).optional().catch(undefined);
const attachment = z.enum(["platform", "cross-platform"]).optional().catch(undefined);
const credentialId = b64url.min(1).max(1024);

/** What `startRegistration()` returns in the browser. Extension results are not used. */
export const RegistrationCredential = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64url.max(8192),
    attestationObject: b64url.max(65536),
    transports,
  }),
  authenticatorAttachment: attachment,
  clientExtensionResults: z.object({}),
});

/** What `startAuthentication()` returns in the browser. */
export const AuthenticationCredential = z.object({
  id: credentialId,
  rawId: credentialId,
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: b64url.max(8192),
    authenticatorData: b64url.max(8192),
    signature: b64url.max(2048),
    userHandle: b64url.max(1024).optional(),
  }),
  authenticatorAttachment: attachment,
  clientExtensionResults: z.object({}),
});

export const PasskeyLoginOptionsRequest = z.object({ challengeToken: Token });
export const PasskeyLoginRequest = z.object({
  challengeToken: Token,
  credential: AuthenticationCredential,
  context: AuthContext,
});
/** Adding a passkey needs the current authenticator code (step-up), not only a session. */
export const PasskeyRegisterOptionsRequest = z.object({
  code: z.string().max(16),
  context: AuthContext,
});
export const AddPasskeyRequest = z.object({
  name: z.string().trim().min(1).max(60),
  credential: RegistrationCredential,
});

export const PasskeyView = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  backedUp: z.boolean(),
});
export type PasskeyView = z.infer<typeof PasskeyView>;

/** Options JSON goes straight to the browser's WebAuthn API; only its shape is checked here. */
export const WebAuthnOptions = z.looseObject({ challenge: b64url.min(16) });
