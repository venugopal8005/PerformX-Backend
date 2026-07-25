import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { ReportRun } from "../src/models/ReportRun.js";

let mongo;
const id = () => new mongoose.Types.ObjectId();

const runDocument = (overrides = {}) => ({
  agency_id: id(),
  client_id: id(),
  report_id: id(),
  meta_ad_account_id: id(),
  meta_account_external_id_snapshot: "act_immutability",
  meta_account_name_snapshot: "Immutable account",
  meta_binding_revision_snapshot: 1,
  meta_binding_performance_validated_at: new Date("2026-07-10T00:00:00.000Z"),
  trigger_type: "manual",
  execution_key: `immutability:${randomUUID()}`,
  execution_stage: "completed",
  status: "ok",
  severity: "medium",
  context_snapshot: {
    version: 1,
    captured_at: new Date("2026-07-10T00:00:00.000Z"),
    source: "execution",
  },
  comparison: {
    period: {
      current: { start: "2026-07-09", end: "2026-07-09" },
      previous: { start: "2026-07-08", end: "2026-07-08" },
    },
  },
  narrative: { status: "ok", executiveSummary: "Persisted evidence" },
  engine_output: { status: "ok", executiveSummary: "Persisted evidence" },
  completed_at: new Date("2026-07-10T00:10:00.000Z"),
  ...overrides,
});

const immutableRejection = (promise) =>
  assert.rejects(
    promise,
    (error) => error.code === "REPORT_RUN_IMMUTABLE_EVIDENCE"
  );

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), {
    dbName: `report_run_immutability_${Date.now()}`,
  });
  await ReportRun.init();
});

after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test("finalized ReportRun evidence rejects every supported document/query rewrite path", async () => {
  const run = await ReportRun.create(runDocument());

  const saved = await ReportRun.findById(run._id);
  saved.narrative = { status: "ok", executiveSummary: "rewritten" };
  await immutableRejection(saved.save());
  await immutableRejection(
    ReportRun.updateOne(
      { _id: run._id },
      { $set: { "comparison.period.current.start": "2026-01-01" } }
    )
  );
  await immutableRejection(
    ReportRun.updateMany(
      { _id: run._id },
      { $set: { context_snapshot: { version: 1 } } }
    )
  );
  await immutableRejection(
    ReportRun.findOneAndUpdate(
      { _id: run._id },
      { $set: { engine_output: { status: "rewritten" } } }
    )
  );
  await immutableRejection(
    ReportRun.updateOne(
      { _id: run._id },
      { $set: { completed_at: new Date("2026-07-11T00:00:00.000Z") } }
    )
  );
  await assert.rejects(
    ReportRun.updateOne(
      { _id: run._id },
      [{ $set: { narrative: { status: "rewritten" } } }],
      { updatePipeline: true }
    ),
    (error) => error.code === "REPORT_RUN_UPDATE_PIPELINE_FORBIDDEN"
  );
  await immutableRejection(
    ReportRun.updateOne(
      { _id: run._id },
      { $rename: { narrative: "rewritten_narrative" } }
    )
  );
  await assert.rejects(
    ReportRun.findOneAndReplace({ _id: run._id }, runDocument()),
    (error) => error.code === "REPORT_RUN_REPLACEMENT_FORBIDDEN"
  );
  await assert.rejects(
    ReportRun.replaceOne({ _id: run._id }, runDocument()),
    (error) => error.code === "REPORT_RUN_REPLACEMENT_FORBIDDEN"
  );

  const persisted = await ReportRun.findById(run._id).lean();
  assert.equal(persisted.narrative.executiveSummary, "Persisted evidence");
  assert.equal(persisted.comparison.period.current.start, "2026-07-09");
  assert.equal(persisted.engine_output.executiveSummary, "Persisted evidence");
});

test("execution identity is immutable before finalization and lifecycle transitions are directed", async () => {
  const run = await ReportRun.create(
    runDocument({
      execution_stage: "claimed",
      status: "running",
      narrative: null,
      engine_output: null,
      completed_at: null,
    })
  );
  await immutableRejection(
    ReportRun.updateOne(
      { _id: run._id },
      { $set: { client_id: id() } }
    )
  );
  await assert.rejects(
    ReportRun.updateOne(
      { _id: run._id },
      { $set: { execution_stage: "completed" } }
    ),
    (error) => error.code === "REPORT_RUN_STAGE_TRANSITION_INVALID"
  );
  await assert.rejects(
    ReportRun.updateOne(
      { _id: run._id },
      { $unset: { execution_stage: 1 } }
    ),
    (error) => error.code === "REPORT_RUN_STAGE_TRANSITION_INVALID"
  );
});

test("valid pre-finalization evidence writes and post-finalization operational metadata remain allowed", async () => {
  const run = await ReportRun.create(
    runDocument({
      execution_stage: "claimed",
      status: "running",
      narrative: null,
      engine_output: null,
      completed_at: null,
    })
  );
  await ReportRun.updateOne(
    { _id: run._id },
    { $set: { execution_stage: "generating" } }
  );
  await ReportRun.updateOne(
    { _id: run._id },
    {
      $set: {
        narrative: { status: "ok", executiveSummary: "Generated once" },
        engine_output: { status: "ok", executiveSummary: "Generated once" },
        execution_stage: "artifacts_ready",
        status: "ok",
      },
    }
  );
  await ReportRun.updateOne(
    { _id: run._id },
    {
      $set: {
        execution_stage: "completed",
        completed_at: new Date(),
      },
    }
  );
  const operationalAt = new Date();
  const operational = await ReportRun.updateOne(
    { _id: run._id },
    { $set: { events_persisted_at: operationalAt } }
  );
  assert.equal(operational.modifiedCount, 1);
  const persisted = await ReportRun.findById(run._id).lean();
  assert.equal(persisted.execution_stage, "completed");
  assert.equal(persisted.narrative.executiveSummary, "Generated once");
  assert.equal(persisted.events_persisted_at.getTime(), operationalAt.getTime());
});
