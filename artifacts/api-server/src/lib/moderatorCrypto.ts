import crypto from "node:crypto";

// The moderator feature lets a project creator paste their own OpenAI API
// key, scoped to that project only. It's stored encrypted at rest rather
// than in plaintext, and is never sent back to any client once saved.
//
// Rather than provisioning a brand-new secret just for this, the encryption
// key is derived from SESSION_SECRET (already required for the app to run)
// via HMAC — a distinct, non-reversible derivation, not the raw session
// secret itself, so this doesn't couple moderator-key encryption to however
// session tokens happen to be handled elsewhere.
function getEncryptionKey(): Buffer {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    throw new Error(
      "SESSION_SECRET must be set to encrypt/decrypt moderator API keys.",
    );
  }
  return crypto
    .createHmac("sha256", sessionSecret)
    .update("moderator-api-key-encryption-v1")
    .digest();
}

export interface EncryptedApiKey {
  encryptedApiKey: string;
  apiKeyIv: string;
  apiKeyAuthTag: string;
}

export function encryptApiKey(plaintext: string): EncryptedApiKey {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  return {
    encryptedApiKey: encrypted.toString("base64"),
    apiKeyIv: iv.toString("base64"),
    apiKeyAuthTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptApiKey(fields: EncryptedApiKey): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(fields.apiKeyIv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(fields.apiKeyAuthTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(fields.encryptedApiKey, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf-8");
}
