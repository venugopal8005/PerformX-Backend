import crypto from "node:crypto";

export const EVALUATION_SCHEMA_VERSION = 1;
export const EVALUATION_RULE_VERSION = 1;
export const EVALUATION_EVIDENCE_VERSION = 1;
export const EVALUATION_NORMALIZATION_VERSION = 1;
export const EVALUATION_CONFIDENCE_VERSION = 1;

export const EVALUATION_CONFIDENCE_LEVELS = Object.freeze([
  "high",
  "medium",
  "low",
  "unavailable",
]);

export const EVALUATION_CONFIDENCE_FACTORS = Object.freeze([
  "overlapping_intervention",
  "insufficient_spend",
  "insufficient_conversions",
  "insufficient_volume",
  "short_observation_window",
  "missing_baseline_report_run",
  "missing_follow_up_report_run",
  "unstable_metric_direction",
  "attribution_incompatible",
  "incomplete_baseline_evidence",
  "incomplete_follow_up_evidence",
  "data_quality_failure",
  "limited_observation_density",
  "evaluation_invalidated",
]);

export const EVALUATION_STATUSES = Object.freeze([
  "awaiting_follow_up",
  "ready",
  "insufficient_data",
  "not_evaluable",
  "invalidated",
]);
export const EVALUATION_EFFECTIVE_STATUSES = Object.freeze([
  ...EVALUATION_STATUSES,
  "superseded",
]);
export const EVALUATION_TRIGGER_TYPES = Object.freeze([
  "intervention_recorded",
  "report_run",
  "manual_refresh",
  "reconciliation",
  "correction",
  "cancellation",
  "rule_upgrade",
]);
export const EVALUATION_INTENT_MODES = Object.freeze([
  "auto_resolved",
  "explicit",
  "observational",
  "not_applicable",
  "unresolved",
]);
export const EVALUATION_METRICS = Object.freeze([
  "ctr",
  "cpc",
  "cpm",
  "cpa",
  "roas",
  "conversions",
  "conversion_value",
  "conversion_rate",
  "clicks",
  "impressions",
  "spend",
]);
export const EVALUATION_PRIMARY_METRICS = Object.freeze([
  "ctr",
  "cpc",
  "cpm",
  "cpa",
  "roas",
  "conversions",
  "conversion_value",
  "conversion_rate",
]);
export const EVALUATION_SUPPORTING_METRICS = Object.freeze([
  "clicks",
  "impressions",
  "spend",
]);
export const EVALUATION_NEUTRAL_METRICS = Object.freeze(["spend", "impressions"]);
export const EVALUATION_DIRECTIONALITIES = Object.freeze([
  "higher_is_better",
  "lower_is_better",
  "context_only",
]);
export const EVALUATION_RESULTS = Object.freeze([
  "improved",
  "worsened",
  "no_material_change",
  "mixed",
]);
export const EVALUATION_INTERPRETABILITY = Object.freeze([
  "directional",
  "observational",
  "not_interpretable",
]);
export const EVALUATION_PROVENANCE = Object.freeze([
  "scheduled_window",
  "scheduled_manual_window",
  "historical_fallback",
]);

export const EVALUATION_METRIC_RULES = Object.freeze({
  ctr: Object.freeze({ directionality: "higher_is_better", relative: 0.1, absolute: 0.2, unit: "percent", minimum: Object.freeze({ impressions: 100 }) }),
  cpc: Object.freeze({ directionality: "lower_is_better", relative: 0.1, absolute: 0.01, unit: "currency", minimum: Object.freeze({ clicks: 10, spend: 1 }) }),
  cpm: Object.freeze({ directionality: "lower_is_better", relative: 0.1, absolute: 0.01, unit: "currency", minimum: Object.freeze({ impressions: 100, spend: 1 }) }),
  cpa: Object.freeze({ directionality: "lower_is_better", relative: 0.1, absolute: 0.01, unit: "currency", minimum: Object.freeze({ conversions: 5, spend: 1 }), requiresAttribution: true }),
  roas: Object.freeze({ directionality: "higher_is_better", relative: 0.1, absolute: 0.1, unit: "ratio", minimum: Object.freeze({ conversions: 5, spend: 1 }), requiresAttribution: true, requiresValue: true }),
  conversions: Object.freeze({ directionality: "higher_is_better", relative: 0.1, absolute: 2, unit: "count", minimum: Object.freeze({ conversions: 5 }), requiresAttribution: true }),
  conversion_value: Object.freeze({ directionality: "higher_is_better", relative: 0.1, absolute: 1, unit: "currency", minimum: Object.freeze({ conversions: 5 }), requiresAttribution: true, requiresValue: true }),
  conversion_rate: Object.freeze({ directionality: "higher_is_better", relative: 0.1, absolute: 0.2, unit: "percent", minimum: Object.freeze({ clicks: 20, conversions: 1 }), requiresAttribution: true }),
  clicks: Object.freeze({ directionality: "higher_is_better", relative: 0.1, absolute: 10, unit: "count", minimum: Object.freeze({ impressions: 100 }) }),
  impressions: Object.freeze({ directionality: "context_only", relative: 0.1, absolute: 100, unit: "count", minimum: Object.freeze({}) }),
  spend: Object.freeze({ directionality: "context_only", relative: 0.1, absolute: 1, unit: "currency", minimum: Object.freeze({}) }),
});

