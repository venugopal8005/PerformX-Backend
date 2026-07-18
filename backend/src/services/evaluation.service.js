import crypto from "node:crypto";

import {
  Activity,
  Client,
  Evaluation,
  EvaluationReconciliationCheckpoint,
  EvaluationSeries,
  Intervention,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  WorkspaceMember,
} from "../models/index.js";
import {
  EVALUATION_ERROR,
  EVALUATION_EVIDENCE_VERSION,
  EVALUATION_LIMITS,
  EVALUATION_NORMALIZATION_VERSION,
  EVALUATION_PRIMARY_METRICS,
  EVALUATION_RULE_VERSION,
  EVALUATION_SCHEMA_VERSION,
  EVALUATION_TRIGGER_TYPES,
  createEvaluationError,
  normalizeEvaluationIdempotencyKey,
} from "../domain/phase4Evaluation.domain.js";
import {
  buildEvaluationSummary,
  buildEvidenceSnapshot,
  canonicalFollowUpWindow,
  classifyOverallResult,
  compareEvaluationMetric,
  detectOverlap,
  evaluationCandidateHash,
  overlapWindowDateBounds,
  selectBaseline,
  selectFollowUp,
} from "./phase4EvaluationEngine.service.js";
import {
  acquireRequiredEvaluationSeriesLease,
  ensureEvaluationSeries,
  fenceEvaluationSeriesLeaseInTransaction,
  releaseEvaluationSeriesLease,
  startEvaluationSeriesLeaseHeartbeat,
} from "./evaluationSeries.service.js";
import {
  acquireClientLifecycleLease,
  createClientLifecycleError,
  fenceClientLifecycleLeaseInTransaction,
  releaseClientLifecycleLease,
  startClientLifecycleLeaseHeartbeat,
} from "./clientLifecycle.service.js";
import { fenceMetaAccountBindingInTransaction } from "./metaAccountBinding.service.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";
import { assertPhase4EvaluationIntegrityReady } from "./phase4EvaluationIndexes.service.js";
import { recordActivity } from "./activityRecorder.service.js";
import { logError } from "../utils/controllerLogger.js";

const defaultModels = { Activity, Client, Evaluation, EvaluationReconciliationCheckpoint, EvaluationSeries, Intervention, Issue, MetaAdAccount, MetaConnection, Report, ReportRun, WorkspaceMember };
const sameId = (left, right) => Boolean(left && right && String(left) === String(right));
const applySession = (query, session) => session && typeof query?.session === "function" ? query.session(session) : query;
const userIdFrom = (actor) => actor?.userId || actor?.id || actor?._id;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const refreshHash = ({ agencyId, interventionId, expectedRevision, idempotencyKey }) => crypto.createHash("sha256").update(JSON.stringify({ agencyId: String(agencyId), interventionId: String(interventionId), expectedRevision, idempotencyKey })).digest("hex");
const nullableSameId = (left, right) => left == null && right == null || sameId(left, right);
const APPROVED_DUPLICATE_INDEXES = new Set([
  "phase4_evaluations_idempotency_unique",
  "phase4_evaluations_report_run_trigger_unique",
]);
const duplicateIndexName = (error) => {
  const named = String(error?.message || "").match(/index:\s+([^\s]+)\s+dup key/i)?.[1];
  if (named) return named;
  const keys = Object.keys(error?.keyPattern || {});
  if (keys.length === 1 && keys[0] === "idempotency_key") return "phase4_evaluations_idempotency_unique";
  if (keys.includes("source_report_run_id")) return "phase4_evaluations_report_run_trigger_unique";
  if (keys.includes("supersedes_evaluation_id")) return "phase4_evaluations_supersedes_unique";
  if (keys.includes("sequence") && keys.includes("intervention_id")) return "phase4_evaluations_intervention_history";
  return null;
};

const recoverApprovedDuplicate = async ({ error, attempted, agencyId, interventionId, Models }) => {
  const indexName = duplicateIndexName(error);
  if (!APPROVED_DUPLICATE_INDEXES.has(indexName) || !attempted) return null;
  const series = await Models.EvaluationSeries.findOne({ agency_id: agencyId, intervention_id: interventionId });
  if (!series?.current_evaluation_id) return null;
  const winner = await Models.Evaluation.findOne({
    _id: series.current_evaluation_id,
    agency_id: agencyId,
    intervention_id: interventionId,
  });
  if (!winner) return null;
  const semanticMatch =
    String(winner.agency_id) === String(agencyId) &&
    String(winner.intervention_id) === String(interventionId) &&
    winner.sequence === attempted.sequence &&
    winner.rule_version === attempted.ruleVersion &&
    winner.evidence_hash === attempted.evidenceHash &&
    winner.trigger_type === attempted.triggerType &&
    nullableSameId(winner.source_report_run_id, attempted.sourceReportRunId) &&
    winner.idempotency_key === attempted.idempotencyKey &&
    nullableSameId(winner.supersedes_evaluation_id, attempted.supersedesEvaluationId) &&
    series.next_sequence === winner.sequence + 1;
  if (!semanticMatch) return null;
  if (attempted.requestHash) {
    if (series.last_manual_refresh_key !== attempted.idempotencyKey || series.last_manual_refresh_hash !== attempted.requestHash) return null;
  }
  return winner;
};

