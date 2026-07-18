import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, MetaConnection, Report, ReportRun,
  ReviewAction, ReviewItem, Signal, User, WorkspaceMember,
} from "../src/models/index.js";
import { acknowledgeReviewItem, completeReviewFromIntervention, interpretReviewItem, snoozeReviewItem } from "../src/services/reviewActions.service.js";
import {
  closeReviewItemsForAuthority, projectEvaluationReview, projectInterventionReview, projectIssueReview, reconcileReviewItemAuthority, reviewProjectionInternals,
} from "../src/services/reviewProjection.service.js";
import { archiveClientLifecycle } from "../src/services/archiveLifecycle.service.js";
import { assignMetaAdAccount } from "../src/controllers/settings.controller.js";
import { applyPhase5ReviewIndexes, initializePhase5ReviewIntegrity } from "../src/services/phase5ReviewIndexes.service.js";
import { createReviewIntervention } from "../src/services/reviewIntervention.service.js";
import { createIntervention } from "../src/services/intervention.service.js";
import { reconcileReviewStream } from "../src/services/reviewReconciliation.service.js";
import { serializeInterventionDetail } from "../src/utils/interventionSerializers.js";

let replset;
const collections = ["activities", "clients", "evaluations", "evaluation_series", "interventions", "issues", "meta_ad_accounts", "meta_connections", "reports", "report_runs", "review_actions", "review_items", "review_reconciliation_checkpoints", "signals", "users", "workspace_members"];
const Models = { Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, MetaConnection, Report, ReportRun, ReviewAction, ReviewItem, Signal, User, WorkspaceMember };

before(async () => {
  process.env.JWT_SECRET ||= "phase5-test-secret-at-least-16";
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of collections) await mongoose.connection.createCollection(name).catch(() => {});
  const reviewCollections = {
    review_items: mongoose.connection.collection("review_items"),
    review_actions: mongoose.connection.collection("review_actions"),
    review_reconciliation_checkpoints: mongoose.connection.collection("review_reconciliation_checkpoints"),
  };
  await applyPhase5ReviewIndexes({ collections: reviewCollections, logger: { log() {} } });
  await initializePhase5ReviewIntegrity({ collections: reviewCollections });
  await mongoose.connection.collection("activities").createIndex({ idempotency_key: 1 }, { unique: true, sparse: true });
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { for (const name of collections) await mongoose.connection.collection(name).deleteMany({}); });

const oid = () => new mongoose.Types.ObjectId();
const response = () => ({ statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } });
const seed = async ({ severity = "moderate", status = "open", revision = 1 } = {}) => {
  const ids = { agency: oid(), client: oid(), account: oid(), issue: oid(), report: oid(), run: oid(), signal: oid(), actor: oid() };
  const now = new Date("2026-07-18T08:00:00.000Z");
  await mongoose.connection.collection("clients").insertOne({ _id: ids.client, agency_id: ids.agency, name: "Client", status: "moderate", is_archived: false, createdAt: now, updatedAt: now });
  await mongoose.connection.collection("meta_ad_accounts").insertOne({ _id: ids.account, agency_id: ids.agency, client_id: ids.client, name: "Account", ad_account_id: "act_1", is_active: true, is_accessible: true, binding_revision: 3 });
  await mongoose.connection.collection("reports").insertOne({ _id: ids.report, agency_id: ids.agency, client_id: ids.client, name: "Daily Monitor", createdAt: now, updatedAt: now });
  await mongoose.connection.collection("signals").insertOne({ _id: ids.signal, agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, report_id: ids.report, report_run_id: ids.run, type: "engagement", severity, title: "CTR dropped", description: "CTR is below baseline.", detected_at: now, createdAt: now, updatedAt: now });
  await mongoose.connection.collection("issues").insertOne({
    _id: ids.issue, agency_id: ids.agency, client_id: ids.client, meta_ad_account_id: ids.account,
    scope: { entity: { level: "campaign", id: "campaign-1", campaign_id: "campaign-1" } },
    title: "CTR dropped", summary: "CTR is below baseline.", status, current_severity: severity,
    lifecycle_revision: revision, latest_signal_id: ids.signal, latest_report_id: ids.report,
    latest_report_run_id: ids.run, report_ids: [ids.report], last_seen_at: now, createdAt: now, updatedAt: now,
  });
  await mongoose.connection.collection("users").insertOne({ _id: ids.actor, agency_id: ids.agency, full_name: "Alex Reviewer", email: "alex@example.com", role: "owner", createdAt: now, updatedAt: now });
  await mongoose.connection.collection("workspace_members").insertOne({ workspace_id: ids.agency, user_id: ids.actor, role: "owner", status: "active", joined_at: now, createdAt: now, updatedAt: now });
  return { ids, now };
};
const project = ({ ids, now }, options = {}) => projectIssueReview({ agencyId: ids.agency, issueId: ids.issue, now, Models, ...options });

test("Issue creation opens one ReviewItem and one append-only opening action", async () => {
  const fixture = await seed();
  const result = await project(fixture, { classification: "created" });
  assert.equal(result.created, true);
  assert.equal(result.item.type, "issue_review");
  assert.equal(result.item.generation, 1);
  assert.equal(result.item.priority, "high");
  assert.equal(await ReviewItem.countDocuments({ issue_id: fixture.ids.issue }), 1);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: result.item._id, action_type: "opened_from_issue" }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: result.item._id, type: "review_item_created" }), 1);
});

test("exact projection replay is idempotent and creates no duplicate action or Activity", async () => {
  const fixture = await seed();
  const first = await project(fixture, { classification: "created" });
  const replay = await project(fixture, { classification: "created" });
  assert.equal(replay.replay, true);
  assert.equal(String(replay.item._id), String(first.item._id));
  assert.equal(await ReviewAction.countDocuments({ review_item_id: first.item._id }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: first.item._id }), 1);
});

