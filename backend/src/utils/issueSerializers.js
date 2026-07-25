import {
  safeHistoricalDate,
  safeHistoricalNumber,
  safeHistoricalObjectId,
  safeHistoricalString,
} from "./historicalValueSanitizer.js";

const id = (value) => safeHistoricalObjectId(value);
const text = (value, maximum = 2000) => safeHistoricalString(value, maximum);
const date = (value) => safeHistoricalDate(value);

const snapshotName = (signal, path) => {
  const parts = path.split(".");
  let value = signal?.context_snapshot;
  for (const part of parts) value = value?.[part];
  return text(value, 512);
};

const identityValue = ({ snapshot, current }) => {
  if (snapshot) return { value: snapshot, provenance: "snapshot" };
  if (current) return { value: text(current, 512), provenance: "current_parent" };
  return { value: null, provenance: "unknown" };
};

export const serializeIssueEvidence = (evidence = {}) => ({
  kind: text(evidence.kind, 64),
  signalId: id(evidence.signal_id),
  reportRunId: id(evidence.report_run_id),
  observedAt: date(evidence.observed_at),
  severity: text(evidence.severity, 32),
  title: text(evidence.title, 512),
  summary: text(evidence.summary),
  primaryMetric: text(evidence.primary_metric, 128),
  delta: safeHistoricalNumber(evidence.delta),
  provenance: ["snapshot", "current_parent", "unknown"].includes(
    evidence.provenance
  )
    ? evidence.provenance
    : "unknown",
});

export const serializeIssueIdentity = (
  issue,
  { signal = null, client = null, report = null, metaAccount = null } = {}
) => {
  const campaignId = text(issue?.scope?.entity?.campaign_id, 256);
  const snapshotCampaign = signal?.context_snapshot?.campaigns?.find(
    (campaign) => String(campaign?.campaign_id) === campaignId
  );
  return {
    client: identityValue({
      snapshot: snapshotName(signal, "client.name"),
      current: client?.name,
    }),
    report: identityValue({
      snapshot: snapshotName(signal, "report.name"),
      current: report?.name,
    }),
    metaAccount: identityValue({
      snapshot: snapshotName(signal, "meta_account.name"),
      current: metaAccount?.name,
    }),
    campaign: {
      id: campaignId,
      ...identityValue({
        snapshot: snapshotCampaign?.campaign_name,
        current: null,
      }),
    },
  };
};

export const serializeIssueListItem = (issue, parents = {}) => ({
  id: id(issue._id),
  clientId: id(issue.client_id),
  metaAdAccountId: id(issue.meta_ad_account_id),
  fingerprint: text(issue.fingerprint, 64),
  fingerprintVersion: safeHistoricalNumber(issue.fingerprint_version),
  status: text(issue.status, 32),
  severity: text(issue.current_severity, 32),
  previousSeverity: text(issue.previous_severity, 32),
  trend: text(issue.trend, 32),
  title: text(issue.title, 512),
  summary: text(issue.summary),
  archetype: text(issue.archetype, 128),
  metricFamily: text(issue.metric_family, 128),
  occurrenceCount: safeHistoricalNumber(issue.occurrence_count),
  reopenCount: safeHistoricalNumber(issue.reopen_count),
  absenceStreak: safeHistoricalNumber(issue.absence_streak),
  openedAt: date(issue.opened_at),
  lastSeenAt: date(issue.last_seen_at),
  resolvedAt: date(issue.resolved_at),
  identity: serializeIssueIdentity(issue, parents),
  latestEvidence: serializeIssueEvidence(issue.latest_evidence),
});

export const serializeIssueDetail = (issue, parents = {}) => ({
  ...serializeIssueListItem(issue, parents),
  reportIds: (
    issue.recent_report_ids?.length
      ? issue.recent_report_ids
      : issue.report_ids || []
  ).slice(-25).map(id).filter(Boolean),
  originReportId: id(issue.origin_report_id),
  latestReportId: id(issue.latest_report_id),
  firstSignalId: id(issue.first_signal_id),
  latestSignalId: id(issue.latest_signal_id),
  latestReportRunId: id(issue.latest_report_run_id),
  predecessorIssueId: id(issue.predecessor_issue_id),
  reopenCount: safeHistoricalNumber(issue.reopen_count),
  reopenedAt: date(issue.reopened_at),
  lifecycleRevision: safeHistoricalNumber(issue.lifecycle_revision),
  latestInterventionId: id(issue.latest_intervention_id),
  interventionCount: safeHistoricalNumber(issue.intervention_count) || 0,
  lastInterventionAt: date(issue.last_intervention_at),
  interventionRevision: safeHistoricalNumber(issue.intervention_revision) || 0,
  monitoringStartedAt: date(issue.monitoring_started_at),
  monitoringReason: text(issue.monitoring_reason, 64),
  monitoringInterventionId: id(issue.monitoring_intervention_id),
  worseningStreak: safeHistoricalNumber(issue.worsening_streak) || 0,
  worseningMetric: text(issue.worsening_metric, 128),
  worseningStartedAt: date(issue.worsening_started_at),
  latestEvaluationId: id(issue.latest_evaluation_id),
  latestEvaluationStatus: text(issue.latest_evaluation_status, 32),
  latestEvaluationResult: text(issue.latest_evaluation_result, 32),
  latestEvaluationConfidence: text(issue.latest_evaluation_confidence, 32),
  latestEvaluationAt: date(issue.latest_evaluation_at),
  scope: {
    version: safeHistoricalNumber(issue?.scope?.version),
    entity: {
      level: text(issue?.scope?.entity?.level, 32),
      id: text(issue?.scope?.entity?.id, 256),
      campaignId: text(issue?.scope?.entity?.campaign_id, 256),
      adsetId: text(issue?.scope?.entity?.adset_id, 256),
      adId: text(issue?.scope?.entity?.ad_id, 256),
    },
    classification: {
      archetype: text(issue?.scope?.classification?.archetype, 128),
      metricFamily: text(issue?.scope?.classification?.metric_family, 128),
    },
    comparison: {
      cadence: text(issue?.scope?.comparison?.cadence, 32),
      timezone: text(issue?.scope?.comparison?.timezone, 128),
    },
  },
  createdAt: date(issue.createdAt),
  updatedAt: date(issue.updatedAt),
});

export const serializeIssueSignalOccurrence = (signal) => ({
  id: id(signal._id),
  issueId: id(signal.issue_id),
  reportId: id(signal.report_id),
  reportRunId: id(signal.report_run_id),
  occurrenceNumber: safeHistoricalNumber(signal.issue_occurrence_number),
  fingerprintSnapshot: text(signal.issue_fingerprint_snapshot, 64),
  matchingStatus: signal.issue_matching_status || "legacy_ungrouped",
  matchingReason: text(signal.issue_matching_reason, 128),
  type: text(signal.type, 128),
  severity: text(signal.severity, 32),
  title: text(signal.title, 512),
  description: text(signal.description),
  recommendation: text(signal.recommendation),
  campaignId: text(signal.campaign_id, 256),
  detectedAt: date(signal.detected_at),
  matchedAt: date(signal.matched_at),
});
