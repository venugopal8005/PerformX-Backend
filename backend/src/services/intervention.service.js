import mongoose from "mongoose";

import {
  Activity,
  Client,
  Intervention,
  Issue,
  MetaAdAccount,
  Report,
  ReportRun,
  Signal,
  User,
  WorkspaceMember,
} from "../models/index.js";
import {
  INTERVENTION_ERROR,
  INTERVENTION_LIMITS,
  buildInterventionRequestHash,
  createInterventionError,
  normalizeBoundedText,
  normalizeInterventionAction,
  normalizeInterventionIdempotencyKey,
  normalizePerformedAt,
} from "../domain/phase3Intervention.domain.js";
import { recordActivity } from "./activityRecorder.service.js";
import {
  acquireClientLifecycleLease,
  createClientLifecycleError,
  fenceClientLifecycleLeaseInTransaction,
  releaseClientLifecycleLease,
  startClientLifecycleLeaseHeartbeat,
} from "./clientLifecycle.service.js";
import {
  buildInterventionEvidenceSnapshots,
  buildManualActorSnapshot,
  buildWorkspaceActorSnapshot,
  normalizePerformerRequest,
} from "./interventionSnapshots.service.js";
import { assertPhase3InterventionIntegrityReady } from "./phase3InterventionIndexes.service.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";
import {
  normalizeEvaluationIntent,
  resolveEvaluationIntent,
} from "../domain/phase4Evaluation.domain.js";
import { processInterventionEvaluation } from "./evaluation.service.js";
import { logError } from "../utils/controllerLogger.js";

const defaultModels = {
  Activity,
  Client,
  Intervention,
  Issue,
  MetaAdAccount,
  Report,
  ReportRun,
  Signal,
  User,
  WorkspaceMember,
};

const processEvaluationSafely = async (evaluationProcessor, options) => {
  try {
    return await evaluationProcessor(options);
  } catch (error) {
    logError("Interventions", "EVALUATION_PROCESSING_ISOLATED_FAILURE", error, {
      interventionId: options.interventionId,
      triggerType: options.triggerType,
    });
    return null;
  }
};

const sameId = (left, right) => Boolean(left && right && String(left) === String(right));
const userIdFrom = (actor) => actor?.userId || actor?.id || actor?._id;
const validRevision = (value, field) => {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw createInterventionError(
      INTERVENTION_ERROR.VALIDATION,
      `${field} must be a non-negative integer.`,
      400
    );
  }
  return revision;
};
const validDateInput = (value) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    throw createInterventionError(
      INTERVENTION_ERROR.VALIDATION,
      "performedAt is invalid.",
      400
    );
  }
  return date;
};
const applySession = (query, session) =>
  session && typeof query?.session === "function" ? query.session(session) : query;

const canonicalCreateRequest = (input = {}) => {
  const action = normalizeInterventionAction(input);
  const performedBy = normalizePerformerRequest(input.performedBy);
  return {
    idempotencyKey: normalizeInterventionIdempotencyKey(input.idempotencyKey),
    expectedIssueRevision: validRevision(input.expectedIssueRevision, "expectedIssueRevision"),
    performedBy,
    evaluationIntent: normalizeEvaluationIntent(input.evaluationIntent, { allowMissing: true }),
    ...action,
    performedAt: validDateInput(input.performedAt),
  };
};

const canonicalCorrectionRequest = (input = {}) => ({
  ...canonicalCreateRequest({ ...input, expectedIssueRevision: 0 }),
  expectedRevision: validRevision(input.expectedRevision, "expectedRevision"),
});

const canonicalCancellationRequest = (input = {}) => ({
  idempotencyKey: normalizeInterventionIdempotencyKey(input.idempotencyKey),
  expectedRevision: validRevision(input.expectedRevision, "expectedRevision"),
  reason: normalizeBoundedText(input.reason, {
    field: "reason",
    maximum: INTERVENTION_LIMITS.reason,
    required: true,
  }),
});