const acquireEvaluationClientLease = async ({ agencyId, clientId, Models }) => {
  for (let attempt = 0; attempt <= EVALUATION_LIMITS.leaseRetries; attempt += 1) {
    const lease = await acquireClientLifecycleLease({ agencyId, clientId, operation: "evaluation_write", ClientModel: Models.Client });
    if (lease.acquired) return lease;
    if (lease.reason !== "client_lifecycle_operation_in_progress" || attempt === EVALUATION_LIMITS.leaseRetries) throw createClientLifecycleError(lease.reason);
    await wait(EVALUATION_LIMITS.leaseRetryDelayMs);
  }
  throw createClientLifecycleError("client_lifecycle_operation_in_progress");
};

const requireManualPermission = async ({ agencyId, intervention, actor, Models }) => {
  const actorId = userIdFrom(actor);
  const membership = await Models.WorkspaceMember.findOne({ workspace_id: agencyId, user_id: actorId, status: "active" });
  if (!membership || (!sameId(intervention.recorded_by_user_id, actorId) && membership.role !== "owner")) {
    throw createEvaluationError(EVALUATION_ERROR.PERMISSION, "Only the original recorder or workspace owner can refresh this Evaluation.", 403);
  }
  return { actorId, membership };
};

const correctionRoot = (item, byId) => {
  let current = item;
  const visited = new Set();
  while (current?.supersedes_intervention_id && !visited.has(String(current._id))) {
    visited.add(String(current._id));
    current = byId.get(String(current.supersedes_intervention_id)) || current;
    if (!current.supersedes_intervention_id) break;
  }
  return String(current?._id || item?._id);
};

const correctionChainIds = (subject, interventions) => {
  const byId = new Map(interventions.map((item) => [String(item._id), item]));
  const root = correctionRoot(subject, byId);
  return interventions.filter((item) => correctionRoot(item, byId) === root).map((item) => item._id);
};

const loadCorrectionChain = async ({ intervention, agencyId, Models, session }) => {
  const documents = new Map([[String(intervention._id), intervention]]);
  const load = async (id) => {
    if (!id || documents.has(String(id))) return documents.get(String(id)) || null;
    const item = await applySession(Models.Intervention.findOne({
      _id: id,
      agency_id: agencyId,
      client_id: intervention.client_id,
      meta_ad_account_id: intervention.meta_ad_account_id,
      campaign_id: intervention.campaign_id,
    }), session);
    if (!item) throw createEvaluationError(EVALUATION_ERROR.OWNERSHIP, "Intervention correction lineage is inconsistent.", 409);
    documents.set(String(item._id), item);
    return item;
  };
  let predecessor = intervention;
  const visitedPredecessors = new Set();
  while (predecessor?.supersedes_intervention_id) {
    if (visitedPredecessors.has(String(predecessor._id))) {
      throw createEvaluationError(EVALUATION_ERROR.OWNERSHIP, "Intervention correction lineage contains a cycle.", 409);
    }
    visitedPredecessors.add(String(predecessor._id));
    predecessor = await load(predecessor.supersedes_intervention_id);
  }
  let successor = intervention;
  const visitedSuccessors = new Set();
  while (successor?.superseded_by_intervention_id) {
    if (visitedSuccessors.has(String(successor._id))) {
      throw createEvaluationError(EVALUATION_ERROR.OWNERSHIP, "Intervention correction lineage contains a cycle.", 409);
    }
    visitedSuccessors.add(String(successor._id));
    successor = await load(successor.superseded_by_intervention_id);
  }
  return [...documents.values()];
};

const loadWindowScopedInterventions = async ({ intervention, agencyId, followUpWindow, timezone, Models, session }) => {
  const bounds = overlapWindowDateBounds({ followUpWindow, timezone });
  if (!bounds) return [];
  return applySession(Models.Intervention.find({
    agency_id: agencyId,
    client_id: intervention.client_id,
    meta_ad_account_id: intervention.meta_ad_account_id,
    campaign_id: intervention.campaign_id,
    performed_at: { $gte: bounds.start, $lt: bounds.endExclusive },
  }).sort({ performed_at: 1, _id: 1 }), session);
};

const effectiveIntent = (intervention) => intervention.evaluation_intent ? {
  mode: intervention.evaluation_intent.mode,
  primary_metric: intervention.evaluation_intent.primary_metric || null,
  watched_metrics: [...(intervention.evaluation_intent.watched_metrics || [])].map(String),
  resolution_source: intervention.evaluation_intent.resolution_source,
  rule_version: intervention.evaluation_intent.rule_version,
} : {
  mode: "unresolved",
  primary_metric: null,
  watched_metrics: [],
  resolution_source: "legacy_intervention_without_intent",
  rule_version: EVALUATION_RULE_VERSION,
};

const baseCandidate = ({ intervention, triggerType, sourceReportRunId, intent, ruleVersion, now }) => ({
  agency_id: intervention.agency_id,
  client_id: intervention.client_id,
  issue_id: intervention.issue_id,
  intervention_id: intervention._id,
  meta_ad_account_id: intervention.meta_ad_account_id,
  campaign_id: intervention.campaign_id,
  report_id_at_action: intervention.report_id_at_action,
  action_type: intervention.action_type,
  schema_version: EVALUATION_SCHEMA_VERSION,
  rule_version: ruleVersion,
  evidence_version: EVALUATION_EVIDENCE_VERSION,
  normalization_version: EVALUATION_NORMALIZATION_VERSION,
  trigger_type: triggerType,
  source_report_run_id: sourceReportRunId || null,
  intent,
  primary_metric: intent.primary_metric,
  watched_metrics: intent.watched_metrics,
  baseline: null,
  follow_up: null,
  metric_results: [],
  observed_result: null,
  interpretability: "not_interpretable",
  reason_codes: [],
  overlap_intervention_ids: [],
  evidence_completeness: "unavailable",
  invalidation_context: null,
  calculated_at: now,
});

