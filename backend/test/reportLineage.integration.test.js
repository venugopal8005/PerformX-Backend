import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Client,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
} from "../src/models/index.js";
import { updateReport } from "../src/controllers/reports.controller.js";
import {
  acquireRequiredClientLifecycleLease,
  fenceClientLifecycleLeaseInTransaction,
  releaseClientLifecycleLease,
} from "../src/services/clientLifecycle.service.js";
import {
  acquireReportExecutionLease,
  findOrCreateReportRun,
  releaseReportExecutionLease,
  renewReportExecutionLease,
} from "../src/services/reportExecution.service.js";
import {
  assertReportClientReparentAllowed,
  hasReportHistoricalEvidence,
} from "../src/services/reportLineage.service.js";
import { auditReportClientLineage } from "../src/services/reportLineageAudit.service.js";
import { runRequiredTransaction } from "../src/services/requiredTransaction.service.js";

let replicaSet;
const objectId = () => new mongoose.Types.ObjectId();

const response = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const createClient = ({ agencyId, name }) =>
  Client.create({ agency_id: agencyId, name, status: "stable" });

const createReport = ({ agencyId, clientId, userId, name = "Daily Monitor" }) =>
  Report.create({
    agency_id: agencyId,
    client_id: clientId,
    created_by: userId,
    name,
    type: "daily",
    status: "paused",
    severity: "low",
    internal_recipients: ["team@example.com"],
    monitored_campaigns: [
      { campaign_id: "campaign-1", campaign_name: "Campaign One" },
    ],
    schedule: { timezone: "UTC", time_of_day: "09:00" },
  });

const createScenario = async () => {
  const agencyId = objectId();
  const userId = objectId();
  const source = await createClient({ agencyId, name: "Source Client" });
  const destination = await createClient({ agencyId, name: "Destination Client" });
  const connection = await MetaConnection.create({
    agency_id: agencyId,
    connection_scope: "workspace",
    client_id: null,
    access_token: "test-access-token",
    status: "active",
    is_active: true,
  });
  const destinationAccount = await MetaAdAccount.create({
    agency_id: agencyId,
    meta_connection_id: connection._id,
    client_id: destination._id,
    assignment_scope: "v1",
    ad_account_id: `act_${destination._id}`,
    name: "Destination Account",
    is_active: true,
    is_accessible: true,
  });
  const sourceAccount = await MetaAdAccount.create({
    agency_id: agencyId,
    meta_connection_id: connection._id,
    client_id: source._id,
    assignment_scope: "v1",
    ad_account_id: `act_${source._id}`,
    name: "Source Account",
    is_active: true,
    is_accessible: true,
  });
  const report = await createReport({
    agencyId,
    clientId: source._id,
    userId,
  });
  await Report.updateOne(
    { _id: report._id },
    {
      $set: {
        meta_ad_account_id: sourceAccount._id,
        meta_account_external_id_snapshot: sourceAccount.ad_account_id,
        meta_account_name_snapshot: sourceAccount.name,
      },
    }
  );
  const boundReport = await Report.findById(report._id);
  return {
    agencyId,
    userId,
    source,
    destination,
    sourceAccount,
    destinationAccount,
    report: boundReport,
  };
};

const withMetaCampaignMock = async (work) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{ id: "campaign-1", name: "Campaign One" }],
    }),
  });
  try {
    return await work();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const update = async ({ scenario, updates }) => {
  const res = response();
  await withMetaCampaignMock(() =>
    updateReport(
      {
        user: { id: scenario.userId, agencyId: scenario.agencyId },
        body: { reportId: scenario.report._id, updates },
      },
      res
    )
  );
  return res;
};

const reparent = (scenario) =>
  update({
    scenario,
    updates: {
      client_id: scenario.destination._id,
      meta_ad_account_id: scenario.destinationAccount._id,
      monitored_campaigns: [
        { campaign_id: "campaign-1", campaign_name: "Campaign One" },
      ],
    },
  });

const createRunEvidence = ({ scenario, report = scenario.report, stage = "failed" }) =>
  ReportRun.create({
    agency_id: scenario.agencyId,
    client_id: report.client_id,
    report_id: report._id,
    execution_stage: stage,
    status: stage === "failed" ? "failed" : "running",
    severity: "low",
  });

const createSignalEvidence = ({ scenario, report = scenario.report }) =>
  Signal.create({
    agency_id: scenario.agencyId,
    client_id: report.client_id,
    report_id: report._id,
    type: "metric_anomaly",
    severity: "moderate",
    title: "Legacy signal",
  });

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replicaSet.getUri(), {
    dbName: `narrative_phase1c_${Date.now()}`,
  });
  await Promise.all([
    Client.init(),
    MetaAdAccount.init(),
    MetaConnection.init(),
    Report.init(),
    ReportRun.init(),
    Signal.init(),
  ]);
}, { timeout: 120_000 });