const requestPayloadForHash = (request) => ({
  ...request,
  evaluationIntent: request.evaluationIntent || undefined,
  performedAt: request.performedAt?.toISOString?.() || request.performedAt,
  idempotencyKey: undefined,
  expectedIssueRevision:
    request.expectedIssueRevision === 0 && request.expectedRevision !== undefined
      ? undefined
      : request.expectedIssueRevision,
});

const existingByKey = async ({ agencyId, key, Models, session = null }) => {
  const query = Models.Intervention.findOne({
    agency_id: agencyId,
    idempotency_key: key,
  }).select("+request_hash");
  return applySession(query, session);
};

const replayOrConflict = (existing, requestHash) => {
  if (!existing) return null;
  if (existing.request_hash === requestHash) {
    return { intervention: existing, idempotentReplay: true };
  }
  throw createInterventionError(
    INTERVENTION_ERROR.IDEMPOTENCY_CONFLICT,
    "The idempotency key was already used for another Intervention request.",
    409
  );
};

const requireRecorder = async ({ agencyId, recorderId, Models, session, capturedAt }) => {
  const [user, membership] = await Promise.all([
    applySession(Models.User.findById(recorderId), session),
    applySession(
      Models.WorkspaceMember.findOne({
        workspace_id: agencyId,
        user_id: recorderId,
        status: "active",
      }),
      session
    ),
  ]);
  if (!user || !membership) {
    throw createInterventionError(
      INTERVENTION_ERROR.PERMISSION,
      "Active workspace membership is required.",
      403
    );
  }
  return {
    user,
    membership,
    snapshot: buildWorkspaceActorSnapshot({ user, membership, capturedAt }),
  };
};

const resolvePerformer = async ({
  request,
  recorder,
  agencyId,
  Models,
  session,
  capturedAt,
}) => {
  if (request.mode === "manual") {
    return {
      userId: null,
      snapshot: buildManualActorSnapshot({
        displayName: request.displayName,
        email: request.email,
        capturedAt,
      }),
    };
  }
  const selectedId = request.mode === "self" ? recorder.user._id : request.userId;
  if (request.mode === "self") {
    return { userId: recorder.user._id, snapshot: recorder.snapshot };
  }
  if (!mongoose.isObjectIdOrHexString(selectedId)) {
    throw createInterventionError(
      INTERVENTION_ERROR.VALIDATION,
      "performedBy.userId is invalid.",
      400
    );
  }
  const selected = await requireRecorder({
    agencyId,
    recorderId: selectedId,
    Models,
    session,
    capturedAt,
  });
  return { userId: selected.user._id, snapshot: selected.snapshot };
};

const permissionForLifecycleChange = ({ intervention, recorder }) => {
  const ownRecord = sameId(intervention.recorded_by_user_id, recorder.user._id);
  const role = recorder.membership.role;
  const highestAuthority = role === "owner";
  if (ownRecord || highestAuthority) return true;
  throw createInterventionError(
    INTERVENTION_ERROR.PERMISSION,
    "Only the original recorder or workspace owner can change this Intervention.",
    403
  );
};

