import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Intervention } from "../src/models/Intervention.js";
import { ReportRun } from "../src/models/ReportRun.js";
import { EvaluationReconciliationCheckpoint } from "../src/models/EvaluationReconciliationCheckpoint.js";
import { evaluationServiceInternals, processReportRunEvaluations, reconcileEvaluations, runEvaluationMaintenance } from "../src/services/evaluation.service.js";
import { detectOverlap } from "../src/services/phase4EvaluationEngine.service.js";

let replset;
before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  await mongoose.connection.createCollection("interventions").catch(() => {});
  await mongoose.connection.createCollection("report_runs").catch(() => {});
  await mongoose.connection.createCollection("evaluation_reconciliation_checkpoints").catch(() => {});
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { await Promise.all([Intervention.collection.deleteMany({}), ReportRun.collection.deleteMany({}), EvaluationReconciliationCheckpoint.collection.deleteMany({})]); });

const oid = () => new mongoose.Types.ObjectId();

test("overlap loading is exact-window scoped and unaffected by more than 500 newer unrelated actions", async () => {
  const scope = { agency_id: oid(), client_id: oid(), meta_ad_account_id: oid(), campaign_id: "subject" };
  const subject = { _id: oid(), ...scope, performed_at: new Date("2026-01-01T12:00:00Z"), status: "active", action_type: "replace_creative" };
  const atStart = { _id: oid(), ...scope, performed_at: new Date("2026-01-02T00:00:00Z"), status: "active", action_type: "change_targeting" };
  const atEnd = { _id: oid(), ...scope, performed_at: new Date("2026-01-02T23:59:59.999Z"), status: "active", action_type: "adjust_budget" };
  const outsideEnd = { _id: oid(), ...scope, performed_at: new Date("2026-01-03T00:00:00Z"), status: "active", action_type: "adjust_budget" };
  const unrelated = Array.from({ length: 501 }, (_, index) => ({
    _id: oid(),
    ...scope,
    campaign_id: `other-${index}`,
    performed_at: new Date(`2026-02-${String(index % 27 + 1).padStart(2, "0")}T12:00:00Z`),
    status: "active",
    action_type: "adjust_budget",
  }));
  await Intervention.collection.insertMany([subject, atStart, atEnd, outsideEnd, ...unrelated]);
  const loaded = await evaluationServiceInternals.loadWindowScopedInterventions({
    intervention: subject,
    agencyId: scope.agency_id,
    followUpWindow: { start: "2026-01-02", end: "2026-01-02" },
    timezone: "UTC",
    Models: { Intervention },
    session: null,
  });
  assert.deepEqual(loaded.map((item) => String(item._id)), [String(atStart._id), String(atEnd._id)]);
  assert.deepEqual(detectOverlap({ interventions: loaded, subjectChainIds: [subject._id], followUpWindow: { start: "2026-01-02", end: "2026-01-02" }, timezone: "UTC" }).map((item) => String(item._id)), [String(atStart._id), String(atEnd._id)]);
});

test("reconciliation paginates deterministically across bounded invocations without duplicates", async () => {
  const agencyId = oid();
  const documents = Array.from({ length: 7 }, () => ({ _id: oid(), agency_id: agencyId }));
  await Intervention.collection.insertMany(documents);
  const processed = [];
  const processOne = async ({ interventionId }) => { processed.push(String(interventionId)); };
  const first = await reconcileEvaluations({ agencyId, batchSize: 2, maxBatches: 2, Models: { Intervention }, processOne });
  assert.equal(first.processed, 4);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await reconcileEvaluations({ agencyId, cursor: first.nextCursor, batchSize: 2, maxBatches: 2, Models: { Intervention }, processOne });
  assert.equal(second.processed, 3);
  assert.equal(second.hasMore, false);
  assert.equal(new Set(processed).size, 7);
  assert.deepEqual(processed, [...documents].sort((a, b) => String(a._id).localeCompare(String(b._id))).map((item) => String(item._id)));
});

test("interrupted reconciliation resumes at the failed persisted item", async () => {
  const agencyId = oid();
  const documents = Array.from({ length: 5 }, () => ({ _id: oid(), agency_id: agencyId })).sort((a, b) => String(a._id).localeCompare(String(b._id)));
  await Intervention.collection.insertMany(documents);
  const completed = [];
  let failedOnce = false;
  const processOne = async ({ interventionId }) => {
    if (String(interventionId) === String(documents[2]._id) && !failedOnce) {
      failedOnce = true;
      throw new Error("injected interruption");
    }
    completed.push(String(interventionId));
  };
  const first = await reconcileEvaluations({ agencyId, batchSize: 5, maxBatches: 1, Models: { Intervention }, processOne });
  assert.equal(first.interrupted, true);
  assert.equal(first.processed, 2);
  assert.equal(first.nextCursor, String(documents[1]._id));
  const second = await reconcileEvaluations({ agencyId, cursor: first.nextCursor, batchSize: 5, maxBatches: 1, Models: { Intervention }, processOne });
  assert.equal(second.interrupted, false);
  assert.deepEqual(completed, documents.map((item) => String(item._id)));
});

