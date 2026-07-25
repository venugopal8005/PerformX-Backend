import crypto from "node:crypto";

export const INTERVENTION_ACTION_VERSION = 1;
export const INTERVENTION_STATUSES = Object.freeze([
  "active",
  "superseded",
  "cancelled",
]);
export const INTERVENTION_PERFORMER_MODES = Object.freeze([
  "self",
  "workspace_member",
  "manual",
]);
export const INTERVENTION_ACTION_TYPES = Object.freeze([
  "pause_campaign",
  "resume_campaign",
  "increase_budget",
  "decrease_budget",
  "replace_creative",
  "add_creative",
  "remove_creative",
  "change_targeting",
  "add_exclusion",
  "change_bid_strategy",
  "fix_tracking",
  "landing_page_change",
  "monitor_only",
  "no_action",
  "internal_note",
  "other",
]);

const NON_ACTIONABLE_INTERVENTION_TYPES = new Set([
  "monitor_only",
  "no_action",
  "internal_note",
]);

export const isActionableIntervention = (intervention = {}) =>
  intervention.status === "active" &&
  INTERVENTION_ACTION_TYPES.includes(intervention.action_type) &&
  !NON_ACTIONABLE_INTERVENTION_TYPES.has(intervention.action_type);

export const INTERVENTION_ACTOR_PROVENANCE = Object.freeze([
  "workspace_member",
  "manual",
]);
export const INTERVENTION_IDENTITY_PROVENANCE = Object.freeze([
  "signal_snapshot",
  "report_run_snapshot",
  "current_parent",
  "unknown",
]);

export const INTERVENTION_LIMITS = Object.freeze({
  idempotencyKeyMin: 16,
  idempotencyKeyMax: 128,
  displayName: 256,
  email: 254,
  reason: 1000,
  note: 2000,
  summary: 500,
  label: 100,
  campaignId: 256,
  title: 512,
  text: 2000,
  futurePerformedAtMs: 5 * 60 * 1000,
  transactionRetryCount: 3,
  leaseRetryCount: 25,
  leaseRetryDelayMs: 20,
});

export const INTERVENTION_ERROR = Object.freeze({
  VALIDATION: "INTERVENTION_VALIDATION_FAILED",
  NOT_FOUND: "INTERVENTION_NOT_FOUND",
  ISSUE_NOT_FOUND: "ISSUE_NOT_FOUND",
  OWNERSHIP: "INTERVENTION_OWNERSHIP_CONFLICT",
  ARCHIVED: "INTERVENTION_CLIENT_ARCHIVED",
  STALE_ISSUE: "INTERVENTION_ISSUE_STALE",
  STALE_REVISION: "INTERVENTION_REVISION_STALE",
  IDEMPOTENCY_CONFLICT: "INTERVENTION_IDEMPOTENCY_CONFLICT",
  PERMISSION: "INTERVENTION_PERMISSION_DENIED",
  INVALID_STATE: "INTERVENTION_INVALID_STATE",
  TRANSACTION_REQUIRED: "INTERVENTION_TRANSACTION_REQUIRED",
  INDEXES_NOT_READY: "INTERVENTION_INDEXES_NOT_READY",
  FILTER_REQUIRED: "INTERVENTION_FILTER_REQUIRED",
});

const ACTION_PAYLOAD_KEYS = Object.freeze({
  pause_campaign: [],
  resume_campaign: [],
  increase_budget: ["mode", "amount", "currency"],
  decrease_budget: ["mode", "amount", "currency"],
  replace_creative: ["summary", "assetCount"],
  add_creative: ["summary", "assetCount"],
  remove_creative: ["summary", "assetCount"],
  change_targeting: ["dimension", "summary"],
  add_exclusion: ["exclusionType", "summary"],
  change_bid_strategy: ["strategy", "summary"],
  fix_tracking: ["area", "summary"],
  landing_page_change: ["summary"],
  monitor_only: [],
  no_action: [],
  internal_note: [],
  other: ["label", "summary"],
});

const TARGETING_DIMENSIONS = new Set([
  "audience",
  "location",
  "demographic",
  "placement",
  "optimization",
  "other",
]);
const EXCLUSION_TYPES = new Set([
  "audience",
  "placement",
  "location",
  "publisher",
  "other",
]);
const BID_STRATEGIES = new Set([
  "lowest_cost",
  "cost_cap",
  "bid_cap",
  "minimum_roas",
  "other",
]);
const TRACKING_AREAS = new Set([
  "pixel",
  "conversions_api",
  "event_mapping",
  "attribution",
  "utm",
  "other",
]);

export const createInterventionError = (code, message, status = 400) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const validationError = (message) =>
  createInterventionError(INTERVENTION_ERROR.VALIDATION, message, 400);

export const normalizeBoundedText = (
  value,
  { field, maximum, required = false } = {}
) => {
  if (value === undefined || value === null) {
    if (required) throw validationError(`${field} is required.`);
    return null;
  }
  if (typeof value !== "string") throw validationError(`${field} must be a string.`);
  const normalized = value.trim();
  if (!normalized) {
    if (required) throw validationError(`${field} is required.`);
    return null;
  }
  if (normalized.length > maximum) {
    throw validationError(`${field} must be at most ${maximum} characters.`);
  }
  return normalized;
};

export const normalizeEmail = (value, { required = false } = {}) => {
  const email = normalizeBoundedText(value, {
    field: "email",
    maximum: INTERVENTION_LIMITS.email,
    required,
  });
  if (email === null) return null;
  const normalized = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw validationError("email is invalid.");
  }
  return normalized;
};

