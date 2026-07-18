import {
  safeHistoricalDate,
  safeHistoricalNumber,
  safeHistoricalObjectId,
  safeHistoricalString,
} from "./historicalValueSanitizer.js";

const plain = (value) => value?.toObject?.({ depopulate: true }) || value || {};
const id = (value) => safeHistoricalObjectId(value);
const text = (value, maximum = 2000) => safeHistoricalString(value, maximum);
const date = (value) => safeHistoricalDate(value);
const number = (value) => safeHistoricalNumber(value);

export const serializeInterventionActionPayload = (input = {}) => {
  const value = plain(input);
  const result = {};
  if (value.budget_mode) result.mode = text(value.budget_mode, 16);
  if (typeof value.budget_amount === "number") result.amount = number(value.budget_amount);
  if (value.currency) result.currency = text(value.currency, 3);
  if (typeof value.asset_count === "number") result.assetCount = number(value.asset_count);
  if (value.change_summary) result.summary = text(value.change_summary, 500);
  if (value.targeting_dimension) result.dimension = text(value.targeting_dimension, 32);
  if (value.exclusion_type) result.exclusionType = text(value.exclusion_type, 32);
  if (value.bid_strategy) result.strategy = text(value.bid_strategy, 32);
  if (value.tracking_area) result.area = text(value.tracking_area, 32);
  if (value.other_label) result.label = text(value.other_label, 100);
  return result;
};

export const serializeInterventionActorSnapshot = (input) => {
  const value = plain(input);
  if (!value.display_name) return null;
  return {
    displayName: text(value.display_name, 256),
    workspaceRole: text(value.workspace_role, 32),
    provenance: text(value.provenance, 32),
    capturedAt: date(value.captured_at),
  };
};

const identity = (input, { external = false } = {}) => {
  const value = plain(input);
  return {
    id: typeof value.id === "string" ? text(value.id, 256) : id(value.id),
    name: text(value.name, 512),
    ...(external ? { externalAccountId: text(value.external_account_id, 256) } : {}),
    provenance: text(value.provenance, 32) || "unknown",
  };
};

export const serializeInterventionIssueSnapshot = (input = {}) => {
  const value = plain(input);
  return {
    version: number(value.version),
    capturedAt: date(value.captured_at),
    provenance: text(value.provenance, 32),
    title: text(value.title, 512),
    summary: text(value.summary),
    archetype: text(value.archetype, 128),
    metricFamily: text(value.metric_family, 128),
    status: text(value.status, 32),
    severity: text(value.severity, 32),
    trend: text(value.trend, 32),
    fingerprint: text(value.fingerprint, 64),
    fingerprintVersion: number(value.fingerprint_version),
    openedAt: date(value.opened_at),
    lastSeenAt: date(value.last_seen_at),
    resolvedAt: date(value.resolved_at),
    occurrenceCount: number(value.occurrence_count),
    reopenCount: number(value.reopen_count),
    latestSignalId: id(value.latest_signal_id),
    latestReportRunId: id(value.latest_report_run_id),
    lifecycleRevision: number(value.lifecycle_revision),
  };
};

export const serializeInterventionScopeSnapshot = (input = {}) => {
  const value = plain(input);
  return {
    version: number(value.version),
    capturedAt: date(value.captured_at),
    client: identity(value.client),
    metaAccount: identity(value.meta_account, { external: true }),
    campaign: identity(value.campaign),
    report: identity(value.report),
  };
};

export const serializeInterventionSignalSnapshot = (input = {}) => {
  const value = plain(input);
  return {
    id: id(value.id),
    reportId: id(value.report_id),
    reportRunId: id(value.report_run_id),
    type: text(value.type, 128),
    severity: text(value.severity, 32),
    title: text(value.title, 512),
    description: text(value.description),
    recommendation: text(value.recommendation),
    detectedAt: date(value.detected_at),
    matchedAt: date(value.matched_at),
    capturedAt: date(value.captured_at),
    provenance: text(value.provenance, 32),
  };
};

export const serializeInterventionCancellation = (input = {}) => {
  const value = plain(input);
  if (!value.cancelled_at) return null;
  return {
    reason: text(value.reason, 1000),
    cancelledAt: date(value.cancelled_at),
    cancelledByUserId: id(value.cancelled_by_user_id),
    cancelledBy: serializeInterventionActorSnapshot(value.cancelled_by_snapshot),
  };
};

export const serializeInterventionListItem = (input = {}) => {
  const value = plain(input);
  return {
    id: id(value._id),
    issueId: id(value.issue_id),
    clientId: id(value.client_id),
    metaAdAccountId: id(value.meta_ad_account_id),
    campaignId: text(value.campaign_id, 256),
    actionType: text(value.action_type, 64),
    actionVersion: number(value.action_version),
    evaluationIntent: value.evaluation_intent ? {
      mode: text(value.evaluation_intent.mode, 32),
      primaryMetric: text(value.evaluation_intent.primary_metric, 64),
      watchedMetrics: (value.evaluation_intent.watched_metrics || []).map((metric) => text(metric, 64)).filter(Boolean),
      resolutionSource: text(value.evaluation_intent.resolution_source, 64),
      ruleVersion: number(value.evaluation_intent.rule_version),
    } : null,
    actionPayload: serializeInterventionActionPayload(value.action_payload),
    reason: text(value.reason, 1000),
    note: text(value.note),
    performedAt: date(value.performed_at),
    recordedAt: date(value.recorded_at),
    performedBy: serializeInterventionActorSnapshot(value.performed_by_snapshot),
    recordedBy: serializeInterventionActorSnapshot(value.recorded_by_snapshot),
    status: text(value.status, 32),
    supersedesInterventionId: id(value.supersedes_intervention_id),
    supersededByInterventionId: id(value.superseded_by_intervention_id),
    correctedAt: date(value.corrected_at),
    cancellation: serializeInterventionCancellation(value.cancellation),
    revision: number(value.revision),
    createdAt: date(value.createdAt),
    updatedAt: date(value.updatedAt),
  };
};

export const serializeInterventionDetail = (input, { permissions = {} } = {}) => {
  const value = plain(input);
  return {
    ...serializeInterventionListItem(value),
    reportIdAtAction: id(value.report_id_at_action),
    reportRunIdAtAction: id(value.report_run_id_at_action),
    performedByUserId: id(value.performed_by_user_id),
    recordedByUserId: id(value.recorded_by_user_id),
    performedBy: serializeInterventionActorSnapshot(value.performed_by_snapshot),
    recordedBy: serializeInterventionActorSnapshot(value.recorded_by_snapshot),
    correctedByUserId: id(value.corrected_by_user_id),
    correctedBy: serializeInterventionActorSnapshot(value.corrected_by_snapshot),
    issueFingerprintSnapshot: text(value.issue_fingerprint_snapshot, 64),
    issueSnapshot: serializeInterventionIssueSnapshot(value.issue_snapshot),
    scopeSnapshot: serializeInterventionScopeSnapshot(value.scope_snapshot),
    latestSignalSnapshot: serializeInterventionSignalSnapshot(value.latest_signal_snapshot),
    permissions: {
      canCorrect: permissions.canCorrect === true,
      canCancel: permissions.canCancel === true,
    },
  };
};