const assertLineage = ({ issue, client, account, signal, reportRun, report, agencyId }) => {
  const campaignId = String(issue?.scope?.entity?.campaign_id || "").trim();
  const signalCampaignId = String(
    signal?.scope?.entity?.campaign_id || signal?.campaign_id || ""
  ).trim();
  const runCampaignIds = (reportRun?.monitored_campaigns || []).map((item) =>
    String(item?.campaign_id || "").trim()
  );
  const reportCampaignIds = (report?.monitored_campaigns || []).map((item) =>
    String(item?.campaign_id || "").trim()
  );
  const scope = issue?.scope || {};
  const valid =
    client &&
    client.is_archived !== true &&
    account &&
    signal &&
    reportRun &&
    report &&
    sameId(issue.agency_id, agencyId) &&
    sameId(issue.client_id, client._id) &&
    sameId(issue.meta_ad_account_id, account._id) &&
    sameId(scope.agency_id, agencyId) &&
    sameId(scope.client_id, issue.client_id) &&
    sameId(scope.meta_ad_account_id, issue.meta_ad_account_id) &&
    campaignId &&
    sameId(scope.entity?.id, campaignId) &&
    scope.entity?.level === "campaign" &&
    sameId(account.agency_id, agencyId) &&
    sameId(account.client_id, issue.client_id) &&
    sameId(signal.agency_id, agencyId) &&
    sameId(signal.client_id, issue.client_id) &&
    sameId(signal.issue_id, issue._id) &&
    sameId(signal._id, issue.latest_signal_id) &&
    sameId(signal.report_id, issue.latest_report_id) &&
    sameId(signal.report_run_id, issue.latest_report_run_id) &&
    sameId(signalCampaignId, campaignId) &&
    sameId(reportRun._id, issue.latest_report_run_id) &&
    sameId(reportRun.agency_id, agencyId) &&
    sameId(reportRun.client_id, issue.client_id) &&
    sameId(reportRun.report_id, issue.latest_report_id) &&
    sameId(reportRun.meta_ad_account_id, issue.meta_ad_account_id) &&
    runCampaignIds.includes(campaignId) &&
    sameId(report._id, issue.latest_report_id) &&
    sameId(report.agency_id, agencyId) &&
    sameId(report.client_id, issue.client_id) &&
    sameId(report.meta_ad_account_id, issue.meta_ad_account_id) &&
    reportCampaignIds.includes(campaignId);

  if (!valid) {
    throw createInterventionError(
      INTERVENTION_ERROR.OWNERSHIP,
      "Persisted Intervention ownership or Issue lineage is inconsistent.",
      409
    );
  }
  return campaignId;
};

const loadWriteContext = async ({
  agencyId,
  issueId,
  recorderId,
  performerRequest,
  leaseToken,
  capturedAt,
  Models,
  session,
}) => {
  const issue = await applySession(
    Models.Issue.findOne({ _id: issueId, agency_id: agencyId }),
    session
  );
  if (!issue) {
    throw createInterventionError(INTERVENTION_ERROR.ISSUE_NOT_FOUND, "Issue not found.", 404);
  }
  const client = await fenceClientLifecycleLeaseInTransaction({
    agencyId,
    clientId: issue.client_id,
    token: leaseToken,
    session,
    now: capturedAt,
    ClientModel: Models.Client,
  });
  const [account, signal, reportRun, report, recorder] = await Promise.all([
    applySession(Models.MetaAdAccount.findOne({ _id: issue.meta_ad_account_id, agency_id: agencyId }), session),
    applySession(Models.Signal.findOne({ _id: issue.latest_signal_id, agency_id: agencyId }), session),
    applySession(Models.ReportRun.findOne({ _id: issue.latest_report_run_id, agency_id: agencyId }), session),
    applySession(Models.Report.findOne({ _id: issue.latest_report_id, agency_id: agencyId }), session),
    requireRecorder({ agencyId, recorderId, Models, session, capturedAt }),
  ]);
  const campaignId = assertLineage({ issue, client, account, signal, reportRun, report, agencyId });
  const performer = await resolvePerformer({
    request: performerRequest,
    recorder,
    agencyId,
    Models,
    session,
    capturedAt,
  });
  return { issue, client, account, signal, reportRun, report, recorder, performer, campaignId };
};

const interventionRevisionScope = (revision) =>
  revision === 0
    ? { $or: [{ intervention_revision: 0 }, { intervention_revision: { $exists: false } }] }
    : { intervention_revision: revision };

const updateIssueCaches = async ({ issue, interventionId, recordedAt, Models, session }) => {
  const interventionRevision = issue.intervention_revision || 0;
  const updated = await Models.Issue.findOneAndUpdate(
    {
      $and: [
        {
          _id: issue._id,
          agency_id: issue.agency_id,
          lifecycle_revision: issue.lifecycle_revision,
        },
        interventionRevisionScope(interventionRevision),
      ],
    },
    {
      $set: {
        latest_intervention_id: interventionId,
        last_intervention_at: recordedAt,
      },
      $inc: { intervention_count: 1, intervention_revision: 1 },
    },
    { new: true, session }
  );
  if (!updated) {
    throw createInterventionError(
      INTERVENTION_ERROR.STALE_ISSUE,
      "The Issue changed while the Intervention was being recorded.",
      409
    );
  }
  return updated;
};

