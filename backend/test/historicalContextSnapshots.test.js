import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Activity,
  Agency,
  Client,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
  User,
} from "../src/models/index.js";
import {
  buildReportRunContextSnapshot,
  buildSignalContextSnapshotFromReportRun,
} from "../src/services/historicalContextSnapshot.service.js";
import { runHistoricalSnapshotBackfill } from "../src/services/historicalSnapshotBackfill.service.js";
import {
  archiveClientLifecycle,
  archiveReportLifecycle,
} from "../src/services/archiveLifecycle.service.js";
import { dispatchReportRunArtifact } from "../src/services/reportDelivery.service.js";
import { markExecutionIntegrityReady } from "../src/services/executionIntegrityIndexes.service.js";
import {
  acquireReportExecutionLease,
  findOrCreateReportRun,
  releaseReportExecutionLease,
} from "../src/services/reportExecution.service.js";
import { runReport } from "../src/services/reportRunner.service.js";
import { saveSignalsFromNarrative } from "../src/services/signalGenerator.service.js";

let replicaSet;
const id = () => new mongoose.Types.ObjectId();

const createDomain = async ({ suffix = "one" } = {}) => {
  const agency = await Agency.create({ name: `Apex ${suffix}`, slug: `apex-${suffix}` });
  const user = await User.create({
    agency_id: agency._id,
    full_name: "Sarah Analyst",
    email: `sarah-${suffix}@example.com`,
    role: "analyst",
  });
  const client = await Client.create({
    agency_id: agency._id,
    name: "Nike India",
    status: "stable",
  });
  const connection = await MetaConnection.create({
    agency_id: agency._id,
    connection_scope: "workspace",
    client_id: null,
    status: "active",
    is_active: true,
  });
  const metaAdAccount = await MetaAdAccount.create({
    agency_id: agency._id,
    meta_connection_id: connection._id,
    client_id: client._id,
    assignment_scope: "v1",
    ad_account_id: `act_${suffix}`,
    name: "Nike Ads",
    is_active: true,
    is_accessible: true,
  });
  const report = await Report.create({
    agency_id: agency._id,
    client_id: client._id,
    meta_ad_account_id: metaAdAccount._id,
    meta_account_external_id_snapshot: metaAdAccount.ad_account_id,
    meta_account_name_snapshot: metaAdAccount.name,
    created_by: user._id,
    name: "Weekly Review",
    type: "weekly",
    status: "active",
    severity: "low",
    recipients: ["legacy@example.com"],
    internal_recipients: ["team@example.com"],
    client_recipients: ["client@example.com"],
    generate_client_report: true,
    generate_internal_report: false,
    client_delivery_mode: "approval_required",
    monitored_campaigns: [
      { campaign_id: "summer", campaign_name: "Summer Sale" },
      { campaign_id: "brand", campaign_name: "Brand Search" },
    ],
    schedule: {
      timezone: "Asia/Kolkata",
      time_of_day: "09:00",
      day_of_week: 1,
    },
  });
  return { agency, user, client, report, connection, metaAdAccount };
};

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replicaSet.getUri(), {
    dbName: `narrative_phase1b_${Date.now()}`,
  });
  await Promise.all([
    Activity.init(),
    Agency.init(),
    Client.init(),
    MetaAdAccount.init(),
    MetaConnection.init(),
    Report.init(),
    ReportRun.init(),
    Signal.init(),
    User.init(),
  ]);
  markExecutionIntegrityReady();
}, { timeout: 120_000 });