const finalized = (candidate) => {
  candidate.reason_codes = [...new Set(candidate.reason_codes)].slice(0, EVALUATION_LIMITS.reasonCodes);
  candidate.summary = buildEvaluationSummary({ status: candidate.status, primaryMetric: candidate.primary_metric, observedResult: candidate.observed_result, baseline: candidate.baseline, followUp: candidate.follow_up, reasons: candidate.reason_codes }).slice(0, EVALUATION_LIMITS.summary);
  candidate.evidence_hash = evaluationCandidateHash(candidate);
  return candidate;
};

const computeCandidate = ({ intervention, runs, relatedInterventions, triggerType, sourceReportRunId, report, ruleVersion = EVALUATION_RULE_VERSION, now }) => {
  const intent = effectiveIntent(intervention);
  const candidate = baseCandidate({ intervention, triggerType, sourceReportRunId, intent, ruleVersion, now });
  if (intervention.status !== "active") {
    candidate.status = "invalidated";
    const reason = intervention.status === "cancelled" ? "intervention_cancelled" : "intervention_superseded";
    const lifecycleFallback = intervention.updatedAt || intervention.recorded_at || intervention.performed_at || new Date(0);
    const invalidatedAt = intervention.status === "cancelled"
      ? intervention.cancellation?.cancelled_at || lifecycleFallback
      : intervention.corrected_at || lifecycleFallback;
    const sourceInterventionId = intervention.status === "superseded"
      ? intervention.superseded_by_intervention_id || intervention._id
      : intervention._id;
    candidate.reason_codes = [reason];
    candidate.invalidation_context = { reason, invalidated_at: invalidatedAt, source_intervention_id: sourceInterventionId };
    return finalized(candidate);
  }
  if (intent.mode === "unresolved") {
    candidate.status = "not_evaluable";
    candidate.reason_codes = ["intent_unresolved"];
    return finalized(candidate);
  }
  if (intent.mode === "not_applicable") {
    candidate.status = "not_evaluable";
    candidate.reason_codes = [intervention.action_type === "fix_tracking" ? "tracking_comparability_unavailable" : "action_not_applicable"];
    return finalized(candidate);
  }
  if (!intent.primary_metric || !EVALUATION_PRIMARY_METRICS.includes(intent.primary_metric)) {
    candidate.status = "not_evaluable";
    candidate.reason_codes = [intent.watched_metrics.length ? "neutral_only_intent" : "unsupported_metric"];
    return finalized(candidate);
  }
  const timezone = report.schedule?.timezone;
  const cadence = report.type;
  const baseline = selectBaseline({ runs, intervention, cadence, timezone });
  if (!baseline.selected) {
    candidate.status = "not_evaluable";
    candidate.reason_codes = [baseline.reason];
    return finalized(candidate);
  }
  candidate.baseline = buildEvidenceSnapshot({ run: baseline.run, validation: baseline.validation, cadence, timezone });
  candidate.evidence_completeness = "partial";
  const followUp = selectFollowUp({ runs, intervention, cadence, timezone, now });
  if (!followUp.selected) {
    candidate.status = followUp.reason === "awaiting_follow_up"
      ? "awaiting_follow_up"
      : followUp.reason === "follow_up_timeout"
        ? "insufficient_data"
        : "not_evaluable";
    candidate.reason_codes = [followUp.reason];
    return finalized(candidate);
  }
  candidate.follow_up = buildEvidenceSnapshot({ run: followUp.run, validation: followUp.validation, cadence, timezone });
  if (candidate.baseline.meta_binding_revision !== candidate.follow_up.meta_binding_revision) {
    candidate.status = "not_evaluable";
    candidate.reason_codes = ["binding_revision_mismatch"];
    return finalized(candidate);
  }
  const chainIds = correctionChainIds(intervention, relatedInterventions);
  const overlaps = detectOverlap({ interventions: relatedInterventions, subjectChainIds: chainIds, followUpWindow: followUp.canonical, timezone });
  if (overlaps.length) {
    candidate.status = "not_evaluable";
    candidate.reason_codes = ["overlapping_intervention"];
    candidate.overlap_intervention_ids = overlaps.map((item) => item._id).slice(0, EVALUATION_LIMITS.overlapInterventions);
    return finalized(candidate);
  }
  candidate.metric_results = intent.watched_metrics.map((metric) => compareEvaluationMetric({ metric, baseline: candidate.baseline, followUp: candidate.follow_up }));
  const primary = candidate.metric_results.find((item) => item.metric === intent.primary_metric);
  if (!primary || primary.classification === "not_evaluable") {
    candidate.status = "not_evaluable";
    candidate.reason_codes = primary?.reason_codes || ["unsupported_metric"];
  } else if (primary.classification === "insufficient_data") {
    candidate.status = "insufficient_data";
    candidate.reason_codes = primary.reason_codes;
  } else {
    candidate.status = "ready";
    candidate.observed_result = classifyOverallResult({ primaryMetric: intent.primary_metric, watchedMetrics: intent.watched_metrics, metricResults: candidate.metric_results });
    candidate.interpretability = intent.mode === "observational" ? "observational" : "directional";
    candidate.evidence_completeness = "complete";
  }
  return finalized(candidate);
};