const actionSummary = (intervention) =>
  String(
    intervention.action_payload?.change_summary ||
      intervention.reason ||
      intervention.note ||
      intervention.action_type
  ).slice(0, INTERVENTION_LIMITS.summary);

const recordInterventionActivity = async ({
  type,
  intervention,
  recorder,
  Models,
  session,
}) => {
  const event = type.replace("intervention_", "");
  return recordActivity({
    agency_id: intervention.agency_id,
    client_id: intervention.client_id,
    report_id: intervention.report_id_at_action,
    user_id: recorder.user._id,
    type,
    title: `Intervention ${event}: ${intervention.action_type}`,
    description: actionSummary(intervention),
    severity: "stable",
    idempotency_key: `phase3:agency:${intervention.agency_id}:intervention:${intervention._id}:${event}`,
    metadata: {
      intervention_id: intervention._id,
      issue_id: intervention.issue_id,
      action_type: intervention.action_type,
      recorder_display_name_snapshot: recorder.snapshot.display_name,
    },
    session,
    ActivityModel: Models.Activity,
  });
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const acquireInterventionClientLease = async ({ agencyId, clientId, Models }) => {
  for (let attempt = 0; attempt <= INTERVENTION_LIMITS.leaseRetryCount; attempt += 1) {
    const lease = await acquireClientLifecycleLease({
      agencyId,
      clientId,
      operation: "intervention_write",
      ClientModel: Models.Client,
    });
    if (lease.acquired) return lease;
    if (
      lease.reason !== "client_lifecycle_operation_in_progress" ||
      attempt === INTERVENTION_LIMITS.leaseRetryCount
    ) {
      throw createClientLifecycleError(lease.reason);
    }
    await wait(INTERVENTION_LIMITS.leaseRetryDelayMs);
  }
  throw createClientLifecycleError("client_lifecycle_operation_in_progress");
};

const withClientLease = async ({ agencyId, clientId, Models, work }) => {
  const lease = await acquireInterventionClientLease({ agencyId, clientId, Models });
  const heartbeat = startClientLifecycleLeaseHeartbeat({
    agencyId,
    clientId,
    token: lease.token,
    ClientModel: Models.Client,
  });
  try {
    const result = await work(lease.token, heartbeat);
    heartbeat.assertOwned();
    return result;
  } finally {
    await heartbeat.stop();
    await releaseClientLifecycleLease({
      agencyId,
      clientId,
      token: lease.token,
      ClientModel: Models.Client,
    }).catch(() => false);
  }
};

const preliminaryIssue = async ({ agencyId, issueId, Models }) => {
  const issue = await Models.Issue.findOne({ _id: issueId, agency_id: agencyId }).select(
    "_id client_id"
  );
  if (!issue) {
    throw createInterventionError(INTERVENTION_ERROR.ISSUE_NOT_FOUND, "Issue not found.", 404);
  }
  return issue;
};

export const createIntervention = async ({
  agencyId,
  recorder: recorderInput,
  issueId,
  input,
  now = new Date(),
  Models = defaultModels,
  transactionRunner = runRequiredTransaction,
  assertIntegrityReady = assertPhase3InterventionIntegrityReady,
  evaluationProcessor = processInterventionEvaluation,
} = {}) => {
  assertIntegrityReady();
  const recorderId = userIdFrom(recorderInput);
  const request = canonicalCreateRequest(input);
  const requestHash = buildInterventionRequestHash({
    operation: "create",
    agencyId,
    targetId: issueId,
    payload: requestPayloadForHash(request),
  });
  const replay = replayOrConflict(
    await existingByKey({ agencyId, key: request.idempotencyKey, Models }),
    requestHash
  );
  if (replay) {
    await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: replay.intervention._id, triggerType: "intervention_recorded", actor: recorderInput, Models });
    return replay;
  }
  const issue = await preliminaryIssue({ agencyId, issueId, Models });

  try {
    const outcome = await withClientLease({
      agencyId,
      clientId: issue.client_id,
      Models,
      work: async (leaseToken, heartbeat) => {
        heartbeat.assertOwned();
        return transactionRunner({
          unavailableCode: INTERVENTION_ERROR.TRANSACTION_REQUIRED,
          unavailableMessage: "Intervention writes require a transaction-capable database deployment.",
          work: async (session) => {
            const duplicate = replayOrConflict(
              await existingByKey({ agencyId, key: request.idempotencyKey, Models, session }),
              requestHash
            );
            if (duplicate) return duplicate;
            const context = await loadWriteContext({
              agencyId,
              issueId,
              recorderId,
              performerRequest: request.performedBy,
              leaseToken,
              capturedAt: now,
              Models,
              session,
            });
            if (context.issue.lifecycle_revision !== request.expectedIssueRevision) {
              throw createInterventionError(
                INTERVENTION_ERROR.STALE_ISSUE,
                "The Issue changed. Refresh it before recording the Intervention.",
                409
              );
            }
            const performedAt = normalizePerformedAt(request.performedAt, {
              openedAt: context.issue.opened_at,
              now,
            });
            const snapshots = buildInterventionEvidenceSnapshots({ ...context, capturedAt: now });
            const evaluationIntent = resolveEvaluationIntent({
              explicitIntent: request.evaluationIntent,
              actionType: request.actionType,
              issue: context.issue,
              signal: context.signal,
            });
            const [intervention] = await Models.Intervention.create(
              [{
                agency_id: agencyId,
                client_id: context.issue.client_id,
                issue_id: context.issue._id,
                meta_ad_account_id: context.issue.meta_ad_account_id,
                campaign_id: context.campaignId,
                report_id_at_action: context.issue.latest_report_id,
                report_run_id_at_action: context.issue.latest_report_run_id,
                performed_by_user_id: context.performer.userId,
                performed_by_snapshot: context.performer.snapshot,
                recorded_by_user_id: context.recorder.user._id,
                recorded_by_snapshot: context.recorder.snapshot,
                action_type: request.actionType,
                action_version: request.actionVersion,
                action_payload: request.actionPayload,
                reason: request.reason,
                note: request.note,
                performed_at: performedAt,
                recorded_at: now,
                issue_snapshot: snapshots.issueSnapshot,
                scope_snapshot: snapshots.scopeSnapshot,
                latest_signal_snapshot: snapshots.latestSignalSnapshot,
                issue_fingerprint_snapshot: context.issue.fingerprint,
                evaluation_intent: evaluationIntent,
                status: "active",
                idempotency_key: request.idempotencyKey,
                request_hash: requestHash,
                revision: 0,
              }],
              { session }
            );
            await updateIssueCaches({
              issue: context.issue,
              interventionId: intervention._id,
              recordedAt: now,
              Models,
              session,
            });
            await recordInterventionActivity({
              type: "intervention_recorded",
              intervention,
              recorder: context.recorder,
              Models,
              session,
            });
            return { intervention, idempotentReplay: false };
          },
        });
      },
    });
    await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: outcome.intervention._id, triggerType: "intervention_recorded", actor: recorderInput, Models });
    return outcome;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const recovered = await existingByKey({ agencyId, key: request.idempotencyKey, Models });
    const result = replayOrConflict(recovered, requestHash);
    if (result) {
      await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: result.intervention._id, triggerType: "intervention_recorded", actor: recorderInput, Models });
      return result;
    }
    throw error;
  }
};

