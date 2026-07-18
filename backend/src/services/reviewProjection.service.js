import {
  Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, Report,
  ReviewAction, ReviewItem, Signal,
} from "../models/index.js";
import {
  REVIEW_ACTIVE_STATES, REVIEW_ERROR, createReviewError, hashReviewEvent, reviewActiveKey,
  reviewPriorityForEvaluationResult, reviewPriorityForIssueSeverity,
} from "../domain/phase5Review.domain.js";
import { assertPhase5ReviewIntegrityReady } from "./phase5ReviewIndexes.service.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";
import { recordActivity } from "./activityRecorder.service.js";
import { logError } from "../utils/controllerLogger.js";
import { loadReviewAuthorityBatch, resolveReviewEffectiveState } from "./reviewAuthority.service.js";

const defaultModels = { Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, Report, ReviewAction, ReviewItem, Signal };
const apply = (query, session) => session && typeof query?.session === "function" ? query.session(session) : query;
const same = (a, b) => Boolean(a && b && String(a) === String(b));
const plain = (value) => value?.toObject ? value.toObject() : value;
const sourceSnapshot = (item, now) => ({ version: 1, captured_at: now, item_type: item.type, item_generation: item.generation, source_revision: item.source_revision, title: item.context_snapshot?.source_title || null, summary: item.context_snapshot?.source_summary || null, provenance: item.context_snapshot?.provenance || "snapshot" });
const actionHash = (input) => hashReviewEvent(input);
const actionKey = (item, event, actionType) => `phase5:review-action:${item._id}:${actionType}:${event}`;
const activeStates = { $in: REVIEW_ACTIVE_STATES };
const terminalStates = ["reviewed", "closed", "superseded"];
const issueReason = (classification, generation) => classification === "reconciliation"
  ? "reconciliation_recovered"
  : classification === "reopened"
    ? "issue_reopened"
    : classification === "cancelled"
      ? "intervention_cancelled"
      : generation > 1 ? "issue_new_evidence" : "issue_created";
const evaluationReason = (classification, generation) => classification === "reconciliation"
  ? "reconciliation_recovered"
  : generation > 1 ? "evaluation_ready_successor" : "evaluation_ready";

const contextSnapshot = ({ client, account, issue, report, campaignName = null, sourceTitle, sourceSummary, capturedAt }) => ({
  version: 1, captured_at: capturedAt,
  client: { id: client?._id || null, name: client?.name || null, provenance: client ? "current_parent" : "unknown" },
  account: { id: account?._id || null, name: account?.name || null, external_id: account?.ad_account_id || null, provenance: account ? "current_parent" : "unknown" },
  campaign: { id: issue?.scope?.entity?.campaign_id || issue?.scope?.entity?.id || null, name: campaignName, provenance: issue?.scope?.entity?.campaign_id || issue?.scope?.entity?.id ? "snapshot" : "unknown" },
  issue: { id: issue?._id || null, name: null, title: issue?.title || null, provenance: issue ? "snapshot" : "unknown" },
  report: report ? { id: report._id, name: report.name || null, provenance: "current_parent" } : null,
  source_title: sourceTitle || null, source_summary: sourceSummary || null, provenance: "snapshot",
});

const appendAction = async ({ item, actionType, actorType = "system", actor = null, decisionType = null, resultingState, eventKey, eventHash, actionIdempotencyKey = null, occurredAt, note = null, interventionId = null, evaluationId = null, signalId = null, Models, session }) => {
  const idempotencyKey = actionIdempotencyKey || actionKey(item, eventKey, actionType);
  const existing = await apply(Models.ReviewAction.findOne({ agency_id: item.agency_id, idempotency_key: idempotencyKey }).select("+request_hash"), session);
  if (existing) {
    if (existing.request_hash !== eventHash) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review action idempotency conflict.", 409);
    return existing;
  }
  const next = item.action_sequence + 1;
  const [created] = await Models.ReviewAction.create([{
    agency_id: item.agency_id, client_id: item.client_id, issue_id: item.issue_id, review_item_id: item._id,
    sequence: next, action_type: actionType, actor_type: actorType, decision_type: decisionType,
    actor_user_id: actor?.userId || null, actor_snapshot: actor?.snapshot || null,
    prior_state: item.state, resulting_state: resultingState,
    item_revision_before: item.revision, item_revision_after: item.revision + 1, source_revision: item.source_revision,
    source_snapshot: sourceSnapshot(item, occurredAt), signal_id: signalId, intervention_id: interventionId,
    evaluation_id: evaluationId, note, occurred_at: occurredAt, recorded_at: occurredAt,
    idempotency_key: idempotencyKey, request_hash: eventHash,
  }], { session });
  return created;
};