test("concurrent active-key allocation converges on one generation", async () => {
  const fixture = await seed();
  const settled = await Promise.allSettled([project(fixture, { classification: "created" }), project(fixture, { classification: "created" })]);
  assert.equal(settled.every((entry) => entry.status === "fulfilled"), true);
  assert.equal(await ReviewItem.countDocuments({ issue_id: fixture.ids.issue, generation: 1 }), 1);
  assert.equal(await ReviewAction.countDocuments({ issue_id: fixture.ids.issue }), 1);
});

test("duplicate recovery rejects a semantically incompatible active winner", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  await assert.rejects(reviewProjectionInternals.recoverDuplicateWinner({ agencyId: fixture.ids.agency, type: "issue_review", issueId: fixture.ids.issue, sourceRevision: 1, eventKey: opened.item.last_projected_event_key, eventHash: opened.item.last_projected_event_hash, reason: "issue_new_evidence", Models }), (error) => error.code === "REVIEW_IDEMPOTENCY_CONFLICT");
  await assert.rejects(reviewProjectionInternals.recoverDuplicateWinner({ agencyId: fixture.ids.agency, type: "issue_review", issueId: fixture.ids.issue, sourceRevision: 1, eventKey: opened.item.last_projected_event_key, eventHash: "f".repeat(64), reason: "issue_created", Models }), (error) => error.code === "REVIEW_IDEMPOTENCY_CONFLICT");
});

const raceReviewItemModel = ({ previousId, winnerId, terminalizedAt }) => ({
  findOne(filter) {
    const query = ReviewItem.findOne(filter);
    if (String(filter?._id || "") !== String(previousId)) return query;
    return {
      then(resolve, reject) {
        return query.then(async (previous) => {
          await mongoose.connection.collection("review_items").updateOne(
            { _id: winnerId },
            { $set: { state: "reviewed", active_key: null, acknowledged_at: null, acknowledged_by_user_id: null, acknowledged_by_snapshot: null, snoozed_at: null, snoozed_until: null, snoozed_by_user_id: null, snoozed_by_snapshot: null, snooze_note: null, reviewed_at: terminalizedAt, reviewed_by_user_id: oid(), reviewed_by_snapshot: { version: 1, captured_at: terminalizedAt, display_name: "Race reviewer", workspace_role: "member", provenance: "workspace_member" }, closed_at: null, close_reason: null, updatedAt: terminalizedAt }, $inc: { revision: 1 } }
          );
          return previous;
        }).then(resolve, reject);
      },
    };
  },
});

test("Issue duplicate recovery never returns a winner terminalized during lineage validation", async () => {
  const fixture = await seed(); const first = await project(fixture, { classification: "created" });
  await mongoose.connection.collection("review_items").updateOne({ _id: first.item._id }, { $set: { state: "reviewed", active_key: null, reviewed_at: fixture.now, reviewed_by_user_id: fixture.ids.actor, reviewed_by_snapshot: { version: 1, captured_at: fixture.now, display_name: "Alex Reviewer", workspace_role: "owner", provenance: "workspace_member" } } });
  const winner = await project(fixture, { classification: "created" });
  assert.equal(winner.item.generation, 2);
  const recovered = await reviewProjectionInternals.recoverDuplicateWinner({ agencyId: fixture.ids.agency, type: "issue_review", issueId: fixture.ids.issue, sourceRevision: winner.item.source_revision, eventKey: winner.item.last_projected_event_key, eventHash: winner.item.last_projected_event_hash, reason: winner.item.reason, Models: { ReviewItem: raceReviewItemModel({ previousId: first.item._id, winnerId: winner.item._id, terminalizedAt: new Date(fixture.now.getTime() + 1000) }) } });
  assert.equal(recovered, null);
  const successor = await project({ ...fixture, now: new Date(fixture.now.getTime() + 2000) }, { classification: "created" });
  assert.equal(successor.item.generation, 3);
  assert.equal(String(successor.item.previous_review_item_id), String(winner.item._id));
  assert.equal(await ReviewItem.countDocuments({ issue_id: fixture.ids.issue, state: { $in: ["open", "acknowledged", "snoozed"] } }), 1);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: successor.item._id }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: successor.item._id, type: "review_item_created" }), 1);
});

test("Evaluation duplicate recovery never returns a winner terminalized during lineage validation", async () => {
  const fixture = await seed(); const seriesId = oid(); const evaluationId = oid();
  await mongoose.connection.collection("evaluation_series").insertOne({ _id: seriesId, agency_id: fixture.ids.agency, current_evaluation_id: evaluationId, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("evaluations").insertOne({ _id: evaluationId, agency_id: fixture.ids.agency, issue_id: fixture.ids.issue, sequence: 1, status: "ready", observed_result: "mixed", summary: "Mixed.", evidence_hash: "7".repeat(64), calculated_at: fixture.now, createdAt: fixture.now, updatedAt: fixture.now });
  const first = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now });
  await mongoose.connection.collection("review_items").updateOne({ _id: first.item._id }, { $set: { state: "reviewed", active_key: null, reviewed_at: fixture.now, reviewed_by_user_id: fixture.ids.actor, reviewed_by_snapshot: { version: 1, captured_at: fixture.now, display_name: "Alex Reviewer", workspace_role: "owner", provenance: "workspace_member" } } });
  const winner = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now });
  assert.equal(winner.item.generation, 2);
  const recovered = await reviewProjectionInternals.recoverDuplicateWinner({ agencyId: fixture.ids.agency, type: "evaluation_review", issueId: fixture.ids.issue, evaluationSeriesId: seriesId, evaluationId, sourceRevision: winner.item.source_revision, eventKey: winner.item.last_projected_event_key, eventHash: winner.item.last_projected_event_hash, reason: winner.item.reason, Models: { ReviewItem: raceReviewItemModel({ previousId: first.item._id, winnerId: winner.item._id, terminalizedAt: new Date(fixture.now.getTime() + 1000) }) } });
  assert.equal(recovered, null);
  const successor = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: new Date(fixture.now.getTime() + 2000) });
  assert.equal(successor.item.generation, 3);
  assert.equal(String(successor.item.previous_review_item_id), String(winner.item._id));
  assert.equal(await ReviewItem.countDocuments({ evaluation_series_id: seriesId, state: { $in: ["open", "acknowledged", "snoozed"] } }), 1);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: successor.item._id }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: successor.item._id, type: "review_item_created" }), 1);
});