test("ReportRun trigger cursor resumes beyond the bounded first invocation", async () => {
  const ids = { agency: oid(), client: oid(), account: oid(), run: oid() };
  await ReportRun.collection.insertOne({
    _id: ids.run,
    agency_id: ids.agency,
    client_id: ids.client,
    meta_ad_account_id: ids.account,
    evaluation_evidence: { completeness: "complete", campaign_snapshots: [{ campaign_id: "campaign-1" }] },
  });
  const documents = Array.from({ length: 205 }, () => ({
    _id: oid(),
    agency_id: ids.agency,
    client_id: ids.client,
    meta_ad_account_id: ids.account,
    campaign_id: "campaign-1",
  })).sort((a, b) => String(a._id).localeCompare(String(b._id)));
  await Intervention.collection.insertMany(documents);
  const processed = [];
  const processOne = async ({ interventionId }) => { processed.push(String(interventionId)); };
  const first = await processReportRunEvaluations({ reportRunId: ids.run, Models: { ReportRun, Intervention }, processOne });
  assert.equal(first.processed, 200);
  assert.equal(first.hasMore, true);
  const persistedPending = await ReportRun.collection.findOne({ _id: ids.run });
  assert.equal(persistedPending.evaluation_processing.status, "pending");
  assert.equal(String(persistedPending.evaluation_processing.cursor), first.nextCursor);
  const second = await processReportRunEvaluations({ reportRunId: ids.run, Models: { ReportRun, Intervention }, processOne });
  assert.equal(second.processed, 5);
  assert.equal(second.hasMore, false);
  const persistedCompleted = await ReportRun.collection.findOne({ _id: ids.run });
  assert.equal(persistedCompleted.evaluation_processing.status, "completed");
  assert.equal(persistedCompleted.evaluation_processing.cursor, null);
  assert.deepEqual(processed, documents.map((item) => String(item._id)));
});

test("durable maintenance checkpoint resumes bounded reconciliation after a simulated process restart", async () => {
  const agencyId = oid();
  const documents = Array.from({ length: 7 }, () => ({ _id: oid(), agency_id: agencyId }))
    .sort((a, b) => String(a._id).localeCompare(String(b._id)));
  await Intervention.collection.insertMany(documents);
  const processed = [];
  const processOne = async ({ interventionId }) => { processed.push(String(interventionId)); };
  const Models = { Intervention, ReportRun, EvaluationReconciliationCheckpoint };
  const boundedReconcile = (options) => reconcileEvaluations({ ...options, batchSize: 2, maxBatches: 1 });

  const first = await runEvaluationMaintenance({ agencyId, Models, processOne, reconcile: boundedReconcile, now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(first.reconciliation.processed, 2);
  assert.equal(first.reconciliation.hasMore, true);
  const persistedAfterFirst = await EvaluationReconciliationCheckpoint.collection.findOne({ _id: `agency:${agencyId}` });
  assert.equal(String(persistedAfterFirst.cursor), String(documents[1]._id));

  for (let invocation = 0; invocation < 3; invocation += 1) {
    await runEvaluationMaintenance({ agencyId, Models, processOne, reconcile: boundedReconcile, now: new Date(`2026-01-0${invocation + 2}T00:00:00Z`) });
  }
  const completed = await EvaluationReconciliationCheckpoint.collection.findOne({ _id: `agency:${agencyId}` });
  assert.equal(completed.cursor, null);
  assert.equal(new Set(processed).size, documents.length);
  assert.deepEqual(processed, documents.map((item) => String(item._id)));
});

test("durable maintenance consumes persisted ReportRun continuation without changing unrelated work", async () => {
  const ids = { agency: oid(), client: oid(), account: oid(), run: oid() };
  await ReportRun.collection.insertOne({
    _id: ids.run,
    agency_id: ids.agency,
    client_id: ids.client,
    meta_ad_account_id: ids.account,
    evaluation_evidence: { completeness: "complete", campaign_snapshots: [{ campaign_id: "campaign-1" }] },
    evaluation_processing: { status: "pending", cursor: null, processed_count: 0, attempt_count: 0 },
  });
  const interventions = Array.from({ length: 3 }, () => ({
    _id: oid(),
    agency_id: ids.agency,
    client_id: ids.client,
    meta_ad_account_id: ids.account,
    campaign_id: "campaign-1",
  }));
  await Intervention.collection.insertMany(interventions);
  const processed = [];
  let reportExecutions = 0;
  let metaCalls = 0;
  const Models = { Intervention, ReportRun, EvaluationReconciliationCheckpoint };
  const result = await runEvaluationMaintenance({
    agencyId: ids.agency,
    Models,
    processOne: async ({ interventionId, triggerType }) => {
      processed.push(`${triggerType}:${interventionId}`);
    },
    reconcile: async () => ({ processed: 0, failed: 0, interrupted: false, hasMore: false, nextCursor: null }),
  });
  assert.equal(result.reportRunsProcessed, 1);
  assert.equal((await ReportRun.collection.findOne({ _id: ids.run })).evaluation_processing.status, "completed");
  assert.equal(processed.length, interventions.length);
  assert.equal(reportExecutions, 0);
  assert.equal(metaCalls, 0);
});