const activityFor = async ({ item, priorState = null, type, title, description, reason, Models, session }) => recordActivity({
  agency_id: item.agency_id, client_id: item.client_id, issue_id: item.issue_id, review_item_id: item._id,
  report_id: item.report_id, user_id: null, type, title, description, severity: item.priority === "critical" ? "critical" : item.priority === "high" ? "moderate" : "stable",
  idempotency_key: `phase5:activity:review-item:${item._id}:${type}:revision:${item.revision}`,
  metadata: { review_item_id: item._id, type: item.type, generation: item.generation, issue_id: item.issue_id, evaluation_id: item.evaluation_id, intervention_id: item.intervention_id, previous_state: priorState || item.state, resulting_state: item.state, reason, priority: item.priority },
  session, ActivityModel: Models.Activity,
});

const transition = async ({ item, operation, actionType, resultingState, eventKey, eventHash, actionIdempotencyKey = null, occurredAt, set = {}, activity = null, actorType = "system", actor = null, decisionType = null, note = null, interventionId = null, evaluationId = null, signalId = null, Models, session }) => {
  const clearedAcknowledgement = { acknowledged_at: null, acknowledged_by_user_id: null, acknowledged_by_snapshot: null };
  const clearedSnooze = { snoozed_at: null, snoozed_until: null, snoozed_by_user_id: null, snoozed_by_snapshot: null, snooze_note: null };
  const clearedReview = { reviewed_at: null, reviewed_by_user_id: null, reviewed_by_snapshot: null };
  const clearedClosure = { closed_at: null, close_reason: null };
  const lifecycleSet = resultingState === "reviewed"
    ? { ...clearedAcknowledgement, ...clearedSnooze, ...clearedClosure }
    : ["closed", "superseded"].includes(resultingState)
      ? { ...clearedAcknowledgement, ...clearedSnooze, ...clearedReview }
      : operation === "system_reopen"
        ? { ...clearedAcknowledgement, ...clearedSnooze, ...clearedReview, ...clearedClosure }
        : {};
  await appendAction({ item, actionType, actorType, actor, decisionType, resultingState, eventKey, eventHash, actionIdempotencyKey, occurredAt, note, interventionId, evaluationId, signalId, Models, session });
  const updated = await Models.ReviewItem.applyApprovedOperation(
    operation,
    { _id: item._id, agency_id: item.agency_id, client_id: item.client_id, issue_id: item.issue_id, evaluation_series_id: item.evaluation_series_id || null, type: item.type, generation: item.generation, source_revision: item.source_revision, revision: item.revision, state: item.state, active_key: item.active_key },
    { $set: { ...lifecycleSet, ...set, state: resultingState, active_key: REVIEW_ACTIVE_STATES.includes(resultingState) ? item.active_key : null, last_projected_event_key: eventKey, last_projected_event_hash: eventHash, updatedAt: occurredAt }, $inc: { revision: 1, action_sequence: 1 } },
    { new: true, session }
  );
  if (!updated) throw createReviewError(REVIEW_ERROR.REVISION_STALE, "The Review item changed. Refresh and try again.", 409);
  if (activity) await activityFor({ item: updated, priorState: item.state, ...activity, Models, session });
  return updated;
};

