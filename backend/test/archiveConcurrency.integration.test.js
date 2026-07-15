import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Activity,
  Client,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
} from "../src/models/index.js";
import {
  archiveClientLifecycle,
  archiveReportLifecycle,
} from "../src/services/archiveLifecycle.service.js";
import {
  acquireRequiredClientLifecycleLease,
  fenceClientLifecycleLeaseInTransaction,
  releaseClientLifecycleLease,
} from "../src/services/clientLifecycle.service.js";
import { claimReportDelivery } from "../src/services/reportDelivery.service.js";
import { runRequiredTransaction } from "../src/services/requiredTransaction.service.js";
import { runArchiveTopologyVerificationCommand } from "../src/scripts/verifyArchiveTopology.js";
import { updateReport } from "../src/controllers/reports.controller.js";

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

const createClient = ({ agencyId, name = "Northstar" }) =>
  Client.create({ agency_id: agencyId, name, status: "stable" });

const createReport = ({
  agencyId,
  clientId,
  userId,
  name = "Daily Monitor",
  metaAdAccountId = null,
  session = null,
}) =>
  Report.create([{
    agency_id: agencyId,
    client_id: clientId,
    meta_ad_account_id: metaAdAccountId,
    created_by: userId,
    name,
    type: "daily",
    status: "paused",
    severity: "low",
    internal_recipients: ["team@example.com"],
    client_recipients: ["client@example.com"],
    monitored_campaigns: [
      { campaign_id: "campaign-1", campaign_name: "Campaign One" },
    ],
    schedule: { timezone: "UTC", time_of_day: "09:00" },
  }], session ? { session } : undefined).then(([report]) => report);

const explicitClientArtifact = (status = "pending") => ({
  status: "awaiting_approval",
  delivery_mode: "approval_required",
  subject: "Performance update",
  html: "<p>Performance update</p>",
  text: "Performance update",
  recipients: [{ email: "client@example.com", status: "pending" }],
  dispatch: {
    idempotency_key: `dispatch-${objectId()}`,
    status,
    attempt_count: 0,
  },
});

const createDispatchScenario = async ({ legacy = false } = {}) => {
  const agencyId = objectId();
  const userId = objectId();
  const client = await createClient({ agencyId });
  const report = await createReport({ agencyId, clientId: client._id, userId });
  let reportRun;

  if (legacy) {
    const result = await ReportRun.collection.insertOne({
      agency_id: agencyId,
      client_id: client._id,
      report_id: report._id,
      status: "ok",
      severity: "low",
      execution_stage: "completed",
      trigger_type: "manual",
      client_report: {
        status: "awaiting_approval",
        delivery_mode: "approval_required",
        subject: "Historical performance update",
        html: "<p>Historical performance update</p>",
        text: "Historical performance update",
        recipients: [{ email: "client@example.com", status: "pending" }],
      },
      createdAt: new Date(),
      updatedAt: new Date(),
      ran_at: new Date(),
    });
    reportRun = await ReportRun.findById(result.insertedId);
  } else {
    reportRun = await ReportRun.create({
      agency_id: agencyId,
      client_id: client._id,
      report_id: report._id,
      status: "ok",
      severity: "low",
      execution_stage: "completed",
      client_report: explicitClientArtifact(),
    });
  }

  return { agencyId, userId, client, report, reportRun };
};

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replicaSet.getUri(), {
    dbName: `narrative_phase1a_${Date.now()}`,
  });
  await Promise.all([
    Activity.init(),
    Client.init(),
    MetaAdAccount.init(),
    MetaConnection.init(),
    Report.init(),
    ReportRun.init(),
  ]);
}, { timeout: 120_000 });

