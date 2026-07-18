import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Evaluation, EvaluationSeries } from "../src/models/index.js";
import { evaluationServiceInternals } from "../src/services/evaluation.service.js";

let replset;
before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of ["evaluations", "evaluation_series"]) await mongoose.connection.createCollection(name).catch(() => {});
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { await Promise.all([Evaluation.collection.deleteMany({}), EvaluationSeries.collection.deleteMany({})]); });

const oid = () => new mongoose.Types.ObjectId();
const duplicate = (index) => Object.assign(new Error(`E11000 duplicate key error index: ${index} dup key`), { code: 11000 });
const seed = async ({ requestHash = null } = {}) => {
  const ids = { agency: oid(), intervention: oid(), evaluation: oid(), reportRun: oid(), predecessor: oid(), series: oid() };
  const attempted = {
    sequence: 1,
    ruleVersion: 1,
    evidenceHash: "a".repeat(64),
    triggerType: "report_run",
    sourceReportRunId: ids.reportRun,
    idempotencyKey: "phase4:report_run:v1:semantic-replay",
    supersedesEvaluationId: ids.predecessor,
    requestHash,
  };
  await Evaluation.collection.insertOne({
    _id: ids.evaluation,
    agency_id: ids.agency,
    intervention_id: ids.intervention,
    sequence: attempted.sequence,
    rule_version: attempted.ruleVersion,
    evidence_hash: attempted.evidenceHash,
    trigger_type: attempted.triggerType,
    source_report_run_id: attempted.sourceReportRunId,
    idempotency_key: attempted.idempotencyKey,
    supersedes_evaluation_id: attempted.supersedesEvaluationId,
  });
  await EvaluationSeries.collection.insertOne({
    _id: ids.series,
    agency_id: ids.agency,
    intervention_id: ids.intervention,
    current_evaluation_id: ids.evaluation,
    next_sequence: 2,
    revision: 1,
    ...(requestHash ? { last_manual_refresh_key: attempted.idempotencyKey, last_manual_refresh_hash: requestHash } : {}),
  });
  return { ids, attempted };
};
const recover = ({ error, ids, attempted }) => evaluationServiceInternals.recoverApprovedDuplicate({
  error,
  attempted,
  agencyId: ids.agency,
  interventionId: ids.intervention,
  Models: { Evaluation, EvaluationSeries },
});

test("only exact Evaluation idempotency and ReportRun trigger identities recover an identical persisted winner", async () => {
  for (const index of [
    "phase4_evaluations_idempotency_unique",
    "phase4_evaluations_report_run_trigger_unique",
  ]) {
    await Promise.all([Evaluation.collection.deleteMany({}), EvaluationSeries.collection.deleteMany({})]);
    const seeded = await seed();
    const winner = await recover({ error: duplicate(index), ...seeded });
    assert.equal(String(winner?._id), String(seeded.ids.evaluation));
    assert.equal(await Evaluation.collection.countDocuments({}), 1);
    assert.equal((await EvaluationSeries.collection.findOne({ _id: seeded.ids.series })).next_sequence, 2);
  }
});

test("duplicate sequence and supersession conflicts never converge to an existing Evaluation", async () => {
  for (const index of [
    "phase4_evaluations_intervention_history",
    "phase4_evaluations_supersedes_unique",
  ]) {
    await Promise.all([Evaluation.collection.deleteMany({}), EvaluationSeries.collection.deleteMany({})]);
    const seeded = await seed();
    assert.equal(await recover({ error: duplicate(index), ...seeded }), null);
    assert.equal(await Evaluation.collection.countDocuments({}), 1);
    const series = await EvaluationSeries.collection.findOne({ _id: seeded.ids.series });
    assert.equal(String(series.current_evaluation_id), String(seeded.ids.evaluation));
    assert.equal(series.next_sequence, 2);
  }
});

test("conflicting evidence, source ReportRun, sequence, supersession, or winner ownership is never recovered", async () => {
  const cases = [
    (attempted) => ({ ...attempted, evidenceHash: "b".repeat(64) }),
    (attempted) => ({ ...attempted, sourceReportRunId: oid() }),
    (attempted) => ({ ...attempted, sequence: 2 }),
    (attempted) => ({ ...attempted, supersedesEvaluationId: oid() }),
  ];
  for (const mutate of cases) {
    await Promise.all([Evaluation.collection.deleteMany({}), EvaluationSeries.collection.deleteMany({})]);
    const seeded = await seed();
    assert.equal(await recover({ error: duplicate("phase4_evaluations_report_run_trigger_unique"), ids: seeded.ids, attempted: mutate(seeded.attempted) }), null);
    assert.equal(await Evaluation.collection.countDocuments({}), 1);
  }
  await Promise.all([Evaluation.collection.deleteMany({}), EvaluationSeries.collection.deleteMany({})]);
  const seeded = await seed();
  assert.equal(await evaluationServiceInternals.recoverApprovedDuplicate({ error: duplicate("phase4_evaluations_idempotency_unique"), attempted: seeded.attempted, agencyId: oid(), interventionId: seeded.ids.intervention, Models: { Evaluation, EvaluationSeries } }), null);
});

test("manual duplicate recovery validates the persisted request hash", async () => {
  const seeded = await seed({ requestHash: "c".repeat(64) });
  seeded.attempted.triggerType = "manual_refresh";
  seeded.attempted.sourceReportRunId = null;
  await Evaluation.collection.updateOne({ _id: seeded.ids.evaluation }, { $set: { trigger_type: "manual_refresh", source_report_run_id: null } });
  assert.ok(await recover({ error: duplicate("phase4_evaluations_idempotency_unique"), ...seeded }));
  assert.equal(await recover({ error: duplicate("phase4_evaluations_idempotency_unique"), ids: seeded.ids, attempted: { ...seeded.attempted, requestHash: "d".repeat(64) } }), null);
});

test("unrelated duplicate indexes are rejected from recovery", async () => {
  const seeded = await seed();
  assert.equal(await recover({ error: duplicate("some_unrelated_unique_index"), ...seeded }), null);
  assert.equal(await recover({ error: duplicate("idempotency_key_1"), ...seeded }), null);
  assert.equal(evaluationServiceInternals.duplicateIndexName(duplicate("some_unrelated_unique_index")), "some_unrelated_unique_index");
});