export const EVALUATION_CADENCE_DAYS = Object.freeze({ daily: 1, weekly: 7, monthly: 30 });
export const EVALUATION_BASELINE_FRESHNESS_DAYS = Object.freeze({ daily: 7, weekly: 21, monthly: 75 });
export const EVALUATION_FOLLOW_UP_TIMEOUT_DAYS = Object.freeze({ daily: 7, weekly: 21, monthly: 75 });

export const EVALUATION_REASON_CODES = Object.freeze([
  "awaiting_follow_up",
  "intent_unresolved",
  "action_not_applicable",
  "tracking_comparability_unavailable",
  "observational_intent",
  "unsupported_metric",
  "neutral_only_intent",
  "historical_fallback_evidence",
  "source_evidence_unvalidated",
  "baseline_not_found",
  "baseline_evidence_missing",
  "baseline_stale",
  "follow_up_not_found",
  "follow_up_evidence_missing",
  "follow_up_timeout",
  "window_mismatch",
  "window_duration_mismatch",
  "cadence_mismatch",
  "timezone_mismatch",
  "currency_mismatch",
  "attribution_mismatch",
  "attribution_not_comparable",
  "binding_revision_mismatch",
  "account_binding_changed",
  "ownership_mismatch",
  "campaign_mismatch",
  "campaign_evidence_missing",
  "malformed_evidence",
  "minimum_volume_not_met",
  "zero_denominator",
  "zero_baseline",
  "overlapping_intervention",
  "overlap_completeness_unavailable",
  "intervention_superseded",
  "intervention_cancelled",
  "client_archived",
  "account_reassigned",
]);

export const EVALUATION_LIMITS = Object.freeze({
  watchedMetrics: 6,
  reasonCodes: 16,
  confidenceFactors: 16,
  warnings: 16,
  summary: 500,
  campaignName: 512,
  campaignId: 256,
  currency: 3,
  timezone: 128,
  attributionWindows: 8,
  attributionWindow: 64,
  campaignSnapshots: 100,
  overlapInterventions: 25,
  candidateRuns: 500,
  reconciliationBatchSize: 50,
  reconciliationMaxBatches: 4,
  idempotencyKeyMin: 16,
  idempotencyKeyMax: 128,
  leaseMs: 60_000,
  heartbeatMs: 15_000,
  leaseRetries: 25,
  leaseRetryDelayMs: 20,
  refreshBucketMs: 60_000,
});

export const EVALUATION_ERROR = Object.freeze({
  VALIDATION: "EVALUATION_VALIDATION_FAILED",
  NOT_FOUND: "EVALUATION_NOT_FOUND",
  INTERVENTION_NOT_FOUND: "INTERVENTION_NOT_FOUND",
  FILTER_REQUIRED: "EVALUATION_FILTER_REQUIRED",
  PERMISSION: "EVALUATION_PERMISSION_DENIED",
  INVALID_STATE: "EVALUATION_INVALID_STATE",
  STALE_REVISION: "EVALUATION_INTERVENTION_REVISION_STALE",
  RATE_LIMITED: "EVALUATION_REFRESH_RATE_LIMITED",
  OWNERSHIP: "EVALUATION_OWNERSHIP_CONFLICT",
  INDEXES_NOT_READY: "EVALUATION_INDEXES_NOT_READY",
  TRANSACTION_REQUIRED: "EVALUATION_TRANSACTION_REQUIRED",
  LEASE_BUSY: "EVALUATION_PROCESSING_IN_PROGRESS",
  LEASE_LOST: "EVALUATION_PROCESSING_LEASE_LOST",
  IDEMPOTENCY_CONFLICT: "EVALUATION_IDEMPOTENCY_CONFLICT",
  INTEGRITY_CONFLICT: "EVALUATION_INTEGRITY_CONFLICT",
});

export const createEvaluationError = (code, message, status = 400) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const validationError = (message) =>
  createEvaluationError(EVALUATION_ERROR.VALIDATION, message, 400);