const refreshReviewItemSource = async ({ item, source, priority, eventKey, eventHash, occurredAt, Models, session }) => {
  const updated = await Models.ReviewItem.applyApprovedOperation(
    "source_refresh",
    { _id: item._id, agency_id: item.agency_id, client_id: item.client_id, issue_id: item.issue_id, evaluation_series_id: item.evaluation_series_id || null, type: item.type, generation: item.generation, source_revision: item.source_revision, revision: item.revision, state: item.state, active_key: item.active_key },
    { $set: { state: item.state, active_key: item.active_key, priority: priority.priority, priority_rank: priority.priorityRank, priority_source: priority.prioritySource, source_revision: source.revision, signal_id: source.signalId || null, report_id: source.reportId || null, report_run_id: source.reportRunId || null, latest_evidence_at: source.latestEvidenceAt, last_projected_event_key: eventKey, last_projected_event_hash: eventHash, updatedAt: occurredAt }, $inc: { revision: 1 } },
    { new: true, session }
  );
  if (!updated) throw createReviewError(REVIEW_ERROR.REVISION_STALE, "Review projection changed concurrently.", 409);
  return updated;
};

const rawAccount = async ({ accountId, agencyId, Models, session }) => {
  const castId = Models.MetaAdAccount.schema.path("_id").cast(accountId);
  const castAgency = Models.MetaAdAccount.schema.path("agency_id").cast(agencyId);
  return Models.MetaAdAccount.collection.findOne({ _id: castId, agency_id: castAgency }, { session: session || undefined, projection: { agency_id: 1, client_id: 1, name: 1, ad_account_id: 1, is_active: 1, is_accessible: 1, binding_revision: 1 } });
};

const issueContext = async ({ agencyId, issueId, Models, session }) => {
  const issue = await apply(Models.Issue.findOne({ _id: issueId, agency_id: agencyId }), session);
  if (!issue) return null;
  const [client, account, report, signal] = await Promise.all([
    apply(Models.Client.findOne({ _id: issue.client_id, agency_id: agencyId }), session),
    rawAccount({ accountId: issue.meta_ad_account_id, agencyId, Models, session }),
    apply(Models.Report.findOne({ _id: issue.latest_report_id, agency_id: agencyId }), session),
    apply(Models.Signal.findOne({ _id: issue.latest_signal_id, agency_id: agencyId }), session),
  ]);
  return { issue, client, account, report, signal };
};

const createItem = async ({ type, reason, eventKey, eventHash, priority, sourceRevision, latestEvidenceAt, context, evaluationSeries = null, evaluation = null, previous = null, openingAction = null, Models, session, now }) => {
  const { issue, client, account, report, signal } = context;
  const identity = reviewActiveKey({ type, issueId: issue._id, evaluationSeriesId: evaluationSeries?._id });
  const highest = await apply(Models.ReviewItem.findOne(type === "issue_review" ? { agency_id: issue.agency_id, issue_id: issue._id, type } : { agency_id: issue.agency_id, evaluation_series_id: evaluationSeries._id, type }).sort({ generation: -1 }).select("generation state"), session);
  const generation = (highest?.generation || 0) + 1;
  const lineagePrevious = highest || previous;
  const [item] = await Models.ReviewItem.create([{
    agency_id: issue.agency_id, client_id: issue.client_id, issue_id: issue._id,
    meta_ad_account_id: issue.meta_ad_account_id, meta_binding_revision_snapshot: account.binding_revision,
    campaign_id: issue.scope?.entity?.campaign_id || issue.scope?.entity?.id, report_id: issue.latest_report_id, report_run_id: issue.latest_report_run_id,
    signal_id: issue.latest_signal_id, evaluation_series_id: evaluationSeries?._id || null, evaluation_id: evaluation?._id || null,
    previous_review_item_id: lineagePrevious?._id || null, type, generation, active_key: identity, reason, state: "open",
    priority: priority.priority, priority_rank: priority.priorityRank, priority_source: priority.prioritySource,
    source_revision: sourceRevision, last_projected_event_key: eventKey, last_projected_event_hash: eventHash,
    opened_at: now, latest_evidence_at: latestEvidenceAt, action_sequence: 1, revision: 1,
    context_snapshot: contextSnapshot({ client, account, issue, report, sourceTitle: evaluation?.summary || signal?.title || issue.title, sourceSummary: evaluation?.summary || signal?.description || issue.summary, capturedAt: now }),
  }], { session });
  const actionType = openingAction || (type === "issue_review" ? "opened_from_issue" : "opened_from_evaluation");
  await Models.ReviewAction.create([{
    agency_id: item.agency_id, client_id: item.client_id, issue_id: item.issue_id, review_item_id: item._id,
    sequence: 1, action_type: actionType, actor_type: "system", prior_state: "open", resulting_state: "open",
    item_revision_before: 0, item_revision_after: 1, source_revision: item.source_revision,
    source_snapshot: sourceSnapshot(item, now), signal_id: signal?._id || null, evaluation_id: evaluation?._id || null,
    occurred_at: now, recorded_at: now, idempotency_key: actionKey(item, eventKey, actionType), request_hash: eventHash,
  }], { session });
  await activityFor({ item, type: "review_item_created", title: "Review item created", description: item.context_snapshot.source_summary, reason, Models, session });
  return item;
};