beforeEach(async () => {
  await Promise.all([
    Activity.deleteMany({}),
    Client.deleteMany({}),
    MetaAdAccount.deleteMany({}),
    MetaConnection.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
}, { timeout: 30_000 });

test("real replica-set rejects stale Client tokens for create, reparent, and Meta assignment", async () => {
  const agencyId = objectId();
  const userId = objectId();
  const source = await createClient({ agencyId, name: "Source" });
  const destination = await createClient({ agencyId, name: "Destination" });
  const base = new Date();
  const staleLease = await acquireRequiredClientLifecycleLease({
    agencyId,
    clientId: destination._id,
    operation: "report_create",
    now: base,
    leaseMs: 10,
  });
  const replacementLease = await acquireRequiredClientLifecycleLease({
    agencyId,
    clientId: destination._id,
    operation: "archive",
    now: new Date(base.getTime() + 11),
  });

  await assert.rejects(
    runRequiredTransaction({
      work: async (session) => {
        await fenceClientLifecycleLeaseInTransaction({
          agencyId,
          clientId: destination._id,
          token: staleLease.token,
          session,
          now: new Date(base.getTime() + 12),
        });
        await createReport({
          agencyId,
          clientId: destination._id,
          userId,
          name: "Must not commit",
          session,
        });
      },
    }),
    (error) => error.code === "client_lifecycle_lease_lost"
  );
  assert.equal(await Report.countDocuments({ name: "Must not commit" }), 0);

  const report = await createReport({
    agencyId,
    clientId: source._id,
    userId,
    name: "Reparent target",
  });
  await assert.rejects(
    runRequiredTransaction({
      work: async (session) => {
        await fenceClientLifecycleLeaseInTransaction({
          agencyId,
          clientId: destination._id,
          token: staleLease.token,
          session,
        });
        await Report.updateOne(
          { _id: report._id },
          { $set: { client_id: destination._id } },
          { session }
        );
      },
    }),
    (error) => error.code === "client_lifecycle_lease_lost"
  );
  assert.equal(String((await Report.findById(report._id)).client_id), String(source._id));

  const connection = await MetaConnection.create({
    agency_id: agencyId,
    connection_scope: "workspace",
    status: "active",
    is_active: true,
  });
  const account = await MetaAdAccount.create({
    agency_id: agencyId,
    meta_connection_id: connection._id,
    ad_account_id: "act_lease_fence",
    is_active: true,
    is_accessible: true,
  });
  await assert.rejects(
    runRequiredTransaction({
      work: async (session) => {
        await fenceClientLifecycleLeaseInTransaction({
          agencyId,
          clientId: destination._id,
          token: staleLease.token,
          session,
        });
        await MetaAdAccount.updateOne(
          { _id: account._id },
          { $set: { client_id: destination._id, assignment_scope: "v1" } },
          { session }
        );
      },
    }),
    (error) => error.code === "client_lifecycle_lease_lost"
  );
  assert.equal((await MetaAdAccount.findById(account._id)).client_id, null);

  await releaseClientLifecycleLease({
    agencyId,
    clientId: destination._id,
    token: replacementLease.token,
  });
  const archived = await archiveClientLifecycle({
    agencyId,
    clientId: destination._id,
    userId,
  });
  assert.equal(archived.outcome, "archived");
  assert.equal(await Report.countDocuments({ client_id: destination._id, is_archived: false }), 0);
});

test("updateReport successfully commits and returns a controller-level reparent", async () => {
  const agencyId = objectId();
  const userId = objectId();
  const source = await createClient({ agencyId, name: "Source" });
  const destination = await createClient({ agencyId, name: "Destination" });
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
    ad_account_id: "act_destination",
    name: "Destination Account",
    is_active: true,
    is_accessible: true,
  });
  const report = await createReport({
    agencyId,
    clientId: source._id,
    userId,
    name: "Controller reparent",
  });
  const res = response();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{ id: "campaign-1", name: "Campaign One" }],
    }),
  });

  try {
    await updateReport(
      {
        user: { id: userId, agencyId },
        body: {
          reportId: report._id,
          updates: {
            client_id: destination._id,
            meta_ad_account_id: destinationAccount._id,
            monitored_campaigns: [
              { campaign_id: "campaign-1", campaign_name: "Campaign One" },
            ],
          },
        },
      },
      res
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(String(res.payload.report.client_id), String(destination._id));
  assert.equal(
    String(res.payload.report.meta_ad_account_id),
    String(destinationAccount._id)
  );
  const persisted = await Report.findById(report._id);
  assert.equal(String(persisted.client_id), String(destination._id));
  assert.equal(String(persisted.meta_ad_account_id), String(destinationAccount._id));
  assert.equal(persisted.meta_account_external_id_snapshot, "act_destination");
});