beforeEach(async () => {
  await Promise.all([
    Activity.deleteMany({}),
    Agency.deleteMany({}),
    Client.deleteMany({}),
    MetaAdAccount.deleteMany({}),
    MetaConnection.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
    Signal.deleteMany({}),
    User.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
}, { timeout: 30_000 });

test("ReportRun context captures the explicit execution identity and configuration allowlist", async () => {
  const { agency, user, client, report } = await createDomain();
  const capturedAt = new Date("2026-06-01T03:30:00.000Z");
  const contextSnapshot = buildReportRunContextSnapshot({
    agency,
    client,
    report,
    actor: user,
    capturedAt,
    source: "execution",
  });
  const lease = await acquireReportExecutionLease({
    reportId: report._id,
    source: "manual",
  });
  assert.equal(lease.acquired, true);
  const { reportRun } = await findOrCreateReportRun({
    report: lease.report,
    leaseToken: lease.token,
    contextSnapshot,
    executionKey: `manual:${report._id}:snapshot-test`,
    source: "manual",
    period: {},
    userId: user._id,
    now: capturedAt,
  });
  await releaseReportExecutionLease({
    reportId: report._id,
    token: lease.token,
  });

  assert.equal(reportRun.context_snapshot.version, 1);
  assert.equal(reportRun.context_snapshot.source, "execution");
  assert.equal(reportRun.context_snapshot.captured_at.toISOString(), capturedAt.toISOString());
  assert.equal(reportRun.context_snapshot.workspace.name, "Apex one");
  assert.equal(reportRun.context_snapshot.client.name, "Nike India");
  assert.equal(reportRun.context_snapshot.report.name, "Weekly Review");
  assert.equal(reportRun.context_snapshot.actor.name, "Sarah Analyst");
  assert.deepEqual(reportRun.context_snapshot.report.configuration.toObject(), {
    type: "weekly",
    schedule: {
      timezone: "Asia/Kolkata",
      time_of_day: "09:00",
      day_of_week: 1,
      day_of_month: null,
    },
    client_delivery_mode: "approval_required",
    generate_client_report: true,
    generate_internal_report: false,
  });
  const serialized = reportRun.context_snapshot.toObject();
  assert.equal("recipients" in serialized.report.configuration, false);
  assert.equal("monitored_campaigns" in serialized.report.configuration, false);
  assert.equal(reportRun.monitored_campaigns.length, 2);
  assert.equal(reportRun.internal_report, null);
});

test("early ReportRun snapshot survives Meta failure and retry does not refresh live identity", async () => {
  const { agency, user, client, report } = await createDomain({ suffix: "retry" });
  const startedAt = new Date("2026-06-02T03:30:00.000Z");

  await assert.rejects(
    runReport(report._id, {
      force: true,
      triggerType: "manual",
      agencyId: agency._id,
      userId: user._id,
      now: startedAt,
    }),
    (error) => error.code === "META_RECONNECT_REQUIRED"
  );
  const firstRun = await ReportRun.findOne({ report_id: report._id });
  assert.equal(firstRun.execution_stage, "failed");
  assert.equal(firstRun.context_snapshot.client.name, "Nike India");
  assert.equal(firstRun.context_snapshot.report.name, "Weekly Review");
  assert.equal(firstRun.context_snapshot.actor.name, "Sarah Analyst");

  await Client.updateOne({ _id: client._id }, { $set: { name: "Nike South Asia" } });
  await Report.updateOne(
    { _id: report._id },
    {
      $set: {
        name: "Monthly Leadership Review",
        type: "monthly",
        schedule: {
          timezone: "UTC",
          time_of_day: "18:00",
          day_of_week: null,
          day_of_month: 10,
        },
      },
    }
  );
  await User.updateOne({ _id: user._id }, { $set: { full_name: "Sarah Updated" } });

  await assert.rejects(
    runReport(report._id, {
      force: true,
      triggerType: "manual",
      agencyId: agency._id,
      userId: user._id,
      now: new Date("2026-06-02T04:30:00.000Z"),
    }),
    (error) => error.code === "META_RECONNECT_REQUIRED"
  );
  const resumed = await ReportRun.findById(firstRun._id);
  assert.equal(resumed.context_snapshot.client.name, "Nike India");
  assert.equal(resumed.context_snapshot.report.name, "Weekly Review");
  assert.equal(resumed.context_snapshot.actor.name, "Sarah Analyst");
  assert.equal(resumed.context_snapshot.report.configuration.type, "weekly");
  assert.equal(resumed.context_snapshot.report.configuration.schedule.timezone, "Asia/Kolkata");
});

test("Signal context uses ReportRun Meta and campaign evidence and remains insert-only", async () => {
  const runId = id();
  const metaId = id();
  const contextSnapshot = {
    version: 1,
    captured_at: new Date("2026-06-03T00:00:00.000Z"),
    source: "execution",
    workspace: { name: "Apex" },
    client: { name: "Nike India" },
    report: { name: "Weekly Review" },
    actor: { name: "Sarah" },
  };
  const reportRun = {
    _id: runId,
    context_snapshot: contextSnapshot,
    started_at: contextSnapshot.captured_at,
    meta_ad_account_id: metaId,
    meta_account_external_id_snapshot: "act_123",
    meta_account_name_snapshot: "Nike Ads",
    monitored_campaigns: [
      { campaign_id: "summer", campaign_name: "Summer Sale" },
      { campaign_id: "brand", campaign_name: "Brand Search" },
      { campaign_id: "summer", campaign_name: "Duplicate" },
    ],
  };
  const campaignContext = buildSignalContextSnapshotFromReportRun({
    reportRun,
    campaignId: "summer",
  });
  const accountContext = buildSignalContextSnapshotFromReportRun({ reportRun });
  assert.deepEqual(campaignContext.campaigns, [
    { campaign_id: "summer", campaign_name: "Summer Sale" },
  ]);
  assert.deepEqual(accountContext.campaigns, [
    { campaign_id: "summer", campaign_name: "Summer Sale" },
    { campaign_id: "brand", campaign_name: "Brand Search" },
  ]);
  assert.equal(String(campaignContext.meta_account.meta_ad_account_id), String(metaId));
  assert.equal(campaignContext.meta_account.external_account_id, "act_123");
  assert.equal(campaignContext.meta_account.name, "Nike Ads");

  const { agency, client, report } = await createDomain({ suffix: "signal" });
  const persistedRun = await ReportRun.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    context_snapshot: contextSnapshot,
    meta_ad_account_id: metaId,
    meta_account_external_id_snapshot: "act_123",
    meta_account_name_snapshot: "Nike Ads",
    monitored_campaigns: reportRun.monitored_campaigns,
    status: "ok",
    severity: "medium",
    started_at: contextSnapshot.captured_at,
  });
  const input = {
    report,
    reportRun: persistedRun,
    reportRunId: persistedRun._id,
    narrative: {
      status: "insufficient_data",
      reason: "Need more data",
      campaign: { id: "summer" },
      userInsight: { headline: "Data needed" },
    },
    comparison: { period: {} },
  };
  const [first] = await saveSignalsFromNarrative(input);
  await assert.rejects(
    ReportRun.updateOne(
      { _id: persistedRun._id },
      { $set: { meta_account_name_snapshot: "Changed live evidence" } }
    ),
    (error) => error.code === "REPORT_RUN_IMMUTABLE_EVIDENCE"
  );
  const [second] = await saveSignalsFromNarrative({
    ...input,
    reportRun: await ReportRun.findById(persistedRun._id),
  });
  assert.equal(String(first._id), String(second._id));
  assert.equal(second.context_snapshot.client.name, "Nike India");
  assert.equal(second.context_snapshot.report.name, "Weekly Review");
  assert.equal(second.context_snapshot.meta_account.name, "Nike Ads");
  assert.equal(second.context_snapshot.campaigns[0].campaign_name, "Summer Sale");
});

