import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { EvaluationSeries } from "../src/models/EvaluationSeries.js";
import {
  acquireEvaluationSeriesLease,
  ensureEvaluationSeries,
  releaseEvaluationSeriesLease,
  renewEvaluationSeriesLease,
} from "../src/services/evaluationSeries.service.js";

let replset;
before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  await mongoose.connection.createCollection("evaluation_series").catch(() => {});
  await EvaluationSeries.collection.createIndex({ agency_id: 1, intervention_id: 1 }, { unique: true, name: "phase4_evaluation_series_intervention_unique" });
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { await EvaluationSeries.collection.deleteMany({}); });

const identity = () => ({ agencyId: new mongoose.Types.ObjectId(), clientId: new mongoose.Types.ObjectId(), issueId: new mongoose.Types.ObjectId(), interventionId: new mongoose.Types.ObjectId() });
test("concurrent Series creation converges on one authority", async () => {
  const input = identity();
  const [left, right] = await Promise.all([ensureEvaluationSeries(input), ensureEvaluationSeries(input)]);
  assert.equal(String(left._id), String(right._id));
  assert.equal(await EvaluationSeries.collection.countDocuments({}), 1);
});
test("only one concurrent processing lease is acquired", async () => {
  const input = identity();
  await ensureEvaluationSeries(input);
  const leases = await Promise.all([acquireEvaluationSeriesLease({ ...input, operation: "report_run" }), acquireEvaluationSeriesLease({ ...input, operation: "manual_refresh" })]);
  assert.equal(leases.filter((item) => item.acquired).length, 1);
});
test("wrong token cannot renew or release another holder lease", async () => {
  const input = identity();
  await ensureEvaluationSeries(input);
  const lease = await acquireEvaluationSeriesLease({ ...input, operation: "report_run" });
  assert.equal(await renewEvaluationSeriesLease({ ...input, token: "wrong" }), null);
  assert.equal(await releaseEvaluationSeriesLease({ ...input, token: "wrong" }), false);
  assert.ok(await renewEvaluationSeriesLease({ ...input, token: lease.token }));
});
test("expired persisted lease can be acquired by a new holder", async () => {
  const input = identity();
  const series = await ensureEvaluationSeries(input);
  await EvaluationSeries.collection.updateOne({ _id: series._id }, { $set: { processing_lock: { operation: "report_run", token: "expired", acquired_at: new Date(0), heartbeat_at: new Date(0), expires_at: new Date(1) } } });
  const lease = await acquireEvaluationSeriesLease({ ...input, operation: "reconciliation", now: new Date() });
  assert.equal(lease.acquired, true);
  assert.notEqual(lease.token, "expired");
});

