import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { Issue, ReportRun, Signal } from "../src/models/index.js";
import {
  applyPhase3HistoricalIntegrityMigration,
  inspectPhase3HistoricalIntegrityMigration,
} from "../src/services/phase3HistoricalIntegrityMigration.service.js";

let mongo;
const id = () => new mongoose.Types.ObjectId();

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), {
    dbName: `phase3_history_migration_${Date.now()}`,
  });
  await Promise.all([Issue.init(), ReportRun.init(), Signal.init()]);
});

after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test("migration backfills stable Signal identity and bounded Issue cache without deleting legacy history", async () => {
  const agencyId = id();
  const clientId = id();
  const reportId = id();
  const run = await ReportRun.create({
    agency_id: agencyId,
    client_id: clientId,
    report_id: reportId,
    meta_ad_account_id: id(),
    trigger_type: "manual",
    execution_key: "phase3-migration-run",
    execution_stage: "completed",
    status: "ok",
    severity: "medium",
    comparison: {
      period: {
        current: { start: "2026-07-10", end: "2026-07-10" },
        previous: { start: "2026-07-09", end: "2026-07-09" },
      },
    },
    narrative: { status: "ok" },
  });
  const signal = await Signal.create({
    agency_id: agencyId,
    client_id: clientId,
    report_id: reportId,
    report_run_id: run._id,
    campaign_id: "campaign-1",
    type: "metric_anomaly",
    severity: "moderate",
    title: "CPA increased",
    metadata: { primary_anomaly: { metric: "cpa", delta: 25 } },
  });
  const legacyReportIds = Array.from({ length: 40 }, id);
  const legacyIssueId = id();
  await Issue.collection.insertOne({
    _id: legacyIssueId,
    agency_id: agencyId,
    client_id: clientId,
    meta_ad_account_id: id(),
    report_ids: legacyReportIds,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await Signal.collection.createIndex(
    { report_run_id: 1 },
    { name: "legacy_report_run_signal_unique", unique: true, sparse: true }
  );

  const inspection = await inspectPhase3HistoricalIntegrityMigration();
  assert.equal(inspection.signalsNeedingIdentity, 1);
  assert.equal(inspection.issuesNeedingRecentCache, 1);
  assert.deepEqual(inspection.legacySingleSignalIndexNames, [
    "legacy_report_run_signal_unique",
  ]);

  const result = await applyPhase3HistoricalIntegrityMigration({
    expected: inspection,
  });
  assert.equal(result.signalsNeedingIdentity, 0);
  assert.equal(result.issuesNeedingRecentCache, 0);
  assert.equal(result.duplicateIdentities, 0);
  assert.equal(result.identityIndexReady, true);
  assert.deepEqual(result.legacySingleSignalIndexNames, []);

  const migratedSignal = await Signal.findById(signal._id).lean();
  assert.match(migratedSignal.observation_key, /^[a-f0-9]{64}$/);
  assert.equal(migratedSignal.observation_identity_version, 1);
  const migratedIssue = await Issue.collection.findOne({ _id: legacyIssueId });
  assert.equal(migratedIssue.report_ids.length, 40);
  assert.equal(migratedIssue.recent_report_ids.length, 25);
  assert.deepEqual(
    migratedIssue.recent_report_ids.map(String),
    legacyReportIds.slice(-25).map(String)
  );
});