test("repeat Signal refresh advances projection revision without noisy ReviewAction", async () => {
  const fixture = await seed(); const first = await project(fixture, { classification: "created" });
  const nextSignal = oid(); const later = new Date("2026-07-18T09:00:00.000Z");
  await mongoose.connection.collection("signals").insertOne({ _id: nextSignal, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, report_id: fixture.ids.report, report_run_id: fixture.ids.run, type: "engagement", severity: "moderate", title: "CTR still low", description: "More evidence.", detected_at: later, createdAt: later, updatedAt: later });
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { latest_signal_id: nextSignal, last_seen_at: later, updatedAt: later }, $inc: { lifecycle_revision: 1 } });
  const refreshed = await project({ ...fixture, now: later }, { classification: "matched" });
  assert.equal(refreshed.item.revision, first.item.revision + 1);
  assert.equal(refreshed.item.source_revision, 2);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: first.item._id }), 1);
});

test("persisted ReviewItem named operations reject forged values without changing the document", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const item = await ReviewItem.findById(opened.item._id);
  const filter = { _id: item._id, agency_id: item.agency_id, client_id: item.client_id, issue_id: item.issue_id, evaluation_series_id: null, type: item.type, generation: item.generation, source_revision: item.source_revision, revision: item.revision, state: item.state, active_key: item.active_key };
  const validSet = { state: item.state, active_key: item.active_key, priority: "high", priority_rank: 1, priority_source: "issue_severity:moderate", source_revision: item.source_revision + 1, signal_id: fixture.ids.signal, report_id: fixture.ids.report, report_run_id: fixture.ids.run, latest_evidence_at: fixture.now, last_projected_event_key: "phase5:adversarial:source-refresh", last_projected_event_hash: "a".repeat(64), updatedAt: fixture.now };
  const attempts = [
    { $set: { ...validSet, priority: "forged_priority" }, $inc: { revision: 1 } },
    { $set: { ...validSet, priority_rank: 2 }, $inc: { revision: 1 } },
    { $set: { ...validSet, source_revision: -10 }, $inc: { revision: 1 } },
    { $set: { ...validSet, source_revision: 1.5 }, $inc: { revision: 1 } },
    { $set: { ...validSet, state: "reviewed" }, $inc: { revision: 1 } },
    { $set: { ...validSet, last_projected_event_hash: "NOT-A-HASH" }, $inc: { revision: 1 } },
    { $set: { ...validSet, signal_id: "invalid-object-id" }, $inc: { revision: 1 } },
    { $set: { ...validSet, unknown_path: true }, $inc: { revision: 1 } },
    { $set: { ...validSet, issue_id: oid() }, $inc: { revision: 1 } },
    { $set: Object.fromEntries(Object.entries(validSet).filter(([key]) => key !== "latest_evidence_at")), $inc: { revision: 1 } },
    { $set: { ...validSet, reason: "invalid_reason" }, $inc: { revision: 1 } },
    { $set: validSet, $inc: { revision: 1.5 } },
  ];
  const before = await mongoose.connection.collection("review_items").findOne({ _id: item._id });
  const session = await mongoose.startSession();
  try {
    for (const update of attempts) {
      await assert.rejects(
        ReviewItem.applyApprovedOperation("source_refresh", filter, update, { new: true, session }).exec(),
        (error) => error.code === "REVIEW_ITEM_MUTATION_REJECTED"
      );
      const after = await mongoose.connection.collection("review_items").findOne({ _id: item._id });
      assert.deepEqual(after, before);
    }
  } finally { await session.endSession(); }
});

test("acknowledgement is fenced, attributed, and exact-replay safe", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const input = { expectedRevision: opened.item.revision, idempotencyKey: "review-acknowledge-0001" };
  const first = await acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input, Models, now: fixture.now });
  const replay = await acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input, Models, now: fixture.now });
  assert.equal(first.item.state, "acknowledged");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(first.item.acknowledged_by_snapshot.display_name, "Alex Reviewer");
  assert.equal("email" in first.item.acknowledged_by_snapshot.toObject(), false);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, action_type: "acknowledged" }), 1);
});

test("final Client lease expiry fence rolls back the Review item, action, and Activity", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  let reads = 0;
  await assert.rejects(
    acknowledgeReviewItem({
      agencyId: fixture.ids.agency,
      reviewItemId: opened.item._id,
      actor: { id: fixture.ids.actor },
      input: { expectedRevision: opened.item.revision, idempotencyKey: "ack-final-fence-expiry-123456" },
      Models,
      now: fixture.now,
      leaseClock: () => reads++ === 0 ? new Date() : new Date(Date.now() + 10 * 60 * 1000),
    }),
    (error) => error.code === "client_lifecycle_lease_lost"
  );
  const item = await ReviewItem.findById(opened.item._id);
  assert.equal(item.state, "open");
  assert.equal(item.action_sequence, 1);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: item._id }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: item._id, type: "review_item_acknowledged" }), 0);
});

test("two reviewers racing converge on exactly one acknowledged transition", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const settled = await Promise.allSettled([
    acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "ack-reviewer-race-one-123456" }, Models, now: fixture.now }),
    acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "ack-reviewer-race-two-123456" }, Models, now: fixture.now }),
  ]);
  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  const item = await ReviewItem.findById(opened.item._id);
  assert.equal(item.state, "acknowledged");
  assert.equal(await ReviewAction.countDocuments({ review_item_id: item._id, action_type: "acknowledged" }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: item._id, type: "review_item_acknowledged" }), 1);
});

