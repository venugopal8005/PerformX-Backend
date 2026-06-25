import crypto from "crypto";

const TOKEN_PREFIX = "enc:v1";

const getEncryptionKey = () => {
  const secret =
    process.env.META_TOKEN_SECRET ||
    process.env.JWT_SECRET ||
    process.env.META_APP_SECRET;

  if (!secret) {
    throw new Error("META_TOKEN_SECRET, JWT_SECRET, or META_APP_SECRET is required");
  }

  return crypto.createHash("sha256").update(secret).digest();
};

export const encryptMetaToken = (token) => {
  if (!token) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(token), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    TOKEN_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
};

export const decryptMetaToken = (encryptedToken) => {
  if (!encryptedToken) return null;
  if (!String(encryptedToken).startsWith(`${TOKEN_PREFIX}:`)) return encryptedToken;

  const [, , ivText, authTagText, encryptedText] = String(encryptedToken).split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivText, "base64url")
  );

  decipher.setAuthTag(Buffer.from(authTagText, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

export const getMetaAccessToken = (connection) => {
  if (!connection) return null;

  return (
    decryptMetaToken(connection.access_token_encrypted) ||
    connection.access_token ||
    null
  );
};