const recordEvaluationActivity = async ({ evaluation, previous, actorId, Models, session }) => {
  if (previous) {
    await recordActivity({ agency_id: evaluation.agency_id, client_id: evaluation.client_id, report_id: evaluation.report_id_at_action, user_id: actorId || null, type: "evaluation_superseded", title: "Evaluation evidence updated", description: evaluation.summary, severity: "stable", idempotency_key: `phase4:evaluation:${evaluation._id}:superseded:${previous._id}`, metadata: { evaluation_id: evaluation._id, superseded_evaluation_id: previous._id, intervention_id: evaluation.intervention_id, issue_id: evaluation.issue_id, trigger: evaluation.trigger_type, primary_metric: evaluation.primary_metric, observed_result: evaluation.observed_result, sequence: evaluation.sequence }, session, ActivityModel: Models.Activity });
  }
  const invalidated = evaluation.status === "invalidated";
  await recordActivity({ agency_id: evaluation.agency_id, client_id: evaluation.client_id, report_id: evaluation.report_id_at_action, user_id: actorId || null, type: invalidated ? "evaluation_invalidated" : "evaluation_created", title: invalidated ? "Evaluation invalidated" : "Evaluation calculated", description: evaluation.summary, severity: "stable", idempotency_key: `phase4:evaluation:${evaluation._id}:${invalidated ? "invalidated" : "created"}`, metadata: { evaluation_id: evaluation._id, intervention_id: evaluation.intervention_id, issue_id: evaluation.issue_id, trigger: evaluation.trigger_type, primary_metric: evaluation.primary_metric, observed_result: evaluation.observed_result, sequence: evaluation.sequence }, session, ActivityModel: Models.Activity });
};

