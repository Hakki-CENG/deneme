import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { allowlisted, PlatformJwtVerifier, verifyDiscordSignature, verifyFeishuSignature, verifyLineSignature, verifySharedSecret, verifySlackSignature, verifyWhatsAppSignature } from "../src/platforms/verification.js";

describe("inbound platform signatures", () => {
  it("verifies Slack v0 signatures and rejects stale timestamps", () => {
    const rawBody = Buffer.from('{"event":"hello"}');
    const timestamp = "1700000000";
    const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:`).update(rawBody).digest("hex")}`;
    expect(verifySlackSignature({ rawBody, timestamp, signature, signingSecret: "secret", nowMs: 1700000000 * 1000 })).toBe(true);
    expect(verifySlackSignature({ rawBody, timestamp, signature, signingSecret: "secret", nowMs: 1700001000 * 1000 })).toBe(false);
  });

  it("verifies WhatsApp HMAC signatures", () => {
    const body = Buffer.from("payload");
    const signature = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
    expect(verifyWhatsAppSignature(body, signature, "app-secret")).toBe(true);
    expect(verifyWhatsAppSignature(body, signature, "wrong")).toBe(false);
  });

  it("verifies Discord Ed25519 signatures over timestamp plus raw body", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const rawBody = Buffer.from('{"type":1}');
    const timestamp = "1700000000";
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString("hex");
    const spki = publicKey.export({ format: "der", type: "spki" });
    const rawPublicKey = spki.subarray(spki.length - 32).toString("hex");
    expect(verifyDiscordSignature({ rawBody, signature, timestamp, publicKeyHex: rawPublicKey })).toBe(true);
    expect(verifyDiscordSignature({ rawBody: Buffer.from("changed"), signature, timestamp, publicKeyHex: rawPublicKey })).toBe(false);
  });

  it("verifies LINE base64 HMAC signatures", () => {
    const raw = Buffer.from('{"events":[]}');
    const signature = createHmac("sha256", "line-secret").update(raw).digest("base64");
    expect(verifyLineSignature(raw, signature, "line-secret")).toBe(true);
    expect(verifyLineSignature(Buffer.from("changed"), signature, "line-secret")).toBe(false);
  });

  it("verifies Feishu timestamp/nonce/encrypt-key signatures and rejects replay", () => {
    const rawBody = Buffer.from('{"event":"message"}'), timestamp = "1700000000", nonce = "nonce";
    const signature = createHash("sha256").update(timestamp).update(nonce).update("encrypt-key").update(rawBody).digest("hex");
    expect(verifyFeishuSignature({ rawBody, timestamp, nonce, signature, encryptKey: "encrypt-key", nowMs: 1700000000 * 1000 })).toBe(true);
    expect(verifyFeishuSignature({ rawBody, timestamp, nonce, signature, encryptKey: "encrypt-key", nowMs: 1700001000 * 1000 })).toBe(false);
  });

  it("verifies bounded exact-origin platform JWTs", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = await exportJWK(publicKey); jwk.kid = "key-1"; jwk.alg = "RS256";
    let fetches = 0;
    const verifier = new PlatformJwtVerifier({
      audience: "app-audience", issuers: ["https://issuer.example"], jwksUrl: "https://keys.example/jwks",
      fetch: async () => { fetches++; return Response.json({ keys: [jwk] }); },
    });
    const token = await new SignJWT({ sub: "user" }).setProtectedHeader({ alg: "RS256", kid: "key-1" }).setIssuer("https://issuer.example").setAudience("app-audience").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    expect(await verifier.verify(`Bearer ${token}`)).toMatchObject({ sub: "user" });
    expect(await verifier.verify(`Bearer ${token}`)).toMatchObject({ sub: "user" });
    expect(fetches).toBe(1);
    const wrong = await new SignJWT({}).setProtectedHeader({ alg: "RS256", kid: "key-1" }).setIssuer("https://issuer.example").setAudience("wrong").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    await expect(verifier.verify(`Bearer ${wrong}`)).rejects.toThrow("verification failed");
    const redirecting = new PlatformJwtVerifier({ audience: "x", issuers: ["https://issuer"], jwksUrl: "https://keys.example/jwks", fetch: async () => new Response(null, { status: 302 }) });
    await expect(redirecting.verify(`Bearer ${token}`)).rejects.toThrow("redirects are forbidden");
  });

  it("uses constant-value allowlists and shared secrets", () => {
    expect(verifySharedSecret("x", "x")).toBe(true);
    expect(verifySharedSecret("x", "y")).toBe(false);
    expect(allowlisted("u2", "u1,u2")).toBe(true);
    expect(allowlisted("u3", "u1,u2")).toBe(false);
  });
});