export const normalizeInterventionIdempotencyKey = (value) => {
  const key = normalizeBoundedText(value, {
    field: "idempotencyKey",
    maximum: INTERVENTION_LIMITS.idempotencyKeyMax,
    required: true,
  });
  if (
    key.length < INTERVENTION_LIMITS.idempotencyKeyMin ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(key)
  ) {
    throw validationError("idempotencyKey is invalid.");
  }
  return key;
};

const normalizeEnum = (value, allowed, field) => {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw validationError(`${field} is invalid.`);
  }
  return value;
};

const strictPayload = (payload, actionType) => {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw validationError("actionPayload must be an object.");
  }
  const allowed = new Set(ACTION_PAYLOAD_KEYS[actionType]);
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw validationError(`actionPayload.${key} is not allowed for ${actionType}.`);
    }
  }
  return payload;
};

const summary = (payload) =>
  normalizeBoundedText(payload.summary, {
    field: "actionPayload.summary",
    maximum: INTERVENTION_LIMITS.summary,
    required: true,
  });

const assetCount = (value) => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw validationError("actionPayload.assetCount must be an integer from 1 to 100.");
  }
  return value;
};

export const normalizeInterventionAction = ({
  actionType,
  actionVersion = INTERVENTION_ACTION_VERSION,
  actionPayload,
  reason,
  note,
} = {}) => {
  if (!INTERVENTION_ACTION_TYPES.includes(actionType)) {
    throw validationError("actionType is invalid.");
  }
  if (actionVersion !== INTERVENTION_ACTION_VERSION) {
    throw validationError("actionVersion is unsupported.");
  }

  const input = strictPayload(actionPayload, actionType);
  let payload = {};
  if (["increase_budget", "decrease_budget"].includes(actionType)) {
    const mode = normalizeEnum(input.mode, new Set(["percent", "absolute"]), "actionPayload.mode");
    const amount = input.amount;
    if (
      typeof amount !== "number" ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 1_000_000_000
    ) {
      throw validationError("actionPayload.amount must be a positive bounded number.");
    }
    if (mode === "percent" && amount > 100) {
      throw validationError("Percent budget amount cannot exceed 100.");
    }
    const currency = input.currency == null
      ? null
      : normalizeBoundedText(input.currency, {
          field: "actionPayload.currency",
          maximum: 3,
          required: mode === "absolute",
        })?.toUpperCase();
    if (mode === "absolute" && !/^[A-Z]{3}$/.test(currency || "")) {
      throw validationError("Absolute budget changes require a three-letter currency.");
    }
    if (mode === "percent" && currency !== null) {
      throw validationError("Percent budget changes must not include currency.");
    }
    payload = { budget_mode: mode, budget_amount: amount, currency };
  } else if (["replace_creative", "add_creative", "remove_creative"].includes(actionType)) {
    payload = { change_summary: summary(input), asset_count: assetCount(input.assetCount) };
  } else if (actionType === "change_targeting") {
    payload = {
      targeting_dimension: normalizeEnum(input.dimension, TARGETING_DIMENSIONS, "actionPayload.dimension"),
      change_summary: summary(input),
    };
  } else if (actionType === "add_exclusion") {
    payload = {
      exclusion_type: normalizeEnum(input.exclusionType, EXCLUSION_TYPES, "actionPayload.exclusionType"),
      change_summary: summary(input),
    };
  } else if (actionType === "change_bid_strategy") {
    payload = {
      bid_strategy: normalizeEnum(input.strategy, BID_STRATEGIES, "actionPayload.strategy"),
      change_summary: summary(input),
    };
  } else if (actionType === "fix_tracking") {
    payload = {
      tracking_area: normalizeEnum(input.area, TRACKING_AREAS, "actionPayload.area"),
      change_summary: summary(input),
    };
  } else if (actionType === "landing_page_change") {
    payload = { change_summary: summary(input) };
  } else if (actionType === "other") {
    payload = {
      other_label: normalizeBoundedText(input.label, {
        field: "actionPayload.label",
        maximum: INTERVENTION_LIMITS.label,
        required: true,
      }),
      change_summary: summary(input),
    };
  }

  const normalizedNote = normalizeBoundedText(note, {
    field: "note",
    maximum: INTERVENTION_LIMITS.note,
    required: actionType === "internal_note",
  });
  const normalizedReason = normalizeBoundedText(reason, {
    field: "reason",
    maximum: INTERVENTION_LIMITS.reason,
    required: actionType !== "internal_note",
  });
  if (actionType === "internal_note" && reason != null) {
    throw validationError("internal_note does not accept reason.");
  }

  return {
    actionType,
    actionVersion,
    actionPayload: payload,
    reason: normalizedReason,
    note: normalizedNote,
  };
};

export const normalizePerformedAt = (value, { openedAt, now = new Date() } = {}) => {
  const performedAt = new Date(value);
  const opened = new Date(openedAt);
  if (!value || Number.isNaN(performedAt.getTime())) {
    throw validationError("performedAt is invalid.");
  }
  if (!openedAt || Number.isNaN(opened.getTime()) || performedAt < opened) {
    throw validationError("performedAt cannot be before the Issue opened.");
  }
  if (performedAt.getTime() > now.getTime() + INTERVENTION_LIMITS.futurePerformedAtMs) {
    throw validationError("performedAt cannot be in the future.");
  }
  return performedAt;
};

const canonicalize = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
};

export const buildInterventionRequestHash = ({ operation, agencyId, targetId, payload }) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          operation: String(operation),
          agency_id: String(agencyId),
          target_id: String(targetId),
          payload,
        })
      )
    )
    .digest("hex");
