import crypto from "crypto";

const MAX_SIGNED_REQUEST_LENGTH = 10 * 1024;
const MAX_META_USER_ID_LENGTH = 256;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class MetaSignedRequestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "MetaSignedRequestError";
    this.code = code;
    this.status = status;
  }
}

const requireAppSecret = (appSecret) => {
  if (typeof appSecret !== "string" || !appSecret.trim()) {
    throw new MetaSignedRequestError(
      "META_APP_SECRET_MISSING",
      "Meta compliance callback configuration is unavailable.",
      503
    );
  }

  return appSecret;
};

const strictBase64UrlDecode = (value) => {
  if (
    typeof value !== "string" ||
    !value ||
    !BASE64URL_PATTERN.test(value) ||
    value.length % 4 === 1
  ) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_MALFORMED",
      "Invalid Meta signed request."
    );
  }

  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_MALFORMED",
      "Invalid Meta signed request."
    );
  }

  if (!decoded.length || decoded.toString("base64url") !== value) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_MALFORMED",
      "Invalid Meta signed request."
    );
  }

  return decoded;
};

const requireMetaUserId = (value) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_META_USER_ID_LENGTH
  ) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_USER_MISSING",
      "Invalid Meta signed request."
    );
  }

  return value.trim();
};

export const verifyMetaSignedRequest = (
  signedRequest,
  { appSecret = process.env.META_APP_SECRET } = {}
) => {
  if (
    typeof signedRequest !== "string" ||
    !signedRequest ||
    signedRequest.length > MAX_SIGNED_REQUEST_LENGTH
  ) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_MISSING",
      "Invalid Meta signed request."
    );
  }

  const segments = signedRequest.split(".");
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_MALFORMED",
      "Invalid Meta signed request."
    );
  }

  const secret = requireAppSecret(appSecret);
  const receivedSignature = strictBase64UrlDecode(segments[0]);
  const encodedPayload = segments[1];
  const payloadBuffer = strictBase64UrlDecode(encodedPayload);
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest();

  if (
    receivedSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(receivedSignature, expectedSignature)
  ) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_INVALID_SIGNATURE",
      "Invalid Meta signed request."
    );
  }

  let payload;
  try {
    payload = JSON.parse(payloadBuffer.toString("utf8"));
  } catch {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_INVALID_PAYLOAD",
      "Invalid Meta signed request."
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_INVALID_PAYLOAD",
      "Invalid Meta signed request."
    );
  }

  if (payload.algorithm !== "HMAC-SHA256") {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_ALGORITHM_INVALID",
      "Invalid Meta signed request."
    );
  }

  const userId = requireMetaUserId(payload.user_id);
  if (
    payload.issued_at !== undefined &&
    (!Number.isFinite(payload.issued_at) || payload.issued_at < 0)
  ) {
    throw new MetaSignedRequestError(
      "META_SIGNED_REQUEST_ISSUED_AT_INVALID",
      "Invalid Meta signed request."
    );
  }

  return { ...payload, user_id: userId };
};

export const hashMetaUserId = (
  metaUserId,
  { appSecret = process.env.META_APP_SECRET } = {}
) => {
  const secret = requireAppSecret(appSecret);
  const userId = requireMetaUserId(metaUserId);

  return crypto
    .createHmac("sha256", secret)
    .update(`meta-data-deletion:${userId}`)
    .digest("hex");
};
