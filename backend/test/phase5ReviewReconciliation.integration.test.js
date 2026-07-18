import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Evaluation, EvaluationSeries, Intervention, Issue, ReviewItem, ReviewReconciliationCheckpoint,
} from "../src/models/index.js";
import {
  REVIEW_LEASE_MS,
  acquireReviewCheckpoint,
  advanceReviewCheckpoint,
  completeReviewCheckpoint,
  heartbeatReviewCheckpoint,
  markReviewCheckpointPoison,
  releaseReviewCheckpoint,
} from "../src/services/reviewCheckpoint.service.js";
import { reconcileReviewStream, runPhase5ReviewMaintenance } from "../src/services/reviewReconciliation.service.js";
import { applyPhase5ReviewIndexes, initializePhase5ReviewIntegrity } from "../src/services/phase5ReviewIndexes.service.js";

let replset;
const names = ["evaluations", "evaluation_series", "interventions", "issues", "review_actions", "review_items", "review_reconciliation_checkpoints"];
before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of names) await mongoose.connection.createCollection(name).catch(() => {});
  const collections = { review_items: mongoose.connection.collection("review_items"), review_actions: mongoose.connection.collection("review_actions"), review_reconciliation_checkpoints: mongoose.connection.collection("review_reconciliation_checkpoints") };
  await applyPhase5ReviewIndexes({ collections, logger: { log() {} } });
  await initializePhase5ReviewIntegrity({ collections });
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { for (const name of names) await mongoose.connection.collection(name).deleteMany({}); });

const oid = () => new mongoose.Types.ObjectId();

test("checkpoint initializes enabled boundary and cycle exactly once", async () => {
  const agency = oid(); const now = new Date("2026-07-18T00:00:00.000Z");
  const first = await acquireReviewCheckpoint({ agencyId: agency, stream: "issues", now });
  assert.equal(first.checkpoint.enabled_at.toISOString(), now.toISOString());
  assert.equal(first.checkpoint.cycle_started_at.toISOString(), now.toISOString());
  assert.equal(first.checkpoint.processing_lock.expires_at.getTime(), now.getTime() + REVIEW_LEASE_MS);
  await releaseReviewCheckpoint({ lease: first, clock: () => new Date(now.getTime() + 1000) });
  const reacquired = await acquireReviewCheckpoint({ agencyId: agency, stream: "issues", now: new Date(now.getTime() + 2000) });
  assert.equal(reacquired.checkpoint.enabled_at.toISOString(), now.toISOString());
  assert.equal(reacquired.checkpoint.cycle_started_at.toISOString(), now.toISOString());
});

test("live lease blocks a competing worker and expired lease permits takeover", async () => {
  const agency = oid(); const now = new Date("2026-07-18T00:00:00.000Z");
  const first = await acquireReviewCheckpoint({ agencyId: agency, stream: "authority", now });
  assert.equal(await acquireReviewCheckpoint({ agencyId: agency, stream: "authority", now: new Date(now.getTime() + 1000) }), null);
  const takeover = await acquireReviewCheckpoint({ agencyId: agency, stream: "authority", now: new Date(now.getTime() + REVIEW_LEASE_MS + 1) });
  assert.ok(takeover);
  assert.notEqual(takeover.token, first.token);
  assert.equal(await releaseReviewCheckpoint({ lease: first, clock: () => new Date(now.getTime() + REVIEW_LEASE_MS + 2) }), false);
});