test("two snoozers racing converge on one complete bounded transition", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const settled = await Promise.allSettled([
    snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "snooze-race-one-123456789", snoozedUntil: "2026-07-19T08:00:00.000Z", note: "First" }, Models, now: fixture.now }),
    snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "snooze-race-two-123456789", snoozedUntil: "2026-07-20T08:00:00.000Z", note: "Second" }, Models, now: fixture.now }),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(["REVIEW_REVISION_STALE", "client_lifecycle_operation_in_progress"].includes(settled.find((entry) => entry.status === "rejected").reason.code), true);
  const item = await ReviewItem.findById(opened.item._id);
  assert.equal(item.state, "snoozed");
  assert.equal(item.revision, opened.item.revision + 1);
  assert.equal(item.action_sequence, 2);
  assert.equal(["First", "Second"].includes(item.snooze_note), true);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: item._id, action_type: "snoozed" }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: item._id, type: "review_item_snoozed" }), 1);
});

test("acknowledge versus snooze converges on one persisted human transition", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const settled = await Promise.allSettled([
    acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "mixed-acknowledge-race-0001" }, Models, now: fixture.now }),
    snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "mixed-snooze-race-00000001", snoozedUntil: "2026-07-19T08:00:00.000Z" }, Models, now: fixture.now }),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(["REVIEW_REVISION_STALE", "REVIEW_INVALID_STATE"].includes(settled.find((entry) => entry.status === "rejected").reason.code), true);
  const item = await ReviewItem.findById(opened.item._id);
  assert.equal(["acknowledged", "snoozed"].includes(item.state), true);
  assert.equal(item.revision, opened.item.revision + 1);
  assert.equal(item.action_sequence, opened.item.action_sequence + 1);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: item._id, actor_type: "human" }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: item._id, type: { $in: ["review_item_acknowledged", "review_item_snoozed"] } }), 1);
});

test("interpretation versus snooze converges on one persisted Evaluation transition", async () => {
  const fixture = await seed(); const seriesId = oid(); const evaluationId = oid();
  await mongoose.connection.collection("evaluation_series").insertOne({ _id: seriesId, agency_id: fixture.ids.agency, current_evaluation_id: evaluationId, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("evaluations").insertOne({ _id: evaluationId, agency_id: fixture.ids.agency, issue_id: fixture.ids.issue, sequence: 1, status: "ready", observed_result: "mixed", summary: "Mixed.", evidence_hash: "8".repeat(64), calculated_at: fixture.now, createdAt: fixture.now, updatedAt: fixture.now });
  const opened = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now });
  const settled = await Promise.allSettled([
    interpretReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "mixed-interpretation-race-01", decision: "interpretation_recorded", note: "Keep monitoring." }, Models, now: fixture.now }),
    snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "mixed-evaluation-snooze-0001", snoozedUntil: "2026-07-19T08:00:00.000Z" }, Models, now: fixture.now }),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(["REVIEW_REVISION_STALE", "REVIEW_INVALID_STATE"].includes(settled.find((entry) => entry.status === "rejected").reason.code), true);
  const item = await ReviewItem.findById(opened.item._id);
  assert.equal(["reviewed", "snoozed"].includes(item.state), true);
  assert.equal(item.revision, opened.item.revision + 1);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: item._id, actor_type: "human" }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: item._id, type: { $in: ["review_item_reviewed", "review_item_snoozed"] } }), 1);
});

test("explicit stale human action leaves the winning transition unchanged", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const winner = await acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "explicit-stale-winner-0001" }, Models, now: fixture.now });
  const before = await mongoose.connection.collection("review_items").findOne({ _id: opened.item._id });
  await assert.rejects(
    snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "explicit-stale-loser-000001", snoozedUntil: "2026-07-19T08:00:00.000Z" }, Models, now: fixture.now }),
    (error) => error.code === "REVIEW_REVISION_STALE"
  );
  assert.equal(winner.item.state, "acknowledged");
  assert.deepEqual(await mongoose.connection.collection("review_items").findOne({ _id: opened.item._id }), before);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, actor_type: "human" }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: opened.item._id, type: { $in: ["review_item_acknowledged", "review_item_snoozed"] } }), 1);
});

test("same human idempotency key with changed semantics fails closed", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  await snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "review-snooze-conflict-01", snoozedUntil: "2026-07-19T00:00:00.000Z", note: "Wait" }, Models, now: fixture.now });
  await assert.rejects(snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "review-snooze-conflict-01", snoozedUntil: "2026-07-20T00:00:00.000Z", note: "Different" }, Models, now: fixture.now }), (error) => error.code === "REVIEW_IDEMPOTENCY_CONFLICT");
});

test("new evidence reopens an acknowledged item and clears acknowledgement evidence", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  await acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "review-ack-reopen-0001" }, Models, now: fixture.now });
  const later = new Date("2026-07-18T10:00:00.000Z");
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { current_severity: "critical", last_seen_at: later, updatedAt: later }, $inc: { lifecycle_revision: 1 } });
  const result = await project({ ...fixture, now: later }, { classification: "matched" });
  assert.equal(result.item.state, "open");
  assert.equal(result.item.priority, "critical");
  assert.equal(result.item.acknowledged_at, null);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, action_type: "reopened_by_severity" }), 1);
});

test("clean observation refresh does not reopen acknowledged Review", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const acknowledged = await acknowledgeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "review-ack-clean-00001" }, Models, now: fixture.now });
  const later = new Date("2026-07-18T10:00:00.000Z");
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { last_seen_at: later, updatedAt: later }, $inc: { lifecycle_revision: 1 } });
  const result = await project({ ...fixture, now: later }, { classification: "clean_observation" });
  assert.equal(result.item.state, "acknowledged");
  assert.equal(result.item.revision, acknowledged.item.revision + 1);
});

test("Issue resolution closes the active Review atomically with its action", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const later = new Date("2026-07-18T11:00:00.000Z");
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { status: "resolved", active_fingerprint: null, resolved_at: later, updatedAt: later }, $inc: { lifecycle_revision: 1 } });
  const result = await project({ ...fixture, now: later }, { classification: "resolved" });
  assert.equal(result.item.state, "closed");
  assert.equal(result.item.active_key, null);
  assert.equal(result.item.close_reason, "source_resolved");
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, action_type: "closed_source_resolved" }), 1);
});

