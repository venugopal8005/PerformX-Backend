import {
  Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewItem,
} from "../models/index.js";
import { INTERVENTION_ERROR, createInterventionError, normalizeInterventionIdempotencyKey } from "../domain/phase3Intervention.domain.js";
import { REVIEW_ERROR, createReviewError, normalizeReviewRevision } from "../domain/phase5Review.domain.js";
import { acquireRequiredClientLifecycleLease, releaseClientLifecycleLease, startClientLifecycleLeaseHeartbeat } from "./clientLifecycle.service.js";
import { createIntervention } from "./intervention.service.js";
import { completeReviewFromIntervention } from "./reviewActions.service.js";
import { loadReviewAuthorityBatch, resolveReviewEffectiveState } from "./reviewAuthority.service.js";
import { logError } from "../utils/controllerLogger.js";

const defaultModels = { Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewItem };

export const createReviewIntervention = async ({ agencyId, reviewItemId, actor, input = {}, now = new Date(), Models = defaultModels, interventionCreator = createIntervention, completionProcessor = completeReviewFromIntervention } = {}) => {
  const key = normalizeInterventionIdempotencyKey(input.idempotencyKey);
  if (input.actionType === "internal_note") throw createInterventionError(INTERVENTION_ERROR.VALIDATION, "internal_note cannot complete a Review item.", 400);
  const preliminary = await Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId });
  if (!preliminary) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
  if (!["issue_review", "evaluation_review"].includes(preliminary.type)) throw createReviewError(REVIEW_ERROR.INVALID_STATE, "This Review item cannot record an Intervention.", 409);
  const existing = await Models.Intervention.findOne({ agency_id: agencyId, idempotency_key: key }).select("+request_hash +review_origin");
  const expectedReviewRevision = normalizeReviewRevision(input.expectedReviewRevision, "expectedReviewRevision");
  const lease = await acquireRequiredClientLifecycleLease({ agencyId, clientId: preliminary.client_id, operation: "intervention_write", ClientModel: Models.Client });
  const heartbeat = startClientLifecycleLeaseHeartbeat({ agencyId, clientId: preliminary.client_id, token: lease.token, ClientModel: Models.Client });
  try {
    heartbeat.assertOwned();
    const item = await Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId });
    if (!item) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
    let authority = null;
    if (!existing) {
      if (item.revision !== expectedReviewRevision) throw createReviewError(REVIEW_ERROR.REVISION_STALE, "The Review item changed. Refresh and try again.", 409);
      if (!["open", "acknowledged", "snoozed"].includes(item.state)) throw createReviewError(REVIEW_ERROR.INVALID_STATE, "The Review item is no longer actionable.", 409);
      authority = (await loadReviewAuthorityBatch({ agencyId, reviewItems: [item], Models }))[0];
      const effective = resolveReviewEffectiveState({ ...authority, now });
      if (!effective.isSourceCurrent || !effective.sourceRevisionSynchronized || !effective.mutationPermissions.canRecordIntervention) throw createReviewError(REVIEW_ERROR.SOURCE_STALE, "The source changed. Refresh the Review item before continuing.", 409);
    }
    if (existing?.review_origin && String(existing.review_origin.review_item_id) !== String(item._id)) {
      throw createInterventionError(INTERVENTION_ERROR.IDEMPOTENCY_CONFLICT, "The idempotency key was already used for another Intervention request.", 409);
    }
    const reviewOrigin = existing?.review_origin || { version: 1, review_item_id: item._id, review_item_type: item.type, review_generation: item.generation, review_source_revision: item.source_revision };
    const expectedIssueRevision = existing
      ? existing.issue_snapshot?.lifecycle_revision
      : authority?.issue?.lifecycle_revision;
    if (!Number.isSafeInteger(expectedIssueRevision) || expectedIssueRevision < 0) {
      throw createReviewError(REVIEW_ERROR.SOURCE_STALE, "The source changed. Refresh the Review item before continuing.", 409);
    }
    const result = await interventionCreator({
      agencyId, recorder: actor, issueId: item.issue_id,
      input: { ...input, idempotencyKey: key, expectedIssueRevision, expectedReviewRevision: undefined },
      now, reviewOrigin, clientLease: { ...lease, clientId: item.client_id }, Models,
    });
    heartbeat.assertOwned();
    let completion = null;
    try {
      completion = await completionProcessor({ agencyId, reviewItemId: item._id, intervention: result.intervention, actor, clientLease: { ...lease, clientId: item.client_id }, now, Models });
    } catch (error) {
      logError("Review", "REVIEW_INTERVENTION_COMPLETION_DEFERRED", error, { reviewItemId: item._id, interventionId: result.intervention._id });
    }
    return {
      intervention: result.intervention,
      idempotentReplay: result.idempotentReplay,
      reviewCompletionStatus: completion?.item ? "completed" : "pending",
      reviewItem: completion?.item || null,
    };
  } finally { await heartbeat.stop(); await releaseClientLifecycleLease({ agencyId, clientId: preliminary.client_id, token: lease.token, ClientModel: Models.Client }).catch(() => false); }
};