beforeEach(async () => {
  await Promise.all([
    Client.deleteMany({}),
    MetaAdAccount.deleteMany({}),
    MetaConnection.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
    Signal.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
}, { timeout: 30_000 });

test("no-history report reparent succeeds through the existing controller transaction", async () => {
  const scenario = await createScenario();
  const res = await reparent(scenario);

  assert.equal(res.statusCode, 200);
  assert.equal(String(res.payload.report.client_id), String(scenario.destination._id));
  assert.equal(
    String(res.payload.report.meta_ad_account_id),
    String(scenario.destinationAccount._id)
  );
  assert.equal(res.payload.report.meta_account_name_snapshot, "Destination Account");
});

test("any ReportRun stage permanently blocks client reparent and releases the destination fence", async () => {
  for (const stage of [
    "claimed",
    "generating",
    "failed",
    "artifacts_ready",
    "delivering",
    "completed",
  ]) {
    const scenario = await createScenario();
    await createRunEvidence({ scenario, stage });
    const res = await reparent(scenario);

    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, "REPORT_CLIENT_LINEAGE_LOCKED");
    assert.equal(res.payload.reason, "historical_evidence_exists");
    assert.equal(
      String((await Report.findById(scenario.report._id)).client_id),
      String(scenario.source._id)
    );
    const destination = await Client.findById(scenario.destination._id).select(
      "+lifecycle_lock"
    );
    assert.equal(destination.lifecycle_lock, undefined);

    await Promise.all([
      Client.deleteMany({}),
      MetaAdAccount.deleteMany({}),
      MetaConnection.deleteMany({}),
      Report.deleteMany({}),
      ReportRun.deleteMany({}),
      Signal.deleteMany({}),
    ]);
  }
});

test("legacy Signal-only evidence blocks client reparent", async () => {
  const scenario = await createScenario();
  await createSignalEvidence({ scenario });
  const evidence = await hasReportHistoricalEvidence({
    agencyId: scenario.agencyId,
    reportId: scenario.report._id,
  });
  assert.deepEqual(evidence, {
    exists: true,
    reportRunExists: false,
    signalExists: true,
  });

  const res = await reparent(scenario);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, "REPORT_CLIENT_LINEAGE_LOCKED");
  assert.equal(
    String((await Report.findById(scenario.report._id)).client_id),
    String(scenario.source._id)
  );
});

test("same-client and client-omitted updates remain allowed with history", async () => {
  const scenario = await createScenario();
  await createRunEvidence({ scenario });
  await createSignalEvidence({ scenario });

  const sameClient = await update({
    scenario,
    updates: { client_id: scenario.source._id, name: "Renamed with history" },
  });
  assert.equal(sameClient.statusCode, 200);
  assert.equal(sameClient.payload.report.name, "Renamed with history");

  const noClient = await update({
    scenario,
    updates: { client_delivery_mode: "approval_required" },
  });
  assert.equal(noClient.statusCode, 200);
  assert.equal(noClient.payload.report.client_delivery_mode, "approval_required");
});

test("execution lease wins, then its ReportRun evidence permanently locks lineage", async () => {
  const scenario = await createScenario();
  const lease = await acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
  });
  assert.equal(lease.acquired, true);

  const whileRunning = await reparent(scenario);
  assert.equal(whileRunning.statusCode, 409);
  assert.equal(whileRunning.payload.code, "report_execution_in_progress");
  assert.equal(
    String((await Report.findById(scenario.report._id)).client_id),
    String(scenario.source._id)
  );

  await findOrCreateReportRun({
    report: lease.report,
    leaseToken: lease.token,
    executionKey: `manual:${scenario.report._id}:phase1c`,
    source: "manual",
    period: {},
    userId: scenario.userId,
  });
  await releaseReportExecutionLease({
    reportId: scenario.report._id,
    token: lease.token,
  });

  const afterExecution = await reparent(scenario);
  assert.equal(afterExecution.statusCode, 409);
  assert.equal(afterExecution.payload.code, "REPORT_CLIENT_LINEAGE_LOCKED");
});

