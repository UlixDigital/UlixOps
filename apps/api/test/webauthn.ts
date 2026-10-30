// A software passkey for tests: a real P-256 key, "none" attestation and signed assertions, so
// the WebAuthn verification runs end to end without a browser.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

type Cbor = Parameters<typeof isoCBOR.encode>[0];

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

export class SoftPasskey {
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;
  readonly credentialId = randomBytes(16).toString("base64url");

  constructor(
    private readonly rpID = "localhost",
    private readonly origin = "http://localhost:3000",
  ) {}

  private cosePublicKey(): Uint8Array {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const coord = (value: string | undefined) => Buffer.from(value ?? "", "base64url");
    const key: Cbor = new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, coord(jwk.x)],
      [-3, coord(jwk.y)],
    ]);
    return isoCBOR.encode(key);
  }

  private authenticatorData(rpID: string, flags: number, attested: boolean): Buffer {
    const signCount = Buffer.alloc(4);
    signCount.writeUInt32BE(this.counter);
    const parts = [createHash("sha256").update(rpID).digest(), Buffer.from([flags]), signCount];
    if (attested) {
      const id = Buffer.from(this.credentialId, "base64url");
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(id.length);
      parts.push(Buffer.alloc(16), idLength, id, Buffer.from(this.cosePublicKey()));
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** What the browser returns from startRegistration(). */
  register(challenge: string, opts: { origin?: string; rpID?: string } = {}) {
    const authData = this.authenticatorData(
      opts.rpID ?? this.rpID,
      FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_DATA,
      true,
    );
    const attestation: Cbor = new Map<string, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: this.clientData(
          "webauthn.create",
          challenge,
          opts.origin ?? this.origin,
        ).toString("base64url"),
        attestationObject: Buffer.from(isoCBOR.encode(attestation)).toString("base64url"),
        transports: ["internal" as const],
      },
      authenticatorAttachment: "platform" as const,
      clientExtensionResults: {},
    };
  }

  /** What the browser returns from startAuthentication(). */
  authenticate(challenge: string, opts: { origin?: string } = {}) {
    this.counter += 1;
    const authData = this.authenticatorData(
      this.rpID,
      FLAG_USER_PRESENT | FLAG_USER_VERIFIED,
      false,
    );
    const clientData = this.clientData("webauthn.get", challenge, opts.origin ?? this.origin);
    const signature = createSign("SHA256")
      .update(Buffer.concat([authData, createHash("sha256").update(clientData).digest()]))
      .sign(this.keys.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key" as const,
      response: {
        clientDataJSON: clientData.toString("base64url"),
        authenticatorData: authData.toString("base64url"),
        signature: signature.toString("base64url"),
      },
      clientExtensionResults: {},
    };
  }
}