export const processInterventionEvaluation = async ({
  agencyId,
  interventionId,
  triggerType,
  sourceReportRunId = null,
  actor = null,
  expectedInterventionRevision = null,
  idempotencyKey = null,
  now = new Date(),
  Models = defaultModels,
  transactionRunner = runRequiredTransaction,
  assertIntegrityReady = assertPhase4EvaluationIntegrityReady,
  ruleVersion = EVALUATION_RULE_VERSION,
  transactionStageHook = null,
  leaseClock = () => new Date(),
} = {}) => {
  if (!EVALUATION_TRIGGER_TYPES.includes(triggerType)) throw createEvaluationError(EVALUATION_ERROR.VALIDATION, "Evaluation trigger is invalid.", 400);
  if (!Number.isSafeInteger(ruleVersion) || ruleVersion < 1) throw createEvaluationError(EVALUATION_ERROR.VALIDATION, "Evaluation rule version is invalid.", 400);
  assertIntegrityReady();
  const preliminary = await Models.Intervention.findOne({ _id: interventionId, agency_id: agencyId });
  if (!preliminary) throw createEvaluationError(EVALUATION_ERROR.INTERVENTION_NOT_FOUND, "Intervention not found.", 404);
  const manual = triggerType === "manual_refresh";
  const permission = manual ? await requireManualPermission({ agencyId, intervention: preliminary, actor, Models }) : { actorId: userIdFrom(actor), membership: null };
  if (manual) {
    const revision = Number(expectedInterventionRevision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw createEvaluationError(EVALUATION_ERROR.VALIDATION, "expectedInterventionRevision must be a non-negative integer.", 400);
    if (preliminary.status !== "active") throw createEvaluationError(EVALUATION_ERROR.INVALID_STATE, "Only active Interventions can be refreshed.", 409);
    normalizeEvaluationIdempotencyKey(idempotencyKey);
  }
  const clientLease = await acquireEvaluationClientLease({ agencyId, clientId: preliminary.client_id, Models });
  const clientHeartbeat = startClientLifecycleLeaseHeartbeat({ agencyId, clientId: preliminary.client_id, token: clientLease.token, ClientModel: Models.Client });
  let seriesLease;
  let seriesHeartbeat;
  let attemptedDuplicateSemantics = null;
  try {
    await ensureEvaluationSeries({ agencyId, clientId: preliminary.client_id, issueId: preliminary.issue_id, interventionId: preliminary._id, SeriesModel: Models.EvaluationSeries });
    seriesLease = await acquireRequiredEvaluationSeriesLease({ agencyId, interventionId: preliminary._id, operation: triggerType, SeriesModel: Models.EvaluationSeries });
    seriesHeartbeat = startEvaluationSeriesLeaseHeartbeat({ agencyId, interventionId: preliminary._id, token: seriesLease.token, SeriesModel: Models.EvaluationSeries });
    const result = await transactionRunner({
      unavailableCode: EVALUATION_ERROR.TRANSACTION_REQUIRED,
      unavailableMessage: "Evaluation writes require a transaction-capable database deployment.",
      work: async (session) => {
        clientHeartbeat.assertOwned();
        seriesHeartbeat.assertOwned();
        const client = await fenceClientLifecycleLeaseInTransaction({ agencyId, clientId: preliminary.client_id, token: clientLease.token, session, now, ClientModel: Models.Client });
        let series = await fenceEvaluationSeriesLeaseInTransaction({ agencyId, interventionId: preliminary._id, token: seriesLease.token, expectedRevision: seriesLease.series.revision, session, now: leaseClock(), SeriesModel: Models.EvaluationSeries });
        let intervention = await applySession(Models.Intervention.findOne({ _id: preliminary._id, agency_id: agencyId }).select("+evaluation_fence_counter"), session);
        if (!intervention) throw createEvaluationError(EVALUATION_ERROR.INTERVENTION_NOT_FOUND, "Intervention not found.", 404);
        if (manual && intervention.revision !== Number(expectedInterventionRevision)) throw createEvaluationError(EVALUATION_ERROR.STALE_REVISION, "The Intervention changed. Refresh before recalculating.", 409);
        intervention = await Models.Intervention.findOneAndUpdate(
          { _id: intervention._id, agency_id: agencyId, status: intervention.status, revision: intervention.revision },
          { $inc: { evaluation_fence_counter: 1 } },
          { new: true, session, timestamps: false, phase3InternalOperation: "evaluation_fence" }
        ).select("+evaluation_fence_counter");
        if (!intervention) throw createEvaluationError(EVALUATION_ERROR.STALE_REVISION, "The Intervention changed during Evaluation processing.", 409);
        const [issue, report, actionRun] = await Promise.all([
          applySession(Models.Issue.findOne({ _id: intervention.issue_id, agency_id: agencyId }), session),
          applySession(Models.Report.findOne({ _id: intervention.report_id_at_action, agency_id: agencyId }), session),
          applySession(Models.ReportRun.findOne({ _id: intervention.report_run_id_at_action, agency_id: agencyId }), session),
        ]);
        const actionCampaignIds = (actionRun?.monitored_campaigns || []).map((item) => String(item?.campaign_id || ""));
        const issueCampaignId = String(issue?.scope?.entity?.campaign_id || issue?.scope?.entity?.id || "");
        const lineageValid =
          client &&
          issue &&
          report &&
          actionRun &&
          sameId(client._id, intervention.client_id) &&
          sameId(issue.client_id, intervention.client_id) &&
          sameId(issue.meta_ad_account_id, intervention.meta_ad_account_id) &&
          sameId(report.client_id, intervention.client_id) &&
          sameId(report.meta_ad_account_id, intervention.meta_ad_account_id) &&
          sameId(actionRun.client_id, intervention.client_id) &&
          sameId(actionRun.report_id, intervention.report_id_at_action) &&
          sameId(actionRun.meta_ad_account_id, intervention.meta_ad_account_id) &&
          issueCampaignId === String(intervention.campaign_id) &&
          actionCampaignIds.includes(String(intervention.campaign_id));
        if (!lineageValid) {
          throw createEvaluationError(EVALUATION_ERROR.OWNERSHIP, "Evaluation lineage is inconsistent.", 409);
        }
        const expectedBindingRevision = Number(actionRun.meta_binding_revision_snapshot);
        if (intervention.status === "active") {
          await fenceMetaAccountBindingInTransaction({ accountId: intervention.meta_ad_account_id, agencyId, clientId: intervention.client_id, expectedBindingRevision, session, MetaAdAccountModel: Models.MetaAdAccount, MetaConnectionModel: Models.MetaConnection });
        } else {
          const historicalAccount = await applySession(
            Models.MetaAdAccount.findOne({ _id: intervention.meta_ad_account_id, agency_id: agencyId }),
            session
          );
          if (!historicalAccount) {
            throw createEvaluationError(EVALUATION_ERROR.OWNERSHIP, "Evaluation account lineage is inconsistent.", 409);
          }
        }
        const [runs, current] = await Promise.all([
          applySession(Models.ReportRun.find({ agency_id: agencyId, client_id: intervention.client_id, report_id: intervention.report_id_at_action, meta_ad_account_id: intervention.meta_ad_account_id, evaluation_evidence: { $exists: true } }).sort({ ran_at: -1, _id: -1 }).limit(EVALUATION_LIMITS.candidateRuns), session),
          series.current_evaluation_id ? applySession(Models.Evaluation.findOne({ _id: series.current_evaluation_id, agency_id: agencyId, intervention_id: intervention._id }), session) : null,
        ]);
        if (series.current_evaluation_id && !current) throw createEvaluationError(EVALUATION_ERROR.OWNERSHIP, "Current Evaluation lineage is inconsistent.", 409);
        const actionReportConfiguration = actionRun.context_snapshot?.report?.configuration;
        const evaluationReport = {
          type: actionReportConfiguration?.type || report.type,
          schedule: {
            timezone: actionReportConfiguration?.schedule?.timezone || report.schedule?.timezone,
          },
        };
        const correctionChain = await loadCorrectionChain({ intervention, agencyId, Models, session });
        const overlapWindow = canonicalFollowUpWindow({
          performedAt: intervention.performed_at,
          timezone: evaluationReport.schedule.timezone,
          cadence: evaluationReport.type,
        });
        const overlapCandidates = await loadWindowScopedInterventions({
          intervention,
          agencyId,
          followUpWindow: overlapWindow,
          timezone: evaluationReport.schedule.timezone,
          Models,
          session,
        });
        const relatedInterventions = [...new Map(
          [...correctionChain, ...overlapCandidates].map((item) => [String(item._id), item])
        ).values()];
        const candidate = computeCandidate({ intervention, runs, relatedInterventions, triggerType, sourceReportRunId, report: evaluationReport, ruleVersion, now });
        const requestHash = manual ? refreshHash({ agencyId, interventionId, expectedRevision: expectedInterventionRevision, idempotencyKey }) : null;
        const bucket = manual ? new Date(Math.floor(now.getTime() / EVALUATION_LIMITS.refreshBucketMs) * EVALUATION_LIMITS.refreshBucketMs) : null;
        if (manual && series.last_manual_refresh_key === idempotencyKey && series.last_manual_refresh_hash && series.last_manual_refresh_hash !== requestHash) {
          throw createEvaluationError(EVALUATION_ERROR.IDEMPOTENCY_CONFLICT, "The idempotency key was already used for another Evaluation refresh request.", 409);
        }
        if (manual && series.last_manual_refresh_bucket && series.last_manual_refresh_bucket.getTime() === bucket.getTime() && series.last_manual_refresh_key !== idempotencyKey) throw createEvaluationError(EVALUATION_ERROR.RATE_LIMITED, "An Evaluation refresh was already requested in this 60-second window.", 429);
        const refreshSet = manual ? { last_manual_refresh_bucket: bucket, last_manual_refresh_key: idempotencyKey, last_manual_refresh_hash: requestHash } : {};
        const staleRuleVersion = current && current.rule_version > candidate.rule_version;
        if (current && (staleRuleVersion || (current.rule_version === candidate.rule_version && current.evidence_hash === candidate.evidence_hash))) {
          clientHeartbeat.assertOwned();
          seriesHeartbeat.assertOwned();
          const advancementTime = leaseClock();
          const updated = await Models.EvaluationSeries.findOneAndUpdate({ _id: series._id, agency_id: agencyId, intervention_id: intervention._id, revision: series.revision, "processing_lock.token": seriesLease.token, "processing_lock.expires_at": { $gt: advancementTime } }, { $set: { ...refreshSet, ...(sourceReportRunId ? { last_processed_report_run_id: sourceReportRunId } : {}) }, $inc: { revision: 1 } }, { new: true, session, phase4SeriesOperation: "advance" });
          if (!updated) throw createEvaluationError(EVALUATION_ERROR.LEASE_LOST, "EvaluationSeries changed during processing.", 409);
          if (manual) await recordActivity({ agency_id: intervention.agency_id, client_id: intervention.client_id, report_id: intervention.report_id_at_action, user_id: permission.actorId, type: "evaluation_refresh_requested", title: "Evaluation refresh requested", description: current.summary, severity: "stable", idempotency_key: `phase4:refresh:${agencyId}:${idempotencyKey}`, metadata: { evaluation_id: current._id, intervention_id: intervention._id, issue_id: intervention.issue_id, trigger: triggerType, primary_metric: current.primary_metric, observed_result: current.observed_result, sequence: current.sequence }, session, ActivityModel: Models.Activity });
          const commitTime = leaseClock();
          const finalLease = await applySession(Models.EvaluationSeries.findOne({ _id: updated._id, agency_id: agencyId, intervention_id: intervention._id, revision: updated.revision, "processing_lock.token": seriesLease.token, "processing_lock.expires_at": { $gt: commitTime } }).select("_id"), session);
          if (!finalLease) throw createEvaluationError(EVALUATION_ERROR.LEASE_LOST, "Evaluation processing ownership expired before commit.", 409);
          return { evaluation: current, created: false, noChange: true, staleRuleVersion: Boolean(staleRuleVersion) };
        }
        const sequence = series.next_sequence;
        const generatedKey = manual ? idempotencyKey : `phase4:${triggerType}:v${candidate.rule_version}:${String(intervention._id)}:${candidate.evidence_hash.slice(0, 40)}`;
        attemptedDuplicateSemantics = {
          sequence,
          ruleVersion: candidate.rule_version,
          evidenceHash: candidate.evidence_hash,
          triggerType,
          sourceReportRunId: sourceReportRunId || null,
          idempotencyKey: generatedKey,
          supersedesEvaluationId: current?._id || null,
          requestHash,
        };
        const [evaluation] = await Models.Evaluation.create([{ ...candidate, sequence, idempotency_key: generatedKey, supersedes_evaluation_id: current?._id || null }], { session });
        await transactionStageHook?.("evaluation_inserted", { evaluation, series, session });
        clientHeartbeat.assertOwned();
        seriesHeartbeat.assertOwned();
        const advancementTime = leaseClock();
        const advanced = await Models.EvaluationSeries.findOneAndUpdate({ _id: series._id, agency_id: agencyId, intervention_id: intervention._id, revision: series.revision, current_evaluation_id: current?._id || null, "processing_lock.token": seriesLease.token, "processing_lock.expires_at": { $gt: advancementTime } }, { $set: { current_evaluation_id: evaluation._id, ...refreshSet, ...(sourceReportRunId ? { last_processed_report_run_id: sourceReportRunId } : {}) }, $inc: { next_sequence: 1, revision: 1 } }, { new: true, session, phase4SeriesOperation: "advance" });
        if (!advanced) throw createEvaluationError(EVALUATION_ERROR.LEASE_LOST, "EvaluationSeries changed during version advancement.", 409);
        await transactionStageHook?.("series_advanced", { evaluation, series: advanced, session });
        if (manual) await recordActivity({ agency_id: intervention.agency_id, client_id: intervention.client_id, report_id: intervention.report_id_at_action, user_id: permission.actorId, type: "evaluation_refresh_requested", title: "Evaluation refresh requested", description: evaluation.summary, severity: "stable", idempotency_key: `phase4:refresh:${agencyId}:${idempotencyKey}`, metadata: { evaluation_id: evaluation._id, intervention_id: intervention._id, issue_id: intervention.issue_id, trigger: triggerType, primary_metric: evaluation.primary_metric, observed_result: evaluation.observed_result, sequence: evaluation.sequence }, session, ActivityModel: Models.Activity });
        await recordEvaluationActivity({ evaluation, previous: current, actorId: permission.actorId, Models, session });
        await transactionStageHook?.("activity_recorded", { evaluation, series: advanced, session });
        const commitTime = leaseClock();
        const finalLease = await applySession(Models.EvaluationSeries.findOne({ _id: advanced._id, agency_id: agencyId, intervention_id: intervention._id, revision: advanced.revision, "processing_lock.token": seriesLease.token, "processing_lock.expires_at": { $gt: commitTime } }).select("_id"), session);
        if (!finalLease) throw createEvaluationError(EVALUATION_ERROR.LEASE_LOST, "Evaluation processing ownership expired before commit.", 409);
        return { evaluation, created: true, noChange: false };
      },
    });
    return result;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await recoverApprovedDuplicate({ error, attempted: attemptedDuplicateSemantics, agencyId, interventionId: preliminary._id, Models });
    if (winner) return { evaluation: winner, created: false, noChange: true, duplicateRecovered: true };
    const conflictIndex = duplicateIndexName(error);
    const strictIntegrityConflict = conflictIndex === "phase4_evaluations_intervention_history" ||
      conflictIndex === "phase4_evaluations_supersedes_unique" ||
      !APPROVED_DUPLICATE_INDEXES.has(conflictIndex);
    throw createEvaluationError(
      strictIntegrityConflict ? EVALUATION_ERROR.INTEGRITY_CONFLICT : EVALUATION_ERROR.IDEMPOTENCY_CONFLICT,
      strictIntegrityConflict
        ? "Evaluation integrity conflict prevented version advancement."
        : "Evaluation uniqueness conflict did not match the requested operation.",
      409
    );
  } finally {
    await seriesHeartbeat?.stop().catch(() => {});
    await releaseEvaluationSeriesLease({ agencyId, interventionId: preliminary._id, token: seriesLease?.token, SeriesModel: Models.EvaluationSeries }).catch(() => false);
    await clientHeartbeat.stop().catch(() => {});
    await releaseClientLifecycleLease({ agencyId, clientId: preliminary.client_id, token: clientLease.token, ClientModel: Models.Client }).catch(() => false);
  }
};

const persistReportRunEvaluationProgress = async ({ reportRunId, status, cursor, processed, Models, now = new Date() }) =>
  Models.ReportRun.findOneAndUpdate(
    { _id: reportRunId },
    {
      $set: {
        "evaluation_processing.status": status,
        "evaluation_processing.cursor": cursor || null,
        "evaluation_processing.last_attempt_at": now,
        "evaluation_processing.completed_at": status === "pending" ? null : now,
      },
      $inc: {
        "evaluation_processing.processed_count": processed,
        "evaluation_processing.attempt_count": 1,
      },
    },
    { new: true, setDefaultsOnInsert: false }
  );

export const processReportRunEvaluations = async ({ reportRunId, cursor: requestedCursor = undefined, Models = defaultModels, processOne = processInterventionEvaluation } = {}) => {
  const reportRun = await Models.ReportRun.findById(reportRunId).lean();
  if (!reportRun?.evaluation_evidence || reportRun.evaluation_evidence.completeness !== "complete") {
    if (reportRun) await persistReportRunEvaluationProgress({ reportRunId, status: "skipped", cursor: null, processed: 0, Models });
    return { processed: 0, skipped: true, nextCursor: null, hasMore: false };
  }
  if (requestedCursor === undefined && reportRun.evaluation_processing?.status === "completed") {
    return { processed: 0, skipped: false, completed: true, nextCursor: null, hasMore: false };
  }
  const snapshots = reportRun.evaluation_evidence.campaign_snapshots;
  if (!Array.isArray(snapshots) || !snapshots.length || snapshots.length > EVALUATION_LIMITS.campaignSnapshots) {
    await persistReportRunEvaluationProgress({ reportRunId, status: "skipped", cursor: null, processed: 0, Models });
    return { processed: 0, skipped: true, nextCursor: null, hasMore: false };
  }
  const campaignIds = [...new Set(snapshots.map((item) => String(item?.campaign_id || "").trim()).filter(Boolean))];
  if (!campaignIds.length) {
    await persistReportRunEvaluationProgress({ reportRunId, status: "skipped", cursor: null, processed: 0, Models });
    return { processed: 0, skipped: true, nextCursor: null, hasMore: false };
  }
  const batchSize = EVALUATION_LIMITS.reconciliationBatchSize;
  const maxBatches = EVALUATION_LIMITS.reconciliationMaxBatches;
  let processed = 0;
  let cursor = requestedCursor === undefined ? reportRun.evaluation_processing?.cursor || null : requestedCursor;
  let hasMore = false;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const interventions = await Models.Intervention.find({
      agency_id: reportRun.agency_id,
      client_id: reportRun.client_id,
      meta_ad_account_id: reportRun.meta_ad_account_id,
      campaign_id: { $in: campaignIds },
      ...(cursor ? { _id: { $gt: cursor } } : {}),
    }).select("_id").sort({ _id: 1 }).limit(batchSize + 1).lean();
    hasMore = interventions.length > batchSize;
    const page = hasMore ? interventions.slice(0, batchSize) : interventions;
    for (const intervention of page) {
      try {
        await processOne({ agencyId: reportRun.agency_id, interventionId: intervention._id, triggerType: "report_run", sourceReportRunId: reportRun._id, Models });
      } catch (error) {
        logError("Evaluations", "REPORT_RUN_EVALUATION_FAILED", error, {
          reportRunId: reportRun._id,
          interventionId: intervention._id,
        });
      }
      processed += 1;
    }
    cursor = page.at(-1)?._id || cursor;
    await persistReportRunEvaluationProgress({ reportRunId, status: hasMore ? "pending" : "completed", cursor: hasMore ? cursor : null, processed: page.length, Models });
    if (!hasMore || !page.length) break;
  }
  return { processed, skipped: false, nextCursor: hasMore && cursor ? String(cursor) : null, hasMore };
};