test("ordinary Intervention completes Issue Review while internal note does not", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const base = { agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, recorded_by_user_id: fixture.ids.actor, recorded_by_snapshot: { version: 1, captured_at: fixture.now, display_name: "Alex Reviewer", workspace_role: "owner", provenance: "workspace_member" }, recorded_at: fixture.now, performed_at: fixture.now, revision: 0, status: "active", createdAt: fixture.now, updatedAt: fixture.now };
  const noteId = oid();
  await mongoose.connection.collection("interventions").insertOne({ _id: noteId, ...base, action_type: "internal_note" });
  assert.equal((await projectInterventionReview({ agencyId: fixture.ids.agency, interventionId: noteId, Models, now: fixture.now })).skipped, true);
  assert.equal((await ReviewItem.findById(opened.item._id)).state, "open");
  const actionId = oid();
  await mongoose.connection.collection("interventions").insertOne({ _id: actionId, ...base, action_type: "monitor_only" });
  const result = await projectInterventionReview({ agencyId: fixture.ids.agency, interventionId: actionId, Models, now: fixture.now });
  assert.equal(result.item.state, "reviewed");
  assert.equal(String(result.item.intervention_id), String(actionId));
});

test("pending Review-origin Intervention completion converges through the real reconciliation stream", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const scope = { version: 1, agency_id: fixture.ids.agency, client_id: fixture.ids.client, meta_ad_account_id: fixture.ids.account, entity: { level: "campaign", id: "campaign-1", campaign_id: "campaign-1" }, classification: { archetype: "ctr_decline", metric_family: "ctr" }, comparison: { cadence: "daily", timezone: "UTC" } };
  await mongoose.connection.collection("reports").updateOne({ _id: fixture.ids.report }, { $set: { meta_ad_account_id: fixture.ids.account, monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Prospecting" }] } });
  await mongoose.connection.collection("report_runs").insertOne({ _id: fixture.ids.run, agency_id: fixture.ids.agency, client_id: fixture.ids.client, report_id: fixture.ids.report, meta_ad_account_id: fixture.ids.account, monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Prospecting" }], createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("signals").updateOne({ _id: fixture.ids.signal }, { $set: { campaign_id: "campaign-1", scope } });
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { scope, fingerprint: "b".repeat(64), fingerprint_version: 1, archetype: "ctr_decline", metric_family: "ctr", occurrence_count: 1, opened_at: fixture.now, latest_evidence: { kind: "signal", signal_id: fixture.ids.signal, report_run_id: fixture.ids.run, observed_at: fixture.now, severity: "moderate", title: "CTR dropped", summary: "CTR is below baseline.", provenance: "snapshot" } } });
  const idempotencyKey = "pending-review-intervention-0001";
  const sourceCreator = (options) => createIntervention({ ...options, assertIntegrityReady: () => {}, evaluationProcessor: async () => null, reviewProcessor: async () => null });
  const pending = await createReviewIntervention({
    agencyId: fixture.ids.agency,
    reviewItemId: opened.item._id,
    actor: { id: fixture.ids.actor },
    input: { expectedReviewRevision: opened.item.revision, idempotencyKey, actionType: "monitor_only", actionPayload: {}, reason: "Monitor the next report window", performedAt: fixture.now.toISOString() },
    now: fixture.now,
    Models,
    interventionCreator: sourceCreator,
    completionProcessor: async () => { throw Object.assign(new Error("deferred for reconciliation"), { code: "REVIEW_INDEXES_NOT_READY" }); },
  });
  assert.equal(pending.reviewCompletionStatus, "pending");
  assert.equal(await Intervention.countDocuments({ _id: pending.intervention._id }), 1);
  assert.ok((await Intervention.findById(pending.intervention._id).select("+review_origin")).review_origin);
  assert.equal((await ReviewItem.findById(opened.item._id)).state, "open");
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, action_type: "intervention_recorded" }), 0);
  assert.equal(await Activity.countDocuments({ "metadata.intervention_id": pending.intervention._id, type: "intervention_recorded" }), 1);

  const reconciliationNow = new Date(fixture.now.getTime() + 1000);
  const reconciliation = await reconcileReviewStream({ stream: "interventions", agencyId: fixture.ids.agency, now: reconciliationNow, clock: () => reconciliationNow, Models });
  assert.equal(reconciliation.processed, 1);
  const completedItem = await ReviewItem.findById(opened.item._id);
  assert.equal(completedItem.state, "reviewed");
  assert.equal(String(completedItem.intervention_id), String(pending.intervention._id));
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, action_type: "intervention_recorded", intervention_id: pending.intervention._id }), 1);
  assert.equal(await Intervention.countDocuments({}), 1);
  assert.equal(await Activity.countDocuments({ "metadata.intervention_id": pending.intervention._id, type: "intervention_recorded" }), 1);

  const replayReconciliation = await reconcileReviewStream({ stream: "interventions", agencyId: fixture.ids.agency, now: reconciliationNow, clock: () => reconciliationNow, Models });
  assert.equal(replayReconciliation.failed, 0);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, action_type: "intervention_recorded" }), 1);
  const replay = await createReviewIntervention({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedReviewRevision: opened.item.revision, idempotencyKey, actionType: "monitor_only", actionPayload: {}, reason: "Monitor the next report window", performedAt: fixture.now.toISOString() }, now: reconciliationNow, Models, interventionCreator: sourceCreator });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.reviewCompletionStatus, "completed");
  assert.equal(String(replay.intervention._id), String(pending.intervention._id));
  assert.equal(JSON.stringify(serializeInterventionDetail(replay.intervention)).includes("review_origin"), false);
});