test("reparent wins before execution and all later evidence uses the destination client", async () => {
  const scenario = await createScenario();
  const moved = await reparent(scenario);
  assert.equal(moved.statusCode, 200);

  const lease = await acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
  });
  assert.equal(lease.acquired, true);
  assert.equal(String(lease.report.client_id), String(scenario.destination._id));
  const { reportRun } = await findOrCreateReportRun({
    report: lease.report,
    leaseToken: lease.token,
    executionKey: `manual:${scenario.report._id}:after-reparent`,
    source: "manual",
    period: {},
    userId: scenario.userId,
  });
  assert.equal(String(reportRun.client_id), String(scenario.destination._id));
  assert.equal(
    await ReportRun.countDocuments({
      report_id: scenario.report._id,
      client_id: scenario.source._id,
    }),
    0
  );
  await releaseReportExecutionLease({
    reportId: scenario.report._id,
    token: lease.token,
  });
});

test("real Report write contention serializes reparent before execution lease acquisition", async () => {
  const scenario = await createScenario();
  const destinationLease = await acquireRequiredClientLifecycleLease({
    agencyId: scenario.agencyId,
    clientId: scenario.destination._id,
    operation: "report_reparent",
  });
  let allowCommit;
  const commitGate = new Promise((resolve) => {
    allowCommit = resolve;
  });
  let reportWriteCompleted;
  const reportWritten = new Promise((resolve) => {
    reportWriteCompleted = resolve;
  });

  const reparentTransaction = runRequiredTransaction({
    work: async (session) => {
      await fenceClientLifecycleLeaseInTransaction({
        agencyId: scenario.agencyId,
        clientId: scenario.destination._id,
        token: destinationLease.token,
        session,
      });
      const report = await Report.findOne({
        _id: scenario.report._id,
        agency_id: scenario.agencyId,
      })
        .select("+execution_lock")
        .session(session);
      await assertReportClientReparentAllowed({
        agencyId: scenario.agencyId,
        report,
        session,
      });
      report.client_id = scenario.destination._id;
      await report.save({ session });
      reportWriteCompleted();
      await commitGate;
    },
  });

  await reportWritten;
  const executionAttempt = acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
  });
  await new Promise((resolve) => setImmediate(resolve));
  allowCommit();
  await reparentTransaction;
  const executionLease = await executionAttempt;

  assert.equal(executionLease.acquired, true);
  assert.equal(
    String(executionLease.report.client_id),
    String(scenario.destination._id)
  );
  await releaseReportExecutionLease({
    reportId: scenario.report._id,
    token: executionLease.token,
  });
  await releaseClientLifecycleLease({
    agencyId: scenario.agencyId,
    clientId: scenario.destination._id,
    token: destinationLease.token,
  });
});

test("execution lease renewal requires exact live ownership and never revives expiry", async () => {
  const scenario = await createScenario();
  const base = new Date();
  const lease = await acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
    now: base,
    leaseMs: 60_000,
  });
  assert.equal(lease.acquired, true);

  assert.equal(
    await renewReportExecutionLease({
      reportId: scenario.report._id,
      agencyId: scenario.agencyId,
      token: lease.token,
      now: new Date(base.getTime() + 1_000),
      leaseMs: 60_000,
    }),
    true
  );
  assert.equal(
    await renewReportExecutionLease({
      reportId: scenario.report._id,
      agencyId: scenario.agencyId,
      token: "wrong-token",
      now: new Date(base.getTime() + 2_000),
    }),
    false
  );
  assert.equal(
    await renewReportExecutionLease({
      reportId: scenario.report._id,
      agencyId: objectId(),
      token: lease.token,
      now: new Date(base.getTime() + 2_000),
    }),
    false
  );

  const boundary = new Date(base.getTime() + 3_000);
  await Report.updateOne(
    { _id: scenario.report._id },
    { $set: { "execution_lock.expires_at": boundary } }
  );
  assert.equal(
    await renewReportExecutionLease({
      reportId: scenario.report._id,
      agencyId: scenario.agencyId,
      token: lease.token,
      now: boundary,
    }),
    false
  );
  assert.equal(
    await renewReportExecutionLease({
      reportId: scenario.report._id,
      agencyId: scenario.agencyId,
      token: lease.token,
      now: new Date(boundary.getTime() + 1),
    }),
    false
  );

  await Report.updateOne(
    { _id: scenario.report._id },
    {
      $set: {
        is_archived: true,
        "execution_lock.expires_at": new Date(base.getTime() + 120_000),
      },
    }
  );
  assert.equal(
    await renewReportExecutionLease({
      reportId: scenario.report._id,
      agencyId: scenario.agencyId,
      token: lease.token,
      now: new Date(base.getTime() + 4_000),
    }),
    false
  );

  await Report.updateOne(
    { _id: scenario.report._id },
    {
      $set: {
        is_archived: false,
        "execution_lock.expires_at": boundary,
      },
    }
  );
  const replacement = await acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
    now: new Date(boundary.getTime() + 1),
  });
  assert.equal(replacement.acquired, true);
  assert.notEqual(replacement.token, lease.token);
});

