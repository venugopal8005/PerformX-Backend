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
  createReport,
  startReport,
  updateReport,
} from "../src/controllers/reports.controller.js";
import {
  assignMetaAdAccount,
  refreshMetaAdAccountCampaigns,
  removeMetaAdAccount,
  removeMetaConnection,
  syncAdAccountsForConnection,
} from "../src/controllers/settings.controller.js";
import { archiveClientLifecycle } from "../src/services/archiveLifecycle.service.js";
import { markExecutionIntegrityReady } from "../src/services/executionIntegrityIndexes.service.js";
import {
  acquireReportExecutionLease,
  findOrCreateReportRun,
  persistGeneratedReportEvidenceWithMetaBindingFence,
  releaseReportExecutionLease,
} from "../src/services/reportExecution.service.js";
import { runReport } from "../src/services/reportRunner.service.js";
import { buildReportRunQuickLook } from "../src/services/reportQuickLook.service.js";
import { auditCurrentReportMetaBindings } from "../src/services/reportMetaBindingAudit.service.js";
import {
  resolveMetaContextForAccount,
  resolveValidatedMetaContextForReport,
} from "../src/services/metaContext.service.js";
import {
  fenceMetaAccountBindingInTransaction,
  readPersistedMetaBindingRevision,
} from "../src/services/metaAccountBinding.service.js";

let replicaSet;
const id = () => new mongoose.Types.ObjectId();

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

const createScenario = async ({ suffix = "one" } = {}) => {
  const agency = await Agency.create({ name: `Agency ${suffix}`, slug: `agency-${suffix}` });
  const user = await User.create({
    agency_id: agency._id,
    full_name: "Owner",
    email: `owner-${suffix}@example.com`,
    role: "owner",
  });
  const clientA = await Client.create({
    agency_id: agency._id,
    name: `Client A ${suffix}`,
    status: "stable",
  });
  const clientB = await Client.create({
    agency_id: agency._id,
    name: `Client B ${suffix}`,
    status: "stable",
  });
  const connection = await MetaConnection.create({
    agency_id: agency._id,
    connection_scope: "workspace",
    client_id: null,
    access_token: "test-token",
    status: "active",
    is_active: true,
  });
  const account = await MetaAdAccount.create({
    agency_id: agency._id,
    meta_connection_id: connection._id,
    client_id: clientA._id,
    assignment_scope: "v1",
    ad_account_id: `act_${suffix}`,
    name: `Account ${suffix}`,
    is_active: true,
    is_accessible: true,
  });
  const report = await Report.create({
    agency_id: agency._id,
    client_id: clientA._id,
    meta_ad_account_id: account._id,
    meta_account_external_id_snapshot: account.ad_account_id,
    meta_account_name_snapshot: account.name,
    created_by: user._id,
    name: `Monitor ${suffix}`,
    type: "daily",
    status: "active",
    severity: "low",
    internal_recipients: [],
    client_recipients: [],
    generate_internal_report: false,
    generate_client_report: false,
    monitored_campaigns: [
      { campaign_id: `campaign-${suffix}`, campaign_name: "Campaign" },
    ],
    schedule: { timezone: "UTC", time_of_day: "09:00" },
  });
  return { agency, user, clientA, clientB, connection, account, report };
};

const assign = async ({ scenario, clientId, confirmReassignment = true }) => {
  const res = response();
  await assignMetaAdAccount(
    {
      user: { id: scenario.user._id, agencyId: scenario.agency._id },
      params: { adAccountId: scenario.account._id },
      body: { clientId, confirmReassignment },
    },
    res
  );
  return res;
};

