import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import {
  REVIEW_ACTION_TYPES,
  REVIEW_CHECKPOINT_STREAMS,
  REVIEW_CLOSE_REASONS,
  REVIEW_DECISION_TYPES,
  REVIEW_HUMAN_ACTIONS,
  REVIEW_ITEM_TYPES,
  REVIEW_PRIORITIES,
  REVIEW_REASONS,
  REVIEW_STATES,
  REVIEW_SYSTEM_ACTIONS,
  canonicalReviewValue,
  hashReviewEvent,
  reviewPriorityForEvaluationResult,
  reviewPriorityForIssueSeverity,
} from "../src/domain/phase5Review.domain.js";
import { Intervention } from "../src/models/Intervention.js";
import { ReviewAction } from "../src/models/ReviewAction.js";
import { ReviewItem } from "../src/models/ReviewItem.js";
import { ReviewReconciliationCheckpoint } from "../src/models/ReviewReconciliationCheckpoint.js";
import { serializeReviewAction, serializeReviewItemDetail } from "../src/utils/reviewSerializers.js";

const oid = () => new mongoose.Types.ObjectId();
const actor = (now = new Date("2026-07-18T00:00:00.000Z")) => ({
  version: 1,
  captured_at: now,
  display_name: "Reviewer",
  workspace_role: "member",
  provenance: "workspace_member",
});
const context = (ids, now = new Date("2026-07-18T00:00:00.000Z")) => ({
  version: 1,
  captured_at: now,
  client: { id: ids.client, name: "Client", provenance: "snapshot" },
  account: { id: ids.account, name: "Account", external_id: "act_1", provenance: "snapshot" },
  campaign: { id: "campaign-1", name: "Campaign", provenance: "snapshot" },
  issue: { id: ids.issue, name: null, title: "CTR dropped", provenance: "snapshot" },
  report: null,
  source_title: "CTR dropped",
  source_summary: "CTR is lower than the comparison window.",
  provenance: "snapshot",
});
const itemInput = (overrides = {}) => {
  const ids = { agency: oid(), client: oid(), issue: oid(), account: oid() };
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    agency_id: ids.agency,
    client_id: ids.client,
    issue_id: ids.issue,
    meta_ad_account_id: ids.account,
    meta_binding_revision_snapshot: 1,
    campaign_id: "campaign-1",
    type: "issue_review",
    generation: 1,
    active_key: `issue_review:${ids.issue}`,
    reason: "issue_created",
    state: "open",
    priority: "critical",
    priority_rank: 0,
    priority_source: "issue_severity:critical",
    source_revision: 1,
    last_projected_event_key: `phase5:issue:${ids.issue}:revision:1:created`,
    last_projected_event_hash: "a".repeat(64),
    opened_at: now,
    latest_evidence_at: now,
    action_sequence: 1,
    revision: 1,
    context_snapshot: context(ids, now),
    ...overrides,
  };
};
const actionInput = (overrides = {}) => {
  const item = itemInput();
  const now = new Date("2026-07-18T00:00:00.000Z");
  return {
    agency_id: item.agency_id,
    client_id: item.client_id,
    issue_id: item.issue_id,
    review_item_id: oid(),
    sequence: 2,
    action_type: "acknowledged",
    actor_type: "human",
    actor_user_id: oid(),
    actor_snapshot: actor(now),
    prior_state: "open",
    resulting_state: "acknowledged",
    item_revision_before: 1,
    item_revision_after: 2,
    source_revision: 1,
    source_snapshot: { version: 1, captured_at: now, item_type: "issue_review", item_generation: 1, source_revision: 1, title: "CTR dropped", summary: null, provenance: "snapshot" },
    occurred_at: now,
    recorded_at: now,
    idempotency_key: "phase5-test-action-0001",
    request_hash: "b".repeat(64),
    ...overrides,
  };
};

