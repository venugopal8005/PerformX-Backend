import crypto from "node:crypto";
import mongoose from "mongoose";

export const REVIEW_ITEM_TYPES = Object.freeze(["issue_review", "evaluation_review"]);
export const REVIEW_STATES = Object.freeze(["open", "acknowledged", "snoozed", "reviewed", "closed", "superseded"]);
export const REVIEW_ACTIVE_STATES = Object.freeze(["open", "acknowledged", "snoozed"]);
export const REVIEW_PRIORITIES = Object.freeze(["critical", "high", "normal"]);
export const REVIEW_PRIORITY_RANK = Object.freeze({ critical: 0, high: 1, normal: 2 });
export const REVIEW_HUMAN_ACTIONS = Object.freeze(["acknowledged", "snoozed", "interpretation_recorded", "intervention_recorded"]);
export const REVIEW_SYSTEM_ACTIONS = Object.freeze([
  "opened_from_issue", "opened_from_evaluation", "reopened_by_evidence", "reopened_by_severity",
  "closed_source_resolved", "closed_client_archived", "closed_account_reassigned",
  "superseded_by_evaluation", "invalidated_by_source", "snooze_expired", "reconciliation_recovered",
]);
export const REVIEW_ACTION_TYPES = Object.freeze([...REVIEW_HUMAN_ACTIONS, ...REVIEW_SYSTEM_ACTIONS]);
export const REVIEW_DECISION_TYPES = Object.freeze(["interpretation_only", "campaign_action", "monitor_only", "no_action"]);
export const REVIEW_REASONS = Object.freeze([
  "issue_created", "issue_reopened", "issue_new_evidence", "issue_severity_escalated",
  "intervention_cancelled", "evaluation_ready", "evaluation_ready_successor", "reconciliation_recovered",
]);
export const REVIEW_CLOSE_REASONS = Object.freeze([
  "source_resolved", "client_archived", "account_reassigned", "evaluation_superseded", "source_invalidated",
]);
export const REVIEW_CHECKPOINT_STREAMS = Object.freeze(["issues", "interventions", "evaluation_series", "snoozes", "authority"]);
export const REVIEW_CHECKPOINT_LEASE_MS = 5 * 60 * 1000;
export const REVIEW_PROVENANCE = Object.freeze(["snapshot", "current_parent", "unknown"]);
export const REVIEW_LIMITS = Object.freeze({
  title: 512, summary: 2000, name: 256, campaignId: 256, note: 2000, snoozeNote: 1000,
  idempotencyKeyMin: 16, idempotencyKeyMax: 512, maximumSnoozeMs: 30 * 24 * 60 * 60 * 1000,
  candidateBatch: 50, maximumBatches: 4, maximumCandidates: 200, timelineLimit: 100, cursorBytes: 4096,
});
export const REVIEW_ERROR = Object.freeze({
  INDEXES_NOT_READY: "REVIEW_INDEXES_NOT_READY", REVISION_STALE: "REVIEW_REVISION_STALE",
  INVALID_STATE: "REVIEW_INVALID_STATE", IDEMPOTENCY_CONFLICT: "REVIEW_IDEMPOTENCY_CONFLICT",
  SOURCE_STALE: "REVIEW_SOURCE_STALE", NOT_FOUND: "REVIEW_NOT_FOUND", VALIDATION: "REVIEW_VALIDATION_FAILED",
  INVALID_CURSOR: "INVALID_REVIEW_CURSOR", INVALID_TIMELINE_CURSOR: "INVALID_TIMELINE_CURSOR",
  TRANSACTION_REQUIRED: "REVIEW_TRANSACTION_REQUIRED",
});

export const createReviewError = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

export const reviewPriorityForIssueSeverity = (severity) => {
  const value = { critical: "critical", moderate: "high", stable: "normal" }[severity];
  if (!value) throw createReviewError(REVIEW_ERROR.VALIDATION, "Issue severity is invalid.");
  return { priority: value, priorityRank: REVIEW_PRIORITY_RANK[value], prioritySource: `issue_severity:${severity}` };
};

export const reviewPriorityForEvaluationResult = (result) => {
  const value = { worsened: "high", mixed: "high", improved: "normal", no_material_change: "normal" }[result];
  if (!value) throw createReviewError(REVIEW_ERROR.VALIDATION, "Evaluation result is invalid.");
  return { priority: value, priorityRank: REVIEW_PRIORITY_RANK[value], prioritySource: `evaluation_result:${result}` };
};

const canonicalize = (value, seen = new Set()) => {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw createReviewError(REVIEW_ERROR.VALIDATION, "Canonical values must be finite.");
    return value;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw createReviewError(REVIEW_ERROR.VALIDATION, "Canonical date is invalid.");
    return value.toISOString();
  }
  if (value instanceof mongoose.Types.ObjectId || mongoose.isObjectIdOrHexString(value)) return String(value).toLowerCase();
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw createReviewError(REVIEW_ERROR.VALIDATION, "Canonical value has an unsupported type.");
  }
  if (seen.has(value)) throw createReviewError(REVIEW_ERROR.VALIDATION, "Canonical value cannot be circular.");
  seen.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalize(value[key], seen);
    if (normalized !== undefined) output[key] = normalized;
  }
  seen.delete(value);
  return output;
};

export const canonicalReviewValue = (value) => canonicalize(value);
export const hashReviewEvent = (value) => crypto.createHash("sha256").update(JSON.stringify({ canonicalVersion: 1, value: canonicalize(value) })).digest("hex");

export const normalizeReviewIdempotencyKey = (value) => {
  if (typeof value !== "string") throw createReviewError(REVIEW_ERROR.VALIDATION, "idempotencyKey is required.");
  const key = value.trim();
  if (key.length < REVIEW_LIMITS.idempotencyKeyMin || key.length > REVIEW_LIMITS.idempotencyKeyMax || !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(key)) {
    throw createReviewError(REVIEW_ERROR.VALIDATION, "idempotencyKey is invalid.");
  }
  return key;
};

export const normalizeReviewRevision = (value, field = "expectedRevision") => {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw createReviewError(REVIEW_ERROR.VALIDATION, `${field} must be a non-negative integer.`);
  return revision;
};

export const reviewActiveKey = ({ type, issueId, evaluationSeriesId }) =>
  type === "issue_review" ? `issue_review:${issueId}` : `evaluation_review:${evaluationSeriesId}`;
