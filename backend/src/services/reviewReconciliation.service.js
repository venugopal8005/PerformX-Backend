import {
  Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, Report, ReviewAction,
  ReviewItem, ReviewReconciliationCheckpoint, Signal, User, WorkspaceMember,
} from "../models/index.js";
import { REVIEW_CHECKPOINT_STREAMS, REVIEW_LIMITS } from "../domain/phase5Review.domain.js";
import { assertPhase5ReviewIntegrityReady } from "./phase5ReviewIndexes.service.js";
import {
  acquireReviewCheckpoint, advanceReviewCheckpoint, completeReviewCheckpoint, heartbeatReviewCheckpoint,
  markReviewCheckpointPoison, releaseReviewCheckpoint, REVIEW_HEARTBEAT_MS,
} from "./reviewCheckpoint.service.js";
import {
  projectEvaluationReview, projectInterventionReview, projectIssueReview, reconcileReviewItemAuthority,
} from "./reviewProjection.service.js";
import { completeReviewFromIntervention } from "./reviewActions.service.js";
import { logError } from "../utils/controllerLogger.js";

const defaultModels = { Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, Report, ReviewAction, ReviewItem, ReviewReconciliationCheckpoint, Signal, User, WorkspaceMember };
const config = Object.freeze({
  issues: { model: "Issue", time: "updatedAt" },
  interventions: { model: "Intervention", time: "updatedAt" },
  evaluation_series: { model: "Evaluation", time: "calculated_at" },
  snoozes: { model: "ReviewItem", time: "snoozed_until" },
  authority: { model: "ReviewItem", time: "createdAt" },
});
const afterCursor = (field, checkpoint) => checkpoint.cursor_time ? { $or: [{ [field]: { $gt: checkpoint.cursor_time } }, { [field]: checkpoint.cursor_time, _id: { $gt: checkpoint.cursor_id } }] } : {};
const sourceQuery = ({ stream, agencyId, checkpoint, now }) => {
  const { time } = config[stream];
  const ownership = agencyId ? { agency_id: agencyId } : {};
  const cursor = afterCursor(time, checkpoint);
  const base = Object.keys(cursor).length ? { ...ownership, $and: [cursor] } : ownership;
  const eventAtOrAfter = (paths) => ({ $or: paths.map((path) => ({ [path]: { $gte: checkpoint.enabled_at } })) });
  if (stream === "issues") return { ...base, $and: [...(base.$and || []), eventAtOrAfter(["createdAt", "opened_at", "last_seen_at", "latest_evidence.observed_at", "resolved_at", "reopened_at"])] };
  if (stream === "interventions") return { ...base, $and: [...(base.$and || []), { $or: [...eventAtOrAfter(["recorded_at", "corrected_at", "cancellation.cancelled_at"]).$or, { review_origin: { $exists: true } }] }] };
  if (stream === "evaluation_series") return { ...base, calculated_at: { $gte: checkpoint.enabled_at } };
  if (stream === "snoozes") return { ...base, state: "snoozed", snoozed_until: { ...(base.snoozed_until || {}), $lte: now } };
  return { ...base, state: { $in: ["open", "acknowledged", "snoozed"] } };
};
const processSource = async ({ stream, source, Models, now }) => {
  if (stream === "issues") return projectIssueReview({ agencyId: source.agency_id, issueId: source._id, classification: "reconciliation", now, Models });
  if (stream === "evaluation_series") {
    const series = await Models.EvaluationSeries.findOne({ agency_id: source.agency_id, intervention_id: source.intervention_id, current_evaluation_id: source._id }).lean();
    if (!series) return { skipped: true };
    return projectEvaluationReview({ agencyId: source.agency_id, evaluationSeriesId: series._id, classification: "reconciliation", now, Models });
  }
  if (stream === "snoozes" || stream === "authority") return reconcileReviewItemAuthority({ agencyId: source.agency_id, reviewItemId: source._id, now, Models });
  const intervention = await Models.Intervention.findById(source._id).select("+review_origin");
  if (intervention?.review_origin && intervention.status === "active") {
    return completeReviewFromIntervention({
      agencyId: intervention.agency_id,
      reviewItemId: intervention.review_origin.review_item_id,
      intervention,
      actor: { id: intervention.recorded_by_user_id, trustedSnapshot: intervention.recorded_by_snapshot },
      now,
      Models,
    });
  }
  return projectInterventionReview({ agencyId: source.agency_id, interventionId: source._id, triggerType: source.status === "cancelled" ? "cancellation" : source.supersedes_intervention_id || source.status === "superseded" ? "correction" : "intervention_recorded", now, Models });
};

