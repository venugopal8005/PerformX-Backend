const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

const SENSITIVE_KEYS = [
  "access_token",
  "authorization",
  "cookie",
  "password",
  "refresh_token",
  "secret",
  "token",
];

const colorize = (color, value) =>
  `${COLORS[color] || ""}${value}${COLORS.reset}`;

const isSensitiveKey = (key) =>
  SENSITIVE_KEYS.some((sensitiveKey) =>
    String(key).toLowerCase().includes(sensitiveKey)
  );

const sanitize = (value, seen = new WeakSet()) => {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value._bsontype && typeof value.toString === "function") {
    return value.toString();
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);

  const plainValue =
    typeof value.toObject === "function"
      ? value.toObject({ virtuals: false })
      : value;

  if (Array.isArray(plainValue)) {
    return plainValue.map((item) => sanitize(item, seen));
  }

  return Object.fromEntries(
    Object.entries(plainValue).map(([key, entryValue]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : sanitize(entryValue, seen),
    ])
  );
};

const formatPayload = (payload) => {
  if (payload === undefined) {
    return "";
  }

  return JSON.stringify(sanitize(payload), null, 2);
};

export const logAction = (
  scope,
  action,
  payload,
  color = "cyan"
) => {
  const timestamp = new Date().toISOString();
  const heading = `${COLORS.bold}[${timestamp}] [${scope}] ${action}${COLORS.reset}`;

  console.log(colorize(color, heading));

  if (payload !== undefined) {
    console.log(colorize("dim", formatPayload(payload)));
  }
};

export const logError = (scope, action, error, payload) => {
  logAction(
    scope,
    action,
    {
      ...(payload || {}),
      error,
    },
    "red"
  );
};