test("cancelling a Review-originated Intervention opens the next Issue Review generation", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const interventionId = oid();
  const actorSnapshot = { version: 1, captured_at: fixture.now, display_name: "Alex Reviewer", workspace_role: "owner", provenance: "workspace_member" };
  await mongoose.connection.collection("interventions").insertOne({
    _id: interventionId,
    agency_id: fixture.ids.agency,
    client_id: fixture.ids.client,
    issue_id: fixture.ids.issue,
    action_type: "monitor_only",
    status: "active",
    revision: 0,
    recorded_at: fixture.now,
    recorded_by_user_id: fixture.ids.actor,
    recorded_by_snapshot: actorSnapshot,
    review_origin: { version: 1, review_item_id: opened.item._id, review_item_type: "issue_review", review_generation: 1, review_source_revision: 1 },
    createdAt: fixture.now,
    updatedAt: fixture.now,
  });
  const intervention = await Intervention.findById(interventionId).select("+review_origin");
  await completeReviewFromIntervention({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, intervention, actor: { id: fixture.ids.actor }, now: fixture.now, Models });
  const cancelledAt = new Date(fixture.now.getTime() + 1000);
  await mongoose.connection.collection("interventions").updateOne({ _id: interventionId }, { $set: { status: "cancelled", cancellation: { cancelled_at: cancelledAt }, updatedAt: cancelledAt }, $inc: { revision: 1 } });
  const result = await projectInterventionReview({ agencyId: fixture.ids.agency, interventionId, triggerType: "cancellation", now: cancelledAt, Models });

  assert.equal(result.created, true);
  assert.equal(result.item.generation, 2);
  assert.equal(result.item.reason, "intervention_cancelled");
  assert.equal(result.item.state, "open");
  assert.equal(await ReviewItem.countDocuments({ issue_id: fixture.ids.issue }), 2);
});

test("reviewed Issue evidence allocates the next generation", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const interventionId = oid();
  await mongoose.connection.collection("interventions").insertOne({ _id: interventionId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, recorded_by_user_id: fixture.ids.actor, recorded_by_snapshot: { version: 1, captured_at: fixture.now, display_name: "Alex Reviewer", workspace_role: "owner", provenance: "workspace_member" }, action_type: "no_action", recorded_at: fixture.now, performed_at: fixture.now, revision: 0, status: "active", createdAt: fixture.now, updatedAt: fixture.now });
  await projectInterventionReview({ agencyId: fixture.ids.agency, interventionId, Models, now: fixture.now });
  const later = new Date("2026-07-18T12:00:00.000Z");
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { status: "open", last_seen_at: later, updatedAt: later }, $inc: { lifecycle_revision: 1 } });
  const next = await project({ ...fixture, now: later }, { classification: "matched" });
  assert.equal(next.created, true);
  assert.equal(next.item.generation, 2);
  assert.equal(String(next.item.previous_review_item_id), String(opened.item._id));
});

test("simultaneous next-generation Issue allocation remains contiguous", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const interventionId = oid();
  await mongoose.connection.collection("interventions").insertOne({ _id: interventionId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, recorded_by_user_id: fixture.ids.actor, recorded_by_snapshot: { version: 1, captured_at: fixture.now, display_name: "Alex Reviewer", workspace_role: "owner", provenance: "workspace_member" }, action_type: "no_action", recorded_at: fixture.now, performed_at: fixture.now, revision: 0, status: "active", createdAt: fixture.now, updatedAt: fixture.now });
  await projectInterventionReview({ agencyId: fixture.ids.agency, interventionId, Models, now: fixture.now });
  const later = new Date("2026-07-18T12:30:00.000Z");
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { last_seen_at: later, updatedAt: later }, $inc: { lifecycle_revision: 1 } });
  const settled = await Promise.allSettled([project({ ...fixture, now: later }, { classification: "matched" }), project({ ...fixture, now: later }, { classification: "matched" })]);
  assert.equal(settled.every((entry) => entry.status === "fulfilled"), true);
  const items = await ReviewItem.find({ issue_id: fixture.ids.issue }).sort({ generation: 1 });
  assert.deepEqual(items.map((item) => item.generation), [1, 2]);
  assert.equal(String(items[1].previous_review_item_id), String(opened.item._id));
  assert.equal(await ReviewAction.countDocuments({ review_item_id: items[1]._id }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: items[1]._id, type: "review_item_created" }), 1);
});

test("ready Evaluation opens a Review and ready successor supersedes then advances generation", async () => {
  const fixture = await seed(); const seriesId = oid(); const firstId = oid();
  await mongoose.connection.collection("evaluation_series").insertOne({ _id: seriesId, agency_id: fixture.ids.agency, intervention_id: oid(), issue_id: fixture.ids.issue, current_evaluation_id: firstId, next_sequence: 2, revision: 1, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("evaluations").insertOne({ _id: firstId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, sequence: 1, status: "ready", observed_result: "worsened", summary: "Performance worsened.", evidence_hash: "c".repeat(64), calculated_at: fixture.now, createdAt: fixture.now, updatedAt: fixture.now });
  const first = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now });
  assert.equal(first.item.generation, 1);
  assert.equal(first.item.priority, "high");
  const secondId = oid(); const later = new Date("2026-07-18T13:00:00.000Z");
  await mongoose.connection.collection("evaluations").insertOne({ _id: secondId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, sequence: 2, status: "ready", observed_result: "improved", summary: "Performance improved.", evidence_hash: "d".repeat(64), calculated_at: later, createdAt: later, updatedAt: later });
  await mongoose.connection.collection("evaluation_series").updateOne({ _id: seriesId }, { $set: { current_evaluation_id: secondId, updatedAt: later }, $inc: { revision: 1, next_sequence: 1 } });
  const second = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: later });
  assert.equal(second.item.generation, 2);
  assert.equal(second.item.priority, "normal");
  assert.equal((await ReviewItem.findById(first.item._id)).state, "superseded");
});

test("concurrent Evaluation generators converge on one semantically exact winner", async () => {
  const fixture = await seed(); const seriesId = oid(); const evaluationId = oid();
  await mongoose.connection.collection("evaluation_series").insertOne({ _id: seriesId, agency_id: fixture.ids.agency, intervention_id: oid(), issue_id: fixture.ids.issue, current_evaluation_id: evaluationId, next_sequence: 2, revision: 1, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("evaluations").insertOne({ _id: evaluationId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, sequence: 1, status: "ready", observed_result: "mixed", summary: "Mixed result.", evidence_hash: "9".repeat(64), calculated_at: fixture.now, createdAt: fixture.now, updatedAt: fixture.now });
  const settled = await Promise.allSettled([
    projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now }),
    projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now }),
  ]);
  assert.equal(settled.every((entry) => entry.status === "fulfilled"), true);
  const items = await ReviewItem.find({ evaluation_series_id: seriesId });
  assert.equal(items.length, 1);
  assert.equal(items[0].generation, 1);
  assert.equal(String(items[0].evaluation_id), String(evaluationId));
  assert.equal(await ReviewAction.countDocuments({ review_item_id: items[0]._id }), 1);
  assert.equal(await Activity.countDocuments({ review_item_id: items[0]._id }), 1);
});

