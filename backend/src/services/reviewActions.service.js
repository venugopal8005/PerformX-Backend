import {
  Activity, Client, Evaluation, EvaluationSeries, Issue, MetaAdAccount, ReviewAction, ReviewItem, User, WorkspaceMember,
} from "../models/index.js";
import {
  REVIEW_ERROR, REVIEW_LIMITS, createReviewError, hashReviewEvent, normalizeReviewIdempotencyKey, normalizeReviewRevision,
} from "../domain/phase5Review.domain.js";
import { assertPhase5ReviewIntegrityReady } from "./phase5ReviewIndexes.service.js";
import { loadReviewAuthorityBatch, resolveReviewEffectiveState } from "./reviewAuthority.service.js";
import { reviewProjectionInternals } from "./reviewProjection.service.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";
import {
  acquireRequiredClientLifecycleLease, fenceClientLifecycleLeaseInTransaction, releaseClientLifecycleLease, startClientLifecycleLeaseHeartbeat,
} from "./clientLifecycle.service.js";

const defaultModels = { Activity, Client, Evaluation, EvaluationSeries, Issue, MetaAdAccount, ReviewAction, ReviewItem, User, WorkspaceMember };
const apply = (query, session) => session && typeof query?.session === "function" ? query.session(session) : query;
const userId = (actor) => actor?.userId || actor?.id || actor?._id;
const bounded = (value, { field, maximum, required = false }) => {
  if (value == null) { if (required) throw createReviewError(REVIEW_ERROR.VALIDATION, `${field} is required.`); return null; }
  if (typeof value !== "string") throw createReviewError(REVIEW_ERROR.VALIDATION, `${field} must be a string.`);
  const text = value.trim();
  if ((!text && required) || text.length > maximum) throw createReviewError(REVIEW_ERROR.VALIDATION, `${field} is invalid.`);
  return text || null;
};

export const buildReviewActor = async ({ agencyId, actor, Models = defaultModels, session = null, now = new Date() }) => {
  const actorId = userId(actor);
  if (actor?.trustedSnapshot && actorId) {
    const snapshot = actor.trustedSnapshot;
    if (snapshot.version !== 1 || !["owner", "member"].includes(snapshot.workspace_role) || typeof snapshot.display_name !== "string" || !snapshot.display_name.trim()) {
      throw createReviewError(REVIEW_ERROR.SOURCE_STALE, "Review actor evidence is unavailable.", 409);
    }
    return {
      userId: actorId,
      snapshot: {
        version: 1,
        captured_at: snapshot.captured_at || now,
        display_name: snapshot.display_name.trim().slice(0, 256),
        workspace_role: snapshot.workspace_role,
        provenance: "workspace_member",
      },
    };
  }
  const [user, membership] = await Promise.all([
    apply(Models.User.findById(actorId), session),
    apply(Models.WorkspaceMember.findOne({ workspace_id: agencyId, user_id: actorId, status: "active" }), session),
  ]);
  if (!user || !membership || !["owner", "member"].includes(membership.role)) throw createReviewError("REVIEW_PERMISSION_DENIED", "You do not have permission to update this Review item.", 403);
  return { userId: user._id, snapshot: { version: 1, captured_at: now, display_name: String(user.full_name || user.name || "Workspace member").slice(0, 256), workspace_role: membership.role, provenance: "workspace_member" } };
};

const loadOneAuthority = async ({ agencyId, item, Models, session }) => (await loadReviewAuthorityBatch({ agencyId, reviewItems: [item], Models, session }))[0];
const replay = async ({ agencyId, key, hash, Models, session }) => {
  const existing = await apply(Models.ReviewAction.findOne({ agency_id: agencyId, idempotency_key: key }).select("+request_hash"), session);
  if (!existing) return null;
  if (existing.request_hash !== hash) throw createReviewError(REVIEW_ERROR.IDEMPOTENCY_CONFLICT, "The idempotency key was already used for another Review action.", 409);
  return apply(Models.ReviewItem.findOne({ _id: existing.review_item_id, agency_id: agencyId }), session);
};

