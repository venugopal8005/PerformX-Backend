import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewItem,
} from "../src/models/index.js";
import { createReviewIntervention } from "../src/services/reviewIntervention.service.js";

let replset;
const names = ["clients", "evaluations", "evaluation_series", "interventions", "issues", "meta_ad_accounts", "review_items"];
const Models = { Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewItem };
before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of names) await mongoose.connection.createCollection(name).catch(() => {});
  await mongoose.connection.collection("interventions").createIndex({ agency_id: 1, idempotency_key: 1 }, { unique: true });
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { for (const name of names) await mongoose.connection.collection(name).deleteMany({}); });

const oid = () => new mongoose.Types.ObjectId();
const seed = async ({ type = "issue_review", itemRevision = 2, sourceRevision = 7, issueRevision = 9 } = {}) => {
  const ids = { agency: oid(), client: oid(), account: oid(), issue: oid(), item: oid(), series: oid(), evaluation: oid(), actor: oid() };
  const now = new Date("2026-07-18T08:00:00.000Z");
  await mongoose.connection.collection("clients").insertOne({ _id: ids.client, agency_id: ids.agency, name: "Client", is_archived: false, createdAt: now, updatedAt: now });
  await mongoose.connection.collection("meta_ad_accounts").insertOne({ _id: ids.account, agency_id: ids.agency, client_id: ids.client, is_active: true, is_accessible: true, binding_revision: 1 });
  await mongoose.connection.collection("issues").insertOne({ _id: ids.issue, agency_id: ids.agency, client_id: ids.client, meta_ad_account_id: ids.account, status: "open", current_severity: "moderate", lifecycle_revision: issueRevision, createdAt: now, updatedAt: now });
  if (type === "evaluation_review") {
    await mongoose.connection.collection("evaluation_series").insertOne({ _id: ids.series, agency_id: ids.agency, current_evaluation_id: ids.evaluation, createdAt: now, updatedAt: now });
    await mongoose.connection.collection("evaluations").insertOne({ _id: ids.evaluation, agency_id: ids.agency, issue_id: ids.issue, sequence: sourceRevision, status: "ready", observed_result: "mixed", calculated_at: now, createdAt: now, updatedAt: now });
  }
  await mongoose.connection.collection("review_items").insertOne({
    _id: ids.item, agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, meta_ad_account_id: ids.account,
    meta_binding_revision_snapshot: 1, campaign_id: "campaign-1", type, generation: 1, active_key: `${type}:${type === "issue_review" ? ids.issue : ids.series}`,
    state: "open", priority: "high", source_revision: type === "issue_review" ? issueRevision : sourceRevision, revision: itemRevision,
    evaluation_series_id: type === "evaluation_review" ? ids.series : null, evaluation_id: type === "evaluation_review" ? ids.evaluation : null,
    createdAt: now, updatedAt: now,
  });
  return { ids, now, itemRevision, sourceRevision, issueRevision, type };
};
const inputFor = (fixture, overrides = {}) => ({ expectedReviewRevision: fixture.itemRevision, idempotencyKey: `review-intervention-${fixture.ids.item}`, actionType: "monitor_only", actionPayload: {}, reason: "Monitor the next window", ...overrides });
const persistedCreator = ({ calls, replay = false } = {}) => async (options) => {
  calls.push(options);
  let intervention = await Intervention.findOne({ agency_id: options.agencyId, idempotency_key: options.input.idempotencyKey }).select("+review_origin");
  if (!intervention) {
    const raw = { _id: oid(), agency_id: options.agencyId, client_id: options.clientLease.clientId, issue_id: options.issueId, action_type: options.input.actionType, idempotency_key: options.input.idempotencyKey, review_origin: options.reviewOrigin, issue_snapshot: { lifecycle_revision: options.input.expectedIssueRevision }, recorded_by_user_id: options.recorder.id, recorded_by_snapshot: { version: 1, captured_at: options.now, display_name: "Reviewer", workspace_role: "member", provenance: "workspace_member" }, status: "active", revision: 0, createdAt: options.now, updatedAt: options.now };
    await mongoose.connection.collection("interventions").insertOne(raw);
    intervention = await Intervention.findById(raw._id).select("+review_origin");
  }
  return { intervention, idempotentReplay: replay || calls.length > 1 };
};

test("Evaluation Review derives expected Issue revision from Issue authority, not Evaluation sequence", async () => {
  const fixture = await seed({ type: "evaluation_review", sourceRevision: 7, issueRevision: 9 }); const calls = [];
  const result = await createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), now: fixture.now, Models, interventionCreator: persistedCreator({ calls }), completionProcessor: async ({ intervention }) => ({ item: { _id: fixture.ids.item, state: "reviewed", intervention_id: intervention._id } }) });
  assert.equal(calls[0].input.expectedIssueRevision, 9);
  assert.equal(calls[0].reviewOrigin.review_source_revision, 7);
  assert.equal(result.reviewCompletionStatus, "completed");
});