const recoverDuplicateWinner = async ({ agencyId, type, issueId, evaluationSeriesId = null, evaluationId = null, sourceRevision, eventKey, eventHash, reason, Models }) => {
  const activeKey = reviewActiveKey({ type, issueId, evaluationSeriesId });
  const winner = await Models.ReviewItem.findOne({ agency_id: agencyId, active_key: activeKey });
  if (!winner) return null;
  const identityMatches = same(winner.agency_id, agencyId) && winner.type === type &&
    same(winner.issue_id, issueId) && winner.active_key === activeKey &&
    (type === "issue_review" ? winner.evaluation_series_id == null && winner.evaluation_id == null : same(winner.evaluation_series_id, evaluationSeriesId) && same(winner.evaluation_id, evaluationId)) &&
    REVIEW_ACTIVE_STATES.includes(winner.state) && Number.isSafeInteger(winner.generation) && winner.generation >= 1 &&
    winner.source_revision === sourceRevision && winner.last_projected_event_key === eventKey &&
    winner.last_projected_event_hash === eventHash && winner.reason === reason;
  if (!identityMatches) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review projection duplicate winner does not match the requested source event.", 409);
  if (winner.generation === 1) {
    if (winner.previous_review_item_id != null) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review projection generation lineage is inconsistent.", 409);
  } else {
    if (!winner.previous_review_item_id) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review projection generation lineage is incomplete.", 409);
    const previous = await Models.ReviewItem.findOne({ _id: winner.previous_review_item_id, agency_id: agencyId });
    const sourceMatches = type === "issue_review" ? same(previous?.issue_id, issueId) : same(previous?.evaluation_series_id, evaluationSeriesId);
    if (!previous || previous.type !== type || !sourceMatches || previous.generation !== winner.generation - 1 || !terminalStates.includes(previous.state)) {
      throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review projection generation lineage is inconsistent.", 409);
    }
  }
  return Models.ReviewItem.findOne({
    _id: winner._id,
    agency_id: agencyId,
    client_id: winner.client_id,
    issue_id: issueId,
    type,
    evaluation_series_id: type === "issue_review" ? null : evaluationSeriesId,
    evaluation_id: type === "issue_review" ? null : evaluationId,
    generation: winner.generation,
    previous_review_item_id: winner.previous_review_item_id || null,
    active_key: activeKey,
    state: { $in: REVIEW_ACTIVE_STATES },
    source_revision: sourceRevision,
    last_projected_event_key: eventKey,
    last_projected_event_hash: eventHash,
    reason,
  });
};