const acquireInitialRun = async (scenario, executionKey) => {
  const lease = await acquireReportExecutionLease({
    reportId: scenario.report._id,
    source: "manual",
  });
  assert.equal(lease.acquired, true);
  const resolution = await findOrCreateReportRun({
    report: lease.report,
    leaseToken: lease.token,
    contextSnapshot: undefined,
    executionKey,
    source: "manual",
    period: {},
    userId: scenario.user._id,
  });
  return { lease, ...resolution };
};

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replicaSet.getUri(), {
    dbName: `narrative_phase1d_${Date.now()}`,
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

test("initial ReportRun transaction snapshots a valid Meta binding revision", async () => {
  const scenario = await createScenario({ suffix: "initial" });
  const { lease, reportRun } = await acquireInitialRun(
    scenario,
    `manual:${scenario.report._id}:initial`
  );

  assert.equal(reportRun.client_id.toString(), scenario.clientA._id.toString());
  assert.equal(reportRun.meta_ad_account_id.toString(), scenario.account._id.toString());
  assert.equal(reportRun.meta_binding_revision_snapshot, 0);
  const account = await MetaAdAccount.findById(scenario.account._id).select(
    "+binding_fence_counter"
  );
  assert.equal(account.binding_fence_counter, 1);
  await releaseReportExecutionLease({
    reportId: scenario.report._id,
    token: lease.token,
  });
});

test("legacy missing revision is logical zero while malformed revision fails closed", async () => {
  const legacy = await createScenario({ suffix: "legacy-revision" });
  await MetaAdAccount.collection.updateOne(
    { _id: legacy.account._id },
    { $unset: { binding_revision: "" } }
  );
  const legacyRun = await acquireInitialRun(
    legacy,
    `manual:${legacy.report._id}:legacy-revision`
  );
  assert.equal(legacyRun.reportRun.meta_binding_revision_snapshot, 0);
  await releaseReportExecutionLease({
    reportId: legacy.report._id,
    token: legacyRun.lease.token,
  });

  const malformed = await createScenario({ suffix: "malformed-revision" });
  await MetaAdAccount.collection.updateOne(
    { _id: malformed.account._id },
    { $set: { binding_revision: null } }
  );
  const lease = await acquireReportExecutionLease({
    reportId: malformed.report._id,
    source: "manual",
  });
  await assert.rejects(
    findOrCreateReportRun({
      report: lease.report,
      leaseToken: lease.token,
      executionKey: `manual:${malformed.report._id}:malformed-revision`,
      source: "manual",
      period: {},
    }),
    (error) => error.code === "META_BINDING_REVISION_INVALID"
  );
  assert.equal(await ReportRun.countDocuments({ report_id: malformed.report._id }), 0);
  await releaseReportExecutionLease({
    reportId: malformed.report._id,
    token: lease.token,
  });
});

test("invalid account ownership and availability fail before initial ReportRun creation", async () => {
  for (const mode of [
    "reassigned",
    "unassigned",
    "inactive",
    "inaccessible",
    "missing",
    "other-agency",
  ]) {
    const scenario = await createScenario({ suffix: mode });
    if (["reassigned", "unassigned"].includes(mode)) {
      const assignment = await assign({
        scenario,
        clientId: mode === "reassigned" ? scenario.clientB._id : null,
      });
      assert.equal(assignment.statusCode, 200);
    } else if (mode === "inactive") {
      await MetaAdAccount.updateOne(
        { _id: scenario.account._id },
        { $set: { is_active: false }, $inc: { binding_revision: 1 } }
      );
    } else if (mode === "inaccessible") {
      await MetaAdAccount.updateOne(
        { _id: scenario.account._id },
        { $set: { is_accessible: false }, $inc: { binding_revision: 1 } }
      );
    } else if (mode === "missing") {
      await MetaAdAccount.deleteOne({ _id: scenario.account._id });
    } else {
      await MetaAdAccount.updateOne(
        { _id: scenario.account._id },
        { $set: { agency_id: id() }, $inc: { binding_revision: 1 } }
      );
    }
    const lease = await acquireReportExecutionLease({
      reportId: scenario.report._id,
      source: "manual",
    });
    await assert.rejects(
      findOrCreateReportRun({
        report: lease.report,
        leaseToken: lease.token,
        executionKey: `manual:${scenario.report._id}:${mode}`,
        source: "manual",
        period: {},
      }),
      (error) =>
        [
          "META_REPORT_BINDING_INVALID",
          "META_ACCOUNT_INACCESSIBLE",
          "META_REPORT_ACCOUNT_UNRESOLVED",
        ].includes(error.code)
    );
    assert.equal(await ReportRun.countDocuments({ report_id: scenario.report._id }), 0);
    await releaseReportExecutionLease({
      reportId: scenario.report._id,
      token: lease.token,
    });
  }
});

test("binding mutation paths advance revision atomically", async () => {
  const scenario = await createScenario({ suffix: "revision" });
  assert.equal(scenario.account.binding_revision, 0);

  let result = await assign({ scenario, clientId: scenario.clientB._id });
  assert.equal(result.statusCode, 200);
  let account = await MetaAdAccount.findById(scenario.account._id);
  assert.equal(account.binding_revision, 1);
  assert.equal(account.client_id.toString(), scenario.clientB._id.toString());

  result = await assign({ scenario, clientId: null });
  assert.equal(result.statusCode, 200);
  account = await MetaAdAccount.findById(scenario.account._id);
  assert.equal(account.binding_revision, 2);
  assert.equal(account.client_id, null);

  const originalFetch = globalThis.fetch;
  let syncedRows = [
    {
      id: scenario.account.ad_account_id,
      name: "Synced Account",
      currency: "INR",
      timezone_name: "Asia/Kolkata",
      account_status: 1,
    },
  ];
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: syncedRows }),
  });
  try {
    await syncAdAccountsForConnection({
      agencyId: scenario.agency._id,
      connectionId: scenario.connection._id,
    });
    syncedRows = [];
    await syncAdAccountsForConnection({
      agencyId: scenario.agency._id,
      connectionId: scenario.connection._id,
    });
    syncedRows = [
      {
        id: scenario.account.ad_account_id,
        name: "Restored Account",
        currency: "INR",
        timezone_name: "Asia/Kolkata",
        account_status: 1,
      },
    ];
    await syncAdAccountsForConnection({
      agencyId: scenario.agency._id,
      connectionId: scenario.connection._id,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  account = await MetaAdAccount.findById(scenario.account._id);
  assert.equal(account.binding_revision, 5);
  assert.equal(account.is_accessible, true);
});

test("cleanup, removal, disconnect, and Client archive each advance affected revisions", async () => {
  const cleanup = await createScenario({ suffix: "cleanup" });
  const incumbent = await MetaAdAccount.create({
    agency_id: cleanup.agency._id,
    meta_connection_id: cleanup.connection._id,
    client_id: cleanup.clientB._id,
    assignment_scope: "v1",
    ad_account_id: "act_cleanup_incumbent",
    name: "Incumbent",
    is_active: true,
    is_accessible: true,
  });
  const reassigned = await assign({ cleanup, scenario: cleanup, clientId: cleanup.clientB._id });
  assert.equal(reassigned.statusCode, 200);
  const cleanedIncumbent = await MetaAdAccount.findById(incumbent._id);
  assert.equal(cleanedIncumbent.client_id, null);
  assert.equal(cleanedIncumbent.binding_revision, 1);

  const removeResponse = response();
  await removeMetaAdAccount(
    {
      user: { id: cleanup.user._id, agencyId: cleanup.agency._id },
      params: { adAccountId: cleanup.account._id },
    },
    removeResponse
  );
  assert.equal(removeResponse.statusCode, 200);
  const removed = await MetaAdAccount.findById(cleanup.account._id);
  assert.equal(removed.binding_revision, 2);
  assert.equal(removed.is_active, false);

  const disconnectedScenario = await createScenario({ suffix: "disconnect" });
  const disconnectResponse = response();
  await removeMetaConnection(
    {
      user: {
        id: disconnectedScenario.user._id,
        agencyId: disconnectedScenario.agency._id,
      },
      params: { connectionId: disconnectedScenario.connection._id },
    },
    disconnectResponse
  );
  assert.equal(disconnectResponse.statusCode, 200);
  const disconnected = await MetaAdAccount.findById(disconnectedScenario.account._id);
  assert.equal(disconnected.binding_revision, 1);
  assert.equal(disconnected.is_accessible, false);

  const archivedScenario = await createScenario({ suffix: "archive" });
  const archived = await archiveClientLifecycle({
    agencyId: archivedScenario.agency._id,
    clientId: archivedScenario.clientA._id,
    userId: archivedScenario.user._id,
  });
  assert.equal(archived.outcome, "archived");
  const archivedAccount = await MetaAdAccount.findById(archivedScenario.account._id);
  assert.equal(archivedAccount.binding_revision, 1);
  assert.equal(archivedAccount.client_id, null);
});

test("report creation final transaction rejects reassignment during campaign validation", async () => {
  const scenario = await createScenario({ suffix: "create-race" });
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const waitForRelease = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  globalThis.fetch = async () => {
    markStarted();
    await waitForRelease;
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            id: "campaign-create-race",
            name: "Campaign",
            status: "ACTIVE",
          },
        ],
      }),
    };
  };
  const res = response();
  const creating = createReport(
    {
      user: { id: scenario.user._id, agencyId: scenario.agency._id },
      body: {
        client_id: scenario.clientA._id,
        meta_ad_account_id: scenario.account._id,
        name: "Racing create",
        internal_recipients: ["team@example.com"],
        monitored_campaigns: [
          { campaign_id: "campaign-create-race", campaign_name: "Campaign" },
        ],
        type: "daily",
        schedule: { time_of_day: "09:00", timezone: "UTC" },
      },
    },
    res
  );
  try {
    await started;
    const assignment = await assign({ scenario, clientId: scenario.clientB._id });
    assert.equal(assignment.statusCode, 200);
    releaseFetch();
    await creating;
  } finally {
    releaseFetch?.();
    globalThis.fetch = originalFetch;
  }
  assert.equal(res.statusCode, 409);
  assert.ok(
    ["META_REPORT_BINDING_INVALID", "META_ACCOUNT_ASSIGNMENT_CHANGED"].includes(
      res.payload.code
    )
  );
  assert.equal(await Report.countDocuments({ name: "Racing create" }), 0);
});