test("backfill is dry-run safe, reference-honest, missing-only, and idempotent", async () => {
  const { agency, user, client, report } = await createDomain({ suffix: "backfill" });
  const destination = await Client.create({
    agency_id: agency._id,
    name: "Client B",
    status: "stable",
  });
  const runId = id();
  await ReportRun.collection.insertOne({
    _id: runId,
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    triggered_by: user._id,
    meta_ad_account_id: id(),
    meta_account_external_id_snapshot: "act_historical",
    meta_account_name_snapshot: "Historical Account",
    monitored_campaigns: [{ campaign_id: "summer", campaign_name: "Summer Sale" }],
    execution_stage: "completed",
    status: "ok",
    severity: "low",
    started_at: new Date("2026-05-01T00:00:00.000Z"),
    ran_at: new Date("2026-05-01T00:00:00.000Z"),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const signalWithRun = await Signal.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    report_run_id: runId,
    campaign_id: "summer",
    type: "metric_anomaly",
    severity: "moderate",
    title: "Historical signal",
  });
  const fallbackSignal = await Signal.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    campaign_id: "legacy-only",
    type: "metric_anomaly",
    severity: "moderate",
    title: "Legacy signal",
  });
  const preservedSignal = await Signal.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    type: "metric_anomaly",
    severity: "moderate",
    title: "Preserved",
    context_snapshot: {
      version: 1,
      captured_at: new Date("2020-01-01T00:00:00.000Z"),
      source: "execution",
      workspace: { name: "Original" },
      client: { name: "Original Client" },
      report: { name: "Original Report" },
      meta_account: {},
      campaigns: [],
    },
  });
  await Report.updateOne({ _id: report._id }, { $set: { client_id: destination._id } });

  const dryRun = await runHistoricalSnapshotBackfill({ apply: false, batchSize: 1 });
  assert.equal(dryRun.mode, "dry_run");
  assert.equal(dryRun.report_runs.missing, 1);
  assert.equal(dryRun.report_runs.updated, 0);
  assert.equal(dryRun.signals.missing, 2);
  assert.equal((await ReportRun.findById(runId)).context_snapshot, undefined);
  assert.equal((await Signal.findById(signalWithRun._id)).context_snapshot, undefined);

  const applied = await runHistoricalSnapshotBackfill({ apply: true, batchSize: 1 });
  assert.equal(applied.report_runs.updated, 1);
  assert.equal(applied.signals.updated, 2);
  const backfilledRun = await ReportRun.findById(runId);
  assert.equal(backfilledRun.context_snapshot.source, "backfill_current_reference");
  assert.equal(backfilledRun.context_snapshot.client.name, "Nike India");
  assert.equal(backfilledRun.context_snapshot.report.name, "Weekly Review");
  assert.equal(backfilledRun.meta_account_name_snapshot, "Historical Account");
  assert.equal(backfilledRun.monitored_campaigns[0].campaign_name, "Summer Sale");

  const derived = await Signal.findById(signalWithRun._id);
  assert.equal(derived.context_snapshot.source, "backfill_current_reference");
  assert.equal(derived.context_snapshot.client.name, "Nike India");
  assert.equal(derived.context_snapshot.meta_account.name, "Historical Account");
  assert.equal(derived.context_snapshot.campaigns[0].campaign_name, "Summer Sale");
  const fallback = await Signal.findById(fallbackSignal._id);
  assert.equal(fallback.context_snapshot.source, "backfill_current_reference");
  assert.equal(fallback.context_snapshot.meta_account.meta_ad_account_id, null);
  assert.equal(fallback.context_snapshot.meta_account.external_account_id, null);
  assert.equal(fallback.context_snapshot.meta_account.name, null);
  assert.equal(fallback.context_snapshot.campaigns[0].campaign_name, null);
  assert.equal(
    (await Signal.findById(preservedSignal._id)).context_snapshot.workspace.name,
    "Original"
  );

  const repeated = await runHistoricalSnapshotBackfill({ apply: true, batchSize: 1 });
  assert.equal(repeated.report_runs.updated, 0);
  assert.equal(repeated.signals.updated, 0);
});