test("forged acquire markers cannot steal a live checkpoint lease", async () => {
  const agency = oid(); const now = new Date("2026-07-18T00:00:00.000Z");
  const first = await acquireReviewCheckpoint({ agencyId: agency, stream: "issues", now });
  const before = await ReviewReconciliationCheckpoint.findById(first.id).select("+processing_lock");
  const forgedToken = "b".repeat(64); const forgedAt = new Date(now.getTime() + 1000);
  await assert.rejects(ReviewReconciliationCheckpoint.findOneAndUpdate(
    { _id: first.id },
    { $set: { last_attempt_at: forgedAt, processing_lock: { token: forgedToken, acquired_at: forgedAt, heartbeat_at: forgedAt, expires_at: new Date(forgedAt.getTime() + REVIEW_LEASE_MS) } }, $inc: { revision: 1 } },
    { new: true, phase5CheckpointOperation: "acquire" }
  ).exec(), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
  const unchanged = await ReviewReconciliationCheckpoint.findById(first.id).select("+processing_lock");
  assert.equal(unchanged.processing_lock.token, first.token);
  assert.equal(unchanged.revision, before.revision);
  const forgedLease = { id: first.id, token: forgedToken, revision: unchanged.revision };
  await assert.rejects(advanceReviewCheckpoint({ lease: forgedLease, cursorTime: forgedAt, cursorId: oid(), now: forgedAt, CheckpointModel: ReviewReconciliationCheckpoint }), (error) => error.code === "REVIEW_RECONCILIATION_LEASE_LOST");
  assert.equal(await releaseReviewCheckpoint({ lease: forgedLease, clock: () => forgedAt, CheckpointModel: ReviewReconciliationCheckpoint }), false);
  const takeover = await acquireReviewCheckpoint({ agencyId: agency, stream: "issues", now: new Date(now.getTime() + REVIEW_LEASE_MS + 1) });
  assert.ok(takeover);
  await advanceReviewCheckpoint({ lease: takeover, cursorTime: takeover.checkpoint.enabled_at, cursorId: oid(), now: new Date(now.getTime() + REVIEW_LEASE_MS + 2), CheckpointModel: ReviewReconciliationCheckpoint });
});

test("heartbeat renews lease and every advance uses the exact live revision fence", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  const lease = await acquireReviewCheckpoint({ agencyId: agency, stream: "issues", now });
  const initialRevision = lease.revision;
  await heartbeatReviewCheckpoint({ lease, clock: () => new Date(now.getTime() + 60_000), CheckpointModel: ReviewReconciliationCheckpoint });
  assert.equal(lease.revision, initialRevision + 1);
  const sourceId = oid(); const cursorTime = new Date(now.getTime() + 120_000);
  await advanceReviewCheckpoint({ lease, cursorTime, cursorId: sourceId, now: new Date(now.getTime() + 61_000), CheckpointModel: ReviewReconciliationCheckpoint });
  assert.equal(String(lease.checkpoint.cursor_id), String(sourceId));
  assert.equal(lease.checkpoint.processed_count, 1);
  const stale = { ...lease, revision: lease.revision - 1 };
  await assert.rejects(advanceReviewCheckpoint({ lease: stale, cursorTime, cursorId: sourceId, now: new Date(now.getTime() + 62_000), CheckpointModel: ReviewReconciliationCheckpoint }), (error) => error.code === "REVIEW_RECONCILIATION_LEASE_LOST");
});

