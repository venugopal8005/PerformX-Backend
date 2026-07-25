export const ISSUE_FINGERPRINT_VERSION = 1;
export const ISSUE_MATCHING_VERSION = 1;

export const ISSUE_STATUSES = Object.freeze(["open", "monitoring", "resolved"]);
export const ACTIVE_ISSUE_STATUSES = Object.freeze(["open", "monitoring"]);
export const SIGNAL_ISSUE_MATCHING_STATUSES = Object.freeze([
  "matched",
  "ineligible",
  "failed",
  "legacy_ungrouped",
]);
export const ISSUE_PROCESSING_STATUSES = Object.freeze([
  "pending",
  "processing",
  "completed",
  "ineligible",
  "not_applicable",
  "failed_retryable",
  "failed_integrity",
]);
export const ISSUE_PROCESSING_RESULT_CLASSIFICATIONS = Object.freeze([
  "matched",
  "created",
  "reopened",
  "successor_created",
  "clean_observation",
  "ineligible",
  "not_applicable",
  "failed_retryable",
  "failed_integrity",
]);
export const ISSUE_ENTITY_LEVELS = Object.freeze(["campaign", "adset", "ad"]);
export const ISSUE_ENABLED_ENTITY_LEVELS = Object.freeze(["campaign"]);
export const ISSUE_TRENDS = Object.freeze(["escalating", "improving", "unchanged"]);
export const ISSUE_SEVERITIES = Object.freeze(["stable", "moderate", "critical"]);
export const ISSUE_SUPPORTED_CADENCES = Object.freeze(["daily", "weekly", "monthly"]);

export const ISSUE_RECURRENCE_MS = 30 * 24 * 60 * 60 * 1000;
export const ISSUE_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const ISSUE_TRANSACTION_RETRY_COUNT = 3;
export const ISSUE_RECENT_REPORT_IDS_LIMIT = 25;

export const ISSUE_ARCHETYPE_METRIC_FAMILY = Object.freeze({
  creative_fatigue: "creative_engagement",
  engagement_quality_drop: "creative_engagement",
  audience_saturation: "audience_delivery",
  audience_overlap: "audience_delivery",
  aggressive_scaling: "scaling_efficiency",
  conversion_funnel_breakdown: "conversion_efficiency",
  auction_pressure: "auction_cost",
  delivery_instability: "delivery_stability",
  pacing_warning: "delivery_stability",
  traffic_quality_drop: "traffic_quality",
  volume_loss: "delivery_volume",
  data_quality_issue: "data_quality",
  ctr_decline: "ctr",
  roas_drop: "roas",
  cpm_spike: "cpm",
  frequency_spike: "frequency",
});

export const ISSUE_POSITIVE_ARCHETYPES = Object.freeze([
  "healthy_scaling",
  "stable_performance",
]);

export const ISSUE_APPROVED_ARCHETYPES = Object.freeze([
  ...Object.keys(ISSUE_ARCHETYPE_METRIC_FAMILY),
  "metric_anomaly",
  ...ISSUE_POSITIVE_ARCHETYPES,
]);

export const ISSUE_PRIMARY_METRIC_FAMILIES = Object.freeze({
  spend: "spend",
  impressions: "impressions",
  reach: "reach",
  frequency: "frequency",
  clicks: "clicks",
  ctr: "ctr",
  cpc: "cpc",
  cpm: "cpm",
  conversions: "conversions",
  conversion_value: "conversion_value",
  conversion_rate: "conversion_rate",
  cvr: "conversion_rate",
  roas: "roas",
  cpa: "cpa",
});

export const ISSUE_REASON = Object.freeze({
  AGENCY_MISSING: "agency_missing",
  CLIENT_MISSING: "client_missing",
  REPORT_MISSING: "report_missing",
  REPORT_RUN_MISSING: "report_run_missing",
  META_ACCOUNT_MISSING: "meta_account_missing",
  OWNERSHIP_CONFLICT: "ownership_conflict",
  CAMPAIGN_MISSING: "campaign_missing",
  CAMPAIGN_AMBIGUOUS: "campaign_ambiguous",
  CAMPAIGN_CONFLICT: "campaign_conflict",
  CAMPAIGN_INVALID: "campaign_invalid",
  CADENCE_MISSING: "cadence_missing",
  CADENCE_UNSUPPORTED: "cadence_unsupported",
  TIMEZONE_MISSING: "timezone_missing",
  TIMEZONE_INVALID: "timezone_invalid",
  ARCHETYPE_MISSING: "archetype_missing",
  ARCHETYPE_UNSUPPORTED: "archetype_unsupported",
  POSITIVE_ARCHETYPE: "positive_archetype",
  METRIC_FAMILY_MISSING: "metric_family_missing",
  ENTITY_LEVEL_UNSUPPORTED: "entity_level_unsupported",
  SCOPE_MALFORMED: "scope_malformed",
  STALE_OBSERVATION: "stale_observation",
  DUPLICATE_OBSERVATION: "duplicate_observation",
  SIGNAL_CARDINALITY: "signal_cardinality_violation",
  FINGERPRINT_COLLISION: "fingerprint_collision",
  ISSUE_OWNERSHIP_CONFLICT: "issue_ownership_conflict",
  SIGNAL_ALREADY_LINKED: "signal_already_linked",
  CLAIM_LOST: "issue_processing_claim_lost",
  INDEXES_UNAVAILABLE: "issue_integrity_indexes_unavailable",
  NO_SIGNAL: "no_signal",
  CLEAN_OBSERVATION_NOT_TRUSTED: "clean_observation_not_trusted",
  PARENT_ARCHIVED: "parent_archived",
  PARENT_NOT_OPERATIONAL: "parent_not_operational",
  LEGACY_UNGROUPED: "legacy_ungrouped",
});

export const ISSUE_ERROR_CODE = Object.freeze({
  OWNERSHIP_CONFLICT: "ISSUE_SCOPE_OWNERSHIP_CONFLICT",
  FINGERPRINT_COLLISION: "ISSUE_FINGERPRINT_COLLISION",
  SIGNAL_CARDINALITY: "ISSUE_SIGNAL_CARDINALITY_VIOLATION",
  SIGNAL_ALREADY_LINKED: "ISSUE_SIGNAL_ALREADY_LINKED",
  CLAIM_LOST: "ISSUE_PROCESSING_CLAIM_LOST",
  TRANSACTION_REQUIRED: "ISSUE_PROCESSING_TRANSACTION_REQUIRED",
  INDEXES_UNAVAILABLE: "ISSUE_INTEGRITY_INDEXES_UNAVAILABLE",
  INDEXES_NOT_READY: "ISSUE_INDEXES_NOT_READY",
});

export const ISSUE_ERROR_MESSAGE_MAX = 500;
export const ISSUE_TEXT_MAX = 2000;

export const severityRank = (severity) =>
  ({ stable: 0, moderate: 1, critical: 2 })[severity] ?? -1;

export const trendForSeverity = (previousSeverity, currentSeverity) => {
  const previous = severityRank(previousSeverity);
  const current = severityRank(currentSeverity);
  if (previous < 0 || current < 0 || previous === current) return "unchanged";
  return current > previous ? "escalating" : "improving";
};

export const issueProcessingKey = (reportRunId) =>
  `report-run:${String(reportRunId)}:issues:v${ISSUE_MATCHING_VERSION}`;
