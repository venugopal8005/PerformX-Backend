import crypto from "node:crypto";
import mongoose from "mongoose";

import {
  Client,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
} from "../models/index.js";
import {
  ISSUE_CLAIM_LEASE_MS,
  ISSUE_ERROR_CODE,
  ISSUE_ERROR_MESSAGE_MAX,
  ISSUE_FINGERPRINT_VERSION,
  ISSUE_MATCHING_VERSION,
  ISSUE_RECENT_REPORT_IDS_LIMIT,
  ISSUE_REASON,
  ISSUE_RECURRENCE_MS,
  ISSUE_SEVERITIES,
  ISSUE_TRANSACTION_RETRY_COUNT,
  issueProcessingKey,
  trendForSeverity,
} from "../domain/phase2Issue.domain.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";
import {
  assertPhase2IssueIntegrityReady,
} from "./phase2IssueIndexes.service.js";
import {
  buildCanonicalIssueObservationScope,
  buildCanonicalSignalIssueScope,
  createIssueScopeIntegrityError,
} from "./signalIssueScope.service.js";
import {
  assertIssueFingerprintScopeMatch,
  buildIssueFingerprint,
} from "./signalFingerprint.service.js";
import {
  buildIssueObservationKey,
  classifyCleanIssueObservation,
  classifyIssueObservationOrder,
  classifyPostInterventionBadObservation,
} from "./issueObservation.service.js";
import {
  normalizeMetaBindingRevision,
  readPersistedMetaBindingRevision,
  requirePermittedWorkspaceConnection,
} from "./metaAccountBinding.service.js";
import { projectIssueReview, projectSourceSafely } from "./reviewProjection.service.js";

const TERMINAL_PROCESSING_STATUSES = new Set([
  "completed",
  "ineligible",
  "not_applicable",
]);

const defaultModels = {
  Client,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
};

const bounded = (value, maximum = ISSUE_ERROR_MESSAGE_MAX) =>
  String(value || "").slice(0, maximum) || null;
const sameId = (left, right) => String(left) === String(right);
const validObjectId = (value) => mongoose.isObjectIdOrHexString(value);
const asPlain = (value) => value?.toObject?.({ depopulate: true }) || value;
const OPERATIONALLY_UNAVAILABLE_META_CODES = new Set([
  "META_ACCOUNT_INACCESSIBLE",
  "META_NOT_CONNECTED",
  "META_RECONNECT_REQUIRED",
]);

const applySession = (query, session) =>
  session && typeof query?.session === "function" ? query.session(session) : query;

const createIntegrityError = (code, message, reason = null) => {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.reason = reason;
  error.issueIntegrityFailure = true;
  return error;
};

const isRetryableTransactionError = (error) =>
  error?.code === 11000 ||
  [112, 244, 251].includes(error?.code) ||
  error?.hasErrorLabel?.("TransientTransactionError") ||
  error?.hasErrorLabel?.("UnknownTransactionCommitResult");

const validateSeverity = (value) =>
  ISSUE_SEVERITIES.includes(value) ? value : "stable";

const primaryEvidence = (signal) => ({
  kind: "signal",
  signal_id: signal._id,
  report_run_id: signal.report_run_id,
  observed_at: signal.detected_at || signal.createdAt || new Date(),
  severity: validateSeverity(signal.severity),
  title: bounded(signal.title, 512),
  summary: bounded(signal.description, 2000),
  primary_metric: bounded(signal?.metadata?.primary_anomaly?.metric, 128),
  delta: Number.isFinite(Number(signal?.metadata?.primary_anomaly?.delta))
    ? Number(signal.metadata.primary_anomaly.delta)
    : null,
  provenance: signal.context_snapshot ? "snapshot" : "unknown",
});

const recentReportIdsForIssue = (issue) => {
  const recent = Array.isArray(issue.recent_report_ids)
    ? issue.recent_report_ids
    : [];
  if (recent.length) return recent;
  return Array.isArray(issue.report_ids) ? issue.report_ids : [];
};

const appendRecentReportId = (issue, reportId) => {
  const values = [
    ...recentReportIdsForIssue(issue).map(String),
    String(reportId),
  ];
  issue.recent_report_ids = [...new Set(values)].slice(
    -ISSUE_RECENT_REPORT_IDS_LIMIT
  );
};

const cleanEvidence = ({ issue, reportRun, observedAt }) => ({
  kind: "clean_observation",
  signal_id: null,
  report_run_id: reportRun._id,
  observed_at: observedAt,
  severity: "stable",
  title: issue.title,
  summary: "A trustworthy comparison window showed no matching issue signal.",
  primary_metric: null,
  delta: null,
  provenance: reportRun.context_snapshot ? "snapshot" : "unknown",
});

export const isOperationalReportForIssueRecovery = ({ report, client } = {}) =>
  Boolean(
    report &&
      client &&
      report.status === "active" &&
      report.is_archived !== true &&
      client.is_archived !== true
  );