export const reconcileEvaluations = async ({
  agencyId = null,
  cursor = null,
  batchSize = EVALUATION_LIMITS.reconciliationBatchSize,
  maxBatches = EVALUATION_LIMITS.reconciliationMaxBatches,
  Models = defaultModels,
  processOne = processInterventionEvaluation,
} = {}) => {
  const safeBatchSize = Math.max(1, Math.min(Number(batchSize) || EVALUATION_LIMITS.reconciliationBatchSize, EVALUATION_LIMITS.reconciliationBatchSize));
  const safeMaxBatches = Math.max(1, Math.min(Number(maxBatches) || EVALUATION_LIMITS.reconciliationMaxBatches, EVALUATION_LIMITS.reconciliationMaxBatches));
  let currentCursor = cursor || null;
  let hasMore = false;
  let processed = 0;
  let failed = 0;
  let interrupted = false;
  for (let batch = 0; batch < safeMaxBatches; batch += 1) {
    const documents = await Models.Intervention.find({
      ...(agencyId ? { agency_id: agencyId } : {}),
      ...(currentCursor ? { _id: { $gt: currentCursor } } : {}),
    }).select("_id agency_id").sort({ _id: 1 }).limit(safeBatchSize + 1).lean();
    hasMore = documents.length > safeBatchSize;
    const page = hasMore ? documents.slice(0, safeBatchSize) : documents;
    for (const intervention of page) {
      try {
        await processOne({
          agencyId: intervention.agency_id,
          interventionId: intervention._id,
          triggerType: "reconciliation",
          Models,
        });
      } catch (error) {
        failed += 1;
        interrupted = true;
        logError("Evaluations", "EVALUATION_RECONCILIATION_ITEM_FAILED", error, {
          interventionId: intervention._id,
        });
        break;
      }
      processed += 1;
      currentCursor = intervention._id;
    }
    if (interrupted) {
      hasMore = true;
      break;
    }
    if (!hasMore || !page.length) break;
  }
  return {
    processed,
    failed,
    interrupted,
    hasMore,
    nextCursor: hasMore && currentCursor ? String(currentCursor) : null,
    batchSize: safeBatchSize,
    maxBatches: safeMaxBatches,
  };
};