test("Phase 5 domain freezes the exact bounded enums", () => {
  assert.deepEqual(REVIEW_ITEM_TYPES, ["issue_review", "evaluation_review"]);
  assert.deepEqual(REVIEW_STATES, ["open", "acknowledged", "snoozed", "reviewed", "closed", "superseded"]);
  assert.deepEqual(REVIEW_PRIORITIES, ["critical", "high", "normal"]);
  assert.deepEqual(REVIEW_HUMAN_ACTIONS, ["acknowledged", "snoozed", "interpretation_recorded", "intervention_recorded"]);
  assert.equal(REVIEW_ACTION_TYPES.length, REVIEW_HUMAN_ACTIONS.length + REVIEW_SYSTEM_ACTIONS.length);
  assert.deepEqual(REVIEW_DECISION_TYPES, ["interpretation_only", "campaign_action", "monitor_only", "no_action"]);
  assert.equal(REVIEW_REASONS.length, 8);
  assert.equal(REVIEW_CLOSE_REASONS.length, 5);
  assert.deepEqual(REVIEW_CHECKPOINT_STREAMS, ["issues", "interventions", "evaluation_series", "snoozes", "authority"]);
});

test("Issue and Evaluation priority mappings are exact", () => {
  assert.deepEqual(reviewPriorityForIssueSeverity("critical"), { priority: "critical", priorityRank: 0, prioritySource: "issue_severity:critical" });
  assert.equal(reviewPriorityForIssueSeverity("moderate").priority, "high");
  assert.equal(reviewPriorityForIssueSeverity("stable").priority, "normal");
  assert.equal(reviewPriorityForEvaluationResult("worsened").priority, "high");
  assert.equal(reviewPriorityForEvaluationResult("mixed").priorityRank, 1);
  assert.equal(reviewPriorityForEvaluationResult("improved").priority, "normal");
  assert.equal(reviewPriorityForEvaluationResult("no_material_change").priorityRank, 2);
  assert.throws(() => reviewPriorityForIssueSeverity("unknown"), /severity is invalid/);
});

test("canonical Review hashing sorts keys, normalizes IDs and dates, and preserves null", () => {
  const objectId = oid();
  const date = new Date("2026-07-18T01:02:03.000Z");
  const left = { z: undefined, b: { y: 2, x: objectId }, a: [date, null] };
  const right = { a: [date.toISOString(), null], b: { x: String(objectId), y: 2 } };
  assert.deepEqual(canonicalReviewValue(left), canonicalReviewValue(right));
  assert.equal(hashReviewEvent(left), hashReviewEvent(right));
  assert.match(hashReviewEvent(left), /^[a-f0-9]{64}$/);
});

test("canonical Review hashing rejects unsupported and non-finite values", () => {
  assert.throws(() => canonicalReviewValue({ value: Number.NaN }), /finite/);
  assert.throws(() => canonicalReviewValue({ value: new Map() }), /unsupported/);
  const circular = {}; circular.self = circular;
  assert.throws(() => canonicalReviewValue(circular), /circular/);
});

test("ReviewItem is strict, concurrency guarded, and index creation disabled", async () => {
  const document = new ReviewItem(itemInput());
  await document.validate();
  assert.equal(ReviewItem.schema.options.strict, "throw");
  assert.equal(ReviewItem.schema.options.optimisticConcurrency, true);
  assert.equal(ReviewItem.schema.options.autoIndex, false);
  assert.equal(ReviewItem.schema.options.autoCreate, false);
  assert.throws(() => new ReviewItem({ ...itemInput(), unknown_field: true }), /not in schema/);
});

test("ReviewItem enforces active identity, terminal identity, and priority rank", async () => {
  await assert.rejects(new ReviewItem(itemInput({ active_key: null })).validate(), /Active ReviewItems require active_key/);
  await assert.rejects(new ReviewItem(itemInput({ state: "closed" })).validate(), /Terminal ReviewItems cannot retain active_key/);
  await assert.rejects(new ReviewItem(itemInput({ priority_rank: 2 })).validate(), /Priority rank/);
});

test("Evaluation ReviewItems require exact Evaluation identity", async () => {
  await assert.rejects(new ReviewItem(itemInput({ type: "evaluation_review", active_key: `evaluation_review:${oid()}` })).validate(), /Evaluation reviews require/);
});