test("post-fetch reassignment rejects generated evidence, Signals, and artifacts", async () => {
  const scenario = await createScenario({ suffix: "fetch-race" });
  const originalFetch = globalThis.fetch;
  let releaseFetch;
  let startedFetch;
  const started = new Promise((resolve) => {
    startedFetch = resolve;
  });
  const release = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) startedFetch();
    await release;
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            date_start: "2026-07-14",
            impressions: "1000",
            clicks: "25",
            spend: "100",
            reach: "900",
            actions: [{ action_type: "purchase", value: "2" }],
          },
        ],
      }),
    };
  };

  const running = runReport(scenario.report._id, {
    force: true,
    triggerType: "manual",
    agencyId: scenario.agency._id,
    userId: scenario.user._id,
    now: new Date("2026-07-15T12:00:00.000Z"),
  });
  try {
    await started;
    const assignment = await assign({ scenario, clientId: scenario.clientB._id });
    assert.equal(assignment.statusCode, 200);
    releaseFetch();
    await assert.rejects(
      running,
      (error) =>
        error.code === "META_ACCOUNT_ASSIGNMENT_CHANGED" ||
        error.code === "META_REPORT_BINDING_INVALID"
    );
  } finally {
    releaseFetch?.();
    globalThis.fetch = originalFetch;
  }

  const reportRun = await ReportRun.findOne({ report_id: scenario.report._id });
  assert.ok(reportRun);
  assert.equal(reportRun.client_id.toString(), scenario.clientA._id.toString());
  assert.equal(reportRun.meta_binding_revision_snapshot, 0);
  assert.equal(reportRun.meta_binding_performance_validated_at, null);
  assert.deepEqual(reportRun.comparison, {});
  assert.equal(reportRun.internal_report, null);
  assert.equal(reportRun.client_report, null);
  assert.equal(reportRun.execution_stage, "failed");
  assert.equal(await Signal.countDocuments({ report_run_id: reportRun._id }), 0);
});