test("persisted checkpoint heartbeat and release reject caller-controlled lease semantics", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  const lease = await acquireReviewCheckpoint({ agencyId: agency, stream: "issues", now });
  const heartbeatAt = new Date(now.getTime() + 60_000);
  const before = await mongoose.connection.collection("review_reconciliation_checkpoints").findOne({ _id: lease.id });
  const forgedUpdates = [
    { $set: { "processing_lock.heartbeat_at": heartbeatAt, "processing_lock.expires_at": new Date("2099-01-01T00:00:00.000Z") }, $inc: { revision: 1 } },
    { $set: { "processing_lock.heartbeat_at": new Date(heartbeatAt.getTime() + 1), "processing_lock.expires_at": new Date(heartbeatAt.getTime() + REVIEW_LEASE_MS) }, $inc: { revision: 1 } },
    { $set: { processing_lock: { token: "f".repeat(64), acquired_at: now, heartbeat_at: heartbeatAt, expires_at: new Date(heartbeatAt.getTime() + REVIEW_LEASE_MS) } }, $inc: { revision: 1 } },
  ];
  for (const update of forgedUpdates) {
    const operation = Object.hasOwn(update.$set, "processing_lock") ? "release" : "heartbeat";
    await assert.rejects(ReviewReconciliationCheckpoint.applyApprovedOperation(
      operation,
      { _id: lease.id, revision: lease.revision, "processing_lock.token": lease.token, "processing_lock.expires_at": { $gt: heartbeatAt } },
      update,
      { new: true }
    ).exec(), (error) => error.code === "REVIEW_CHECKPOINT_MUTATION_REJECTED");
    assert.deepEqual(await mongoose.connection.collection("review_reconciliation_checkpoints").findOne({ _id: lease.id }), before);
  }
  const staleHeartbeatLease = { ...lease, revision: lease.revision - 1 };
  await assert.rejects(
    heartbeatReviewCheckpoint({ lease: staleHeartbeatLease, clock: () => heartbeatAt, CheckpointModel: ReviewReconciliationCheckpoint }),
    (error) => error.code === "REVIEW_RECONCILIATION_LEASE_LOST"
  );
  assert.deepEqual(await mongoose.connection.collection("review_reconciliation_checkpoints").findOne({ _id: lease.id }), before);
  await assert.rejects(
    heartbeatReviewCheckpoint({ lease, clock: () => new Date(now.getTime() + REVIEW_LEASE_MS + 1), CheckpointModel: ReviewReconciliationCheckpoint }),
    (error) => error.code === "REVIEW_RECONCILIATION_LEASE_LOST"
  );
  assert.deepEqual(await mongoose.connection.collection("review_reconciliation_checkpoints").findOne({ _id: lease.id }), before);
  await heartbeatReviewCheckpoint({ lease, clock: () => heartbeatAt, CheckpointModel: ReviewReconciliationCheckpoint });
  assert.equal(lease.checkpoint.processing_lock.heartbeat_at.getTime(), heartbeatAt.getTime());
  assert.equal(lease.checkpoint.processing_lock.expires_at.getTime(), heartbeatAt.getTime() + REVIEW_LEASE_MS);
  const stale = { ...lease, revision: lease.revision - 1 };
  assert.equal(await releaseReviewCheckpoint({ lease: stale, clock: () => new Date(heartbeatAt.getTime() + 1), CheckpointModel: ReviewReconciliationCheckpoint }), false);
  assert.equal(await releaseReviewCheckpoint({ lease, clock: () => new Date(heartbeatAt.getTime() + 2), CheckpointModel: ReviewReconciliationCheckpoint }), true);
  const released = await ReviewReconciliationCheckpoint.findById(lease.id).select("+processing_lock");
  assert.equal(released.processing_lock, null);
});

test("final expiry fence prevents checkpoint advancement", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const lease = await acquireReviewCheckpoint({ agencyId: oid(), stream: "snoozes", now });
  await assert.rejects(advanceReviewCheckpoint({ lease, cursorTime: now, cursorId: oid(), now: new Date(now.getTime() + REVIEW_LEASE_MS + 1), CheckpointModel: ReviewReconciliationCheckpoint }), (error) => error.code === "REVIEW_RECONCILIATION_LEASE_LOST");
});

test("poison evidence is bounded and successful advance clears active poison tracking", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z");
  const lease = await acquireReviewCheckpoint({ agencyId: oid(), stream: "issues", now });
  const failedId = oid();
  await markReviewCheckpointPoison({ lease, sourceId: failedId, code: "BOOM", attempts: 1, now, CheckpointModel: ReviewReconciliationCheckpoint });
  assert.equal(lease.checkpoint.poison_source_id, String(failedId));
  assert.equal(lease.checkpoint.poison_attempts, 1);
  await advanceReviewCheckpoint({ lease, cursorTime: now, cursorId: failedId, now, CheckpointModel: ReviewReconciliationCheckpoint });
  assert.equal(lease.checkpoint.poison_source_id, null);
  assert.equal(lease.checkpoint.poison_attempts, 0);
});