test("ReviewItem insertion enforces exact lifecycle evidence for every persisted state", async () => {
  const base = itemInput();
  const now = new Date("2026-07-18T01:00:00.000Z");
  await assert.rejects(new ReviewItem({ ...base, active_key: `issue_review:${oid()}` }).validate(), /exact source identity/);
  await assert.rejects(new ReviewItem({ ...base, state: "open", closed_at: now, close_reason: "source_resolved" }).validate(), /cannot contain lifecycle evidence/);
  await assert.rejects(new ReviewItem({ ...base, state: "acknowledged", acknowledged_at: now }).validate(), /complete acknowledgement/);
  await assert.rejects(new ReviewItem({ ...base, state: "snoozed", snoozed_at: now, snoozed_until: new Date(now.getTime() + 31 * 86400000), snoozed_by_user_id: oid(), snoozed_by_snapshot: actor(now) }).validate(), /bounded snooze/);
  await assert.rejects(new ReviewItem({ ...base, state: "reviewed", active_key: null }).validate(), /complete review evidence/);
  await assert.rejects(new ReviewItem({ ...base, state: "closed", active_key: null }).validate(), /closure evidence/);
  const seriesId = oid(); const evaluationId = oid();
  await assert.rejects(new ReviewItem({ ...base, type: "evaluation_review", evaluation_series_id: seriesId, evaluation_id: evaluationId, active_key: null, state: "superseded", closed_at: now, close_reason: "source_resolved" }).validate(), /supersession evidence/);
  await new ReviewItem({ ...base, type: "evaluation_review", evaluation_series_id: seriesId, evaluation_id: evaluationId, active_key: null, state: "superseded", closed_at: now, close_reason: "evaluation_superseded" }).validate();
});