test("performance evidence transaction rolls back account fence and generated fields", async () => {
  const scenario = await createScenario({ suffix: "rollback" });
  const { lease, reportRun } = await acquireInitialRun(
    scenario,
    `manual:${scenario.report._id}:rollback`
  );
  const before = await MetaAdAccount.findById(scenario.account._id).select(
    "+binding_fence_counter"
  );

  await assert.rejects(
    persistGeneratedReportEvidenceWithMetaBindingFence({
      reportRun,
      leaseToken: lease.token,
      generatedFields: {
        comparison: { currentPeriodMetrics: { spend: 100 } },
        narrative: { status: "ok" },
        engine_output: { status: "ok" },
        execution_stage: "artifacts_ready",
      },
      afterEvidenceWrite: async () => {
        throw new Error("forced evidence rollback");
      },
    }),
    /forced evidence rollback/
  );

  const afterAccount = await MetaAdAccount.findById(scenario.account._id).select(
    "+binding_fence_counter"
  );
  const afterRun = await ReportRun.findById(reportRun._id);
  assert.equal(afterAccount.binding_fence_counter, before.binding_fence_counter);
  assert.deepEqual(afterRun.comparison, {});
  assert.equal(afterRun.narrative, null);
  assert.equal(afterRun.meta_binding_performance_validated_at, null);
  await releaseReportExecutionLease({
    reportId: scenario.report._id,
    token: lease.token,
  });
});