const projectIssueReviewOnce = async ({ agencyId, issueId, classification = "evidence", now = new Date(), Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady } = {}) => {
  assertReady();
  return transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review projection requires a transaction-capable database deployment.", work: async (session) => {
    const context = await issueContext({ agencyId, issueId, Models, session });
    if (!context?.issue || !context.client || context.client.is_archived || !context.account || context.account.is_active !== true || context.account.is_accessible !== true || !same(context.account.client_id, context.issue.client_id) || !Number.isSafeInteger(context.account.binding_revision)) return { deferred: false, skipped: true };
    const { issue } = context;
    const eventKey = `phase5:issue:${issue._id}:revision:${issue.lifecycle_revision}:${classification}`;
    const eventHash = actionHash({ eventKey, status: issue.status, severity: issue.current_severity, signalId: issue.latest_signal_id, reportRunId: issue.latest_report_run_id });
    const active = await apply(Models.ReviewItem.findOne({ agency_id: agencyId, active_key: reviewActiveKey({ type: "issue_review", issueId: issue._id }) }), session);
    if (issue.status === "resolved") {
      if (!active) return { skipped: true };
      if (active.last_projected_event_key === eventKey) {
        if (active.last_projected_event_hash !== eventHash) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review projection integrity conflict.", 409);
        return { item: active, replay: true };
      }
      const item = await transition({ item: active, operation: "system_close", actionType: "closed_source_resolved", resultingState: "closed", eventKey, eventHash, occurredAt: now, set: { closed_at: now, close_reason: "source_resolved" }, activity: { type: "review_item_closed", title: "Review item closed", description: "The source Issue was resolved.", reason: "source_resolved" }, Models, session });
      return { item };
    }
    if (!["open", "monitoring"].includes(issue.status)) return { skipped: true };
    const priority = reviewPriorityForIssueSeverity(issue.current_severity);
    if (!active) {
      const previous = await apply(Models.ReviewItem.findOne({ agency_id: agencyId, issue_id: issue._id, type: "issue_review" }).sort({ generation: -1 }), session);
      const reason = issueReason(classification, (previous?.generation || 0) + 1);
      const item = await createItem({ type: "issue_review", reason, eventKey, eventHash, priority, sourceRevision: issue.lifecycle_revision, latestEvidenceAt: issue.last_seen_at, context, previous, openingAction: classification === "reconciliation" ? "reconciliation_recovered" : null, Models, session, now });
      return { item, created: true };
    }
    if (active.source_revision > issue.lifecycle_revision) return { item: active, stale: true };
    if (active.last_projected_event_key === eventKey) {
      if (active.last_projected_event_hash !== eventHash) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review projection integrity conflict.", 409);
      return { item: active, replay: true };
    }
    const shouldReopen = classification !== "clean_observation" && ["acknowledged", "snoozed"].includes(active.state);
    if (shouldReopen) {
      const actionType = priority.priorityRank < active.priority_rank ? "reopened_by_severity" : "reopened_by_evidence";
      const item = await transition({ item: active, operation: "system_reopen", actionType, resultingState: "open", eventKey, eventHash, occurredAt: now, signalId: issue.latest_signal_id, set: { reason: priority.priorityRank < active.priority_rank ? "issue_severity_escalated" : "issue_new_evidence", priority: priority.priority, priority_rank: priority.priorityRank, priority_source: priority.prioritySource, source_revision: issue.lifecycle_revision, signal_id: issue.latest_signal_id, report_id: issue.latest_report_id, report_run_id: issue.latest_report_run_id, latest_evidence_at: issue.last_seen_at }, activity: { type: "review_item_reopened", title: "Review item reopened", description: issue.summary, reason: actionType }, Models, session });
      return { item };
    }
    const item = await refreshReviewItemSource({ item: active, source: { revision: issue.lifecycle_revision, signalId: issue.latest_signal_id, reportId: issue.latest_report_id, reportRunId: issue.latest_report_run_id, latestEvidenceAt: issue.last_seen_at }, priority, eventKey, eventHash, occurredAt: now, Models, session });
    return { item };
  } });
};

export const projectIssueReview = async (options = {}) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await projectIssueReviewOnce(options); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      const Models = options.Models || defaultModels;
      const issue = await Models.Issue.findOne({ _id: options.issueId, agency_id: options.agencyId }).lean();
      if (!issue) return { skipped: true };
      const eventKey = `phase5:issue:${issue._id}:revision:${issue.lifecycle_revision}:${options.classification || "evidence"}`;
      const eventHash = actionHash({ eventKey, status: issue.status, severity: issue.current_severity, signalId: issue.latest_signal_id, reportRunId: issue.latest_report_run_id });
      const active = await Models.ReviewItem.findOne({ agency_id: options.agencyId, active_key: reviewActiveKey({ type: "issue_review", issueId: issue._id }) });
      const reason = issueReason(options.classification || "evidence", active?.generation || 1);
      const winner = await recoverDuplicateWinner({ agencyId: options.agencyId, type: "issue_review", issueId: issue._id, sourceRevision: issue.lifecycle_revision, eventKey, eventHash, reason, Models });
      if (winner) return { item: winner, replay: true, duplicateRecovered: true };
      if (attempt === 3) return { deferred: true };
    }
  }
  return { deferred: true };
};