test("initial ReportRun transaction fences token, expiry, Client, and archive state", async () => {
  const valid = await createScenario();
  const validLease = await acquireReportExecutionLease({
    reportId: valid.report._id,
    source: "manual",
  });
  const executionKey = `manual:${valid.report._id}:fenced`;
  const first = await findOrCreateReportRun({
    report: validLease.report,
    leaseToken: validLease.token,
    executionKey,
    source: "manual",
    period: {},
    userId: valid.userId,
  });
  const resumed = await findOrCreateReportRun({
    report: validLease.report,
    leaseToken: validLease.token,
    contextSnapshot: { should_not_replace: true },
    executionKey,
    source: "manual",
    period: {},
    userId: valid.userId,
  });
  assert.equal(first.created, true);
  assert.equal(resumed.created, false);
  assert.equal(String(resumed.reportRun._id), String(first.reportRun._id));
  assert.equal(await ReportRun.countDocuments({ execution_key: executionKey }), 1);
  assert.equal(resumed.reportRun.context_snapshot, undefined);
  await Report.updateOne(
    { _id: valid.report._id },
    { $set: { "execution_lock.expires_at": new Date(Date.now() - 1) } }
  );
  await assert.rejects(
    findOrCreateReportRun({
      report: validLease.report,
      leaseToken: validLease.token,
      executionKey,
      source: "manual",
      period: {},
    }),
    (error) => error.code === "REPORT_EXECUTION_LEASE_LOST"
  );
  assert.equal(await ReportRun.countDocuments({ execution_key: executionKey }), 1);

  const wrongClient = await createScenario();
  const wrongClientLease = await acquireReportExecutionLease({
    reportId: wrongClient.report._id,
    source: "manual",
  });
  const staleClientReport = wrongClientLease.report.toObject();
  staleClientReport.client_id = wrongClient.destination._id;
  await assert.rejects(
    findOrCreateReportRun({
      report: staleClientReport,
      leaseToken: wrongClientLease.token,
      executionKey: `manual:${wrongClient.report._id}:wrong-client`,
      source: "manual",
      period: {},
    }),
    (error) => error.code === "REPORT_CLIENT_LINEAGE_CHANGED"
  );

  const wrongToken = await createScenario();
  const wrongTokenLease = await acquireReportExecutionLease({
    reportId: wrongToken.report._id,
    source: "manual",
  });
  await assert.rejects(
    findOrCreateReportRun({
      report: wrongTokenLease.report,
      leaseToken: "wrong-token",
      executionKey: `manual:${wrongToken.report._id}:wrong-token`,
      source: "manual",
      period: {},
    }),
    (error) => error.code === "REPORT_EXECUTION_LEASE_LOST"
  );

  const expired = await createScenario();
  const expiredLease = await acquireReportExecutionLease({
    reportId: expired.report._id,
    source: "manual",
  });
  await Report.updateOne(
    { _id: expired.report._id },
    { $set: { "execution_lock.expires_at": new Date(Date.now() - 1) } }
  );
  await assert.rejects(
    findOrCreateReportRun({
      report: expiredLease.report,
      leaseToken: expiredLease.token,
      executionKey: `manual:${expired.report._id}:expired`,
      source: "manual",
      period: {},
    }),
    (error) => error.code === "REPORT_EXECUTION_LEASE_LOST"
  );

  const archived = await createScenario();
  const archivedLease = await acquireReportExecutionLease({
    reportId: archived.report._id,
    source: "manual",
  });
  await Report.updateOne(
    { _id: archived.report._id },
    { $set: { is_archived: true } }
  );
  await assert.rejects(
    findOrCreateReportRun({
      report: archivedLease.report,
      leaseToken: archivedLease.token,
      executionKey: `manual:${archived.report._id}:archived`,
      source: "manual",
      period: {},
    }),
    (error) => error.code === "REPORT_ARCHIVED"
  );

  assert.equal(
    await ReportRun.countDocuments({
      report_id: { $in: [wrongClient.report._id, wrongToken.report._id, expired.report._id, archived.report._id] },
    }),
    0
  );
});