test("non-ready Evaluation successor supersedes without opening a replacement", async () => {
  const fixture = await seed(); const seriesId = oid(); const firstId = oid();
  await mongoose.connection.collection("evaluation_series").insertOne({ _id: seriesId, agency_id: fixture.ids.agency, current_evaluation_id: firstId, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("evaluations").insertOne({ _id: firstId, agency_id: fixture.ids.agency, issue_id: fixture.ids.issue, sequence: 1, status: "ready", observed_result: "mixed", summary: "Mixed.", evidence_hash: "e".repeat(64), calculated_at: fixture.now, createdAt: fixture.now, updatedAt: fixture.now });
  const first = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now });
  const secondId = oid(); const later = new Date("2026-07-18T14:00:00.000Z");
  await mongoose.connection.collection("evaluations").insertOne({ _id: secondId, agency_id: fixture.ids.agency, issue_id: fixture.ids.issue, sequence: 2, status: "insufficient_data", observed_result: null, summary: "Insufficient.", evidence_hash: "f".repeat(64), calculated_at: later, createdAt: later, updatedAt: later });
  await mongoose.connection.collection("evaluation_series").updateOne({ _id: seriesId }, { $set: { current_evaluation_id: secondId, updatedAt: later } });
  const result = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: later });
  assert.equal(result.skipped, true);
  assert.equal((await ReviewItem.findById(first.item._id)).state, "superseded");
  assert.equal(await ReviewItem.countDocuments({ evaluation_series_id: seriesId }), 1);
});

test("Evaluation interpretation is human-attributed and terminal", async () => {
  const fixture = await seed(); const seriesId = oid(); const evaluationId = oid();
  await mongoose.connection.collection("evaluation_series").insertOne({ _id: seriesId, agency_id: fixture.ids.agency, current_evaluation_id: evaluationId, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("evaluations").insertOne({ _id: evaluationId, agency_id: fixture.ids.agency, issue_id: fixture.ids.issue, sequence: 1, status: "ready", observed_result: "improved", summary: "Improved.", evidence_hash: "1".repeat(64), calculated_at: fixture.now, createdAt: fixture.now, updatedAt: fixture.now });
  const opened = await projectEvaluationReview({ agencyId: fixture.ids.agency, evaluationSeriesId: seriesId, Models, now: fixture.now });
  const result = await interpretReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "review-interpret-00001", decision: "interpretation_recorded", note: "Keep monitoring before changing budget." }, Models, now: fixture.now });
  assert.equal(result.item.state, "reviewed");
  assert.equal(result.action.decision_type, "interpretation_only");
  assert.equal(result.item.active_key, null);
});

test("expired snooze reconciliation reopens exactly once", async () => {
  const fixture = await seed(); const opened = await project(fixture, { classification: "created" });
  const snoozed = await snoozeReviewItem({ agencyId: fixture.ids.agency, reviewItemId: opened.item._id, actor: { id: fixture.ids.actor }, input: { expectedRevision: opened.item.revision, idempotencyKey: "review-snooze-expiry-01", snoozedUntil: "2026-07-18T09:00:00.000Z" }, Models, now: fixture.now });
  const later = new Date("2026-07-18T10:00:00.000Z");
  const first = await reconcileReviewItemAuthority({ agencyId: fixture.ids.agency, reviewItemId: snoozed.item._id, Models, now: later });
  const replay = await reconcileReviewItemAuthority({ agencyId: fixture.ids.agency, reviewItemId: snoozed.item._id, Models, now: later });
  assert.equal(first.item.state, "open");
  assert.equal(replay.noChange, true);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: opened.item._id, action_type: "snooze_expired" }), 1);
});