export const reconcileReviewStream = async ({ stream, agencyId = null, now = new Date(), clock = () => new Date(), Models = defaultModels, processOne = processSource, assertReady = assertPhase5ReviewIntegrityReady, batchSize = REVIEW_LIMITS.candidateBatch, maxBatches = REVIEW_LIMITS.maximumBatches } = {}) => {
  assertReady();
  if (!REVIEW_CHECKPOINT_STREAMS.includes(stream)) throw new Error("Unknown Review reconciliation stream.");
  const lease = await acquireReviewCheckpoint({ agencyId, stream, now, CheckpointModel: Models.ReviewReconciliationCheckpoint });
  if (!lease) return { stream, acquired: false, processed: 0, failed: 0, poisoned: 0, hasMore: true };
  let processed = 0; let failed = 0; let poisoned = 0; let hasMore = false; let lastHeartbeat = now;
  try {
    for (let batch = 0; batch < Math.min(maxBatches, REVIEW_LIMITS.maximumBatches); batch += 1) {
      const checkpoint = lease.checkpoint;
      const { model, time } = config[stream];
      const documents = await Models[model].find(sourceQuery({ stream, agencyId, checkpoint, now })).sort({ [time]: 1, _id: 1 }).limit(Math.min(batchSize, REVIEW_LIMITS.candidateBatch) + 1).lean();
      hasMore = documents.length > Math.min(batchSize, REVIEW_LIMITS.candidateBatch);
      const page = documents.slice(0, Math.min(batchSize, REVIEW_LIMITS.candidateBatch));
      if (!page.length) { hasMore = false; await completeReviewCheckpoint({ lease, now: clock(), CheckpointModel: Models.ReviewReconciliationCheckpoint }); break; }
      for (const source of page) {
        const operationNow = clock();
        if (operationNow.getTime() - lastHeartbeat.getTime() >= REVIEW_HEARTBEAT_MS) { lastHeartbeat = operationNow; await heartbeatReviewCheckpoint({ lease, clock: () => lastHeartbeat, CheckpointModel: Models.ReviewReconciliationCheckpoint }); }
        try {
          await processOne({ stream, source, Models, now });
          await advanceReviewCheckpoint({ lease, cursorTime: source[time], cursorId: source._id, now: clock(), CheckpointModel: Models.ReviewReconciliationCheckpoint });
          processed += 1;
        } catch (error) {
          failed += 1;
          const previousAttempts = lease.checkpoint.poison_source_id === String(source._id) ? lease.checkpoint.poison_attempts : 0;
          const attempts = previousAttempts + 1;
          const skip = attempts >= 3;
          await markReviewCheckpointPoison({ lease, sourceId: source._id, code: error?.code, attempts, now: clock(), advance: skip, cursorTime: source[time], cursorId: source._id, CheckpointModel: Models.ReviewReconciliationCheckpoint });
          logError("Review", "REVIEW_RECONCILIATION_ITEM_FAILED", error, { stream, sourceId: source._id, attempts });
          if (skip) { poisoned += 1; continue; }
          hasMore = true;
          return { stream, acquired: true, processed, failed, poisoned, hasMore };
        }
      }
      if (!hasMore) { await completeReviewCheckpoint({ lease, now: clock(), CheckpointModel: Models.ReviewReconciliationCheckpoint }); break; }
    }
    return { stream, acquired: true, processed, failed, poisoned, hasMore };
  } finally { await releaseReviewCheckpoint({ lease, clock, CheckpointModel: Models.ReviewReconciliationCheckpoint }).catch(() => false); }
};

export const runPhase5ReviewMaintenance = async ({ agencyId = null, now = new Date(), Models = defaultModels, reconcileStream = reconcileReviewStream } = {}) => {
  const streams = [];
  for (const stream of REVIEW_CHECKPOINT_STREAMS) {
    try { streams.push(await reconcileStream({ stream, agencyId, now, Models })); }
    catch (error) { logError("Review", "REVIEW_RECONCILIATION_STREAM_FAILED", error, { stream }); streams.push({ stream, acquired: false, processed: 0, failed: 1, poisoned: 0, hasMore: true }); }
  }
  return { streams, processed: streams.reduce((sum, item) => sum + item.processed, 0), failed: streams.reduce((sum, item) => sum + item.failed, 0) };
};