test("real Client fence transaction and archive resolve to one committed order", async () => {
  const agencyId = objectId();
  const userId = objectId();
  const client = await createClient({ agencyId });
  const base = new Date();
  const lease = await acquireRequiredClientLifecycleLease({
    agencyId,
    clientId: client._id,
    operation: "report_create",
    now: base,
    leaseMs: 1_000,
  });
  let releaseFence;
  const fenceMayCommit = new Promise((resolve) => {
    releaseFence = resolve;
  });
  let fenceReached;
  const fenced = new Promise((resolve) => {
    fenceReached = resolve;
  });

  const protectedFlow = runRequiredTransaction({
    work: async (session) => {
      await fenceClientLifecycleLeaseInTransaction({
        agencyId,
        clientId: client._id,
        token: lease.token,
        session,
        now: new Date(base.getTime() + 1),
        leaseMs: 1_000,
      });
      await Report.create(
        [
          {
            agency_id: agencyId,
            client_id: client._id,
            created_by: userId,
            name: "Fenced report",
            type: "daily",
            status: "paused",
            severity: "low",
            internal_recipients: ["team@example.com"],
            schedule: { timezone: "UTC", time_of_day: "09:00" },
          },
        ],
        { session }
      );
      fenceReached();
      await fenceMayCommit;
    },
  });

  await fenced;
  const archiveFlow = archiveClientLifecycle({
    agencyId,
    clientId: client._id,
    userId,
    now: new Date(base.getTime() + 5_000),
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  releaseFence();
  const [protectedResult, archiveResult] = await Promise.allSettled([
    protectedFlow,
    archiveFlow,
  ]);

  assert.equal(protectedResult.status, "fulfilled");
  assert.equal(archiveResult.status, "fulfilled");
  assert.equal(archiveResult.value.outcome, "archived");
  const finalClient = await Client.findById(client._id);
  const finalReport = await Report.findOne({ name: "Fenced report" });
  assert.equal(finalClient.is_archived, true);
  assert.equal(finalReport.is_archived, true);
});

test("real explicit dispatch claim and report archive preserve both orderings", async () => {
  const approveFirst = await createDispatchScenario();
  const claim = await claimReportDelivery({
    reportRunId: approveFirst.reportRun._id,
    audience: "client",
  });
  assert.equal(claim.claimed, true);
  const blockedArchive = await archiveReportLifecycle({
    agencyId: approveFirst.agencyId,
    reportId: approveFirst.report._id,
    userId: approveFirst.userId,
  });
  assert.equal(blockedArchive.outcome, "dispatch_in_progress");

  await Promise.all([
    Activity.deleteMany({}),
    Client.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
  ]);
  const archiveFirst = await createDispatchScenario();
  const archived = await archiveReportLifecycle({
    agencyId: archiveFirst.agencyId,
    reportId: archiveFirst.report._id,
    userId: archiveFirst.userId,
  });
  assert.equal(archived.outcome, "archived");
  const blockedClaim = await claimReportDelivery({
    reportRunId: archiveFirst.reportRun._id,
    audience: "client",
  });
  assert.equal(blockedClaim.claimed, false);
  assert.equal(blockedClaim.outcome, "not_required");

  await Promise.all([
    Activity.deleteMany({}),
    Client.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
  ]);
  const concurrent = await createDispatchScenario();
  const [concurrentClaim, concurrentArchive] = await Promise.allSettled([
    claimReportDelivery({
      reportRunId: concurrent.reportRun._id,
      audience: "client",
    }),
    archiveReportLifecycle({
      agencyId: concurrent.agencyId,
      reportId: concurrent.report._id,
      userId: concurrent.userId,
    }),
  ]);
  assert.equal(concurrentClaim.status, "fulfilled");
  assert.equal(concurrentArchive.status, "fulfilled");
  const finalReport = await Report.findById(concurrent.report._id);
  const finalRun = await ReportRun.findById(concurrent.reportRun._id);
  assert.equal(
    finalReport.is_archived &&
      ["pending", "failed", "dispatching"].includes(
        finalRun.client_report.dispatch.status
      ),
    false
  );
});

test("real legacy missing dispatch claim and archive cannot cross", async () => {
  const approveFirst = await createDispatchScenario({ legacy: true });
  const claim = await claimReportDelivery({
    reportRunId: approveFirst.reportRun._id,
    audience: "client",
  });
  assert.equal(claim.claimed, true);
  const blockedArchive = await archiveReportLifecycle({
    agencyId: approveFirst.agencyId,
    reportId: approveFirst.report._id,
    userId: approveFirst.userId,
  });
  assert.equal(blockedArchive.outcome, "dispatch_in_progress");

  await Promise.all([
    Activity.deleteMany({}),
    Client.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
  ]);
  const archiveFirst = await createDispatchScenario({ legacy: true });
  const archived = await archiveReportLifecycle({
    agencyId: archiveFirst.agencyId,
    reportId: archiveFirst.report._id,
    userId: archiveFirst.userId,
  });
  assert.equal(archived.outcome, "archived");
  const blockedClaim = await claimReportDelivery({
    reportRunId: archiveFirst.reportRun._id,
    audience: "client",
  });
  assert.equal(blockedClaim.claimed, false);
  assert.equal(blockedClaim.outcome, "not_required");

  await Promise.all([
    Activity.deleteMany({}),
    Client.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
  ]);
  const concurrent = await createDispatchScenario({ legacy: true });
  const [claimResult, archiveResult] = await Promise.allSettled([
    claimReportDelivery({
      reportRunId: concurrent.reportRun._id,
      audience: "client",
    }),
    archiveReportLifecycle({
      agencyId: concurrent.agencyId,
      reportId: concurrent.report._id,
      userId: concurrent.userId,
    }),
  ]);
  assert.equal(claimResult.status, "fulfilled");
  assert.equal(archiveResult.status, "fulfilled");
  const finalReport = await Report.findById(concurrent.report._id);
  const finalRun = await ReportRun.findById(concurrent.reportRun._id);
  assert.equal(
    finalReport.is_archived &&
      ["pending", "failed", "dispatching"].includes(
        finalRun.client_report.dispatch.status
      ),
    false
  );
});

test("archive topology verifier accepts the disposable replica set without exposing its URI", async () => {
  const isolatedMongoose = new mongoose.Mongoose();
  const output = [];
  const exitCode = await runArchiveTopologyVerificationCommand({
    mongooseInstance: isolatedMongoose,
    mongoUri: replicaSet.getUri(),
    logger: {
      log: (message) => output.push(message),
      error: (message) => output.push(message),
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(output.some((line) => line.includes("transaction-capable: yes")), true);
  assert.equal(output.some((line) => line.includes(replicaSet.getUri())), false);
});