const projectEvaluationReviewOnce = async ({ agencyId, evaluationSeriesId, classification = "source", now = new Date(), Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady } = {}) => {
  assertReady();
  return transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review projection requires a transaction-capable database deployment.", work: async (session) => {
    const series = await apply(Models.EvaluationSeries.findOne({ _id: evaluationSeriesId, agency_id: agencyId }), session);
    if (!series?.current_evaluation_id) return { skipped: true };
    const evaluation = await apply(Models.Evaluation.findOne({ _id: series.current_evaluation_id, agency_id: agencyId }), session);
    if (!evaluation) return { skipped: true };
    const context = await issueContext({ agencyId, issueId: evaluation.issue_id, Models, session });
    if (
      !context?.client || context.client.is_archived || !context.account ||
      context.account.is_active !== true || context.account.is_accessible !== true ||
      !same(context.account.client_id, context.issue.client_id) ||
      !Number.isSafeInteger(context.account.binding_revision)
    ) return { skipped: true };
    const eventKey = `phase5:evaluation-series:${series._id}:sequence:${evaluation.sequence}`;
    const eventHash = actionHash({ eventKey, evaluationId: evaluation._id, status: evaluation.status, observedResult: evaluation.observed_result, evidenceHash: evaluation.evidence_hash });
    const key = reviewActiveKey({ type: "evaluation_review", evaluationSeriesId: series._id });
    const active = await apply(Models.ReviewItem.findOne({ agency_id: agencyId, active_key: key }), session);
    const eligible = evaluation.status === "ready" && ["improved", "worsened", "mixed", "no_material_change"].includes(evaluation.observed_result);
    if (active && !same(active.evaluation_id, evaluation._id)) {
      await transition({ item: active, operation: "system_supersede", actionType: "superseded_by_evaluation", resultingState: "superseded", eventKey, eventHash, occurredAt: now, evaluationId: evaluation._id, set: { closed_at: now, close_reason: "evaluation_superseded" }, activity: { type: "review_item_superseded", title: "Review item superseded", description: evaluation.summary, reason: "evaluation_superseded" }, Models, session });
    } else if (active && !eligible) {
      const item = await transition({ item: active, operation: "system_close", actionType: "invalidated_by_source", resultingState: "closed", eventKey, eventHash, occurredAt: now, evaluationId: evaluation._id, set: { closed_at: now, close_reason: "source_invalidated" }, activity: { type: "review_item_closed", title: "Review item closed", description: evaluation.summary, reason: "source_invalidated" }, Models, session });
      return { item };
    } else if (active && active.last_projected_event_key === eventKey) {
      if (active.last_projected_event_hash !== eventHash) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "Review projection integrity conflict.", 409);
      return { item: active, replay: true };
    }
    if (!eligible) return { skipped: true };
    const current = await apply(Models.ReviewItem.findOne({ agency_id: agencyId, active_key: key }), session);
    if (current) return { item: current, replay: true };
    const previous = await apply(Models.ReviewItem.findOne({ agency_id: agencyId, evaluation_series_id: series._id, type: "evaluation_review" }).sort({ generation: -1 }), session);
    const priority = reviewPriorityForEvaluationResult(evaluation.observed_result);
    const item = await createItem({ type: "evaluation_review", reason: evaluationReason(classification, (previous?.generation || 0) + 1), eventKey, eventHash, priority, sourceRevision: evaluation.sequence, latestEvidenceAt: evaluation.calculated_at, context, evaluationSeries: series, evaluation, previous, openingAction: classification === "reconciliation" ? "reconciliation_recovered" : null, Models, session, now });
    return { item, created: true };
  } });
};