const streamModels = { Evaluation, EvaluationSeries, Intervention, Issue, ReviewItem, ReviewReconciliationCheckpoint };
const seedStreamDocument = async ({ stream, agency, now, index = 0 }) => {
  const _id = oid(); const at = new Date(now.getTime() + index);
  if (stream === "issues") await mongoose.connection.collection("issues").insertOne({ _id, agency_id: agency, opened_at: at, last_seen_at: at, createdAt: at, updatedAt: at });
  if (stream === "interventions") await mongoose.connection.collection("interventions").insertOne({ _id, agency_id: agency, recorded_at: at, updatedAt: at });
  if (stream === "evaluation_series") await mongoose.connection.collection("evaluations").insertOne({ _id, agency_id: agency, intervention_id: oid(), calculated_at: at, createdAt: at, updatedAt: at });
  if (stream === "snoozes") await mongoose.connection.collection("review_items").insertOne({ _id, agency_id: agency, state: "snoozed", snoozed_until: at, createdAt: at });
  if (stream === "authority") await mongoose.connection.collection("review_items").insertOne({ _id, agency_id: agency, state: "open", createdAt: at });
  return _id;
};

test("all five persisted reconciliation streams process bounded candidates", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  for (const stream of ["issues", "interventions", "evaluation_series", "snoozes", "authority"]) {
    if (stream === "authority") await mongoose.connection.collection("review_items").deleteMany({});
    await seedStreamDocument({ stream, agency, now });
    const seen = [];
    const result = await reconcileReviewStream({ stream, agencyId: agency, now, clock: () => now, Models: streamModels, processOne: async ({ source }) => seen.push(String(source._id)) });
    assert.equal(result.processed, 1, stream);
    assert.equal(seen.length, 1, stream);
  }
});

test("reconciliation eligibility is based on authoritative events, never updatedAt alone", async () => {
  const enabled = new Date("2026-07-18T00:00:00.000Z");
  const old = new Date(enabled.getTime() - 86400000); const later = new Date(enabled.getTime() + 1000);

  const issueAgency = oid();
  await mongoose.connection.collection("issues").insertOne({ _id: oid(), agency_id: issueAgency, opened_at: old, last_seen_at: old, createdAt: old, updatedAt: later });
  let seen = 0;
  await reconcileReviewStream({ stream: "issues", agencyId: issueAgency, now: enabled, clock: () => enabled, Models: streamModels, processOne: async () => { seen += 1; } });
  assert.equal(seen, 0);
  await mongoose.connection.collection("issues").insertOne({ _id: oid(), agency_id: issueAgency, opened_at: old, last_seen_at: later, latest_evidence: { observed_at: later }, createdAt: old, updatedAt: later });
  await reconcileReviewStream({ stream: "issues", agencyId: issueAgency, now: later, clock: () => later, Models: streamModels, processOne: async () => { seen += 1; } });
  assert.equal(seen, 1);

  const evaluationAgency = oid();
  await mongoose.connection.collection("evaluations").insertOne({ _id: oid(), agency_id: evaluationAgency, intervention_id: oid(), calculated_at: old, createdAt: old, updatedAt: later });
  seen = 0;
  await reconcileReviewStream({ stream: "evaluation_series", agencyId: evaluationAgency, now: enabled, clock: () => enabled, Models: streamModels, processOne: async () => { seen += 1; } });
  assert.equal(seen, 0);
  await mongoose.connection.collection("evaluations").insertOne({ _id: oid(), agency_id: evaluationAgency, intervention_id: oid(), calculated_at: later, createdAt: later, updatedAt: later });
  await reconcileReviewStream({ stream: "evaluation_series", agencyId: evaluationAgency, now: later, clock: () => later, Models: streamModels, processOne: async () => { seen += 1; } });
  assert.equal(seen, 1);

  const interventionAgency = oid();
  await mongoose.connection.collection("interventions").insertOne({ _id: oid(), agency_id: interventionAgency, recorded_at: old, corrected_at: null, cancellation: null, createdAt: old, updatedAt: later });
  seen = 0;
  await reconcileReviewStream({ stream: "interventions", agencyId: interventionAgency, now: enabled, clock: () => enabled, Models: streamModels, processOne: async () => { seen += 1; } });
  assert.equal(seen, 0);
  await mongoose.connection.collection("interventions").insertOne({ _id: oid(), agency_id: interventionAgency, recorded_at: old, corrected_at: later, createdAt: old, updatedAt: later });
  await reconcileReviewStream({ stream: "interventions", agencyId: interventionAgency, now: later, clock: () => later, Models: streamModels, processOne: async () => { seen += 1; } });
  assert.equal(seen, 1);
});

