import {
  safeHistoricalDate,
  safeHistoricalNumber,
  safeHistoricalObjectId,
  safeHistoricalString,
} from "./historicalValueSanitizer.js";

const plain = (value) => value?.toObject?.({ depopulate: true }) || value || {};
const id = (value) => safeHistoricalObjectId(value);
const text = (value, maximum = 500) => safeHistoricalString(value, maximum);
const date = (value) => safeHistoricalDate(value);
const number = (value) => safeHistoricalNumber(value);
const metricValues = (value = {}) => ({
  spend: number(value.spend),
  impressions: number(value.impressions),
  clicks: number(value.clicks),
  conversions: number(value.conversions),
  conversionValue: number(value.conversion_value),
  ctr: number(value.ctr),
  cpc: number(value.cpc),
  cpm: number(value.cpm),
  cpa: number(value.cpa),
  roas: number(value.roas),
  conversionRate: number(value.conversion_rate),
});
const evidence = (input) => {
  const value = plain(input);
  if (!value.report_run_id) return null;
  return {
    reportRunId: id(value.report_run_id),
    window: {
      start: text(value.window?.start, 10),
      end: text(value.window?.end, 10),
      timezone: text(value.window?.timezone, 128),
      cadence: text(value.window?.cadence, 16),
    },
    campaignId: text(value.campaign_id, 256),
    campaignName: text(value.campaign_name, 512),
    currency: text(value.currency, 3),
    attributionWindows: (value.attribution_windows || []).map((item) => text(item, 64)).filter(Boolean),
    metaBindingRevision: number(value.meta_binding_revision),
    provenance: text(value.provenance, 32),
    values: metricValues(value.values),
    rowCount: number(value.row_count),
    sourceLevel: text(value.source_level, 32),
    completeness: text(value.completeness, 32),
  };
};

const result = (input = {}) => {
  const value = plain(input);
  return {
    metric: text(value.metric, 64),
    directionality: text(value.directionality, 32),
    unit: text(value.unit, 16),
    baselineValue: number(value.baseline_value),
    followUpValue: number(value.follow_up_value),
    absoluteDelta: number(value.absolute_delta),
    relativeDelta: number(value.relative_delta),
    minimumEvidenceMet: value.minimum_evidence_met === true,
    material: value.material === true,
    classification: text(value.classification, 32),
    reasonCodes: (value.reason_codes || []).map((item) => text(item, 128)).filter(Boolean),
  };
};

const threshold = (input = {}) => {
  const value = plain(input);
  const pair = (item = {}) => ({
    relative: number(item.relative),
    absolute: number(item.absolute),
  });
  return {
    metric: text(value.metric, 64),
    directionality: text(value.directionality, 32),
    unit: text(value.unit, 16),
    materialImprovement: pair(value.material_improvement),
    materialWorsening: pair(value.material_worsening),
    noiseBoundary: {
      ...pair(value.noise_boundary),
      requiresBoth: value.noise_boundary?.requires_both === true,
    },
    minimumEvidence: {
      spend: number(value.minimum_evidence?.spend),
      impressions: number(value.minimum_evidence?.impressions),
      clicks: number(value.minimum_evidence?.clicks),
      conversions: number(value.minimum_evidence?.conversions),
    },
    requiresAttribution: value.requires_attribution === true,
    requiresConversionValue: value.requires_conversion_value === true,
  };
};

const confidence = (value) => ({
  confidenceLevel: text(value.confidence_level, 32) || "unavailable",
  confidenceScore: number(value.confidence_score),
  confidenceFactors: value.confidence_level
    ? (value.confidence_factors || []).map((item) => text(item, 128)).filter(Boolean)
    : ["legacy_confidence_unavailable"],
  confidenceVersion: number(value.confidence_version),
});

export const serializeEvaluationListItem = (input, { superseded = false } = {}) => {
  const value = plain(input);
  const primary = (value.metric_results || []).find((item) => item.metric === value.primary_metric);
  return {
    id: id(value._id),
    interventionId: id(value.intervention_id),
    issueId: id(value.issue_id),
    clientId: id(value.client_id),
    reportId: id(value.report_id_at_action),
    sourceReportRunId: id(value.source_report_run_id),
    sequence: number(value.sequence),
    actionType: text(value.action_type, 64),
    status: text(value.status, 32),
    effectiveStatus: superseded ? "superseded" : text(value.status, 32),
    primaryMetric: text(value.primary_metric, 64),
    watchedMetrics: (value.watched_metrics || []).map((item) => text(item, 64)).filter(Boolean),
    baselineValue: number(primary?.baseline_value),
    followUpValue: number(primary?.follow_up_value),
    absoluteDelta: number(primary?.absolute_delta),
    relativeDelta: number(primary?.relative_delta),
    observedResult: text(value.observed_result, 32),
    ...confidence(value),
    interpretability: text(value.interpretability, 32),
    reasonCodes: (value.reason_codes || []).map((item) => text(item, 128)).filter(Boolean),
    calculatedAt: date(value.calculated_at),
  };
};

export const serializeEvaluationDetail = (
  input,
  { superseded = false, supersededByEvaluationId = null, canRefresh = false } = {}
) => {
  const value = plain(input);
  return {
    ...serializeEvaluationListItem(value, { superseded }),
    agencyId: id(value.agency_id),
    metaAdAccountId: id(value.meta_ad_account_id),
    campaignId: text(value.campaign_id, 256),
    reportIdAtAction: id(value.report_id_at_action),
    schemaVersion: number(value.schema_version),
    ruleVersion: number(value.rule_version),
    evidenceVersion: number(value.evidence_version),
    normalizationVersion: number(value.normalization_version),
    triggerType: text(value.trigger_type, 32),
    intent: {
      mode: text(value.intent?.mode, 32),
      primaryMetric: text(value.intent?.primary_metric, 64),
      watchedMetrics: (value.intent?.watched_metrics || []).map((item) => text(item, 64)).filter(Boolean),
      resolutionSource: text(value.intent?.resolution_source, 64),
      ruleVersion: number(value.intent?.rule_version),
    },
    baseline: evidence(value.baseline),
    followUp: evidence(value.follow_up),
    metricResults: (value.metric_results || []).map(result),
    thresholdSnapshots: (value.threshold_snapshots || []).map(threshold),
    overlapInterventionIds: (value.overlap_intervention_ids || []).map(id).filter(Boolean),
    evidenceCompleteness: text(value.evidence_completeness, 32),
    summary: text(value.summary, 500),
    supersedesEvaluationId: id(value.supersedes_evaluation_id),
    supersededByEvaluationId: id(supersededByEvaluationId),
    invalidationContext: value.invalidation_context ? {
      reason: text(value.invalidation_context.reason, 64),
      invalidatedAt: date(value.invalidation_context.invalidated_at),
      sourceInterventionId: id(value.invalidation_context.source_intervention_id),
    } : null,
    canRefresh: canRefresh === true,
  };
};