const preliminaryIntervention = async ({ agencyId, interventionId, Models }) => {
  const intervention = await Models.Intervention.findOne({
    _id: interventionId,
    agency_id: agencyId,
  }).select("+request_hash");
  if (!intervention) {
    throw createInterventionError(INTERVENTION_ERROR.NOT_FOUND, "Intervention not found.", 404);
  }
  return intervention;
};

export const correctIntervention = async ({
  agencyId,
  recorder: recorderInput,
  interventionId,
  input,
  now = new Date(),
  Models = defaultModels,
  transactionRunner = runRequiredTransaction,
  assertIntegrityReady = assertPhase3InterventionIntegrityReady,
  evaluationProcessor = processInterventionEvaluation,
} = {}) => {
  assertIntegrityReady();
  const recorderId = userIdFrom(recorderInput);
  const request = canonicalCorrectionRequest(input);
  const requestHash = buildInterventionRequestHash({
    operation: "correct",
    agencyId,
    targetId: interventionId,
    payload: requestPayloadForHash(request),
  });
  const replay = replayOrConflict(
    await existingByKey({ agencyId, key: request.idempotencyKey, Models }),
    requestHash
  );
  if (replay) {
    if (replay.intervention.supersedes_intervention_id) {
      await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: replay.intervention.supersedes_intervention_id, triggerType: "correction", actor: recorderInput, Models });
    }
    await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: replay.intervention._id, triggerType: "correction", actor: recorderInput, Models });
    return replay;
  }
  const original = await preliminaryIntervention({ agencyId, interventionId, Models });

  try {
    const outcome = await withClientLease({
      agencyId,
      clientId: original.client_id,
      Models,
      work: async (leaseToken, heartbeat) => {
        heartbeat.assertOwned();
        return transactionRunner({
          unavailableCode: INTERVENTION_ERROR.TRANSACTION_REQUIRED,
          unavailableMessage: "Intervention corrections require a transaction-capable database deployment.",
          work: async (session) => {
            const duplicate = replayOrConflict(
              await existingByKey({ agencyId, key: request.idempotencyKey, Models, session }),
              requestHash
            );
            if (duplicate) return duplicate;
            const current = await applySession(
              Models.Intervention.findOne({ _id: interventionId, agency_id: agencyId }).select("+request_hash"),
              session
            );
            if (!current) throw createInterventionError(INTERVENTION_ERROR.NOT_FOUND, "Intervention not found.", 404);
            const context = await loadWriteContext({
              agencyId,
              issueId: current.issue_id,
              recorderId,
              performerRequest: request.performedBy,
              leaseToken,
              capturedAt: now,
              Models,
              session,
            });
            permissionForLifecycleChange({ intervention: current, recorder: context.recorder });
            if (current.status !== "active" || current.revision !== request.expectedRevision) {
              throw createInterventionError(
                current.status !== "active" ? INTERVENTION_ERROR.INVALID_STATE : INTERVENTION_ERROR.STALE_REVISION,
                current.status !== "active" ? "Only active Interventions can be corrected." : "The Intervention changed. Refresh before correcting it.",
                409
              );
            }
            const performedAt = normalizePerformedAt(request.performedAt, {
              openedAt: current.issue_snapshot.opened_at,
              now,
            });
            const successorId = new mongoose.Types.ObjectId();
            const transitioned = await Models.Intervention.findOneAndUpdate(
              { _id: current._id, agency_id: agencyId, status: "active", revision: request.expectedRevision },
              {
                $set: {
                  status: "superseded",
                  superseded_by_intervention_id: successorId,
                  corrected_at: now,
                  corrected_by_user_id: context.recorder.user._id,
                  corrected_by_snapshot: context.recorder.snapshot,
                  updatedAt: now,
                },
                $inc: { revision: 1 },
              },
              {
                new: true,
                session,
                runValidators: true,
                timestamps: false,
                phase3InternalOperation: "supersede",
              }
            );
            if (!transitioned) {
              throw createInterventionError(INTERVENTION_ERROR.STALE_REVISION, "The Intervention changed during correction.", 409);
            }
            const evaluationIntent = resolveEvaluationIntent({
              explicitIntent: request.evaluationIntent,
              actionType: request.actionType,
              issue: context.issue,
              signal: context.signal,
            });
            const [successor] = await Models.Intervention.create(
              [{
                _id: successorId,
                agency_id: current.agency_id,
                client_id: current.client_id,
                issue_id: current.issue_id,
                meta_ad_account_id: current.meta_ad_account_id,
                campaign_id: current.campaign_id,
                report_id_at_action: current.report_id_at_action,
                report_run_id_at_action: current.report_run_id_at_action,
                performed_by_user_id: context.performer.userId,
                performed_by_snapshot: context.performer.snapshot,
                recorded_by_user_id: context.recorder.user._id,
                recorded_by_snapshot: context.recorder.snapshot,
                action_type: request.actionType,
                action_version: request.actionVersion,
                action_payload: request.actionPayload,
                reason: request.reason,
                note: request.note,
                performed_at: performedAt,
                recorded_at: now,
                issue_snapshot: current.issue_snapshot,
                scope_snapshot: current.scope_snapshot,
                latest_signal_snapshot: current.latest_signal_snapshot,
                issue_fingerprint_snapshot: current.issue_fingerprint_snapshot,
                evaluation_intent: evaluationIntent,
                status: "active",
                supersedes_intervention_id: current._id,
                idempotency_key: request.idempotencyKey,
                request_hash: requestHash,
                revision: 0,
              }],
              { session }
            );
            await updateIssueCaches({ issue: context.issue, interventionId: successor._id, recordedAt: now, Models, session });
            await recordInterventionActivity({ type: "intervention_corrected", intervention: successor, recorder: context.recorder, Models, session });
            return { intervention: successor, supersededIntervention: transitioned, idempotentReplay: false };
          },
        });
      },
    });
    const predecessorId = outcome.supersededIntervention?._id || outcome.intervention.supersedes_intervention_id;
    if (predecessorId) await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: predecessorId, triggerType: "correction", actor: recorderInput, Models });
    await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: outcome.intervention._id, triggerType: "correction", actor: recorderInput, Models });
    return outcome;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const recovered = await existingByKey({ agencyId, key: request.idempotencyKey, Models });
    const result = replayOrConflict(recovered, requestHash);
    if (result) {
      if (result.intervention.supersedes_intervention_id) {
        await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: result.intervention.supersedes_intervention_id, triggerType: "correction", actor: recorderInput, Models });
      }
      await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: result.intervention._id, triggerType: "correction", actor: recorderInput, Models });
      return result;
    }
    throw createInterventionError(
      INTERVENTION_ERROR.INVALID_STATE,
      "This Intervention already has a correction.",
      409
    );
  }
};