export const normalizeEvaluationMetric = (value, { nullable = false } = {}) => {
  if (nullable && (value == null || value === "")) return null;
  const metric = String(value || "").trim().toLowerCase();
  if (!EVALUATION_METRICS.includes(metric)) throw validationError("Evaluation metric is invalid.");
  return metric;
};

export const normalizeEvaluationIntent = (input, { allowMissing = true } = {}) => {
  if (input == null && allowMissing) return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError("evaluationIntent must be an object.");
  }
  const allowed = new Set(["mode", "primaryMetric", "watchedMetrics"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw validationError(`evaluationIntent.${key} is not allowed.`);
  }
  const mode = String(input.mode || "explicit").trim();
  if (mode !== "explicit") throw validationError("Explicit request intent must use explicit mode.");
  const watched = [...new Set((input.watchedMetrics || []).map((metric) => normalizeEvaluationMetric(metric)))];
  const primary = normalizeEvaluationMetric(input.primaryMetric, { nullable: true });
  if (!watched.length || watched.length > EVALUATION_LIMITS.watchedMetrics) {
    throw validationError("evaluationIntent.watchedMetrics must contain 1 to 6 metrics.");
  }
  if (primary && !watched.includes(primary)) {
    throw validationError("evaluationIntent.primaryMetric must be watched.");
  }
  return Object.freeze({
    mode,
    primary_metric: primary,
    watched_metrics: watched,
    resolution_source: "request",
    rule_version: EVALUATION_RULE_VERSION,
  });
};

const ISSUE_METRIC_ALIASES = Object.freeze({
  ctr: "ctr", cpc: "cpc", cpm: "cpm", cpa: "cpa", roas: "roas",
  conversions: "conversions", conversion: "conversions", conversion_value: "conversion_value",
  conversion_rate: "conversion_rate", clicks: "clicks", impressions: "impressions", spend: "spend",
});

const supportedMetricFrom = (value) => ISSUE_METRIC_ALIASES[String(value || "").trim().toLowerCase()] || null;

export const resolveEvaluationIntent = ({ explicitIntent, actionType, issue, signal } = {}) => {
  const explicit = explicitIntent?.resolution_source === "request"
    ? explicitIntent
    : normalizeEvaluationIntent(explicitIntent, { allowMissing: true });
  if (explicit) return explicit;
  if (actionType === "internal_note") {
    return { mode: "not_applicable", primary_metric: null, watched_metrics: [], resolution_source: "action_policy", rule_version: EVALUATION_RULE_VERSION };
  }
  if (actionType === "fix_tracking") {
    return { mode: "not_applicable", primary_metric: null, watched_metrics: [], resolution_source: "tracking_comparability", rule_version: EVALUATION_RULE_VERSION };
  }
  if (actionType === "other") {
    return { mode: "unresolved", primary_metric: null, watched_metrics: [], resolution_source: "unresolved", rule_version: EVALUATION_RULE_VERSION };
  }
  const signalMetric = supportedMetricFrom(signal?.metadata?.primary_anomaly?.metric);
  const issueMetric = supportedMetricFrom(issue?.metric_family);
  const metric = signalMetric || issueMetric;
  if (metric) {
    return {
      mode: ["monitor_only", "no_action"].includes(actionType) ? "observational" : "auto_resolved",
      primary_metric: metric,
      watched_metrics: [metric],
      resolution_source: signalMetric ? "latest_signal_primary_anomaly" : "issue_metric_family",
      rule_version: EVALUATION_RULE_VERSION,
    };
  }
  return { mode: "unresolved", primary_metric: null, watched_metrics: [], resolution_source: "unresolved", rule_version: EVALUATION_RULE_VERSION };
};

const canonicalize = (value, seen = new WeakSet()) => {
  if (value instanceof Date) return value.toISOString();
  if (value?._bsontype === "ObjectId" || value?.constructor?.name === "ObjectId") {
    return String(value);
  }
  if (!Array.isArray(value) && value && typeof value.toObject === "function") {
    return canonicalize(value.toObject({ depopulate: true, flattenMaps: true, virtuals: false }), seen);
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const canonical = Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key], seen)])
    );
    seen.delete(value);
    return canonical;
  }
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
  return value;
};

export const hashEvaluationEvidence = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");

export const normalizeEvaluationIdempotencyKey = (value) => {
  const key = String(value || "").trim();
  if (
    key.length < EVALUATION_LIMITS.idempotencyKeyMin ||
    key.length > EVALUATION_LIMITS.idempotencyKeyMax ||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(key)
  ) throw validationError("idempotencyKey is invalid.");
  return key;
};