test("authority reconciliation scans existing active ReviewItems regardless of enabled boundary", async () => {
  const enabled = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  await mongoose.connection.collection("review_items").insertOne({ _id: oid(), agency_id: agency, state: "open", createdAt: new Date(enabled.getTime() - 86400000) });
  let seen = 0;
  await reconcileReviewStream({ stream: "authority", agencyId: agency, now: enabled, clock: () => enabled, Models: streamModels, processOne: async () => { seen += 1; } });
  assert.equal(seen, 1);
});

test("reconciliation processes at most four batches of fifty", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  for (let index = 0; index < 205; index += 1) await seedStreamDocument({ stream: "issues", agency, now, index });
  let calls = 0;
  const result = await reconcileReviewStream({ stream: "issues", agencyId: agency, now, clock: () => now, Models: streamModels, processOne: async () => { calls += 1; } });
  assert.equal(result.processed, 200);
  assert.equal(calls, 200);
  assert.equal(result.hasMore, true);
});

test("first two poison failures retain cursor; third advances and records poison count", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  const sourceId = await seedStreamDocument({ stream: "issues", agency, now });
  const fail = async () => { throw Object.assign(new Error("poison"), { code: "POISON_TEST" }); };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const operationNow = new Date(now.getTime() + attempt);
    const result = await reconcileReviewStream({ stream: "issues", agencyId: agency, now, clock: () => operationNow, Models: streamModels, processOne: fail });
    assert.equal(result.failed, 1);
    assert.equal(result.poisoned, attempt === 3 ? 1 : 0);
  }
  const checkpoint = await ReviewReconciliationCheckpoint.findById(`agency:${agency}:issues`).select("+processing_lock");
  assert.equal(checkpoint.poison_count, 1);
  assert.equal(checkpoint.cursor_id, null);
  assert.equal(String(sourceId).length, 24);
});

test("completed cycle resets cursor and next cycle retries from enabled boundary", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  await seedStreamDocument({ stream: "issues", agency, now });
  let calls = 0;
  await reconcileReviewStream({ stream: "issues", agencyId: agency, now, clock: () => now, Models: streamModels, processOne: async () => { calls += 1; } });
  const later = new Date(now.getTime() + 1000);
  await reconcileReviewStream({ stream: "issues", agencyId: agency, now: later, clock: () => later, Models: streamModels, processOne: async () => { calls += 1; } });
  assert.equal(calls, 2);
});

test("maintenance isolates one failed stream and continues the remaining streams", async () => {
  const visited = [];
  const result = await runPhase5ReviewMaintenance({ reconcileStream: async ({ stream }) => {
    visited.push(stream);
    if (stream === "interventions") throw new Error("isolated");
    return { stream, acquired: true, processed: 1, failed: 0, poisoned: 0, hasMore: false };
  } });
  assert.deepEqual(visited, ["issues", "interventions", "evaluation_series", "snoozes", "authority"]);
  assert.equal(result.processed, 4);
  assert.equal(result.failed, 1);
});

test("checkpoint completion clears cycle cursor while preserving first-start boundary", async () => {
  const now = new Date("2026-07-18T00:00:00.000Z"); const agency = oid();
  const lease = await acquireReviewCheckpoint({ agencyId: agency, stream: "authority", now });
  await advanceReviewCheckpoint({ lease, cursorTime: now, cursorId: oid(), now, CheckpointModel: ReviewReconciliationCheckpoint });
  await completeReviewCheckpoint({ lease, now: new Date(now.getTime() + 1000), CheckpointModel: ReviewReconciliationCheckpoint });
  assert.equal(lease.checkpoint.cursor_time, null);
  assert.equal(lease.checkpoint.cycle_started_at, null);
  assert.equal(lease.checkpoint.enabled_at.toISOString(), now.toISOString());
});