test("internal note is rejected before lease acquisition and Intervention creation", async () => {
  const fixture = await seed(); let calls = 0;
  await assert.rejects(createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture, { actionType: "internal_note" }), Models, interventionCreator: async () => { calls += 1; } }), (error) => error.code === "INTERVENTION_VALIDATION_FAILED");
  assert.equal(calls, 0);
  assert.equal(await Intervention.countDocuments({}), 0);
});

test("stale Review revision fails before Intervention creation", async () => {
  const fixture = await seed(); let calls = 0;
  await assert.rejects(createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture, { expectedReviewRevision: fixture.itemRevision - 1 }), Models, interventionCreator: async () => { calls += 1; } }), (error) => error.code === "REVIEW_REVISION_STALE");
  assert.equal(calls, 0);
});

test("stale source binding fails before Intervention creation", async () => {
  const fixture = await seed(); let calls = 0;
  await mongoose.connection.collection("meta_ad_accounts").updateOne({ _id: fixture.ids.account }, { $set: { binding_revision: 2 } });
  await assert.rejects(createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), Models, interventionCreator: async () => { calls += 1; } }), (error) => error.code === "REVIEW_SOURCE_STALE");
  assert.equal(calls, 0);
});

test("Review completion failure preserves committed Intervention and returns bounded pending result", async () => {
  const fixture = await seed(); const calls = [];
  const result = await createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), now: fixture.now, Models, interventionCreator: persistedCreator({ calls }), completionProcessor: async () => { throw Object.assign(new Error("indexes unavailable"), { code: "REVIEW_INDEXES_NOT_READY" }); } });
  assert.equal(result.reviewCompletionStatus, "pending");
  assert.equal(result.reviewItem, null);
  assert.equal(await Intervention.countDocuments({ _id: result.intervention._id }), 1);
  assert.equal(calls.length, 1);
});

test("Review CAS conflict after source commit preserves Intervention", async () => {
  const fixture = await seed(); const calls = [];
  const result = await createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), now: fixture.now, Models, interventionCreator: persistedCreator({ calls }), completionProcessor: async () => { throw Object.assign(new Error("stale"), { code: "REVIEW_REVISION_STALE" }); } });
  assert.equal(result.reviewCompletionStatus, "pending");
  assert.ok(await Intervention.findById(result.intervention._id));
});

test("exact replay bypasses stale Review revision and reuses persisted Review origin", async () => {
  const fixture = await seed(); const firstCalls = [];
  const first = await createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), now: fixture.now, Models, interventionCreator: persistedCreator({ calls: firstCalls }), completionProcessor: async () => { throw new Error("pending"); } });
  await mongoose.connection.collection("review_items").updateOne({ _id: fixture.ids.item }, { $set: { state: "reviewed", active_key: null }, $inc: { revision: 1 } });
  const replayCalls = [];
  const replay = await createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), now: new Date(fixture.now.getTime() + 1000), Models, interventionCreator: persistedCreator({ calls: replayCalls, replay: true }), completionProcessor: async () => { throw new Error("still pending"); } });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(String(replay.intervention._id), String(first.intervention._id));
  assert.equal(String(replayCalls[0].reviewOrigin.review_item_id), String(fixture.ids.item));
  assert.equal(replayCalls[0].input.expectedIssueRevision, fixture.issueRevision);
  assert.equal(await Intervention.countDocuments({}), 1);
});

test("same key owned by another Review item fails closed before creator", async () => {
  const fixture = await seed(); const foreignItem = oid(); const key = inputFor(fixture).idempotencyKey;
  await mongoose.connection.collection("interventions").insertOne({ _id: oid(), agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, idempotency_key: key, action_type: "monitor_only", review_origin: { version: 1, review_item_id: foreignItem, review_item_type: "issue_review", review_generation: 1, review_source_revision: fixture.issueRevision }, issue_snapshot: { lifecycle_revision: fixture.issueRevision }, status: "active", revision: 0, createdAt: fixture.now, updatedAt: fixture.now });
  let calls = 0;
  await assert.rejects(createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), now: fixture.now, Models, interventionCreator: async () => { calls += 1; } }), (error) => error.code === "INTERVENTION_IDEMPOTENCY_CONFLICT");
  assert.equal(calls, 0);
});

test("ordinary action, monitor-only, and no-action remain valid completing decisions", async () => {
  for (const actionType of ["decrease_budget", "monitor_only", "no_action"]) {
    const fixture = await seed(); const calls = [];
    const result = await createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture, { idempotencyKey: `review-action-${actionType}-12345`, actionType }), now: fixture.now, Models, interventionCreator: persistedCreator({ calls }), completionProcessor: async () => ({ item: { _id: fixture.ids.item, state: "reviewed" } }) });
    assert.equal(result.reviewCompletionStatus, "completed");
  }
});

test("foreign Review identity is non-disclosing and never reaches source creation", async () => {
  const fixture = await seed(); let calls = 0;
  await assert.rejects(createReviewIntervention({ agencyId: oid(), reviewItemId: fixture.ids.item, actor: { id: fixture.ids.actor }, input: inputFor(fixture), Models, interventionCreator: async () => { calls += 1; } }), (error) => error.code === "REVIEW_NOT_FOUND" && error.status === 404);
  assert.equal(calls, 0);
});