test("real Client archive caps immediate closure, batches authority reads, and converges 120 items", async () => {
  const fixture = await seed(); const itemIds = []; const issueDocuments = []; const reviewDocuments = [];
  for (let index = 0; index < 120; index += 1) {
    const issueId = oid(); const itemId = oid(); const signalId = oid();
    itemIds.push(itemId);
    issueDocuments.push({ _id: issueId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, meta_ad_account_id: fixture.ids.account, status: "open", current_severity: "moderate", lifecycle_revision: 1, latest_signal_id: signalId, last_seen_at: fixture.now });
    reviewDocuments.push({
      _id: itemId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: issueId, meta_ad_account_id: fixture.ids.account,
      meta_binding_revision_snapshot: 3, campaign_id: `campaign-${index}`, type: "issue_review", generation: 1,
      active_key: `issue_review:${issueId}`, reason: "issue_created", state: "open", priority: "high", priority_rank: 1,
      priority_source: "issue_severity:moderate", source_revision: 1, last_projected_event_key: `phase5:test:${index}`,
      last_projected_event_hash: "a".repeat(64), opened_at: fixture.now, latest_evidence_at: fixture.now, action_sequence: 1, revision: 1,
      context_snapshot: { version: 1, captured_at: fixture.now, client: { id: fixture.ids.client, name: "Client", provenance: "snapshot" }, account: { id: fixture.ids.account, name: "Account", external_id: "act_1", provenance: "snapshot" }, campaign: { id: `campaign-${index}`, name: null, provenance: "snapshot" }, issue: { id: issueId, name: null, title: "Issue", provenance: "snapshot" }, report: null, source_title: "Issue", source_summary: "Needs review", provenance: "snapshot" },
      createdAt: fixture.now, updatedAt: fixture.now,
    });
  }
  await mongoose.connection.collection("issues").insertMany(issueDocuments);
  await mongoose.connection.collection("review_items").insertMany(reviewDocuments);
  const archived = await archiveClientLifecycle({ agencyId: fixture.ids.agency, clientId: fixture.ids.client, userId: fixture.ids.actor, now: fixture.now });
  assert.equal(archived.outcome, "archived");
  assert.equal(await ReviewItem.countDocuments({ _id: { $in: itemIds }, state: "closed" }), 50);
  assert.equal(await ReviewItem.countDocuments({ _id: { $in: itemIds }, state: { $in: ["open", "acknowledged", "snoozed"] } }), 70);

  const counts = { clients: 0, accounts: 0, issues: 0, series: 0 };
  const originals = { clientFind: Client.find, accountFind: MetaAdAccount.collection.find, issueFind: Issue.find, seriesFind: EvaluationSeries.find };
  Client.find = function (...args) { counts.clients += 1; return originals.clientFind.apply(this, args); };
  MetaAdAccount.collection.find = function (...args) { counts.accounts += 1; return originals.accountFind.apply(this, args); };
  Issue.find = function (...args) { counts.issues += 1; return originals.issueFind.apply(this, args); };
  EvaluationSeries.find = function (...args) { counts.series += 1; return originals.seriesFind.apply(this, args); };
  try {
    const second = await closeReviewItemsForAuthority({ agencyId: fixture.ids.agency, clientId: fixture.ids.client, limit: 50, now: new Date(fixture.now.getTime() + 1000), Models });
    assert.deepEqual({ processed: second.processed, closed: second.closed, hasMore: second.hasMore }, { processed: 50, closed: 50, hasMore: true });
  } finally {
    Client.find = originals.clientFind; MetaAdAccount.collection.find = originals.accountFind; Issue.find = originals.issueFind; EvaluationSeries.find = originals.seriesFind;
  }
  assert.deepEqual(counts, { clients: 1, accounts: 1, issues: 1, series: 1 });
  const third = await closeReviewItemsForAuthority({ agencyId: fixture.ids.agency, clientId: fixture.ids.client, limit: 50, now: new Date(fixture.now.getTime() + 2000), Models });
  assert.equal(third.closed, 20);
  assert.equal(await ReviewItem.countDocuments({ _id: { $in: itemIds }, state: "closed" }), 120);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: { $in: itemIds }, action_type: "closed_client_archived" }), 120);
  assert.equal(await Activity.countDocuments({ review_item_id: { $in: itemIds }, type: "review_item_closed" }), 120);
});

test("real Meta reassignment caps immediate closure and converges 120 stale bindings", async () => {
  const fixture = await seed(); const destination = oid(); const connection = oid(); const itemIds = []; const issues = []; const items = [];
  await mongoose.connection.collection("clients").insertOne({ _id: destination, agency_id: fixture.ids.agency, name: "Destination", status: "stable", is_archived: false, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("meta_connections").insertOne({ _id: connection, agency_id: fixture.ids.agency, client_id: null, connection_scope: "workspace", status: "active", is_active: true, createdAt: fixture.now, updatedAt: fixture.now });
  await mongoose.connection.collection("meta_ad_accounts").updateOne({ _id: fixture.ids.account }, { $set: { meta_connection_id: connection, assignment_scope: "v1" } });
  for (let index = 0; index < 120; index += 1) {
    const issueId = oid(); const itemId = oid(); itemIds.push(itemId);
    issues.push({ _id: issueId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, meta_ad_account_id: fixture.ids.account, status: "open", current_severity: "moderate", lifecycle_revision: 1, latest_signal_id: oid(), last_seen_at: fixture.now });
    items.push({ _id: itemId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: issueId, meta_ad_account_id: fixture.ids.account, meta_binding_revision_snapshot: 3, campaign_id: `reassign-${index}`, type: "issue_review", generation: 1, active_key: `issue_review:${issueId}`, reason: "issue_created", state: "open", priority: "high", priority_rank: 1, priority_source: "issue_severity:moderate", source_revision: 1, last_projected_event_key: `phase5:reassign:${index}`, last_projected_event_hash: "b".repeat(64), opened_at: fixture.now, latest_evidence_at: fixture.now, action_sequence: 1, revision: 1, context_snapshot: { version: 1, captured_at: fixture.now, client: { id: fixture.ids.client, name: "Client", provenance: "snapshot" }, account: { id: fixture.ids.account, name: "Account", external_id: "act_1", provenance: "snapshot" }, campaign: { id: `reassign-${index}`, name: null, provenance: "snapshot" }, issue: { id: issueId, name: null, title: "Issue", provenance: "snapshot" }, report: null, source_title: "Issue", source_summary: "Needs review", provenance: "snapshot" }, createdAt: fixture.now, updatedAt: fixture.now });
  }
  await mongoose.connection.collection("issues").insertMany(issues);
  await mongoose.connection.collection("review_items").insertMany(items);
  const res = response();
  await assignMetaAdAccount({ user: { id: fixture.ids.actor, agencyId: fixture.ids.agency }, params: { adAccountId: fixture.ids.account }, body: { clientId: destination, confirmReassignment: true } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(String((await MetaAdAccount.findById(fixture.ids.account)).client_id), String(destination));
  assert.equal(await ReviewItem.countDocuments({ _id: { $in: itemIds }, state: "closed" }), 50);
  await closeReviewItemsForAuthority({ agencyId: fixture.ids.agency, accountId: fixture.ids.account, limit: 50, now: new Date(fixture.now.getTime() + 1000), Models });
  await closeReviewItemsForAuthority({ agencyId: fixture.ids.agency, accountId: fixture.ids.account, limit: 50, now: new Date(fixture.now.getTime() + 2000), Models });
  assert.equal(await ReviewItem.countDocuments({ _id: { $in: itemIds }, state: "closed", close_reason: "account_reassigned" }), 120);
  assert.equal(await ReviewAction.countDocuments({ review_item_id: { $in: itemIds }, action_type: "closed_account_reassigned" }), 120);
  assert.equal(await Activity.countDocuments({ review_item_id: { $in: itemIds }, type: "review_item_closed" }), 120);
});