const executeHumanTransition = async ({ agencyId, reviewItemId, actor, input, actionType, allowedStates, resultingState, decisionType = null, note = null, extraSet = {}, requestSemantics = {}, activity, Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady, now = new Date(), leaseClock = () => new Date() }) => {
  assertReady();
  const key = normalizeReviewIdempotencyKey(input.idempotencyKey);
  const expectedRevision = normalizeReviewRevision(input.expectedRevision);
  const requestHash = hashReviewEvent({ operation: actionType, agencyId, reviewItemId, actorUserId: userId(actor), decisionType, note, requestSemantics });
  const existingReplay = await replay({ agencyId, key, hash: requestHash, Models });
  if (existingReplay) return { item: existingReplay, action: await Models.ReviewAction.findOne({ agency_id: agencyId, idempotency_key: key }), idempotentReplay: true };
  const preliminary = await Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId });
  if (!preliminary) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
  let lease;
  try {
    lease = await acquireRequiredClientLifecycleLease({ agencyId, clientId: preliminary.client_id, operation: "review_write", ClientModel: Models.Client });
  } catch (error) {
    if (error?.code === "client_lifecycle_operation_in_progress") {
      throw createReviewError(REVIEW_ERROR.REVISION_STALE, "The Review item is being updated. Refresh and try again.", 409);
    }
    throw error;
  }
  const heartbeat = startClientLifecycleLeaseHeartbeat({ agencyId, clientId: preliminary.client_id, token: lease.token, ClientModel: Models.Client });
  try {
    heartbeat.assertOwned();
    return await transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review actions require a transaction-capable database deployment.", work: async (session) => {
      const duplicate = await replay({ agencyId, key, hash: requestHash, Models, session });
      if (duplicate) return { item: duplicate, action: await apply(Models.ReviewAction.findOne({ agency_id: agencyId, idempotency_key: key }), session), idempotentReplay: true };
      await fenceClientLifecycleLeaseInTransaction({ agencyId, clientId: preliminary.client_id, token: lease.token, session, now: leaseClock(), ClientModel: Models.Client });
      const item = await apply(Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId }), session);
      if (!item) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
      if (item.revision !== expectedRevision) throw createReviewError(REVIEW_ERROR.REVISION_STALE, "The Review item changed. Refresh and try again.", 409);
      if (!allowedStates.includes(item.state)) throw createReviewError(REVIEW_ERROR.INVALID_STATE, "The Review action is not valid in the current state.", 409);
      const authority = await loadOneAuthority({ agencyId, item, Models, session });
      const effective = resolveReviewEffectiveState({ ...authority, now });
      if (!effective.isSourceCurrent || !effective.sourceRevisionSynchronized) throw createReviewError(REVIEW_ERROR.SOURCE_STALE, "The source changed. Refresh the Review item before continuing.", 409);
      if (actionType === "interpretation_recorded" && item.type !== "evaluation_review") throw createReviewError(REVIEW_ERROR.INVALID_STATE, "Interpretation review is only available for Evaluation items.", 409);
      const reviewActor = await buildReviewActor({ agencyId, actor, Models, session, now });
      const actorFields = actionType === "acknowledged"
        ? { acknowledged_by_user_id: reviewActor.userId, acknowledged_by_snapshot: reviewActor.snapshot }
        : actionType === "snoozed"
          ? { snoozed_by_user_id: reviewActor.userId, snoozed_by_snapshot: reviewActor.snapshot }
          : actionType === "interpretation_recorded"
            ? { reviewed_by_user_id: reviewActor.userId, reviewed_by_snapshot: reviewActor.snapshot }
            : {};
      const operation = actionType === "acknowledged" ? "acknowledge" : actionType === "snoozed" ? "snooze" : "human_review";
      const updated = await reviewProjectionInternals.transition({ item, operation, actionType, actorType: "human", actor: reviewActor, decisionType, resultingState, eventKey: key, eventHash: requestHash, actionIdempotencyKey: key, occurredAt: now, note, set: { ...extraSet, ...actorFields }, activity, Models, session });
      heartbeat.assertOwned();
      await fenceClientLifecycleLeaseInTransaction({ agencyId, clientId: preliminary.client_id, token: lease.token, session, now: leaseClock(), ClientModel: Models.Client });
      return { item: updated, action: await apply(Models.ReviewAction.findOne({ agency_id: agencyId, idempotency_key: key }), session), idempotentReplay: false };
    } });
  } finally { await heartbeat.stop(); await releaseClientLifecycleLease({ agencyId, clientId: preliminary.client_id, token: lease.token, ClientModel: Models.Client }).catch(() => false); }
};

export const acknowledgeReviewItem = (options = {}) => { const now = options.now || new Date(); return executeHumanTransition({ ...options, now, actionType: "acknowledged", allowedStates: ["open"], resultingState: "acknowledged", extraSet: { acknowledged_at: now }, requestSemantics: {}, activity: { type: "review_item_acknowledged", title: "Review item acknowledged", description: "A workspace member acknowledged this item.", reason: "acknowledged" } }); };