test("Quick Look keeps persisted history but rejects stale live ownership before Meta HTTP", async () => {
  const scenario = await createScenario({ suffix: "quick-look" });
  const reportRun = await ReportRun.create({
    agency_id: scenario.agency._id,
    client_id: scenario.clientA._id,
    report_id: scenario.report._id,
    meta_ad_account_id: scenario.account._id,
    status: "ok",
    severity: "low",
    comparison: {
      period: {
        current: { start: "2026-07-14", end: "2026-07-14" },
        previous: { start: "2026-07-13", end: "2026-07-13" },
      },
      currentPeriodMetrics: { impressions: 100, clicks: 10, spend: 20 },
      previousPeriodMetrics: { impressions: 100, clicks: 5, spend: 15 },
    },
  });
  await assign({ scenario, clientId: scenario.clientB._id });

  const snapshot = await buildReportRunQuickLook({
    reportRun,
    report: scenario.report,
    query: { range: "last_available" },
  });
  assert.equal(snapshot.metrics.clicks.value, 10);

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Meta should not be called for stale ownership");
  };
  try {
    await assert.rejects(
      buildReportRunQuickLook({
        reportRun,
        report: scenario.report,
        query: { range: "last_7_days" },
      }),
      (error) => error.code === "META_REPORT_BINDING_INVALID"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("startReport rejects a stale binding and the read-only audit counts it", async () => {
  const scenario = await createScenario({ suffix: "start" });
  await assign({ scenario, clientId: null });
  await Report.updateOne({ _id: scenario.report._id }, { $set: { status: "paused" } });
  const res = response();
  await startReport(
    {
      user: { id: scenario.user._id, agencyId: scenario.agency._id },
      body: { reportId: scenario.report._id },
    },
    res
  );
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, "META_REPORT_BINDING_INVALID");
  assert.equal(await ReportRun.countDocuments({ report_id: scenario.report._id }), 0);

  const updateResponse = response();
  await updateReport(
    {
      user: { id: scenario.user._id, agencyId: scenario.agency._id },
      body: {
        reportId: scenario.report._id,
        updates: { status: "active" },
      },
    },
    updateResponse
  );
  assert.equal(updateResponse.statusCode, 409);
  assert.equal(updateResponse.payload.code, "META_REPORT_BINDING_INVALID");

  const audit = await auditCurrentReportMetaBindings();
  assert.equal(audit.reports_scanned, 1);
  assert.equal(audit.meta_account_unassigned, 1);
  assert.equal(audit.valid_current_bindings, 0);
});

const signalNarrative = () => ({
  status: "ok",
  executiveSummary: "Creative performance needs attention.",
  likelyCause: { id: "creative_fatigue", archetype: "Creative fatigue" },
  userInsight: {
    headline: "Refresh the creative",
    decisionBrief: { primaryAction: "Test a new creative angle." },
  },
});

const persistedArtifacts = ({ recipient = null } = {}) => ({
  internal_report: {
    status: recipient ? "generated" : "sent",
    subject: "Existing report",
    html: "<p>Existing immutable report</p>",
    recipients: recipient ? [{ email: recipient, status: "pending" }] : [],
    dispatch: {
      idempotency_key: `legacy-artifact-${new mongoose.Types.ObjectId()}`,
      status: recipient ? "pending" : "sent",
      attempt_count: recipient ? 0 : 1,
    },
  },
  client_report: {
    status: "cancelled",
    delivery_mode: "generate_only",
    subject: "Existing client report",
    html: "<p>Existing immutable client report</p>",
    recipients: [],
    dispatch: {
      idempotency_key: `legacy-client-artifact-${new mongoose.Types.ObjectId()}`,
      status: "not_required",
      attempt_count: 0,
    },
  },
});

test("legacy revisionless artifacts skip new events and still reach persisted delivery", async () => {
  const scenario = await createScenario({ suffix: "legacy-artifact-signal" });
  const executionKey = `manual:${scenario.report._id}:legacy-artifact`;
  const now = new Date("2026-07-15T12:00:00.000Z");
  const inserted = await ReportRun.collection.insertOne({
    agency_id: scenario.agency._id,
    client_id: scenario.clientA._id,
    report_id: scenario.report._id,
    meta_ad_account_id: scenario.account._id,
    triggered_by: scenario.user._id,
    trigger_type: "manual",
    execution_key: executionKey,
    execution_stage: "artifacts_ready",
    status: "ok",
    severity: "high",
    comparison: { period: {}, currentPeriodMetrics: { clicks: 5 } },
    narrative: signalNarrative(),
    engine_output: signalNarrative(),
    ...persistedArtifacts({ recipient: "team@example.com" }),
    artifacts_ready_at: now,
    ran_at: now,
    started_at: now,
  });

  const originalFetch = globalThis.fetch;
  const originalWebhook = process.env.REPORT_EMAIL_WEBHOOK_URL;
  let deliveryCalls = 0;
  process.env.REPORT_EMAIL_WEBHOOK_URL = "https://n8n.example.com/webhook/report";
  globalThis.fetch = async () => {
    deliveryCalls += 1;
    return { ok: true, status: 200, text: async () => "ok" };
  };
  try {
    await runReport(scenario.report._id, {
      force: true,
      triggerType: "manual",
      executionKey,
      agencyId: scenario.agency._id,
      userId: scenario.user._id,
      now,
    });
    await runReport(scenario.report._id, {
      force: true,
      triggerType: "manual",
      executionKey,
      agencyId: scenario.agency._id,
      userId: scenario.user._id,
      now,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.REPORT_EMAIL_WEBHOOK_URL;
    else process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhook;
  }

  const reportRun = await ReportRun.findById(inserted.insertedId);
  assert.equal(deliveryCalls, 1);
  assert.equal(await Signal.countDocuments({ report_run_id: reportRun._id }), 0);
  assert.deepEqual(reportRun.signal_ids, []);
  assert.equal(reportRun.events_persisted_at, null);
  assert.equal(
    reportRun.events_persistence_status,
    "skipped_unvalidated_legacy_evidence"
  );
  assert.equal(
    reportRun.events_persistence_reason,
    "meta_performance_evidence_not_validated"
  );
});

test("modern validated performance evidence still creates one idempotent Signal", async () => {
  const scenario = await createScenario({ suffix: "modern-signal" });
  const executionKey = `manual:${scenario.report._id}:modern-signal`;
  const { lease, reportRun } = await acquireInitialRun(scenario, executionKey);
  const now = new Date("2026-07-15T12:00:00.000Z");
  await persistGeneratedReportEvidenceWithMetaBindingFence({
    reportRun,
    leaseToken: lease.token,
    now,
    generatedFields: {
      comparison: { period: {}, currentPeriodMetrics: { clicks: 5 } },
      narrative: signalNarrative(),
      engine_output: signalNarrative(),
      ...persistedArtifacts(),
      execution_stage: "artifacts_ready",
      artifacts_ready_at: now,
    },
  });
  await releaseReportExecutionLease({
    reportId: scenario.report._id,
    token: lease.token,
  });

  await runReport(scenario.report._id, {
    force: true,
    triggerType: "manual",
    executionKey,
    agencyId: scenario.agency._id,
    userId: scenario.user._id,
    now,
  });
  const updated = await ReportRun.findById(reportRun._id);
  assert.equal(await Signal.countDocuments({ report_run_id: reportRun._id }), 1);
  assert.equal(updated.signal_ids.length, 1);
  assert.ok(updated.events_persisted_at);
  assert.equal(updated.events_persistence_status, "persisted");
  assert.equal(updated.events_persistence_reason, null);
});

test("workspace execution connection scope accepts only workspace or null legacy compatibility", async () => {
  const scenario = await createScenario({ suffix: "connection-scope" });
  const resolve = () =>
    resolveValidatedMetaContextForReport({
      agency_id: scenario.agency._id,
      client_id: scenario.clientA._id,
      meta_ad_account_id: scenario.account._id,
    });
  const resolveAccount = () =>
    resolveMetaContextForAccount({
      agencyId: scenario.agency._id,
      metaAdAccountId: scenario.account._id,
    });

  await resolve();
  await resolveAccount();
  await MetaConnection.collection.updateOne(
    { _id: scenario.connection._id },
    { $unset: { connection_scope: "" } }
  );
  await resolve();
  await resolveAccount();
  await MetaConnection.collection.updateOne(
    { _id: scenario.connection._id },
    { $set: { connection_scope: null } }
  );
  await resolve();
  await resolveAccount();

  const { lease, reportRun } = await acquireInitialRun(
    scenario,
    `manual:${scenario.report._id}:connection-scope`
  );
  await MetaConnection.collection.updateOne(
    { _id: scenario.connection._id },
    { $set: { connection_scope: "legacy_client", client_id: null } }
  );
  await assert.rejects(resolve(), (error) => error.code === "META_NOT_CONNECTED");
  await assert.rejects(resolveAccount(), (error) => error.code === "META_NOT_CONNECTED");
  await assert.rejects(
    persistGeneratedReportEvidenceWithMetaBindingFence({
      reportRun,
      leaseToken: lease.token,
      generatedFields: { comparison: { currentPeriodMetrics: { clicks: 1 } } },
    }),
    (error) => error.code === "META_NOT_CONNECTED"
  );
  const audit = await auditCurrentReportMetaBindings();
  assert.equal(audit.workspace_connection_invalid, 1);

  await MetaConnection.collection.updateOne(
    { _id: scenario.connection._id },
    { $set: { connection_scope: "legacy_client", client_id: scenario.clientA._id } }
  );
  await assert.rejects(resolve(), (error) => error.code === "META_NOT_CONNECTED");
  await assert.rejects(resolveAccount(), (error) => error.code === "META_NOT_CONNECTED");
  await MetaConnection.collection.updateOne(
    { _id: scenario.connection._id },
    { $set: { connection_scope: "workspace", client_id: scenario.clientA._id } }
  );
  await assert.rejects(resolve(), (error) => error.code === "META_NOT_CONNECTED");
  await assert.rejects(resolveAccount(), (error) => error.code === "META_NOT_CONNECTED");
  await releaseReportExecutionLease({
    reportId: scenario.report._id,
    token: lease.token,
  });
});

test("raw persisted binding revision accepts only absence or non-negative integers", async () => {
  const scenario = await createScenario({ suffix: "raw-revision" });
  const cases = [
    { label: "absent", update: { $unset: { binding_revision: "" } }, revision: 0 },
    { label: "zero", update: { $set: { binding_revision: 0 } }, revision: 0 },
    { label: "seven", update: { $set: { binding_revision: 7 } }, revision: 7 },
    { label: "null", update: { $set: { binding_revision: null } } },
    { label: "negative", update: { $set: { binding_revision: -1 } } },
    { label: "fractional", update: { $set: { binding_revision: 1.5 } } },
    { label: "numeric-string", update: { $set: { binding_revision: "0" } } },
    { label: "string", update: { $set: { binding_revision: "abc" } } },
    { label: "boolean", update: { $set: { binding_revision: true } } },
    { label: "object", update: { $set: { binding_revision: {} } } },
    { label: "array", update: { $set: { binding_revision: [] } } },
    { label: "nan", update: { $set: { binding_revision: Number.NaN } } },
    { label: "infinity", update: { $set: { binding_revision: Number.POSITIVE_INFINITY } } },
  ];

  for (const item of cases) {
    await MetaAdAccount.collection.updateOne({ _id: scenario.account._id }, item.update);
    if (item.revision !== undefined) {
      const result = await readPersistedMetaBindingRevision({
        accountId: scenario.account._id,
        agencyId: scenario.agency._id,
      });
      assert.equal(result.revision, item.revision, item.label);
    } else {
      await assert.rejects(
        readPersistedMetaBindingRevision({
          accountId: scenario.account._id,
          agencyId: scenario.agency._id,
        }),
        (error) => error.code === "META_BINDING_REVISION_INVALID",
        item.label
      );
    }
  }
});

test("expected revision zero fence matches only absent or numeric zero", async () => {
  for (const item of [
    { label: "absent", update: { $unset: { binding_revision: "" } }, allowed: true },
    { label: "zero", update: { $set: { binding_revision: 0 } }, allowed: true },
    { label: "null", update: { $set: { binding_revision: null } }, allowed: false },
    { label: "numeric-string", update: { $set: { binding_revision: "0" } }, allowed: false },
    { label: "string", update: { $set: { binding_revision: "abc" } }, allowed: false },
    { label: "fractional", update: { $set: { binding_revision: 1.5 } }, allowed: false },
    { label: "negative", update: { $set: { binding_revision: -1 } }, allowed: false },
  ]) {
    const scenario = await createScenario({ suffix: `zero-fence-${item.label}` });
    await MetaAdAccount.collection.updateOne({ _id: scenario.account._id }, item.update);
    const attempt = mongoose.connection.transaction((session) =>
      fenceMetaAccountBindingInTransaction({
        accountId: scenario.account._id,
        agencyId: scenario.agency._id,
        clientId: scenario.clientA._id,
        expectedBindingRevision: 0,
        session,
      })
    );
    if (item.allowed) {
      const result = await attempt;
      assert.equal(result.bindingRevision, 0, item.label);
    } else {
      await assert.rejects(attempt, undefined, item.label);
    }
  }
});

test("malformed raw revision blocks initial history, Quick Look, creation, and activation before Meta HTTP", async () => {
  const scenario = await createScenario({ suffix: "malformed-boundaries" });
  await MetaAdAccount.collection.updateOne(
    { _id: scenario.account._id },
    { $set: { binding_revision: "abc" } }
  );
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Meta HTTP must not run through malformed binding state");
  };
  try {
    const lease = await acquireReportExecutionLease({
      reportId: scenario.report._id,
      source: "manual",
    });
    await assert.rejects(
      findOrCreateReportRun({
        report: lease.report,
        leaseToken: lease.token,
        executionKey: `manual:${scenario.report._id}:malformed-boundaries`,
        source: "manual",
        period: {},
      }),
      (error) => error.code === "META_BINDING_REVISION_INVALID"
    );
    assert.equal(await ReportRun.countDocuments({ report_id: scenario.report._id }), 0);
    await releaseReportExecutionLease({
      reportId: scenario.report._id,
      token: lease.token,
    });

    const historicalRun = await ReportRun.create({
      agency_id: scenario.agency._id,
      client_id: scenario.clientA._id,
      report_id: scenario.report._id,
      meta_ad_account_id: scenario.account._id,
      status: "ok",
      severity: "low",
      comparison: {},
    });
    await assert.rejects(
      buildReportRunQuickLook({
        reportRun: historicalRun,
        report: scenario.report,
        query: { range: "last_7_days" },
      }),
      (error) => error.code === "META_BINDING_REVISION_INVALID"
    );

    const createResponse = response();
    await createReport(
      {
        user: { id: scenario.user._id, agencyId: scenario.agency._id },
        body: {
          client_id: scenario.clientA._id,
          meta_ad_account_id: scenario.account._id,
          name: "Malformed binding report",
          internal_recipients: ["team@example.com"],
          monitored_campaigns: [
            { campaign_id: "campaign-malformed", campaign_name: "Campaign" },
          ],
          type: "daily",
          schedule: { time_of_day: "09:00", timezone: "UTC" },
        },
      },
      createResponse
    );
    assert.equal(createResponse.statusCode, 409);
    assert.equal(createResponse.payload.code, "META_BINDING_REVISION_INVALID");
    assert.equal(await Report.countDocuments({ name: "Malformed binding report" }), 0);

    await Report.updateOne({ _id: scenario.report._id }, { $set: { status: "paused" } });
    const startResponse = response();
    await startReport(
      {
        user: { id: scenario.user._id, agencyId: scenario.agency._id },
        body: { reportId: scenario.report._id },
      },
      startResponse
    );
    assert.equal(startResponse.statusCode, 409);
    assert.equal(startResponse.payload.code, "META_BINDING_REVISION_INVALID");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("assigned-account campaign refresh rejects malformed raw revision before Meta HTTP", async () => {
  const scenario = await createScenario({ suffix: "refresh-malformed-revision" });
  await MetaAdAccount.collection.updateOne(
    { _id: scenario.account._id },
    { $set: { binding_revision: "abc" } }
  );

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Meta HTTP must not run through malformed binding state");
  };
  try {
    const res = response();
    await refreshMetaAdAccountCampaigns(
      {
        user: { agencyId: scenario.agency._id },
        params: { adAccountId: scenario.account._id },
      },
      res
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, "META_BINDING_REVISION_INVALID");
    assert.equal(res.payload.message, "The Meta ad account binding state is invalid.");
    assert.equal(fetchCalls, 0);

    const rawAccount = await MetaAdAccount.collection.findOne({
      _id: scenario.account._id,
    });
    assert.equal(rawAccount.binding_revision, "abc");
    assert.equal(rawAccount.campaigns_last_synced_at ?? null, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assigned-account campaign refresh accepts absent, zero, and positive revisions", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({
        data: [{ id: "campaign-control", name: "Control", status: "ACTIVE" }],
      }),
    };
  };
  try {
    for (const item of [
      { label: "absent", update: { $unset: { binding_revision: "" } } },
      { label: "zero", update: { $set: { binding_revision: 0 } } },
      { label: "positive", update: { $set: { binding_revision: 7 } } },
    ]) {
      const scenario = await createScenario({ suffix: `refresh-${item.label}` });
      await MetaAdAccount.collection.updateOne(
        { _id: scenario.account._id },
        item.update
      );
      const res = response();
      await refreshMetaAdAccountCampaigns(
        {
          user: { agencyId: scenario.agency._id },
          params: { adAccountId: scenario.account._id },
        },
        res
      );

      assert.equal(res.statusCode, 200, item.label);
      assert.equal(res.payload.success, true, item.label);
      assert.equal(res.payload.campaign_count, 1, item.label);
      assert.ok(
        (await MetaAdAccount.findById(scenario.account._id)).campaigns_last_synced_at,
        item.label
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 3);
});

test("assigned-account campaign refresh rejects explicit legacy client connection authority", async () => {
  const scenario = await createScenario({ suffix: "refresh-legacy-connection" });
  await MetaConnection.collection.updateOne(
    { _id: scenario.connection._id },
    { $set: { connection_scope: "legacy_client", client_id: null } }
  );

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Meta HTTP must not use explicit legacy client authority");
  };
  try {
    const res = response();
    await refreshMetaAdAccountCampaigns(
      {
        user: { agencyId: scenario.agency._id },
        params: { adAccountId: scenario.account._id },
      },
      res
    );

    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.code, "META_NOT_CONNECTED");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