export const validatePersistedIssueParents = async ({ reportRun, Models, session }) => {
  const [report, client, account] = await Promise.all([
    applySession(
      Models.Report.findOne({
        _id: reportRun.report_id,
        agency_id: reportRun.agency_id,
      }),
      session
    ),
    applySession(
      Models.Client.findOne({
        _id: reportRun.client_id,
        agency_id: reportRun.agency_id,
      }),
      session
    ),
    applySession(
      Models.MetaAdAccount.findOne({
        _id: reportRun.meta_ad_account_id,
        agency_id: reportRun.agency_id,
      }),
      session
    ),
  ]);

  if (!report || !client || !account) {
    throw createIssueScopeIntegrityError(ISSUE_REASON.OWNERSHIP_CONFLICT, {
      field: !report ? "report_id" : !client ? "client_id" : "meta_ad_account_id",
    });
  }
  if (
    !validObjectId(report.client_id) ||
    !validObjectId(report.meta_ad_account_id) ||
    !validObjectId(account.client_id) ||
    !sameId(report.client_id, reportRun.client_id) ||
    !sameId(report.meta_ad_account_id, reportRun.meta_ad_account_id) ||
    !sameId(account.client_id, reportRun.client_id)
  ) {
    throw createIssueScopeIntegrityError(ISSUE_REASON.OWNERSHIP_CONFLICT);
  }

  const reportOperational = isOperationalReportForIssueRecovery({ report, client });
  let referencedConnection = null;
  if (account.meta_connection_id) {
    referencedConnection = await applySession(
      Models.MetaConnection.findById(account.meta_connection_id),
      session
    );
  }
  if (
    referencedConnection &&
    !sameId(referencedConnection.agency_id, reportRun.agency_id)
  ) {
    throw createIssueScopeIntegrityError(ISSUE_REASON.OWNERSHIP_CONFLICT, {
      field: "meta_connection_id",
    });
  }

  const validatedAt = new Date(reportRun.meta_binding_performance_validated_at);
  if (!reportRun.meta_binding_performance_validated_at || Number.isNaN(validatedAt.getTime())) {
    return {
      report,
      client,
      account,
      connection: referencedConnection,
      operationalAuthority: false,
      operationalAuthorityReason: "meta_performance_evidence_not_validated",
      reportOperational,
      archived: report.is_archived === true || client.is_archived === true,
    };
  }

  let expectedBindingRevision;
  let persistedBindingRevision;
  try {
    expectedBindingRevision = normalizeMetaBindingRevision(
      reportRun.meta_binding_revision_snapshot
    );
    ({ revision: persistedBindingRevision } = await readPersistedMetaBindingRevision({
      accountId: reportRun.meta_ad_account_id,
      agencyId: reportRun.agency_id,
      session,
      MetaAdAccountModel: Models.MetaAdAccount,
    }));
  } catch (error) {
    throw createIntegrityError(
      error?.code || "META_BINDING_REVISION_INVALID",
      error?.message || "The persisted Meta binding evidence is invalid.",
      error?.reason || "meta_binding_revision_invalid"
    );
  }
  if (persistedBindingRevision !== expectedBindingRevision) {
    throw createIntegrityError(
      "META_ACCOUNT_ASSIGNMENT_CHANGED",
      "The Meta ad account assignment changed after report evidence was validated.",
      "meta_account_assignment_changed"
    );
  }

  if (account.is_active !== true || account.is_accessible !== true) {
    return {
      report,
      client,
      account,
      connection: referencedConnection,
      operationalAuthority: false,
      operationalAuthorityReason: "meta_account_inaccessible",
      reportOperational,
      archived: report.is_archived === true || client.is_archived === true,
    };
  }

  let connection = null;
  let operationalAuthority = false;
  let operationalAuthorityReason = null;
  try {
    ({ connection } = await requirePermittedWorkspaceConnection({
      account,
      agencyId: reportRun.agency_id,
      session,
      includeToken: false,
      MetaConnectionModel: Models.MetaConnection,
    }));
    operationalAuthority = true;
  } catch (error) {
    if (!OPERATIONALLY_UNAVAILABLE_META_CODES.has(error?.code)) {
      throw createIntegrityError(
        error?.code || ISSUE_ERROR_CODE.OWNERSHIP_CONFLICT,
        error?.message || "Meta authority validation failed.",
        error?.reason || ISSUE_REASON.OWNERSHIP_CONFLICT
      );
    }
    operationalAuthorityReason = bounded(
      error.reason || "workspace_meta_connection_invalid"
    );
  }

  return {
    report,
    client,
    account,
    connection,
    operationalAuthority,
    operationalAuthorityReason,
    reportOperational,
    archived: report.is_archived === true || client.is_archived === true,
  };
};