test("initial ReportRun transaction rolls back both evidence and lease fence on failure", async () => {
  const scenario = await createScenario();
  const base = new Date();
  const lease = await acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
    now: base,
    leaseMs: 60_000,
  });
  const before = await Report.findById(scenario.report._id).select("+execution_lock");
  const forcedFailure = new Error("forced transactional create failure");
  const ThrowingReportRunModel = {
    findOne: (...args) => ReportRun.findOne(...args),
    create: async (documents, options) => {
      await ReportRun.create(documents, options);
      throw forcedFailure;
    },
  };

  await assert.rejects(
    findOrCreateReportRun({
      report: lease.report,
      leaseToken: lease.token,
      executionKey: `manual:${scenario.report._id}:rollback`,
      source: "manual",
      period: {},
      ownershipNow: new Date(base.getTime() + 1_000),
      ReportRunModel: ThrowingReportRunModel,
    }),
    forcedFailure
  );

  const after = await Report.findById(scenario.report._id).select("+execution_lock");
  assert.equal(await ReportRun.countDocuments({ report_id: scenario.report._id }), 0);
  assert.equal(
    after.execution_lock.expires_at.toISOString(),
    before.execution_lock.expires_at.toISOString()
  );
});

test("expired stale execution holder cannot create Client A evidence after reparent to Client B", async () => {
  const scenario = await createScenario();
  const staleLease = await acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
  });
  assert.equal(String(staleLease.report.client_id), String(scenario.source._id));
  await Report.updateOne(
    { _id: scenario.report._id },
    { $set: { "execution_lock.expires_at": new Date(Date.now() - 1) } }
  );

  const moved = await reparent(scenario);
  assert.equal(moved.statusCode, 200);
  assert.equal(String(moved.payload.report.client_id), String(scenario.destination._id));
  assert.equal(
    await renewReportExecutionLease({
      reportId: scenario.report._id,
      agencyId: scenario.agencyId,
      token: staleLease.token,
    }),
    false
  );
  await assert.rejects(
    findOrCreateReportRun({
      report: staleLease.report,
      leaseToken: staleLease.token,
      executionKey: `manual:${scenario.report._id}:stale-holder`,
      source: "manual",
      period: {},
      userId: scenario.userId,
    }),
    (error) => error.code === "REPORT_CLIENT_LINEAGE_CHANGED"
  );

  const current = await Report.findById(scenario.report._id);
  assert.equal(String(current.client_id), String(scenario.destination._id));
  assert.equal(await ReportRun.countDocuments({ report_id: scenario.report._id }), 0);
  assert.equal(
    await ReportRun.countDocuments({
      report_id: scenario.report._id,
      client_id: scenario.source._id,
    }),
    0
  );
});

test("read-only lineage audit detects mixed and current-client mismatches", async () => {
  const scenario = await createScenario();
  const secondReport = await createReport({
    agencyId: scenario.agencyId,
    clientId: scenario.destination._id,
    userId: scenario.userId,
    name: "Run mismatch",
  });
  const thirdReport = await createReport({
    agencyId: scenario.agencyId,
    clientId: scenario.source._id,
    userId: scenario.userId,
    name: "Mixed signals",
  });
  const fourthReport = await createReport({
    agencyId: scenario.agencyId,
    clientId: scenario.destination._id,
    userId: scenario.userId,
    name: "Signal mismatch",
  });

  await ReportRun.create([
    {
      agency_id: scenario.agencyId,
      client_id: scenario.source._id,
      report_id: scenario.report._id,
    },
    {
      agency_id: scenario.agencyId,
      client_id: scenario.destination._id,
      report_id: scenario.report._id,
    },
    {
      agency_id: scenario.agencyId,
      client_id: scenario.source._id,
      report_id: secondReport._id,
    },
  ]);
  await Signal.create([
    {
      agency_id: scenario.agencyId,
      client_id: scenario.source._id,
      report_id: thirdReport._id,
      type: "metric_anomaly",
      title: "Source signal",
    },
    {
      agency_id: scenario.agencyId,
      client_id: scenario.destination._id,
      report_id: thirdReport._id,
      type: "metric_anomaly",
      title: "Destination signal",
    },
    {
      agency_id: scenario.agencyId,
      client_id: scenario.source._id,
      report_id: fourthReport._id,
      type: "metric_anomaly",
      title: "Historical signal",
    },
  ]);

  assert.deepEqual(await auditReportClientLineage(), {
    reports_scanned: 4,
    reports_with_report_run_history: 2,
    reports_with_signal_history: 2,
    mixed_report_run_client_lineage: 1,
    mixed_signal_client_lineage: 1,
    current_report_client_differs_from_run_history: 1,
    current_report_client_differs_from_signal_history: 1,
  });
});
