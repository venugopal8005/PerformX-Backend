import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Evaluation, EvaluationSeries, Intervention } from "../src/models/index.js";

let replset;
before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of ["evaluations", "evaluation_series", "interventions"]) {
    await mongoose.connection.createCollection(name).catch(() => {});
  }
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => {
  await Promise.all([Evaluation.collection.deleteMany({}), EvaluationSeries.collection.deleteMany({}), Intervention.collection.deleteMany({})]);
});

const oid = () => new mongoose.Types.ObjectId();
const unchanged = async (collection, id, expected) => {
  assert.deepEqual(await collection.findOne({ _id: id }), expected);
};

test("Evaluation bulk updates, pipelines, replacements, and deletes are rejected without persisted change", async () => {
  const id = oid();
  await Evaluation.collection.insertOne({ _id: id, agency_id: oid(), status: "ready", evidence_hash: "a".repeat(64), nested: { value: 1 } });
  const original = await Evaluation.collection.findOne({ _id: id });
  const operations = [
    [{ updateOne: { filter: { _id: id }, update: { $set: { status: "invalidated" } } } }],
    [{ updateOne: { filter: { _id: id }, update: [{ $set: { status: "invalidated" } }] } }],
    [{ replaceOne: { filter: { _id: id }, replacement: { _id: id, agency_id: original.agency_id, status: "invalidated" } } }],
    [{ deleteOne: { filter: { _id: id } } }],
    [{ deleteMany: { filter: { agency_id: original.agency_id } } }],
  ];
  for (const writes of operations) {
    await assert.rejects(Evaluation.bulkWrite(writes), (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED");
    await unchanged(Evaluation.collection, id, original);
  }
});

test("Evaluation direct query and document deletion are rejected without persisted change", async () => {
  const id = oid();
  await Evaluation.collection.insertOne({ _id: id, agency_id: oid(), status: "ready", evidence_hash: "b".repeat(64) });
  const original = await Evaluation.collection.findOne({ _id: id });
  await assert.rejects(Evaluation.deleteOne({ _id: id }), (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED");
  await unchanged(Evaluation.collection, id, original);
  await assert.rejects(Evaluation.findOneAndDelete({ _id: id }), (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED");
  await unchanged(Evaluation.collection, id, original);
  await assert.rejects(Evaluation.findByIdAndDelete(id), (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED");
  await unchanged(Evaluation.collection, id, original);
  const document = await Evaluation.findById(id);
  await assert.rejects(document.deleteOne(), (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED");
  await unchanged(Evaluation.collection, id, original);
});

test("Evaluation findOneAndReplace is rejected and immutable evidence remains byte-for-byte unchanged", async () => {
  const id = oid();
  await Evaluation.collection.insertOne({ _id: id, agency_id: oid(), status: "ready", evidence_hash: "c".repeat(64), nested: { value: 1 } });
  const original = await Evaluation.collection.findOne({ _id: id });
  await assert.rejects(
    Evaluation.findOneAndReplace(
      { _id: id },
      { ...original, status: "invalidated", evidence_hash: "d".repeat(64), nested: { value: 2 } }
    ),
    (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED"
  );
  await unchanged(Evaluation.collection, id, original);
});

test("EvaluationSeries bulk mutation cannot alter pointer, sequence, revision, or lease", async () => {
  const id = oid();
  await EvaluationSeries.collection.insertOne({
    _id: id,
    agency_id: oid(),
    client_id: oid(),
    issue_id: oid(),
    intervention_id: oid(),
    current_evaluation_id: oid(),
    next_sequence: 4,
    revision: 3,
    processing_lock: { operation: "report_run", token: "owned", acquired_at: new Date(0), heartbeat_at: new Date(0), expires_at: new Date("2030-01-01") },
  });
  const original = await EvaluationSeries.collection.findOne({ _id: id });
  await assert.rejects(EvaluationSeries.bulkWrite([{ updateOne: { filter: { _id: id }, update: [{ $set: { revision: 99, next_sequence: 99, processing_lock: null } }] } }]), (error) => error.code === "EVALUATION_SERIES_QUERY_MUTATION_REJECTED");
  await unchanged(EvaluationSeries.collection, id, original);
});

test("EvaluationSeries findOneAndReplace is rejected and authority remains byte-for-byte unchanged", async () => {
  const id = oid();
  const authority = {
    _id: id,
    agency_id: oid(),
    client_id: oid(),
    issue_id: oid(),
    intervention_id: oid(),
    current_evaluation_id: oid(),
    next_sequence: 4,
    revision: 3,
    processing_lock: { operation: "report_run", token: "owned", acquired_at: new Date(0), heartbeat_at: new Date(0), expires_at: new Date("2030-01-01") },
  };
  await EvaluationSeries.collection.insertOne(authority);
  const original = await EvaluationSeries.collection.findOne({ _id: id });
  await assert.rejects(
    EvaluationSeries.findOneAndReplace(
      { _id: id },
      { ...authority, current_evaluation_id: oid(), next_sequence: 99, revision: 99, processing_lock: null }
    ),
    (error) => error.code === "EVALUATION_SERIES_QUERY_MUTATION_REJECTED"
  );
  await unchanged(EvaluationSeries.collection, id, original);
});

test("EvaluationSeries operation labels cannot bypass the fenced authority contract", async () => {
  const id = oid();
  const authority = {
    _id: id,
    agency_id: oid(),
    client_id: oid(),
    issue_id: oid(),
    intervention_id: oid(),
    current_evaluation_id: oid(),
    next_sequence: 4,
    revision: 3,
    processing_lock: { operation: "report_run", token: "owned", acquired_at: new Date(0), heartbeat_at: new Date(0), expires_at: new Date("2030-01-01") },
  };
  await EvaluationSeries.collection.insertOne(authority);
  const original = await EvaluationSeries.collection.findOne({ _id: id });
  await assert.rejects(
    EvaluationSeries.findOneAndUpdate(
      { _id: id },
      { $set: { current_evaluation_id: oid() }, $inc: { next_sequence: 1, revision: 1 } },
      { new: true, phase4SeriesOperation: "advance" }
    ),
    (error) => error.code === "EVALUATION_SERIES_QUERY_MUTATION_REJECTED"
  );
  await unchanged(EvaluationSeries.collection, id, original);
});

test("EvaluationSeries document deletion is rejected and authority remains unchanged", async () => {
  const id = oid();
  await EvaluationSeries.collection.insertOne({
    _id: id,
    agency_id: oid(),
    client_id: oid(),
    issue_id: oid(),
    intervention_id: oid(),
    current_evaluation_id: oid(),
    next_sequence: 2,
    revision: 1,
  });
  const original = await EvaluationSeries.collection.findOne({ _id: id });
  const document = await EvaluationSeries.findById(id);
  await assert.rejects(document.deleteOne(), (error) => error.code === "EVALUATION_SERIES_QUERY_MUTATION_REJECTED");
  await unchanged(EvaluationSeries.collection, id, original);
});

test("Intervention bulk mutation cannot alter immutable evaluation intent", async () => {
  const id = oid();
  await Intervention.collection.insertOne({
    _id: id,
    agency_id: oid(),
    evaluation_intent: { mode: "auto_resolved", primary_metric: "ctr", watched_metrics: ["ctr"], resolution_source: "issue_metric_family", rule_version: 1 },
  });
  const original = await Intervention.collection.findOne({ _id: id });
  for (const update of [
    { $set: { "evaluation_intent.primary_metric": "cpc" } },
    [{ $set: { evaluation_intent: { mode: "unresolved", primary_metric: null, watched_metrics: [], resolution_source: "bad", rule_version: 1 } } }],
    { $unset: { evaluation_intent: 1 } },
    { $rename: { evaluation_intent: "changed_intent" } },
  ]) {
    await assert.rejects(Intervention.bulkWrite([{ updateOne: { filter: { _id: id }, update } }]), (error) => error.code === "INTERVENTION_QUERY_MUTATION_REJECTED");
    await unchanged(Intervention.collection, id, original);
  }
});

test("Intervention findOneAndReplace cannot alter evaluation intent", async () => {
  const id = oid();
  const intervention = {
    _id: id,
    agency_id: oid(),
    evaluation_intent: { mode: "auto_resolved", primary_metric: "ctr", watched_metrics: ["ctr"], resolution_source: "issue_metric_family", rule_version: 1 },
  };
  await Intervention.collection.insertOne(intervention);
  const original = await Intervention.collection.findOne({ _id: id });
  await assert.rejects(
    Intervention.findOneAndReplace(
      { _id: id },
      { ...intervention, evaluation_intent: { mode: "auto_resolved", primary_metric: "cpc", watched_metrics: ["cpc"], resolution_source: "replacement", rule_version: 1 } }
    ),
    (error) => error.code === "INTERVENTION_QUERY_MUTATION_REJECTED"
  );
  await unchanged(Intervention.collection, id, original);
});