const reconciliationCheckpointId = (agencyId) => agencyId ? `agency:${String(agencyId)}` : "global";

export const runEvaluationMaintenance = async ({
  agencyId = null,
  Models = defaultModels,
  processReportRun = processReportRunEvaluations,
  reconcile = reconcileEvaluations,
  processOne = processInterventionEvaluation,
  pendingReportRunLimit = EVALUATION_LIMITS.reconciliationMaxBatches,
  now = new Date(),
} = {}) => {
  const safePendingLimit = Math.max(1, Math.min(Number(pendingReportRunLimit) || EVALUATION_LIMITS.reconciliationMaxBatches, EVALUATION_LIMITS.reconciliationMaxBatches));
  const pendingRuns = await Models.ReportRun.find({
    "evaluation_processing.status": "pending",
    ...(agencyId ? { agency_id: agencyId } : {}),
  }).select("_id").sort({ _id: 1 }).limit(safePendingLimit).lean();
  let reportRunsProcessed = 0;
  let reportRunFailures = 0;
  for (const reportRun of pendingRuns) {
    try {
      await processReportRun({ reportRunId: reportRun._id, Models, processOne });
      reportRunsProcessed += 1;
    } catch (error) {
      reportRunFailures += 1;
      logError("Evaluations", "REPORT_RUN_EVALUATION_CONTINUATION_FAILED", error, { reportRunId: reportRun._id });
    }
  }

  const checkpointId = reconciliationCheckpointId(agencyId);
  const checkpoint = await Models.EvaluationReconciliationCheckpoint.findById(checkpointId).lean();
  const cursor = checkpoint?.cursor || null;
  const reconciliation = await reconcile({ agencyId, cursor, Models, processOne });
  const cycleCompleted = !reconciliation.hasMore;
  await Models.EvaluationReconciliationCheckpoint.findOneAndUpdate(
    { _id: checkpointId },
    {
      $set: {
        agency_id: agencyId || null,
        cursor: cycleCompleted ? null : reconciliation.nextCursor || cursor,
        cycle_started_at: cursor ? checkpoint?.cycle_started_at || now : now,
        last_attempt_at: now,
        ...(cycleCompleted ? { last_completed_at: now } : {}),
      },
      $inc: {
        processed_count: reconciliation.processed,
        failed_count: reconciliation.failed,
        revision: 1,
      },
      $setOnInsert: { _id: checkpointId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return {
    reportRunsChecked: pendingRuns.length,
    reportRunsProcessed,
    reportRunFailures,
    reconciliation,
    checkpointId,
  };
};

export const evaluationServiceInternals = { computeCandidate, correctionChainIds, duplicateIndexName, effectiveIntent, loadCorrectionChain, loadWindowScopedInterventions, persistReportRunEvaluationProgress, reconciliationCheckpointId, recoverApprovedDuplicate, refreshHash };