const cancellationReplay = (intervention, key, hash) => {
  if (!intervention?.cancellation || intervention.cancellation.idempotency_key !== key) return null;
  if (intervention.cancellation.request_hash !== hash) {
    throw createInterventionError(
      INTERVENTION_ERROR.IDEMPOTENCY_CONFLICT,
      "The cancellation idempotency key was used for another request.",
      409
    );
  }
  return { intervention, idempotentReplay: true };
};

export const cancelIntervention = async ({
  agencyId,
  recorder: recorderInput,
  interventionId,
  input,
  now = new Date(),
  Models = defaultModels,
  transactionRunner = runRequiredTransaction,
  assertIntegrityReady = assertPhase3InterventionIntegrityReady,
  evaluationProcessor = processInterventionEvaluation,
} = {}) => {
  assertIntegrityReady();
  const recorderId = userIdFrom(recorderInput);
  const request = canonicalCancellationRequest(input);
  const requestHash = buildInterventionRequestHash({
    operation: "cancel",
    agencyId,
    targetId: interventionId,
    payload: { expectedRevision: request.expectedRevision, reason: request.reason },
  });
  const existingReplay = await Models.Intervention.findOne({
    agency_id: agencyId,
    "cancellation.idempotency_key": request.idempotencyKey,
  });
  const replay = cancellationReplay(existingReplay, request.idempotencyKey, requestHash);
  if (replay) {
    await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: replay.intervention._id, triggerType: "cancellation", actor: recorderInput, Models });
    return replay;
  }
  const original = await preliminaryIntervention({ agencyId, interventionId, Models });

  try {
    const outcome = await withClientLease({
      agencyId,
      clientId: original.client_id,
      Models,
      work: async (leaseToken, heartbeat) => {
        heartbeat.assertOwned();
        return transactionRunner({
          unavailableCode: INTERVENTION_ERROR.TRANSACTION_REQUIRED,
          unavailableMessage: "Intervention cancellation requires a transaction-capable database deployment.",
          work: async (session) => {
            const duplicate = await applySession(
              Models.Intervention.findOne({
                agency_id: agencyId,
                "cancellation.idempotency_key": request.idempotencyKey,
              }),
              session
            );
            const duplicateResult = cancellationReplay(duplicate, request.idempotencyKey, requestHash);
            if (duplicateResult) return duplicateResult;
            const current = await applySession(
              Models.Intervention.findOne({ _id: interventionId, agency_id: agencyId }),
              session
            );
            if (!current) throw createInterventionError(INTERVENTION_ERROR.NOT_FOUND, "Intervention not found.", 404);
            const context = await loadWriteContext({
              agencyId,
              issueId: current.issue_id,
              recorderId,
              performerRequest: { mode: "self" },
              leaseToken,
              capturedAt: now,
              Models,
              session,
            });
            permissionForLifecycleChange({ intervention: current, recorder: context.recorder });
            if (current.status !== "active" || current.revision !== request.expectedRevision) {
              throw createInterventionError(
                current.status !== "active" ? INTERVENTION_ERROR.INVALID_STATE : INTERVENTION_ERROR.STALE_REVISION,
                current.status !== "active" ? "Only active Interventions can be cancelled." : "The Intervention changed. Refresh before cancelling it.",
                409
              );
            }
            const cancellation = {
              reason: request.reason,
              cancelled_at: now,
              cancelled_by_user_id: context.recorder.user._id,
              cancelled_by_snapshot: context.recorder.snapshot,
              idempotency_key: request.idempotencyKey,
              request_hash: requestHash,
            };
            const cancelled = await Models.Intervention.findOneAndUpdate(
              { _id: current._id, agency_id: agencyId, status: "active", revision: request.expectedRevision },
              {
                $set: { status: "cancelled", cancellation, updatedAt: now },
                $inc: { revision: 1 },
              },
              {
                new: true,
                session,
                runValidators: true,
                timestamps: false,
                phase3InternalOperation: "cancel",
              }
            );
            if (!cancelled) {
              throw createInterventionError(INTERVENTION_ERROR.STALE_REVISION, "The Intervention changed during cancellation.", 409);
            }
            await recordInterventionActivity({ type: "intervention_cancelled", intervention: cancelled, recorder: context.recorder, Models, session });
            return { intervention: cancelled, idempotentReplay: false };
          },
        });
      },
    });
    await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: outcome.intervention._id, triggerType: "cancellation", actor: recorderInput, Models });
    return outcome;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const recovered = await Models.Intervention.findOne({
      agency_id: agencyId,
      "cancellation.idempotency_key": request.idempotencyKey,
    });
    const result = cancellationReplay(recovered, request.idempotencyKey, requestHash);
    if (result) {
      await processEvaluationSafely(evaluationProcessor, { agencyId, interventionId: result.intervention._id, triggerType: "cancellation", actor: recorderInput, Models });
      return result;
    }
    throw error;
  }
};

export const interventionPermissions = ({ intervention, userId, workspaceRole }) => {
  const allowed =
    intervention?.status === "active" &&
    (sameId(intervention.recorded_by_user_id, userId) || workspaceRole === "owner");
  return { canCorrect: Boolean(allowed), canCancel: Boolean(allowed) };
};

export const interventionServiceInternals = {
  canonicalCreateRequest,
  canonicalCorrectionRequest,
  canonicalCancellationRequest,
  assertLineage,
  permissionForLifecycleChange,
};