export const projectEvaluationReview = async (options = {}) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await projectEvaluationReviewOnce(options); }
    catch (error) {
      if (error?.code !== 11000) throw error;
      const Models = options.Models || defaultModels;
      const series = await Models.EvaluationSeries.findOne({ _id: options.evaluationSeriesId, agency_id: options.agencyId }).lean();
      const evaluation = series?.current_evaluation_id ? await Models.Evaluation.findOne({ _id: series.current_evaluation_id, agency_id: options.agencyId }).lean() : null;
      if (!series || !evaluation) return { skipped: true };
      const eventKey = `phase5:evaluation-series:${series._id}:sequence:${evaluation.sequence}`;
      const eventHash = actionHash({ eventKey, evaluationId: evaluation._id, status: evaluation.status, observedResult: evaluation.observed_result, evidenceHash: evaluation.evidence_hash });
      const active = await Models.ReviewItem.findOne({ agency_id: options.agencyId, active_key: reviewActiveKey({ type: "evaluation_review", evaluationSeriesId: series._id }) });
      const reason = evaluationReason(options.classification || "source", active?.generation || 1);
      const winner = await recoverDuplicateWinner({ agencyId: options.agencyId, type: "evaluation_review", issueId: evaluation.issue_id, evaluationSeriesId: series._id, evaluationId: evaluation._id, sourceRevision: evaluation.sequence, eventKey, eventHash, reason, Models });
      if (winner) return { item: winner, replay: true, duplicateRecovered: true };
      if (attempt === 3) return { deferred: true };
    }
  }
  return { deferred: true };
};

export const projectInterventionReview = async ({ agencyId, interventionId, triggerType = "intervention_recorded", now = new Date(), Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady } = {}) => {
  assertReady();
  const intervention = await Models.Intervention.findOne({ _id: interventionId, agency_id: agencyId }).select("+review_origin");
  if (!intervention) return { skipped: true };
  if (triggerType === "cancellation") {
    return projectIssueReview({ agencyId, issueId: intervention.issue_id, classification: "cancelled", now, Models, transactionRunner, assertReady });
  }
  if (intervention.review_origin) return { skipped: true, ownedByReviewOrchestration: true };
  if (intervention.action_type === "internal_note") return { skipped: true };
  return transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review projection requires a transaction-capable database deployment.", work: async (session) => {
    const item = await apply(Models.ReviewItem.findOne({ agency_id: agencyId, issue_id: intervention.issue_id, type: "issue_review", state: activeStates }).sort({ generation: -1 }), session);
    if (!item) return { skipped: true };
    const eventKey = `phase5:intervention:${intervention._id}:revision:${intervention.revision}:${intervention.status}`;
    const decisionType = intervention.action_type === "monitor_only" ? "monitor_only" : intervention.action_type === "no_action" ? "no_action" : "campaign_action";
    const eventHash = actionHash({ eventKey, reviewItemId: item._id, actionType: intervention.action_type, decisionType, status: intervention.status });
    const actor = {
      userId: intervention.recorded_by_user_id,
      snapshot: {
        version: 1,
        captured_at: intervention.recorded_by_snapshot?.captured_at || intervention.recorded_at,
        display_name: String(intervention.recorded_by_snapshot?.display_name || "Workspace member").slice(0, 256),
        workspace_role: ["owner", "member"].includes(intervention.recorded_by_snapshot?.workspace_role) ? intervention.recorded_by_snapshot.workspace_role : "member",
        provenance: "workspace_member",
      },
    };
    const updated = await transition({ item, operation: "human_review", actionType: "intervention_recorded", actorType: "human", actor, decisionType, resultingState: "reviewed", eventKey, eventHash, occurredAt: intervention.recorded_at || now, interventionId: intervention._id, set: { reviewed_at: intervention.recorded_at || now, reviewed_by_user_id: actor.userId, reviewed_by_snapshot: actor.snapshot, intervention_id: intervention._id }, Models, session });
    return { item: updated };
  } });
};