test("ReviewItem rejects every unapproved query mutation boundary", async () => {
  const id = oid();
  for (const query of [
    ReviewItem.updateOne({ _id: id }, { $set: { state: "closed" } }),
    ReviewItem.updateMany({}, { $set: { state: "closed" } }),
    ReviewItem.findOneAndUpdate({ _id: id }, { $set: { state: "closed" } }),
    ReviewItem.findOneAndReplace({ _id: id }, itemInput()),
    ReviewItem.replaceOne({ _id: id }, itemInput()),
    ReviewItem.deleteOne({ _id: id }),
    ReviewItem.deleteMany({}),
  ]) await assert.rejects(query.exec(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
  await assert.rejects(ReviewItem.bulkWrite([]), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
  await assert.rejects(ReviewItem.hydrate({ _id: id, ...itemInput() }).save(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
});

test("ReviewItem approved CAS still rejects pipelines and incomplete fences", async () => {
  await assert.rejects(ReviewItem.findOneAndUpdate({ _id: oid(), agency_id: oid(), revision: 1, state: "open" }, [{ $set: { state: "closed" } }], { phase5ReviewOperation: "project", session: {}, updatePipeline: true }).exec(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
  await assert.rejects(ReviewItem.findOneAndUpdate({ _id: oid(), agency_id: oid(), revision: 1, state: "open" }, { $set: { state: "closed" }, $inc: { revision: 1 } }, { phase5ReviewOperation: "human_transition" }).exec(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
  const identity = { _id: oid(), agency_id: oid(), client_id: oid(), issue_id: oid(), revision: 1, state: "open", active_key: `issue_review:${oid()}` };
  await assert.rejects(ReviewItem.findOneAndUpdate(identity, { $set: { state: "open" }, $unset: { context_snapshot: 1 }, $inc: { revision: 1 } }, { phase5ReviewOperation: "project", session: {} }).exec(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
  await assert.rejects(ReviewItem.findOneAndUpdate(identity, { $set: { source_revision: 2 }, $inc: { revision: 1 } }, { phase5ReviewOperation: "human_transition", session: {} }).exec(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
});

test("ReviewItem rejects forged approved operation markers with invalid semantics", async () => {
  const item = itemInput(); const now = new Date("2026-07-18T02:00:00.000Z");
  const filter = { _id: oid(), active_key: item.active_key, agency_id: item.agency_id, client_id: item.client_id, evaluation_series_id: null, generation: 1, issue_id: item.issue_id, revision: 1, source_revision: 1, state: "open", type: "issue_review" };
  await assert.rejects(ReviewItem.findOneAndUpdate(filter, { $set: { state: "open", active_key: item.active_key, closed_at: now, close_reason: "source_resolved", last_projected_event_key: "forged", last_projected_event_hash: "c".repeat(64), updatedAt: now }, $inc: { revision: 1, action_sequence: 1 } }, { phase5ReviewOperation: "system_close", session: {} }).exec(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
  await assert.rejects(ReviewItem.findOneAndUpdate({ ...filter, state: { $in: ["reviewed"] } }, { $set: { state: "closed", active_key: null, acknowledged_at: null, acknowledged_by_user_id: null, acknowledged_by_snapshot: null, snoozed_at: null, snoozed_until: null, snoozed_by_user_id: null, snoozed_by_snapshot: null, snooze_note: null, reviewed_at: null, reviewed_by_user_id: null, reviewed_by_snapshot: null, closed_at: now, close_reason: "source_resolved", last_projected_event_key: "forged", last_projected_event_hash: "c".repeat(64), updatedAt: now }, $inc: { revision: 1, action_sequence: 1 } }, { phase5ReviewOperation: "system_close", session: {} }).exec(), (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED");
});

test("ReviewAction validates human and system actor boundaries", async () => {
  await new ReviewAction(actionInput()).validate();
  await assert.rejects(new ReviewAction(actionInput({ actor_user_id: null, actor_snapshot: null })).validate(), /Human ReviewActions require/);
  await assert.rejects(new ReviewAction(actionInput({ action_type: "opened_from_issue", actor_type: "system" })).validate(), /cannot contain human actor/);
  await assert.rejects(new ReviewAction(actionInput({ item_revision_after: 4 })).validate(), /advance exactly once/);
});

test("ReviewAction enforces exact action decision and source mappings", async () => {
  const human = { action_type: "interpretation_recorded", prior_state: "open", resulting_state: "reviewed", decision_type: "interpretation_only", note: "Continue monitoring." };
  await new ReviewAction(actionInput(human)).validate();
  await assert.rejects(new ReviewAction(actionInput({ ...human, decision_type: null })).validate(), /Interpretation actions require/);
  await assert.rejects(new ReviewAction(actionInput({ ...human, note: null })).validate(), /Interpretation actions require/);
  await assert.rejects(new ReviewAction(actionInput({ action_type: "intervention_recorded", prior_state: "open", resulting_state: "reviewed", decision_type: "interpretation_only", intervention_id: oid() })).validate(), /Intervention actions require/);
  await assert.rejects(new ReviewAction(actionInput({ action_type: "intervention_recorded", prior_state: "open", resulting_state: "reviewed", decision_type: "campaign_action" })).validate(), /Intervention actions require/);
  await assert.rejects(new ReviewAction(actionInput({ action_type: "opened_from_issue", actor_type: "system", actor_user_id: null, actor_snapshot: null, decision_type: "no_action", prior_state: "open", resulting_state: "open", signal_id: oid() })).validate(), /System ReviewActions cannot contain a decision/);
  await assert.rejects(new ReviewAction(actionInput({ action_type: "opened_from_issue", actor_type: "system", actor_user_id: null, actor_snapshot: null, decision_type: null, prior_state: "open", resulting_state: "open", signal_id: null })).validate(), /state transition is invalid/);
  await assert.rejects(new ReviewAction(actionInput({ sequence: 0 })).validate(), /sequence/);
});

test("ReviewAction is strict and append-only across every mutation path", async () => {
  assert.equal(ReviewAction.schema.options.strict, "throw");
  assert.equal(ReviewAction.schema.options.autoIndex, false);
  assert.equal(ReviewAction.schema.options.autoCreate, false);
  const id = oid();
  for (const query of [
    ReviewAction.updateOne({ _id: id }, { $set: { note: "changed" } }),
    ReviewAction.updateMany({}, { $set: { note: "changed" } }),
    ReviewAction.findOneAndUpdate({ _id: id }, { $set: { note: "changed" } }),
    ReviewAction.findOneAndReplace({ _id: id }, actionInput()),
    ReviewAction.replaceOne({ _id: id }, actionInput()),
    ReviewAction.deleteOne({ _id: id }),
    ReviewAction.deleteMany({}),
  ]) await assert.rejects(query.exec(), (error) => error.code === "REVIEW_ACTION_MUTATION_REJECTED");
  await assert.rejects(ReviewAction.bulkWrite([]), (error) => error.code === "REVIEW_ACTION_MUTATION_REJECTED");
  await assert.rejects(ReviewAction.hydrate({ _id: id, ...actionInput() }).save(), (error) => error.code === "REVIEW_ACTION_MUTATION_REJECTED");
});

test("Review checkpoint is strict and blocks unnamed writes", async () => {
  assert.equal(ReviewReconciliationCheckpoint.schema.options.strict, "throw");
  assert.equal(ReviewReconciliationCheckpoint.schema.options.autoIndex, false);
  assert.equal(ReviewReconciliationCheckpoint.schema.options.autoCreate, false);
  await assert.rejects(ReviewReconciliationCheckpoint.updateOne({ _id: "global:issues" }, { $set: { cursor_time: new Date() } }).exec(), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
  await assert.rejects(ReviewReconciliationCheckpoint.replaceOne({ _id: "global:issues" }, {}).exec(), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
  await assert.rejects(ReviewReconciliationCheckpoint.deleteMany({}).exec(), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
  await assert.rejects(ReviewReconciliationCheckpoint.bulkWrite([]), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
  await assert.rejects(ReviewReconciliationCheckpoint.hydrate({ _id: "global:issues", agency_id: null, stream: "issues", enabled_at: new Date(), revision: 0 }).save(), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
  await assert.rejects(ReviewReconciliationCheckpoint.findOneAndUpdate(
    { _id: "global:issues", revision: 1, "processing_lock.token": "a".repeat(64), "processing_lock.expires_at": { $gt: new Date() } },
    { $set: { cursor_time: new Date() }, $inc: { revision: 1 } },
    { phase5CheckpointOperation: "heartbeat" }
  ).exec(), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
});

test("Intervention Review origin is optional, strict, immutable, and private", () => {
  const path = Intervention.schema.path("review_origin");
  assert.equal(path.options.immutable, true);
  assert.equal(path.options.select, false);
  assert.equal(path.schema.options.strict, "throw");
  assert.equal(new Intervention().review_origin, undefined);
  assert.deepEqual(Object.keys(path.schema.paths).filter((key) => key !== "_id"), ["version", "review_item_id", "review_item_type", "review_generation", "review_source_revision"]);
});

test("Review serializers exclude actor email and all private authority fields", () => {
  const item = { ...itemInput(), _id: oid(), request_hash: "secret", idempotency_key: "secret", processing_lock: { token: "secret" } };
  item.acknowledged_at = new Date();
  item.acknowledged_by_snapshot = { ...actor(), email: "secret@example.com" };
  const detail = serializeReviewItemDetail(item, { effectiveState: "acknowledged", effectivePriority: "critical", mutationPermissions: {}, isSourceCurrent: true, sourceRevisionSynchronized: true }, { actions: [actionInput({ _id: oid(), actor_snapshot: { ...actor(), email: "secret@example.com" }, request_hash: "secret", idempotency_key: "secret" })] });
  const json = JSON.stringify(detail);
  for (const secret of ["secret@example.com", "request_hash", "idempotency_key", "processing_lock", "review_origin"]) assert.equal(json.includes(secret), false);
  assert.equal("email" in detail.acknowledgement.by, false);
  assert.equal("requestHash" in serializeReviewAction(actionInput()), false);
});

test("Phase 5 models declare exactly the approved sixteen Review indexes", () => {
  const indexes = [...ReviewItem.schema.indexes(), ...ReviewAction.schema.indexes(), ...ReviewReconciliationCheckpoint.schema.indexes()]
    .map(([, options]) => options.name)
    .filter((name) => name?.startsWith("phase5_"));
  assert.equal(indexes.length, 16);
  assert.equal(new Set(indexes).size, 16);
});