test("archive and failed delivery do not mutate historical snapshots", async () => {
  const { agency, user, client, report } = await createDomain({ suffix: "lifecycle" });
  const capturedAt = new Date("2026-06-04T00:00:00.000Z");
  const contextSnapshot = buildReportRunContextSnapshot({
    agency,
    client,
    report,
    actor: user,
    capturedAt,
    source: "execution",
  });
  const reportRun = await ReportRun.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    context_snapshot: contextSnapshot,
    status: "ok",
    severity: "low",
    execution_stage: "artifacts_ready",
    internal_report: {
      status: "generated",
      subject: "Historical report",
      html: "<p>Historical report</p>",
      text: "Historical report",
      recipients: [{ email: "team@example.com", status: "pending" }],
      dispatch: {
        idempotency_key: `snapshot-delivery-${id()}`,
        status: "pending",
        attempt_count: 0,
      },
    },
  });
  const originalSnapshot = reportRun.context_snapshot.toObject();
  const originalFetch = globalThis.fetch;
  const originalWebhook = process.env.REPORT_EMAIL_WEBHOOK_URL;
  process.env.REPORT_EMAIL_WEBHOOK_URL = "https://n8n.example.com/report";
  globalThis.fetch = async () => {
    const error = new Error("connection reset");
    error.code = "ECONNRESET";
    throw error;
  };
  try {
    const delivery = await dispatchReportRunArtifact({
      reportRunId: reportRun._id,
      audience: "internal",
    });
    assert.equal(delivery.outcome, "uncertain");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.REPORT_EMAIL_WEBHOOK_URL;
    else process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhook;
  }
  assert.deepEqual(
    (await ReportRun.findById(reportRun._id)).context_snapshot.toObject(),
    originalSnapshot
  );

  await ReportRun.updateOne(
    { _id: reportRun._id },
    { $set: { "internal_report.dispatch.status": "not_required" } }
  );
  assert.equal(
    (await archiveReportLifecycle({
      agencyId: agency._id,
      reportId: report._id,
      userId: user._id,
    })).outcome,
    "archived"
  );
  assert.deepEqual(
    (await ReportRun.findById(reportRun._id)).context_snapshot.toObject(),
    originalSnapshot
  );

  const second = await createDomain({ suffix: "client-archive" });
  const secondSnapshot = buildReportRunContextSnapshot({
    agency: second.agency,
    client: second.client,
    report: second.report,
    actor: second.user,
    capturedAt,
    source: "execution",
  });
  const secondRun = await ReportRun.create({
    agency_id: second.agency._id,
    client_id: second.client._id,
    report_id: second.report._id,
    context_snapshot: secondSnapshot,
    status: "ok",
    severity: "low",
  });
  assert.equal(
    (await archiveClientLifecycle({
      agencyId: second.agency._id,
      clientId: second.client._id,
      userId: second.user._id,
    })).outcome,
    "archived"
  );
  assert.deepEqual(
    (await ReportRun.findById(secondRun._id)).context_snapshot.toObject(),
    secondSnapshot
  );
});

test("backfill leaves unresolved identities null instead of guessing", async () => {
  const agencyId = id();
  const clientId = id();
  const reportId = id();
  const userId = id();
  const runId = id();
  await ReportRun.collection.insertOne({
    _id: runId,
    agency_id: agencyId,
    client_id: clientId,
    report_id: reportId,
    triggered_by: userId,
    execution_stage: "failed",
    status: "failed",
    severity: "low",
    started_at: new Date("2026-05-02T00:00:00.000Z"),
    ran_at: new Date("2026-05-02T00:00:00.000Z"),
  });
  await runHistoricalSnapshotBackfill({ apply: true, batchSize: 10 });
  const run = await ReportRun.findById(runId);
  assert.equal(run.context_snapshot.workspace.name, null);
  assert.equal(run.context_snapshot.client.name, null);
  assert.equal(run.context_snapshot.report.name, null);
  assert.equal(run.context_snapshot.report.configuration, null);
  assert.equal(run.context_snapshot.actor.name, null);
  assert.equal(run.context_snapshot.source, "backfill_current_reference");
});