export const closeReviewItemsForAuthority = async ({ agencyId, clientId = null, accountId = null, limit = 50, now = new Date(), Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady } = {}) => {
  assertReady();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 50));
  return transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review authority projection requires a transaction-capable database deployment.", work: async (session) => {
    const items = await apply(Models.ReviewItem.find({ agency_id: agencyId, state: activeStates, ...(clientId ? { client_id: clientId } : {}), ...(accountId ? { meta_ad_account_id: accountId } : {}) }).sort({ _id: 1 }).limit(safeLimit), session);
    const authorities = await loadReviewAuthorityBatch({ agencyId, reviewItems: items, Models, session });
    const closedItems = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const { client, metaAccount: account } = authorities[index];
      let reason = null;
      if (!client || client.is_archived) reason = client?.is_archived ? "client_archived" : "source_invalidated";
      else if (!account || !same(account.client_id, item.client_id) || account.binding_revision !== item.meta_binding_revision_snapshot) reason = account ? "account_reassigned" : "source_invalidated";
      if (!reason) continue;
      const actionType = reason === "client_archived" ? "closed_client_archived" : reason === "account_reassigned" ? "closed_account_reassigned" : "invalidated_by_source";
      const eventKey = `phase5:authority:${reason}:item:${item._id}:revision:${item.revision}`;
      const eventHash = actionHash({ eventKey, reason, clientId: item.client_id, accountId: item.meta_ad_account_id, bindingRevision: account?.binding_revision ?? null });
      const updated = await transition({ item, operation: "system_close", actionType, resultingState: "closed", eventKey, eventHash, occurredAt: now, set: { closed_at: now, close_reason: reason }, activity: { type: "review_item_closed", title: "Review item closed", description: reason === "client_archived" ? "The Client was archived." : "The Meta account assignment changed.", reason }, Models, session });
      closedItems.push(updated);
    }
    return { processed: items.length, closed: closedItems.length, hasMore: items.length === safeLimit };
  } });
};

export const reconcileReviewItemAuthority = async ({ agencyId, reviewItemId, now = new Date(), Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady } = {}) => {
  assertReady();
  return transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review authority reconciliation requires a transaction-capable database deployment.", work: async (session) => {
    const item = await apply(Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId }), session);
    if (!item || !REVIEW_ACTIVE_STATES.includes(item.state)) return { skipped: true };
    const authority = (await loadReviewAuthorityBatch({ agencyId, reviewItems: [item], Models, session }))[0];
    const effective = resolveReviewEffectiveState({ ...authority, now });
    if (item.state === "snoozed" && effective.snoozedVisibility === "expired_actionable") {
      const eventKey = `phase5:item:${item._id}:snooze-expired:${new Date(item.snoozed_until).toISOString()}`;
      const eventHash = actionHash({ eventKey, sourceRevision: item.source_revision });
      const updated = await transition({ item, operation: "system_reopen", actionType: "snooze_expired", resultingState: "open", eventKey, eventHash, occurredAt: now, set: {}, Models, session });
      return { item: updated, reopened: true };
    }
    if (!["closed", "superseded"].includes(effective.effectiveState)) return { item, noChange: true };
    const reason = effective.effectiveCloseReason || "source_invalidated";
    const actionType = reason === "source_resolved" ? "closed_source_resolved" : reason === "client_archived" ? "closed_client_archived" : reason === "account_reassigned" ? "closed_account_reassigned" : reason === "evaluation_superseded" ? "superseded_by_evaluation" : "invalidated_by_source";
    const eventKey = `phase5:reconcile:authority:${item._id}:revision:${item.revision}`;
    const eventHash = actionHash({ eventKey, reason, effectiveState: effective.effectiveState });
    const updated = await transition({ item, operation: effective.effectiveState === "superseded" ? "system_supersede" : "system_close", actionType, resultingState: effective.effectiveState, eventKey, eventHash, occurredAt: now, set: { closed_at: now, close_reason: reason }, activity: { type: effective.effectiveState === "superseded" ? "review_item_superseded" : "review_item_closed", title: effective.effectiveState === "superseded" ? "Review item superseded" : "Review item closed", description: "Review authority changed.", reason }, Models, session });
    return { item: updated };
  } });
};

export const projectSourceSafely = async (processor, options, { operation = "source_projection" } = {}) => {
  try { return await processor(options); }
  catch (error) {
    if (error?.code !== REVIEW_ERROR.INDEXES_NOT_READY) logError("Review", "REVIEW_PROJECTION_ISOLATED_FAILURE", error, { operation });
    return { deferred: true };
  }
};

export const reviewProjectionInternals = { appendAction, contextSnapshot, createItem, issueContext, recoverDuplicateWinner, refreshReviewItemSource, transition };