export const claimReportRunIssueProcessing = async ({
  reportRunId,
  now = new Date(),
  ReportRunModel = ReportRun,
} = {}) => {
  const existing = await ReportRunModel.findById(reportRunId).select(
    "+issue_processing.claim_token"
  );
  if (!existing) {
    const error = new Error("ReportRun not found for Issue processing.");
    error.code = "ISSUE_REPORT_RUN_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  const currentStatus = existing.issue_processing?.status;
  if (TERMINAL_PROCESSING_STATUSES.has(currentStatus)) {
    return { acquired: false, terminal: true, reportRun: existing, token: null };
  }
  if (currentStatus === "failed_integrity") {
    throw createIntegrityError(
      existing.issue_processing.failure_code || "ISSUE_PROCESSING_FAILED_INTEGRITY",
      existing.issue_processing.failure_message || "Issue processing previously failed integrity checks."
    );
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + ISSUE_CLAIM_LEASE_MS);
  const claimed = await ReportRunModel.findOneAndUpdate(
    {
      _id: reportRunId,
      $or: [
        { issue_processing: { $exists: false } },
        { issue_processing: null },
        { "issue_processing.status": { $in: ["pending", "failed_retryable"] } },
        {
          "issue_processing.status": "processing",
          "issue_processing.claim_expires_at": { $lte: now },
        },
      ],
    },
    {
      $set: {
        "issue_processing.processing_key": issueProcessingKey(reportRunId),
        "issue_processing.version": ISSUE_MATCHING_VERSION,
        "issue_processing.status": "processing",
        "issue_processing.claim_token": token,
        "issue_processing.claimed_at": now,
        "issue_processing.claim_expires_at": expiresAt,
        "issue_processing.completed_at": null,
        "issue_processing.failure_code": null,
        "issue_processing.failure_message": null,
        "issue_processing.result_classification": null,
        "issue_processing.issue_id": null,
      },
      $inc: { "issue_processing.attempts": 1 },
    },
    { new: true }
  ).select("+issue_processing.claim_token");

  if (claimed) return { acquired: true, terminal: false, reportRun: claimed, token, expiresAt };
  const current = await ReportRunModel.findById(reportRunId).select(
    "+issue_processing.claim_token"
  );
  return { acquired: false, terminal: false, reportRun: current, token: null };
};

const completeProcessing = async ({
  reportRunId,
  token,
  status,
  classification,
  issueId = null,
  now,
  session,
  ReportRunModel,
}) => {
  const leaseCheckAt = new Date();
  const updated = await ReportRunModel.findOneAndUpdate(
    {
      _id: reportRunId,
      "issue_processing.status": "processing",
      "issue_processing.claim_token": token,
      "issue_processing.claim_expires_at": { $gt: leaseCheckAt },
    },
    {
      $set: {
        "issue_processing.status": status,
        "issue_processing.claim_token": null,
        "issue_processing.claim_expires_at": null,
        "issue_processing.completed_at": now,
        "issue_processing.failure_code": null,
        "issue_processing.failure_message": null,
        "issue_processing.result_classification": classification,
        "issue_processing.issue_id": issueId,
      },
    },
    { new: true, session }
  );
  if (updated) return updated;
  throw createIntegrityError(
    ISSUE_ERROR_CODE.CLAIM_LOST,
    "Issue processing claim expired or changed before completion.",
    ISSUE_REASON.CLAIM_LOST
  );
};

const markProcessingFailure = async ({
  reportRunId,
  token,
  status,
  error,
  ReportRunModel,
}) => {
  const leaseCheckAt = new Date();
  return ReportRunModel.updateOne(
    {
      _id: reportRunId,
      "issue_processing.status": "processing",
      "issue_processing.claim_token": token,
      "issue_processing.claim_expires_at": { $gt: leaseCheckAt },
    },
    {
      $set: {
        "issue_processing.status": status,
        "issue_processing.claim_token": null,
        "issue_processing.claim_expires_at": null,
        "issue_processing.failure_code": bounded(error?.code, 128),
        "issue_processing.failure_message": bounded(error?.message),
        "issue_processing.result_classification": status,
      },
    }
  );
};

const markRunSignalsFailed = async ({ reportRunId, error, SignalModel }) =>
  SignalModel.updateMany(
    {
      report_run_id: reportRunId,
      $or: [{ issue_id: null }, { issue_id: { $exists: false } }],
    },
    {
      $set: {
        issue_matching_status: "failed",
        issue_matching_reason: bounded(error?.reason || error?.code, 128),
        matching_version: ISSUE_MATCHING_VERSION,
      },
    },
    { overwriteImmutable: true }
  );

const markSignalIneligible = async ({ signal, reason, session, SignalModel }) => {
  if (!signal?._id) return;
  await SignalModel.updateOne(
    { _id: signal._id, $or: [{ issue_id: null }, { issue_id: { $exists: false } }] },
    {
      $set: {
        issue_matching_status: "ineligible",
        issue_matching_reason: bounded(reason, 128),
        matching_version: ISSUE_MATCHING_VERSION,
      },
    },
    { session, overwriteImmutable: true }
  );
};

const activeIssueQuery = ({ scopeResult, fingerprint }) => ({
  agency_id: scopeResult.lineage.agencyId,
  client_id: scopeResult.lineage.clientId,
  fingerprint_version: ISSUE_FINGERPRINT_VERSION,
  active_fingerprint: fingerprint,
  status: { $in: ["open", "monitoring"] },
});

const historyIssueQuery = ({ scopeResult, fingerprint }) => ({
  agency_id: scopeResult.lineage.agencyId,
  client_id: scopeResult.lineage.clientId,
  fingerprint_version: ISSUE_FINGERPRINT_VERSION,
  fingerprint,
});

const assertIssueOwnership = ({ issue, scopeResult, fingerprint }) => {
  if (
    !sameId(issue.agency_id, scopeResult.lineage.agencyId) ||
    !sameId(issue.client_id, scopeResult.lineage.clientId) ||
    !sameId(issue.meta_ad_account_id, scopeResult.lineage.metaAccountId)
  ) {
    throw createIntegrityError(
      "ISSUE_OWNERSHIP_CONFLICT",
      "Issue ownership conflicts with Signal scope.",
      ISSUE_REASON.ISSUE_OWNERSHIP_CONFLICT
    );
  }
  assertIssueFingerprintScopeMatch({
    expectedScope: scopeResult.scope,
    actualScope: issue.scope,
    fingerprint,
  });
};

const assertPersistedIssueLineage = async ({ issue, Models, session }) => {
  const reportIds = [...new Set(recentReportIdsForIssue(issue).map(String))];
  const [firstSignal, latestSignal, latestRun, ownedReportCount] = await Promise.all([
    applySession(
      Models.Signal.findOne({
        _id: issue.first_signal_id,
        agency_id: issue.agency_id,
        client_id: issue.client_id,
      }),
      session
    ),
    applySession(
      Models.Signal.findOne({
        _id: issue.latest_signal_id,
        agency_id: issue.agency_id,
        client_id: issue.client_id,
      }),
      session
    ),
    applySession(
      Models.ReportRun.findOne({
        _id: issue.latest_report_run_id,
        agency_id: issue.agency_id,
        client_id: issue.client_id,
        meta_ad_account_id: issue.meta_ad_account_id,
      }),
      session
    ),
    applySession(
      Models.Report.countDocuments({
        _id: { $in: reportIds },
        agency_id: issue.agency_id,
        client_id: issue.client_id,
      }),
      session
    ),
  ]);
  if (
    !firstSignal ||
    !latestSignal ||
    !latestRun ||
    ownedReportCount !== reportIds.length ||
    !sameId(firstSignal.report_id, issue.origin_report_id) ||
    !sameId(latestSignal.report_id, issue.latest_report_id) ||
    !reportIds.includes(String(issue.latest_report_id))
  ) {
    throw createIntegrityError(
      ISSUE_ERROR_CODE.OWNERSHIP_CONFLICT,
      "Persisted Issue lineage conflicts with its ownership scope.",
      ISSUE_REASON.ISSUE_OWNERSHIP_CONFLICT
    );
  }
};

const setCurrentOccurrence = ({ issue, signal, reportRun, observation }) => {
  const previousSeverity = issue.current_severity;
  const currentSeverity = validateSeverity(signal.severity);
  issue.previous_severity = previousSeverity;
  issue.current_severity = currentSeverity;
  issue.trend = trendForSeverity(previousSeverity, currentSeverity);
  issue.status = currentSeverity === "stable" ? "monitoring" : "open";
  issue.active_fingerprint = issue.fingerprint;
  issue.resolved_at = null;
  issue.last_seen_at = signal.detected_at || signal.createdAt || new Date();
  issue.latest_signal_id = signal._id;
  issue.latest_report_run_id = reportRun._id;
  issue.latest_report_id = signal.report_id;
  appendRecentReportId(issue, signal.report_id);
  issue.title = bounded(signal.title, 512) || issue.title;
  issue.summary = bounded(signal.description, 2000);
  issue.latest_evidence = primaryEvidence(signal);
  issue.absence_streak = 0;
  issue.worsening_streak = 0;
  issue.worsening_metric = null;
  issue.worsening_started_at = null;
  issue.last_observation_key = observation.key;
  issue.last_observation_end = observation.window.endDate;
  issue.lifecycle_revision += 1;
};

const trackPostInterventionBadObservation = ({ issue, signal, reportRun, observation, policy, now }) => {
  const previousSeverity = issue.current_severity;
  const observedAt = signal.detected_at || signal.createdAt || now;
  const continuing = policy.eligibleForStreak && issue.worsening_metric === policy.metric;
  issue.worsening_streak = policy.eligibleForStreak ? (continuing ? issue.worsening_streak + 1 : 1) : 0;
  issue.worsening_metric = policy.eligibleForStreak ? policy.metric : null;
  issue.worsening_started_at = policy.eligibleForStreak
    ? continuing ? issue.worsening_started_at || observedAt : observedAt
    : null;
  issue.previous_severity = previousSeverity;
  issue.current_severity = validateSeverity(signal.severity);
  issue.trend = trendForSeverity(previousSeverity, issue.current_severity);
  issue.last_seen_at = observedAt;
  issue.latest_signal_id = signal._id;
  issue.latest_report_run_id = reportRun._id;
  issue.latest_report_id = signal.report_id;
  appendRecentReportId(issue, signal.report_id);
  issue.title = bounded(signal.title, 512) || issue.title;
  issue.summary = bounded(signal.description, 2000);
  issue.latest_evidence = primaryEvidence(signal);
  issue.absence_streak = 0;
  issue.last_observation_key = observation.key;
  issue.last_observation_end = observation.window.endDate;
  issue.lifecycle_revision += 1;

  const shouldOpen = policy.criticalImmediate || issue.worsening_streak >= policy.requiredConsecutive;
  if (shouldOpen) {
    const wasResolved = issue.status === "resolved";
    issue.status = "open";
    issue.active_fingerprint = issue.fingerprint;
    issue.resolved_at = null;
    if (wasResolved) {
      issue.reopen_count += 1;
      issue.reopened_at = observedAt;
    }
  }
  return shouldOpen;
};

const createIssueDocument = ({
  scopeResult,
  fingerprintResult,
  signal,
  reportRun,
  observation,
  predecessorIssueId = null,
}) => ({
  agency_id: scopeResult.lineage.agencyId,
  client_id: scopeResult.lineage.clientId,
  meta_ad_account_id: scopeResult.lineage.metaAccountId,
  fingerprint: fingerprintResult.fingerprint,
  fingerprint_version: fingerprintResult.fingerprintVersion,
  active_fingerprint: fingerprintResult.fingerprint,
  scope: scopeResult.scope,
  archetype: scopeResult.scope.classification.archetype,
  metric_family: scopeResult.scope.classification.metric_family,
  origin_report_id: signal.report_id,
  latest_report_id: signal.report_id,
  recent_report_ids: [signal.report_id],
  status: validateSeverity(signal.severity) === "stable" ? "monitoring" : "open",
  opened_at: signal.detected_at || signal.createdAt || new Date(),
  last_seen_at: signal.detected_at || signal.createdAt || new Date(),
  resolved_at: null,
  reopened_at: null,
  reopen_count: 0,
  occurrence_count: 1,
  first_signal_id: signal._id,
  latest_signal_id: signal._id,
  latest_report_run_id: reportRun._id,
  current_severity: validateSeverity(signal.severity),
  previous_severity: null,
  trend: "unchanged",
  absence_streak: 0,
  worsening_streak: 0,
  worsening_metric: null,
  worsening_started_at: null,
  last_observation_key: observation.key,
  last_observation_end: observation.window.endDate,
  latest_evidence: primaryEvidence(signal),
  title: bounded(signal.title, 512) || "Performance issue",
  summary: bounded(signal.description, 2000),
  predecessor_issue_id: predecessorIssueId,
  lifecycle_revision: 0,
});

const linkSignal = async ({
  signal,
  issue,
  scopeResult,
  fingerprint,
  occurrenceNumber,
  matchedAt,
  session,
  SignalModel,
}) => {
  if (signal.issue_id) {
    if (
      sameId(signal.issue_id, issue._id) &&
      signal.issue_fingerprint_snapshot === fingerprint
    ) {
      return false;
    }
    throw createIntegrityError(
      ISSUE_ERROR_CODE.SIGNAL_ALREADY_LINKED,
      "Signal is already linked to another Issue.",
      ISSUE_REASON.SIGNAL_ALREADY_LINKED
    );
  }
  const result = await SignalModel.updateOne(
    {
      _id: signal._id,
      agency_id: scopeResult.lineage.agencyId,
      client_id: scopeResult.lineage.clientId,
      $or: [{ issue_id: null }, { issue_id: { $exists: false } }],
    },
    {
      $set: {
        scope: scopeResult.scope,
        fingerprint,
        fingerprint_version: ISSUE_FINGERPRINT_VERSION,
        issue_id: issue._id,
        issue_occurrence_number: occurrenceNumber,
        issue_fingerprint_snapshot: fingerprint,
        matched_at: matchedAt,
        matching_version: ISSUE_MATCHING_VERSION,
        issue_matching_status: "matched",
        issue_matching_reason: null,
      },
    },
    { session, overwriteImmutable: true }
  );
  if (result.modifiedCount === 1) return true;
  throw createIntegrityError(
    ISSUE_ERROR_CODE.SIGNAL_ALREADY_LINKED,
    "Signal lineage changed before Issue matching committed.",
    ISSUE_REASON.SIGNAL_ALREADY_LINKED
  );
};

export const processNegativeSignalTransaction = async ({
  reportRun,
  signal,
  token,
  parentState,
  Models,
  session,
  now,
  completeRunProcessing = true,
}) => {
  if (
    parentState?.operationalAuthority !== true ||
    parentState?.reportOperational !== true ||
    parentState?.archived === true
  ) {
    throw createIntegrityError(
      "ISSUE_OPERATIONAL_AUTHORITY_REQUIRED",
      "Negative Signal Issue mutation requires validated operational Meta authority.",
      parentState?.operationalAuthorityReason || ISSUE_REASON.PARENT_NOT_OPERATIONAL
    );
  }
  const scopeResult = buildCanonicalSignalIssueScope({ signal, reportRun });
  if (!scopeResult.eligible) {
    await markSignalIneligible({
      signal,
      reason: scopeResult.reason,
      session,
      SignalModel: Models.Signal,
    });
    if (completeRunProcessing) {
      await completeProcessing({
        reportRunId: reportRun._id,
        token,
        status: scopeResult.notApplicable ? "not_applicable" : "ineligible",
        classification: scopeResult.notApplicable ? "not_applicable" : "ineligible",
        now,
        session,
        ReportRunModel: Models.ReportRun,
      });
    }
    return { classification: scopeResult.notApplicable ? "not_applicable" : "ineligible", issue: null };
  }

  const fingerprintResult = buildIssueFingerprint(scopeResult.scope);
  const observation = buildIssueObservationKey({
    fingerprint: fingerprintResult.fingerprint,
    reportRun,
  });
  if (!observation) {
    await markSignalIneligible({ signal, reason: "comparison_window_invalid", session, SignalModel: Models.Signal });
    if (completeRunProcessing) {
      await completeProcessing({ reportRunId: reportRun._id, token, status: "ineligible", classification: "ineligible", now, session, ReportRunModel: Models.ReportRun });
    }
    return { classification: "ineligible", issue: null };
  }

  let issue = await applySession(
    Models.Issue.findOne(activeIssueQuery({ scopeResult, fingerprint: fingerprintResult.fingerprint })),
    session
  );
  let latestResolved = null;
  if (!issue) {
    latestResolved = await applySession(
      Models.Issue.findOne({
        ...historyIssueQuery({ scopeResult, fingerprint: fingerprintResult.fingerprint }),
        status: "resolved",
      }).sort({ resolved_at: -1, _id: -1 }),
      session
    );
  }
  const prior = issue || latestResolved;
  if (prior) {
    assertIssueOwnership({ issue: prior, scopeResult, fingerprint: fingerprintResult.fingerprint });
    await assertPersistedIssueLineage({ issue: prior, Models, session });
    const order = classifyIssueObservationOrder({ issue: prior, observation });
    if (["stale", "duplicate"].includes(order)) {
      if (
        order === "duplicate" &&
        signal.issue_id &&
        sameId(signal.issue_id, prior._id)
      ) {
        if (completeRunProcessing) {
          await completeProcessing({ reportRunId: reportRun._id, token, status: "completed", classification: "matched", issueId: prior._id, now, session, ReportRunModel: Models.ReportRun });
        }
        return { classification: "matched", issue: prior };
      }
      await markSignalIneligible({
        signal,
        reason: order === "stale" ? ISSUE_REASON.STALE_OBSERVATION : ISSUE_REASON.DUPLICATE_OBSERVATION,
        session,
        SignalModel: Models.Signal,
      });
      if (completeRunProcessing) {
        await completeProcessing({ reportRunId: reportRun._id, token, status: "ineligible", classification: "ineligible", now, session, ReportRunModel: Models.ReportRun });
      }
      return { classification: "ineligible", issue: null };
    }
  }

  let classification;
  if (issue) {
    issue.occurrence_count += 1;
    if (issue.status === "monitoring" && issue.latest_intervention_id) {
      const policy = classifyPostInterventionBadObservation({
        issue,
        signal,
        reportRun,
        observedAt: observation.window.endDate,
      });
      trackPostInterventionBadObservation({ issue, signal, reportRun, observation, policy, now });
    } else {
      setCurrentOccurrence({ issue, signal, reportRun, observation });
    }
    await issue.save({ session });
    classification = "matched";
  } else if (latestResolved) {
    const resolvedAt = new Date(latestResolved.resolved_at);
    const recurrenceAge = observation.window.endDate.getTime() - resolvedAt.getTime();
    if (recurrenceAge >= 0 && recurrenceAge <= ISSUE_RECURRENCE_MS) {
      issue = latestResolved;
      issue.occurrence_count += 1;
      if (issue.latest_intervention_id) {
        const policy = classifyPostInterventionBadObservation({
          issue,
          signal,
          reportRun,
          observedAt: observation.window.endDate,
        });
        const reopened = trackPostInterventionBadObservation({ issue, signal, reportRun, observation, policy, now });
        classification = reopened ? "reopened" : "matched";
      } else {
        issue.reopen_count += 1;
        issue.reopened_at = signal.detected_at || signal.createdAt || now;
        setCurrentOccurrence({ issue, signal, reportRun, observation });
        classification = "reopened";
      }
      await issue.save({ session });
    } else {
      [issue] = await Models.Issue.create(
        [createIssueDocument({ scopeResult, fingerprintResult, signal, reportRun, observation, predecessorIssueId: latestResolved._id })],
        { session }
      );
      classification = "successor_created";
    }
  } else {
    [issue] = await Models.Issue.create(
      [createIssueDocument({ scopeResult, fingerprintResult, signal, reportRun, observation })],
      { session }
    );
    classification = "created";
  }

  await linkSignal({
    signal,
    issue,
    scopeResult,
    fingerprint: fingerprintResult.fingerprint,
    occurrenceNumber: issue.occurrence_count,
    matchedAt: now,
    session,
    SignalModel: Models.Signal,
  });
  if (completeRunProcessing) {
    await completeProcessing({ reportRunId: reportRun._id, token, status: "completed", classification, issueId: issue._id, now, session, ReportRunModel: Models.ReportRun });
  }
  return { classification, issue };
};

const processCleanObservationTransaction = async ({
  reportRun,
  token,
  Models,
  session,
  now,
  parentState,
}) => {
  const base = buildCanonicalIssueObservationScope({ reportRun });
  if (
    !base.eligible ||
    !parentState.reportOperational ||
    !parentState.operationalAuthority
  ) {
    await completeProcessing({ reportRunId: reportRun._id, token, status: base.eligible ? "not_applicable" : "ineligible", classification: base.eligible ? "not_applicable" : "ineligible", now, session, ReportRunModel: Models.ReportRun });
    return { classification: base.eligible ? "not_applicable" : "ineligible", issues: [] };
  }

  const issues = await applySession(
    Models.Issue.find({
      agency_id: base.agencyId,
      client_id: base.clientId,
      meta_ad_account_id: base.metaAccountId,
      "scope.entity.level": "campaign",
      "scope.entity.campaign_id": base.campaignId,
      "scope.comparison.cadence": base.cadence,
      "scope.comparison.timezone": base.timezone,
      $or: [
        { status: { $in: ["open", "monitoring"] } },
        { status: "resolved", worsening_streak: { $gt: 0 } },
      ],
    }),
    session
  );
  if (!issues.length) {
    await completeProcessing({ reportRunId: reportRun._id, token, status: "not_applicable", classification: "not_applicable", now, session, ReportRunModel: Models.ReportRun });
    return { classification: "not_applicable", issues: [] };
  }

  const changed = [];
  for (const issue of issues) {
    const observation = buildIssueObservationKey({ fingerprint: issue.fingerprint, reportRun });
    if (!observation || classifyIssueObservationOrder({ issue, observation }) !== "newer") continue;
    const quality = classifyCleanIssueObservation({ reportRun, issue });
    if (!quality.trustedBase) continue;
    await assertPersistedIssueLineage({ issue, Models, session });

    issue.last_observation_key = observation.key;
    issue.last_observation_end = observation.window.endDate;
    issue.latest_report_run_id = reportRun._id;
    issue.lifecycle_revision += 1;
    issue.worsening_streak = 0;
    issue.worsening_metric = null;
    issue.worsening_started_at = null;
    if (!quality.clean) {
      issue.absence_streak = 0;
      await issue.save({ session });
      changed.push(issue);
      continue;
    }

    if (issue.status === "resolved") {
      await issue.save({ session });
      changed.push(issue);
      continue;
    }

    const previousSeverity = issue.current_severity;
    issue.previous_severity = previousSeverity;
    issue.current_severity = "stable";
    issue.trend = trendForSeverity(previousSeverity, "stable");
    issue.absence_streak += 1;
    issue.latest_evidence = cleanEvidence({
      issue,
      reportRun,
      observedAt: observation.window.endDate,
    });
    const evaluationSupportsResolution =
      !issue.monitoring_intervention_id ||
      (issue.latest_evaluation_status === "ready" &&
        issue.latest_evaluation_result === "improved" &&
        ["high", "medium"].includes(issue.latest_evaluation_confidence) &&
        issue.latest_evaluation_at &&
        (issue.monitoring_started_at || issue.last_intervention_at) &&
        new Date(issue.latest_evaluation_at) >= new Date(issue.monitoring_started_at || issue.last_intervention_at));
    if (issue.absence_streak >= 2 && evaluationSupportsResolution) {
      issue.status = "resolved";
      issue.resolved_at = observation.window.endDate;
      issue.active_fingerprint = null;
    } else {
      issue.status = "monitoring";
      issue.resolved_at = null;
      issue.active_fingerprint = issue.fingerprint;
      issue.monitoring_started_at ||= observation.window.endDate;
      issue.monitoring_reason ||= "clean_observation";
    }
    await issue.save({ session });
    changed.push(issue);
  }

  const classification = changed.length ? "clean_observation" : "not_applicable";
  await completeProcessing({ reportRunId: reportRun._id, token, status: changed.length ? "completed" : "not_applicable", classification, now, session, ReportRunModel: Models.ReportRun });
  return { classification, issues: changed };
};

export const runIssueMatchingTransaction = async ({
  reportRunId,
  token,
  Models,
  now,
  transactionRunner,
}) =>
  transactionRunner({
    unavailableCode: ISSUE_ERROR_CODE.TRANSACTION_REQUIRED,
    unavailableMessage: "Issue matching requires a transaction-capable database deployment.",
    work: async (session) => {
      const leaseCheckAt = new Date();
      const reportRun = await applySession(
        Models.ReportRun.findOne({
          _id: reportRunId,
          "issue_processing.status": "processing",
          "issue_processing.claim_token": token,
          "issue_processing.claim_expires_at": { $gt: leaseCheckAt },
        }).select("+issue_processing.claim_token"),
        session
      );
      if (!reportRun) {
        throw createIntegrityError(ISSUE_ERROR_CODE.CLAIM_LOST, "Issue processing claim is no longer valid.", ISSUE_REASON.CLAIM_LOST);
      }

      const parentState = await validatePersistedIssueParents({ reportRun, Models, session });
      const signals = await applySession(
        Models.Signal.find({ report_run_id: reportRunId }).sort({ detected_at: 1, _id: 1 }),
        session
      );
      for (const signal of signals) {
        // Validate persisted Signal ownership before operational-state handling so
        // a contradictory lineage can never be downgraded to ordinary ineligibility.
        buildCanonicalSignalIssueScope({ signal, reportRun });
      }
      if (parentState.archived) {
        for (const signal of signals) {
          await markSignalIneligible({
            signal,
            reason: ISSUE_REASON.PARENT_ARCHIVED,
            session,
            SignalModel: Models.Signal,
          });
        }
        await completeProcessing({ reportRunId, token, status: "not_applicable", classification: "not_applicable", now, session, ReportRunModel: Models.ReportRun });
        return { classification: "not_applicable", issue: null };
      }
      if (signals.length) {
        if (!parentState.reportOperational || !parentState.operationalAuthority) {
          for (const signal of signals) {
            await markSignalIneligible({
              signal,
              reason: !parentState.reportOperational
                ? ISSUE_REASON.PARENT_NOT_OPERATIONAL
                : parentState.operationalAuthorityReason,
              session,
              SignalModel: Models.Signal,
            });
          }
          await completeProcessing({
            reportRunId,
            token,
            status: "ineligible",
            classification: "ineligible",
            now,
            session,
            ReportRunModel: Models.ReportRun,
          });
          return { classification: "ineligible", issue: null };
        }

        const outcomes = [];
        for (const signal of signals) {
          outcomes.push(
            await processNegativeSignalTransaction({
              reportRun,
              signal,
              token,
              parentState,
              Models,
              session,
              now,
              completeRunProcessing: false,
            })
          );
        }
        const issues = [
          ...new Map(
            outcomes
              .filter((outcome) => outcome.issue?._id)
              .map((outcome) => [String(outcome.issue._id), outcome.issue])
          ).values(),
        ];
        const successful = outcomes.filter((outcome) => outcome.issue);
        const classification =
          successful.length === 0
            ? outcomes.some((outcome) => outcome.classification === "ineligible")
              ? "ineligible"
              : "not_applicable"
            : successful.length === 1
              ? successful[0].classification
              : "matched";
        await completeProcessing({
          reportRunId,
          token,
          status: successful.length ? "completed" : classification,
          classification,
          issueId: issues.length === 1 ? issues[0]._id : null,
          now,
          session,
          ReportRunModel: Models.ReportRun,
        });
        return {
          classification,
          issue: issues.length === 1 ? issues[0] : null,
          issues,
          outcomes,
        };
      }
      return processCleanObservationTransaction({ reportRun, token, Models, session, now, parentState });
    },
  });

export const processReportRunIssues = async ({
  reportRunId,
  now = new Date(),
  Models = defaultModels,
  transactionRunner = runRequiredTransaction,
  reviewProcessor = projectIssueReview,
} = {}) => {
  assertPhase2IssueIntegrityReady();

  const claim = await claimReportRunIssueProcessing({
    reportRunId,
    now,
    ReportRunModel: Models.ReportRun,
  });
  if (claim.terminal) {
    return {
      skipped: true,
      classification: claim.reportRun.issue_processing?.result_classification || "not_applicable",
      issueId: claim.reportRun.issue_processing?.issue_id || null,
    };
  }
  if (!claim.acquired) {
    const error = new Error("Issue processing is already in progress.");
    error.code = "ISSUE_PROCESSING_IN_PROGRESS";
    error.status = 409;
    throw error;
  }

  let lastError;
  for (let attempt = 1; attempt <= ISSUE_TRANSACTION_RETRY_COUNT; attempt += 1) {
    try {
      const outcome = await runIssueMatchingTransaction({ reportRunId, token: claim.token, Models, now, transactionRunner });
      const changed = outcome.issue ? [outcome.issue] : outcome.issues || [];
      for (const issue of changed.slice(0, 50)) {
        await projectSourceSafely(reviewProcessor, { agencyId: issue.agency_id, issueId: issue._id, classification: outcome.classification, now }, { operation: "issue_post_commit" });
      }
      return outcome;
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === ISSUE_TRANSACTION_RETRY_COUNT) break;
    }
  }

  const integrityFailure = Boolean(
    lastError?.issueIntegrityFailure ||
      [
        ISSUE_ERROR_CODE.FINGERPRINT_COLLISION,
        ISSUE_ERROR_CODE.OWNERSHIP_CONFLICT,
        ISSUE_ERROR_CODE.SIGNAL_CARDINALITY,
        ISSUE_ERROR_CODE.SIGNAL_ALREADY_LINKED,
        ISSUE_ERROR_CODE.CLAIM_LOST,
      ].includes(lastError?.code)
  );
  const failureUpdate = await markProcessingFailure({
    reportRunId,
    token: claim.token,
    status: integrityFailure ? "failed_integrity" : "failed_retryable",
    error: lastError,
    ReportRunModel: Models.ReportRun,
  }).catch(() => null);
  if (integrityFailure && failureUpdate?.modifiedCount === 1) {
    await markRunSignalsFailed({
      reportRunId,
      error: lastError,
      SignalModel: Models.Signal,
    }).catch(() => null);
  }
  throw lastError;
};

export const ISSUE_MATCHING_DEFAULT_MODELS = defaultModels;