export const snoozeReviewItem = (options = {}) => {
  const now = options.now || new Date();
  const until = new Date(options.input?.snoozedUntil);
  if (!options.input?.snoozedUntil || !Number.isFinite(until.getTime()) || until <= now || until.getTime() - now.getTime() > REVIEW_LIMITS.maximumSnoozeMs) throw createReviewError(REVIEW_ERROR.VALIDATION, "snoozedUntil must be within the next 30 days.");
  const note = bounded(options.input?.note, { field: "note", maximum: REVIEW_LIMITS.snoozeNote });
  return executeHumanTransition({ ...options, now, actionType: "snoozed", allowedStates: ["open", "acknowledged", "snoozed"], resultingState: "snoozed", note, extraSet: { acknowledged_at: null, acknowledged_by_user_id: null, acknowledged_by_snapshot: null, snoozed_at: now, snoozed_until: until, snooze_note: note }, requestSemantics: { snoozedUntil: until, note }, activity: { type: "review_item_snoozed", title: "Review item snoozed", description: "A workspace member snoozed this item.", reason: "snoozed" } });
};

export const interpretReviewItem = (options = {}) => {
  if (options.input?.decision !== "interpretation_recorded") throw createReviewError(REVIEW_ERROR.VALIDATION, "decision is invalid.");
  const note = bounded(options.input?.note, { field: "note", maximum: REVIEW_LIMITS.note, required: true });
  const now = options.now || new Date();
  return executeHumanTransition({ ...options, now, actionType: "interpretation_recorded", allowedStates: ["open", "acknowledged", "snoozed"], resultingState: "reviewed", decisionType: "interpretation_only", note, extraSet: { reviewed_at: now, active_key: null }, requestSemantics: { decision: "interpretation_recorded", note }, activity: { type: "review_item_reviewed", title: "Review completed", description: note, reason: "interpretation_recorded" }, Models: options.Models || defaultModels });
};

export const completeReviewFromIntervention = async ({ agencyId, reviewItemId, intervention, actor, clientLease = null, now = new Date(), Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady, leaseClock = () => new Date() } = {}) => {
  assertReady();
  const item = await Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId });
  if (!item || !intervention?.review_origin || String(intervention.review_origin.review_item_id) !== String(item._id)) throw createReviewError(REVIEW_ERROR.SOURCE_STALE, "Review completion source is unavailable.", 409);
  const key = `phase5:review-item:${item._id}:intervention:${intervention._id}:completed`;
  const decisionType = intervention.action_type === "monitor_only" ? "monitor_only" : intervention.action_type === "no_action" ? "no_action" : "campaign_action";
  const hash = hashReviewEvent({ key, itemId: item._id, generation: item.generation, sourceRevision: item.source_revision, interventionId: intervention._id, actionType: intervention.action_type, decisionType });
  const existing = await replay({ agencyId, key, hash, Models });
  if (existing) return { item: existing, idempotentReplay: true };
  return transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review completion requires a transaction-capable database deployment.", work: async (session) => {
    if (clientLease) await fenceClientLifecycleLeaseInTransaction({ agencyId, clientId: item.client_id, token: clientLease.token, session, now: leaseClock(), ClientModel: Models.Client });
    const duplicate = await replay({ agencyId, key, hash, Models, session });
    if (duplicate) return { item: duplicate, idempotentReplay: true };
    const current = await apply(Models.ReviewItem.findOne({ _id: item._id, agency_id: agencyId }), session);
    if (!current || current.generation !== intervention.review_origin.review_generation || current.source_revision !== intervention.review_origin.review_source_revision || !["open", "acknowledged", "snoozed"].includes(current.state)) throw createReviewError(REVIEW_ERROR.SOURCE_STALE, "Review completion is pending source reconciliation.", 409);
    const authority = await loadOneAuthority({ agencyId, item: current, Models, session });
    const effective = resolveReviewEffectiveState({ ...authority, now });
    if (!effective.isSourceCurrent || !effective.sourceRevisionSynchronized) throw createReviewError(REVIEW_ERROR.SOURCE_STALE, "Review completion is pending source reconciliation.", 409);
    const reviewActor = await buildReviewActor({ agencyId, actor, Models, session, now });
    const updated = await reviewProjectionInternals.transition({ item: current, operation: "human_review", actionType: "intervention_recorded", actorType: "human", actor: reviewActor, decisionType, resultingState: "reviewed", eventKey: key, eventHash: hash, actionIdempotencyKey: key, occurredAt: now, interventionId: intervention._id, set: { reviewed_at: now, reviewed_by_user_id: reviewActor.userId, reviewed_by_snapshot: reviewActor.snapshot, intervention_id: intervention._id }, Models, session });
    if (clientLease) await fenceClientLifecycleLeaseInTransaction({ agencyId, clientId: item.client_id, token: clientLease.token, session, now: leaseClock(), ClientModel: Models.Client });
    return { item: updated, idempotentReplay: false };
  } });
};

export const REVIEW_ACTION_DEFAULT_MODELS = defaultModels;
