import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Agency,
  Activity,
  Client,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
} from "../src/models/index.js";
import {
  claimReportRunIssueProcessing,
  processReportRunIssues,
  runIssueMatchingTransaction,
} from "../src/services/issueMatching.service.js";
import {
  initializePhase2IssueIntegrity,
  resetPhase2IssueIntegrityReadiness,
} from "../src/services/phase2IssueIndexes.service.js";
import { runRequiredTransaction } from "../src/services/requiredTransaction.service.js";
import {
  processReportRunIssuesBeforeDelivery,
  runReport,
} from "../src/services/reportRunner.service.js";
import { markExecutionIntegrityReady } from "../src/services/executionIntegrityIndexes.service.js";
import { saveSignalsFromNarrative } from "../src/services/signalGenerator.service.js";
import {
  getIssue,
  getIssues,
  getIssueSignals,
} from "../src/controllers/issues.controller.js";
import {
  applyPhase2IssueMigration,
  inspectPhase2IssueMigration,
  verifyPhase2IssueMigrationApply,
} from "../src/services/phase2IssueMigration.service.js";

let replicaSet;
let sequence = 0;
const objectId = () => new mongoose.Types.ObjectId();

const createDomain = async () => {
  sequence += 1;
  const agency = await Agency.create({ name: `Phase Two ${sequence}`, slug: `phase-two-${sequence}` });
  const client = await Client.create({ agency_id: agency._id, name: "Acme", status: "stable" });
  const connection = await MetaConnection.create({
    agency_id: agency._id,
    connection_scope: "workspace",
    client_id: null,
    status: "active",
    is_active: true,
  });
  const account = await MetaAdAccount.create({
    agency_id: agency._id,
    meta_connection_id: connection._id,
    client_id: client._id,
    assignment_scope: "v1",
    ad_account_id: `act_${sequence}`,
    name: "Acme Ads",
    is_active: true,
    is_accessible: true,
  });
  const report = await Report.create({
    agency_id: agency._id,
    client_id: client._id,
    meta_ad_account_id: account._id,
    created_by: objectId(),
    name: "Daily Monitor",
    type: "daily",
    status: "active",
    severity: "low",
    monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Campaign One" }],
    schedule: { timezone: "Asia/Kolkata", time_of_day: "09:00" },
  });
  return { agency, client, connection, account, report };
};

const runContext = (domain) => ({
  version: 1,
  captured_at: new Date(),
  source: "execution",
  workspace: { name: domain.agency.name },
  client: { name: domain.client.name },
  report: {
    name: domain.report.name,
    configuration: {
      type: "daily",
      schedule: { timezone: "Asia/Kolkata", time_of_day: "09:00" },
      client_delivery_mode: "generate_only",
      generate_client_report: true,
      generate_internal_report: true,
    },
  },
  actor: { name: "Analyst" },
});

const createRun = async (
  domain,
  { start, end = start, signal = true, severity = "moderate", campaignId = "campaign-1", narrative = null, campaigns = null } = {}
) => {
  const reportRun = await ReportRun.create({
    agency_id: domain.agency._id,
    client_id: domain.client._id,
    report_id: domain.report._id,
    context_snapshot: runContext(domain),
    meta_ad_account_id: domain.account._id,
    meta_account_external_id_snapshot: domain.account.ad_account_id,
    meta_account_name_snapshot: domain.account.name,
    meta_binding_revision_snapshot: 0,
    meta_binding_performance_validated_at: new Date(),
    trigger_type: "manual",
    execution_key: `phase2:${domain.report._id}:${start}:${Math.random()}`,
    execution_stage: "artifacts_ready",
    status: "ok",
    severity: severity === "critical" ? "high" : "medium",
    comparison: {
      mode: "scheduled_window",
      period: { type: "daily", current: { start, end }, previous: { start, end } },
    },
    narrative: narrative || {
      status: "ok",
      likelyCause: { id: signal ? "creative_fatigue" : "stable_performance" },
      dataQuality: { level: "strong" },
      trustGate: { blocked: false },
    },
    monitored_campaigns: (campaigns || ["campaign-1"]).map((campaign_id) => ({ campaign_id, campaign_name: campaign_id })),
    ran_at: new Date(`${end}T12:00:00.000Z`),
  });
  if (signal) {
    await Signal.create({
      agency_id: domain.agency._id,
      client_id: domain.client._id,
      report_id: domain.report._id,
      report_run_id: reportRun._id,
      context_snapshot: {
        version: 1,
        captured_at: new Date(),
        source: "execution",
        workspace: { name: domain.agency.name },
        client: { name: domain.client.name },
        report: { name: domain.report.name },
        meta_account: { meta_ad_account_id: domain.account._id, external_account_id: domain.account.ad_account_id, name: domain.account.name },
        campaigns: campaignId
          ? [{ campaign_id: campaignId, campaign_name: campaignId }]
          : [],
      },
      campaign_id: campaignId,
      type: "creative_fatigue",
      severity,
      title: "Creative fatigue",
      description: "CTR declined.",
      metadata: { archetype_id: "creative_fatigue", primary_anomaly: { metric: "ctr", delta: -20 } },
      detected_at: new Date(`${end}T12:00:00.000Z`),
    });
  }
  return reportRun;
};

const process = (run) => processReportRunIssues({ reportRunId: run._id });

const clearDomainCollections = async () => {
  await Promise.all([
    Activity.deleteMany({}),
    Agency.deleteMany({}),
    Client.deleteMany({}),
    Issue.deleteMany({}),
    MetaAdAccount.deleteMany({}),
    MetaConnection.deleteMany({}),
    Report.deleteMany({}),
    ReportRun.deleteMany({}),
    Signal.deleteMany({}),
  ]);
};

const createPersistedRunnerRun = async (
  domain,
  { negative = false, executionKey = `phase2-runner:${objectId()}` } = {}
) => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const narrative = negative
    ? {
        status: "ok",
        severity: { level: "medium" },
        executiveSummary: "Creative performance needs attention.",
        likelyCause: {
          id: "creative_fatigue",
          archetype: "Creative fatigue",
        },
        campaign: { id: "campaign-1", name: "Campaign One" },
        rankedAnomalies: [{ metric: "ctr", delta: -20 }],
        dataQuality: { level: "strong" },
        trustGate: { blocked: false },
        userInsight: {
          headline: "Refresh the creative",
          decisionBrief: { primaryAction: "Test a new creative angle." },
        },
      }
    : {
        status: "ok",
        severity: { level: "low" },
        executiveSummary: "Performance is stable.",
        likelyCause: { id: "stable_performance", archetype: "Stable performance" },
        rankedAnomalies: [],
        dataQuality: { level: "strong" },
        trustGate: { blocked: false },
      };
  const deliveryKey = `${executionKey}:internal:batch`;
  const reportRun = await ReportRun.create({
    agency_id: domain.agency._id,
    client_id: domain.client._id,
    report_id: domain.report._id,
    context_snapshot: runContext(domain),
    meta_ad_account_id: domain.account._id,
    meta_account_external_id_snapshot: domain.account.ad_account_id,
    meta_account_name_snapshot: domain.account.name,
    meta_binding_revision_snapshot: 0,
    meta_binding_performance_validated_at: now,
    monitored_campaigns: [
      { campaign_id: "campaign-1", campaign_name: "Campaign One" },
    ],
    trigger_type: "manual",
    execution_key: executionKey,
    execution_stage: "artifacts_ready",
    execution_attempt_count: 1,
    started_at: now,
    artifacts_ready_at: now,
    status: "ok",
    severity: negative ? "medium" : "low",
    comparison: {
      mode: "scheduled_window",
      period: {
        type: "daily",
        current: { start: "2026-07-16", end: "2026-07-16" },
        previous: { start: "2026-07-15", end: "2026-07-15" },
      },
      currentPeriodMetrics: { clicks: negative ? 80 : 100 },
      previousPeriodMetrics: { clicks: 100 },
      rowCounts: { current: 1, previous: 1, total: 2 },
    },
    narrative,
    engine_output: narrative,
    internal_report: {
      status: "generated",
      subject: "Narrative report",
      html: "<p>Persisted report</p>",
      text: "Persisted report",
      recipients: [{ email: "team@example.com", status: "pending" }],
      dispatch: {
        idempotency_key: deliveryKey,
        status: "pending",
        attempt_count: 0,
      },
    },
    client_report: {
      status: "cancelled",
      delivery_mode: "generate_only",
      subject: "Client report",
      html: "<p>Client report</p>",
      recipients: [],
      dispatch: {
        idempotency_key: `${executionKey}:client:batch`,
        status: "not_required",
        attempt_count: 0,
      },
    },
    ran_at: now,
  });
  return { reportRun, executionKey, deliveryKey, now };
};

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replicaSet.getUri(), { dbName: `narrative_phase2_${Date.now()}` });
  await Promise.all([
    Activity.init(), Agency.init(), Client.init(), Issue.init(), MetaAdAccount.init(), MetaConnection.init(), Report.init(), ReportRun.init(), Signal.init(),
  ]);
  const integrity = await initializePhase2IssueIntegrity({
    collections: { issues: Issue.collection, signals: Signal.collection },
  });
  assert.equal(integrity.ready, true);
  markExecutionIntegrityReady();
}, { timeout: 120_000 });

beforeEach(async () => {
  await clearDomainCollections();
});

after(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
}, { timeout: 30_000 });

test("first and repeated occurrences create one Issue with ordered write-once Signal lineage", async () => {
  const domain = await createDomain();
  const first = await createRun(domain, { start: "2026-07-10", severity: "moderate" });
  assert.equal((await process(first)).classification, "created");
  const second = await createRun(domain, { start: "2026-07-11", severity: "critical" });
  assert.equal((await process(second)).classification, "matched");
  const issue = await Issue.findOne({});
  const signals = await Signal.find({}).sort({ detected_at: 1 });
  assert.equal(await Issue.countDocuments({}), 1);
  assert.equal(issue.occurrence_count, 2);
  assert.equal(issue.current_severity, "critical");
  assert.equal(issue.previous_severity, "moderate");
  assert.equal(issue.trend, "escalating");
  assert.deepEqual(signals.map((item) => item.issue_occurrence_number), [1, 2]);
  assert.equal(signals.every((item) => String(item.issue_id) === String(issue._id)), true);
});

test("one ReportRun creates and independently matches multiple deterministic metric Signals", async () => {
  const domain = await createDomain();
  const reportRun = await createRun(domain, {
    start: "2026-07-10",
    signal: false,
    narrative: {
      status: "ok",
      severity: { level: "high" },
      executiveSummary: "CTR, CPA, and ROAS independently need attention.",
      likelyCause: { id: "creative_fatigue", archetype: "Creative fatigue" },
      campaign: { id: "campaign-1", name: "Campaign One" },
      rankedAnomalies: [
        { metric: "ctr", label: "CTR", delta: -30, direction: "bad", usable: true },
        { metric: "cpa", label: "CPA", delta: 45, direction: "bad", usable: true },
        { metric: "roas", label: "ROAS", delta: -25, direction: "bad", usable: true },
      ],
      dataQuality: { level: "strong" },
      trustGate: { blocked: false },
    },
  });
  const input = {
    report: domain.report,
    reportRun,
    reportRunId: reportRun._id,
    narrative: reportRun.narrative,
    comparison: reportRun.comparison,
  };
  const [workerOne, workerTwo] = await Promise.all([
    saveSignalsFromNarrative(input),
    saveSignalsFromNarrative(input),
  ]);
  assert.equal(workerOne.length, 3);
  assert.equal(workerTwo.length, 3);
  assert.equal(await Signal.countDocuments({ report_run_id: reportRun._id }), 3);
  assert.equal(
    (
      await Signal.distinct("observation_key", {
        report_run_id: reportRun._id,
      })
    ).length,
    3
  );

  const outcome = await process(reportRun);
  assert.equal(outcome.issues.length, 3);
  assert.equal(await Issue.countDocuments({ agency_id: domain.agency._id }), 3);
  assert.equal(
    await Signal.countDocuments({
      report_run_id: reportRun._id,
      issue_matching_status: "matched",
    }),
    3
  );
  assert.deepEqual(
    (await Issue.distinct("metric_family", { agency_id: domain.agency._id })).sort(),
    ["cpa", "creative_engagement", "roas"]
  );

  const replay = await process(reportRun);
  assert.equal(replay.skipped, true);
  assert.equal(await Issue.countDocuments({ agency_id: domain.agency._id }), 3);
  assert.equal(await Signal.countDocuments({ report_run_id: reportRun._id }), 3);
});

test("trusted stable-severity negative evidence starts in monitoring", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10", severity: "stable" }));
  const issue = await Issue.findOne({});
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.current_severity, "stable");
  assert.ok(issue.active_fingerprint);
});

test("trusted distinct clean windows move monitoring then resolve without duplicate advancement", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10", severity: "critical" }));
  const cleanOne = await createRun(domain, { start: "2026-07-11", signal: false, severity: "stable" });
  assert.equal((await process(cleanOne)).classification, "clean_observation");
  let issue = await Issue.findOne({});
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.absence_streak, 1);
  assert.equal((await process(cleanOne)).skipped, true);
  issue = await Issue.findOne({});
  assert.equal(issue.absence_streak, 1);
  await process(await createRun(domain, { start: "2026-07-12", signal: false, severity: "stable" }));
  issue = await Issue.findOne({});
  assert.equal(issue.status, "resolved");
  assert.equal(issue.active_fingerprint, null);
  assert.equal(issue.absence_streak, 2);
});

test("paused and archived Reports cannot advance or replace clean recovery evidence", async () => {
  for (const state of ["paused", "archived"]) {
    const domain = await createDomain();
    await process(await createRun(domain, { start: "2026-07-10", severity: "critical" }));
    const before = await Issue.findOne({}).lean();
    const clean = await createRun(domain, { start: "2026-07-11", signal: false });
    if (state === "paused") {
      await Report.updateOne({ _id: domain.report._id }, { $set: { status: "paused" } });
    } else {
      await Report.updateOne(
        { _id: domain.report._id },
        { $set: { is_archived: true, archived_at: new Date() } }
      );
    }
    assert.equal((await process(clean)).classification, "not_applicable");
    const after = await Issue.findById(before._id).lean();
    assert.equal(after.status, before.status);
    assert.equal(after.absence_streak, before.absence_streak);
    assert.equal(after.lifecycle_revision, before.lifecycle_revision);
    assert.equal(String(after.latest_report_run_id), String(before.latest_report_run_id));
    assert.deepEqual(after.latest_evidence, before.latest_evidence);
  }
});

test("Meta account ownership requires a present valid exact Client ID", async () => {
  const invalidOwners = [
    { label: "missing", update: { $unset: { client_id: "" } } },
    { label: "null", update: { $set: { client_id: null } } },
    { label: "malformed", update: { $set: { client_id: "not-an-object-id" } } },
    { label: "foreign", update: { $set: { client_id: objectId() } } },
  ];
  for (const invalid of invalidOwners) {
    const domain = await createDomain();
    const run = await createRun(domain, { start: "2026-07-10" });
    await MetaAdAccount.collection.updateOne({ _id: domain.account._id }, invalid.update);
    await assert.rejects(
      process(run),
      (error) => error.code === "ISSUE_SCOPE_OWNERSHIP_CONFLICT",
      invalid.label
    );
    assert.equal(await Issue.countDocuments({ agency_id: domain.agency._id }), 0);
    const signal = await Signal.findOne({ report_run_id: run._id });
    assert.equal(signal.issue_id, null);
    assert.equal(signal.issue_matching_status, "failed");
  }
});

test("negative Signals cannot mutate Issues without current operational Meta authority", async () => {
  const scenarios = [
    {
      label: "inactive account",
      reason: "meta_account_inaccessible",
      mutate: ({ account }) =>
        MetaAdAccount.updateOne({ _id: account._id }, { $set: { is_active: false } }),
    },
    {
      label: "inaccessible account",
      reason: "meta_account_inaccessible",
      mutate: ({ account }) =>
        MetaAdAccount.updateOne(
          { _id: account._id },
          { $set: { is_accessible: false } }
        ),
    },
    {
      label: "revoked workspace connection",
      reason: "workspace_meta_reconnect_required",
      mutate: ({ connection }) =>
        MetaConnection.updateOne(
          { _id: connection._id },
          { $set: { status: "revoked", is_active: true } }
        ),
    },
    {
      label: "non-authoritative connection",
      reason: "workspace_meta_connection_invalid",
      mutate: ({ connection, client }) =>
        MetaConnection.collection.updateOne(
          { _id: connection._id },
          {
            $set: {
              connection_scope: "legacy_client",
              client_id: client._id,
            },
          }
        ),
    },
  ];

  for (const scenario of scenarios) {
    await clearDomainCollections();
    const domain = await createDomain();
    await process(await createRun(domain, { start: "2026-07-10" }));
    const issueBefore = await Issue.findOne({}).lean();
    const nextRun = await createRun(domain, { start: "2026-07-11" });
    await scenario.mutate(domain);

    let deliveryCalls = 0;
    await processReportRunIssuesBeforeDelivery({
      reportRunId: nextRun._id,
      deliveryProcessor: async ({ reportRunId }) => {
        deliveryCalls += 1;
        return { reportRun: await ReportRun.findById(reportRunId) };
      },
    });
    assert.equal(deliveryCalls, 1, scenario.label);
    assert.equal(await Issue.countDocuments({}), 1, scenario.label);
    const issueAfter = await Issue.findById(issueBefore._id).lean();
    assert.equal(issueAfter.occurrence_count, issueBefore.occurrence_count, scenario.label);
    assert.equal(issueAfter.lifecycle_revision, issueBefore.lifecycle_revision, scenario.label);
    assert.equal(String(issueAfter.latest_signal_id), String(issueBefore.latest_signal_id), scenario.label);
    assert.equal(String(issueAfter.latest_report_run_id), String(issueBefore.latest_report_run_id), scenario.label);
    assert.deepEqual(issueAfter.latest_evidence, issueBefore.latest_evidence, scenario.label);

    const signal = await Signal.findOne({ report_run_id: nextRun._id });
    assert.equal(signal.issue_id, null, scenario.label);
    assert.equal(signal.issue_matching_status, "ineligible", scenario.label);
    assert.equal(signal.issue_matching_reason, scenario.reason, scenario.label);
    const persistedRun = await ReportRun.findById(nextRun._id);
    assert.equal(persistedRun.issue_processing.status, "ineligible", scenario.label);
    assert.equal(
      persistedRun.issue_processing.result_classification,
      "ineligible",
      scenario.label
    );
    assert.equal(persistedRun.issue_processing.issue_id, null, scenario.label);
  }
});

test("negative Signal ownership and binding contradictions fail integrity without lineage mutation", async () => {
  const scenarios = [
    {
      label: "account assigned to another Client",
      code: "ISSUE_SCOPE_OWNERSHIP_CONFLICT",
      mutate: async ({ account, agency }) => {
        const foreignClient = await Client.create({
          agency_id: agency._id,
          name: "Foreign client",
          status: "stable",
        });
        await MetaAdAccount.updateOne(
          { _id: account._id },
          { $set: { client_id: foreignClient._id } }
        );
      },
    },
    {
      label: "account moved to another agency",
      code: "ISSUE_SCOPE_OWNERSHIP_CONFLICT",
      mutate: async ({ account }) => {
        const foreignAgency = await Agency.create({
          name: `Foreign ${objectId()}`,
          slug: `foreign-${objectId()}`,
        });
        await MetaAdAccount.updateOne(
          { _id: account._id },
          { $set: { agency_id: foreignAgency._id } }
        );
      },
    },
    {
      label: "binding revision changed",
      code: "META_ACCOUNT_ASSIGNMENT_CHANGED",
      mutate: ({ account }) =>
        MetaAdAccount.updateOne(
          { _id: account._id },
          { $inc: { binding_revision: 1 } }
        ),
    },
    {
      label: "workspace connection moved to another agency",
      code: "ISSUE_SCOPE_OWNERSHIP_CONFLICT",
      mutate: async ({ connection }) => {
        const foreignAgency = await Agency.create({
          name: `Connection owner ${objectId()}`,
          slug: `connection-owner-${objectId()}`,
        });
        await MetaConnection.updateOne(
          { _id: connection._id },
          { $set: { agency_id: foreignAgency._id } }
        );
      },
    },
    {
      label: "Signal Client conflicts with ReportRun Client",
      code: "ISSUE_SCOPE_OWNERSHIP_CONFLICT",
      mutate: async ({ agency, run }) => {
        const foreignClient = await Client.create({
          agency_id: agency._id,
          name: "Signal foreign client",
          status: "stable",
        });
        await Signal.updateOne(
          { report_run_id: run._id },
          { $set: { client_id: foreignClient._id } }
        );
      },
    },
  ];

  for (const scenario of scenarios) {
    await clearDomainCollections();
    const domain = await createDomain();
    await process(await createRun(domain, { start: "2026-07-10" }));
    const issueBefore = await Issue.findOne({}).lean();
    const nextRun = await createRun(domain, { start: "2026-07-11" });
    await scenario.mutate({ ...domain, run: nextRun });

    let deliveryCalls = 0;
    await assert.rejects(
      processReportRunIssuesBeforeDelivery({
        reportRunId: nextRun._id,
        deliveryProcessor: async () => {
          deliveryCalls += 1;
          return { reportRun: await ReportRun.findById(nextRun._id) };
        },
      }),
      (error) => error.code === scenario.code,
      scenario.label
    );
    assert.equal(deliveryCalls, 0, scenario.label);
    assert.equal(await Issue.countDocuments({}), 1, scenario.label);
    const issueAfter = await Issue.findById(issueBefore._id).lean();
    assert.equal(issueAfter.occurrence_count, issueBefore.occurrence_count, scenario.label);
    assert.equal(issueAfter.lifecycle_revision, issueBefore.lifecycle_revision, scenario.label);
    assert.equal(String(issueAfter.latest_signal_id), String(issueBefore.latest_signal_id), scenario.label);
    assert.equal(String(issueAfter.latest_report_run_id), String(issueBefore.latest_report_run_id), scenario.label);
    assert.deepEqual(issueAfter.latest_evidence, issueBefore.latest_evidence, scenario.label);

    const signal = await Signal.findOne({ report_run_id: nextRun._id });
    assert.equal(signal.issue_id, null, scenario.label);
    assert.equal(signal.issue_matching_status, "failed", scenario.label);
    const persistedRun = await ReportRun.findById(nextRun._id);
    assert.equal(persistedRun.issue_processing.status, "failed_integrity", scenario.label);
    assert.equal(persistedRun.issue_processing.failure_code, scenario.code, scenario.label);
    assert.equal(persistedRun.issue_processing.issue_id, null, scenario.label);
  }
});

test("untrusted and revoked clean observations cannot resolve an Issue", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const weak = await createRun(domain, {
    start: "2026-07-11",
    signal: false,
    narrative: { status: "ok", likelyCause: { id: "stable_performance" }, dataQuality: { level: "weak" }, trustGate: { blocked: false } },
  });
  assert.equal((await process(weak)).classification, "not_applicable");
  await MetaConnection.updateOne({ _id: domain.connection._id }, { $set: { status: "revoked", is_active: false } });
  await process(await createRun(domain, { start: "2026-07-12", signal: false }));
  const issue = await Issue.findOne({});
  assert.equal(issue.status, "open");
  assert.equal(issue.absence_streak, 0);
});

test("archived parents are not processed and leave an explicit bounded Signal state", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  await Report.updateOne({ _id: domain.report._id }, { $set: { is_archived: true, archived_at: new Date() } });
  assert.equal((await process(run)).classification, "not_applicable");
  const signal = await Signal.findOne({ report_run_id: run._id });
  assert.equal(signal.issue_matching_status, "ineligible");
  assert.equal(signal.issue_matching_reason, "parent_archived");
  assert.equal(await Issue.countDocuments({}), 0);
});

test("data-quality Issue accepts trustworthy data-quality recovery evidence", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  await Signal.updateOne(
    { report_run_id: run._id },
    { $set: { type: "data_quality_issue", "metadata.archetype_id": "data_quality_issue" } }
  );
  await process(run);
  const clean = await createRun(domain, {
    start: "2026-07-11",
    signal: false,
    narrative: { status: "ok", likelyCause: { id: "not_stable" }, dataQuality: { level: "strong" }, trustGate: { blocked: false } },
  });
  assert.equal((await process(clean)).classification, "clean_observation");
  const issue = await Issue.findOne({});
  assert.equal(issue.archetype, "data_quality_issue");
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.absence_streak, 1);
});

test("one moderate post-Intervention observation is tracked and consecutive evidence returns the Issue to open", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const interventionId = objectId();
  await Issue.updateOne({}, {
    $set: {
      status: "monitoring",
      latest_intervention_id: interventionId,
      monitoring_intervention_id: interventionId,
      monitoring_started_at: new Date("2026-07-10T13:00:00.000Z"),
      monitoring_reason: "actionable_intervention_recorded",
      last_intervention_at: new Date("2026-07-10T13:00:00.000Z"),
    },
  });

  await process(await createRun(domain, { start: "2026-07-11", severity: "moderate" }));
  let issue = await Issue.findOne({});
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.worsening_streak, 1);

  await process(await createRun(domain, { start: "2026-07-12", severity: "moderate" }));
  issue = await Issue.findOne({});
  assert.equal(issue.status, "open");
  assert.equal(issue.worsening_streak, 2);
  assert.equal(await Issue.countDocuments({}), 1);
});

test("critical strong-authority post-Intervention evidence returns the Issue to open immediately", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const interventionId = objectId();
  await Issue.updateOne({}, {
    $set: {
      status: "monitoring",
      latest_intervention_id: interventionId,
      monitoring_intervention_id: interventionId,
      monitoring_started_at: new Date("2026-07-10T13:00:00.000Z"),
      monitoring_reason: "actionable_intervention_recorded",
      last_intervention_at: new Date("2026-07-10T13:00:00.000Z"),
    },
  });
  await process(await createRun(domain, { start: "2026-07-11", severity: "critical" }));
  const issue = await Issue.findOne({});
  assert.equal(issue.status, "open");
  assert.equal(issue.worsening_streak, 1);
});

test("a clean recovery after one bad post-Intervention observation clears the worsening streak", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const interventionId = objectId();
  await Issue.updateOne({}, {
    $set: {
      status: "monitoring",
      latest_intervention_id: interventionId,
      monitoring_intervention_id: interventionId,
      monitoring_started_at: new Date("2026-07-10T13:00:00.000Z"),
      monitoring_reason: "actionable_intervention_recorded",
      last_intervention_at: new Date("2026-07-10T13:00:00.000Z"),
    },
  });
  await process(await createRun(domain, { start: "2026-07-11", severity: "moderate" }));
  await process(await createRun(domain, { start: "2026-07-12", signal: false }));
  const issue = await Issue.findOne({});
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.worsening_streak, 0);
  assert.equal(issue.worsening_metric, null);
});

test("intervention-backed resolution requires acceptable improved Evaluation confidence plus clean observations", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const interventionId = objectId();
  await Issue.updateOne({}, {
    $set: {
      status: "monitoring",
      latest_intervention_id: interventionId,
      monitoring_intervention_id: interventionId,
      monitoring_started_at: new Date("2026-07-10T13:00:00.000Z"),
      monitoring_reason: "actionable_intervention_recorded",
      last_intervention_at: new Date("2026-07-10T13:00:00.000Z"),
      intervention_count: 1,
      latest_evaluation_id: objectId(),
      latest_evaluation_status: "ready",
      latest_evaluation_result: "improved",
      latest_evaluation_confidence: "low",
      latest_evaluation_at: new Date("2026-07-11T13:00:00.000Z"),
    },
  });
  await process(await createRun(domain, { start: "2026-07-11", signal: false }));
  await process(await createRun(domain, { start: "2026-07-12", signal: false }));
  let issue = await Issue.findOne({});
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.absence_streak, 2);

  await Issue.updateOne({}, {
    $set: {
      latest_evaluation_id: objectId(),
      latest_evaluation_confidence: "high",
      latest_evaluation_at: new Date("2026-07-12T13:00:00.000Z"),
    },
  });
  await process(await createRun(domain, { start: "2026-07-13", signal: false }));
  issue = await Issue.findOne({});
  assert.equal(issue.status, "resolved");
});

test("retryable transaction failures retry without partial lineage", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  let attempts = 0;
  const retryingRunner = async (options) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("transient write conflict");
      error.code = 112;
      throw error;
    }
    return runRequiredTransaction(options);
  };
  const result = await processReportRunIssues({
    reportRunId: run._id,
    transactionRunner: retryingRunner,
  });
  assert.equal(result.classification, "created");
  assert.equal(attempts, 2);
  assert.equal(await Issue.countDocuments({}), 1);
  assert.equal(await Signal.countDocuments({ issue_id: { $type: "objectId" } }), 1);
});

test("Issue matching remains committed when Review projection fails", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  let reviewCalls = 0;
  const result = await processReportRunIssues({
    reportRunId: run._id,
    reviewProcessor: async () => {
      reviewCalls += 1;
      throw Object.assign(new Error("injected Review projection failure"), { code: "REVIEW_TEST_FAILURE" });
    },
  });

  assert.equal(result.classification, "created");
  assert.equal(reviewCalls, 1);
  assert.equal(await Issue.countDocuments({ agency_id: domain.agency._id }), 1);
  assert.equal(await Signal.countDocuments({ report_run_id: run._id, issue_id: { $type: "objectId" } }), 1);
  assert.equal((await ReportRun.findById(run._id)).issue_processing.status, "completed");
});

test("corrupted cross-owner Issue lineage fails closed before lifecycle mutation", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const issue = await Issue.findOne({});
  const foreign = await createDomain();
  const foreignSignal = await Signal.create({
    agency_id: foreign.agency._id,
    client_id: foreign.client._id,
    report_id: foreign.report._id,
    type: "creative_fatigue",
    severity: "moderate",
    title: "Foreign",
  });
  await Issue.updateOne({ _id: issue._id }, { $set: { latest_signal_id: foreignSignal._id } });
  const next = await createRun(domain, { start: "2026-07-11" });
  await assert.rejects(
    process(next),
    (error) => error.code === "ISSUE_SCOPE_OWNERSHIP_CONFLICT"
  );
  const unchanged = await Issue.findById(issue._id);
  const failedRun = await ReportRun.findById(next._id);
  const failedSignal = await Signal.findOne({ report_run_id: next._id });
  assert.equal(unchanged.occurrence_count, 1);
  assert.equal(failedRun.issue_processing.status, "failed_integrity");
  assert.equal(failedSignal.issue_matching_status, "failed");
  assert.equal(failedSignal.issue_id, null);
});

test("recurrence within 30 days reopens while later recurrence creates a successor", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-05-01" }));
  await process(await createRun(domain, { start: "2026-05-02", signal: false }));
  await process(await createRun(domain, { start: "2026-05-03", signal: false }));
  const original = await Issue.findOne({});
  const within = await createRun(domain, { start: "2026-05-20" });
  assert.equal((await process(within)).classification, "reopened");
  assert.equal((await Issue.findById(original._id)).reopen_count, 1);
  await process(await createRun(domain, { start: "2026-05-21", signal: false }));
  await process(await createRun(domain, { start: "2026-05-22", signal: false }));
  const outside = await createRun(domain, { start: "2026-07-01" });
  assert.equal((await process(outside)).classification, "successor_created");
  const successor = await Issue.findOne({ predecessor_issue_id: original._id });
  assert.ok(successor);
});

test("stale and duplicate observations do not mutate Issue lifecycle", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-12" }));
  const before = await Issue.findOne({}).lean();
  const stale = await createRun(domain, { start: "2026-07-11" });
  assert.equal((await process(stale)).classification, "ineligible");
  const staleSignal = await Signal.findOne({ report_run_id: stale._id });
  const after = await Issue.findById(before._id).lean();
  assert.equal(staleSignal.issue_matching_reason, "stale_observation");
  assert.equal(after.occurrence_count, before.occurrence_count);
  assert.equal(after.lifecycle_revision, before.lifecycle_revision);
});

test("exact observation keys deduplicate while distinct windows with the same end remain valid", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-01", end: "2026-07-02" }));
  const distinct = await createRun(domain, { start: "2026-07-02", end: "2026-07-02" });
  assert.equal((await process(distinct)).classification, "matched");
  let issue = await Issue.findOne({});
  assert.equal(issue.occurrence_count, 2);

  const duplicate = await createRun(domain, { start: "2026-07-02", end: "2026-07-02" });
  assert.equal((await process(duplicate)).classification, "ineligible");
  issue = await Issue.findById(issue._id);
  assert.equal(issue.occurrence_count, 2);
  const duplicateSignal = await Signal.findOne({ report_run_id: duplicate._id });
  assert.equal(duplicateSignal.issue_matching_reason, "duplicate_observation");
});

test("multi-campaign ambiguity is ineligible while an explicit member campaign matches", async () => {
  const domain = await createDomain();
  const ambiguous = await createRun(domain, { start: "2026-07-10", campaignId: null, campaigns: ["one", "two"] });
  await Signal.updateOne({ report_run_id: ambiguous._id }, { $set: { campaign_id: null } });
  assert.equal((await process(ambiguous)).classification, "ineligible");
  const explicit = await createRun(domain, { start: "2026-07-11", campaignId: "two", campaigns: ["one", "two"] });
  assert.equal((await process(explicit)).classification, "created");
});

test("simultaneous first occurrences converge on one active Issue", async () => {
  const domain = await createDomain();
  const [first, second] = await Promise.all([
    createRun(domain, { start: "2026-07-10", end: "2026-07-11" }),
    createRun(domain, { start: "2026-07-11", end: "2026-07-11" }),
  ]);
  await Promise.all([process(first), process(second)]);
  assert.equal(await Issue.countDocuments({ active_fingerprint: { $type: "string" } }), 1);
  const issue = await Issue.findOne({});
  const linked = await Signal.find({ issue_id: issue._id }).sort({ issue_occurrence_number: 1 });
  assert.equal(linked.length, 2);
  assert.equal(issue.occurrence_count, 2);
  assert.deepEqual(linked.map((signal) => signal.issue_occurrence_number), [1, 2]);
});

test("concurrent repeated occurrences allocate complete unique occurrence numbers", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-09" }));
  const [second, third] = await Promise.all([
    createRun(domain, { start: "2026-07-10", end: "2026-07-11" }),
    createRun(domain, { start: "2026-07-11", end: "2026-07-11" }),
  ]);
  await Promise.all([process(second), process(third)]);
  const issue = await Issue.findOne({});
  const linked = await Signal.find({ issue_id: issue._id }).sort({ issue_occurrence_number: 1 });
  assert.equal(issue.occurrence_count, 3);
  assert.equal(linked.length, 3);
  assert.deepEqual(linked.map((signal) => signal.issue_occurrence_number), [1, 2, 3]);
});

test("concurrent workers cannot double-count one post-Intervention observation", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-09" }));
  const interventionId = objectId();
  await Issue.updateOne({}, {
    $set: {
      status: "monitoring",
      latest_intervention_id: interventionId,
      monitoring_intervention_id: interventionId,
      monitoring_started_at: new Date("2026-07-09T13:00:00.000Z"),
      monitoring_reason: "actionable_intervention_recorded",
      last_intervention_at: new Date("2026-07-09T13:00:00.000Z"),
    },
  });
  const [first, duplicate] = await Promise.all([
    createRun(domain, { start: "2026-07-10", severity: "moderate" }),
    createRun(domain, { start: "2026-07-10", severity: "moderate" }),
  ]);

  const outcomes = await Promise.all([process(first), process(duplicate)]);
  const issue = await Issue.findOne({});
  const linked = await Signal.find({ issue_id: issue._id });

  assert.deepEqual(outcomes.map((outcome) => outcome.classification).sort(), ["ineligible", "matched"]);
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.worsening_streak, 1);
  assert.equal(issue.occurrence_count, 2);
  assert.equal(linked.length, 2);
  assert.equal(await Issue.countDocuments({}), 1);
});

test("duplicate-key retry reloads and validates the winning Issue scope", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-09" }));
  const next = await createRun(domain, { start: "2026-07-10" });
  let attempts = 0;
  const duplicateThenRetry = async (options) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("forced duplicate key race");
      error.code = 11000;
      throw error;
    }
    return runRequiredTransaction(options);
  };
  const result = await processReportRunIssues({
    reportRunId: next._id,
    transactionRunner: duplicateThenRetry,
  });
  assert.equal(result.classification, "matched");
  assert.equal(attempts, 2);
  assert.equal((await Issue.findOne({})).occurrence_count, 2);
  assert.equal(await Signal.countDocuments({ issue_id: { $type: "objectId" } }), 2);
});

test("duplicate-key recovery rejects a winning Issue with a conflicting full scope", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-09" }));
  const issue = await Issue.findOne({});
  const next = await createRun(domain, { start: "2026-07-10" });
  let attempts = 0;
  const corruptWinnerThenRetry = async (options) => {
    attempts += 1;
    if (attempts === 1) {
      await Issue.collection.updateOne(
        { _id: issue._id },
        { $set: { "scope.entity.id": "conflicting-campaign" } }
      );
      const error = new Error("forced duplicate key race");
      error.code = 11000;
      throw error;
    }
    return runRequiredTransaction(options);
  };
  await assert.rejects(
    processReportRunIssues({
      reportRunId: next._id,
      transactionRunner: corruptWinnerThenRetry,
    }),
    (error) => error.code === "ISSUE_FINGERPRINT_COLLISION"
  );
  assert.equal(attempts, 2);
  assert.equal((await Issue.findById(issue._id)).occurrence_count, 1);
  assert.equal(await Signal.countDocuments({ report_run_id: next._id, issue_id: { $type: "objectId" } }), 0);
});

test("conditional Signal-link failure rolls back Issue increment and ReportRun completion", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  const claim = await claimReportRunIssueProcessing({ reportRunId: run._id });
  const FailingSignal = new Proxy(Signal, {
    get(target, property, receiver) {
      if (property === "updateOne") {
        return async (filter, update, options) =>
          update?.$set?.issue_id
            ? { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
            : target.updateOne(filter, update, options);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    runIssueMatchingTransaction({
      reportRunId: run._id,
      token: claim.token,
      Models: { Client, Issue, MetaAdAccount, MetaConnection, Report, ReportRun, Signal: FailingSignal },
      now: new Date(),
      transactionRunner: runRequiredTransaction,
    }),
    (error) => error.code === "ISSUE_SIGNAL_ALREADY_LINKED"
  );
  assert.equal(await Issue.countDocuments({}), 0);
  assert.equal(await Signal.countDocuments({ issue_id: { $type: "objectId" } }), 0);
  assert.equal((await ReportRun.findById(run._id)).issue_processing.status, "processing");
});

test("expired stale claim holder cannot complete or mutate Issue state", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  const claim = await claimReportRunIssueProcessing({ reportRunId: run._id });
  assert.equal(claim.acquired, true);
  await ReportRun.updateOne({ _id: run._id }, { $set: { "issue_processing.claim_expires_at": new Date(Date.now() - 1) } });
  await assert.rejects(
    runIssueMatchingTransaction({
      reportRunId: run._id,
      token: claim.token,
      Models: { Agency, Client, Issue, MetaAdAccount, MetaConnection, Report, ReportRun, Signal },
      now: new Date(),
      transactionRunner: runRequiredTransaction,
    }),
    (error) => error.code === "ISSUE_PROCESSING_CLAIM_LOST"
  );
  assert.equal(await Issue.countDocuments({}), 0);
  assert.equal(await Signal.countDocuments({ issue_id: { $type: "objectId" } }), 0);
  const unchangedRun = await ReportRun.findById(run._id);
  assert.equal(unchangedRun.issue_processing.status, "processing");
  assert.equal(unchangedRun.issue_processing.completed_at, null);
});

test("recurrence at exactly 30 days reopens and the next represented day creates a successor", async () => {
  const exactDomain = await createDomain();
  await process(await createRun(exactDomain, { start: "2026-05-01" }));
  await process(await createRun(exactDomain, { start: "2026-05-02", signal: false }));
  await process(await createRun(exactDomain, { start: "2026-05-03", signal: false }));
  const exactIssue = await Issue.findOne({ agency_id: exactDomain.agency._id });
  const boundaryRun = await createRun(exactDomain, { start: "2026-06-02" });
  assert.equal((await process(boundaryRun)).classification, "reopened");
  assert.equal((await Issue.findById(exactIssue._id)).reopen_count, 1);

  const outsideDomain = await createDomain();
  await process(await createRun(outsideDomain, { start: "2026-05-01" }));
  await process(await createRun(outsideDomain, { start: "2026-05-02", signal: false }));
  await process(await createRun(outsideDomain, { start: "2026-05-03", signal: false }));
  const predecessor = await Issue.findOne({ agency_id: outsideDomain.agency._id });
  const outsideRun = await createRun(outsideDomain, { start: "2026-06-03" });
  assert.equal((await process(outsideRun)).classification, "successor_created");
  const successor = await Issue.findOne({ predecessor_issue_id: predecessor._id });
  assert.ok(successor);
});

test("Issue list applies agency and operational filters with deterministic pagination", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10", severity: "moderate" }));
  await process(await createRun(domain, { start: "2026-07-11", campaignId: "campaign-2", campaigns: ["campaign-2"], severity: "critical" }));
  await Issue.updateMany({ agency_id: domain.agency._id }, { $set: { reopen_count: 2 } });
  const firstResponse = response();
  await getIssues({
    user: { agencyId: domain.agency._id },
    query: { clientId: String(domain.client._id), reportId: String(domain.report._id), metaAdAccountId: String(domain.account._id), limit: "1" },
  }, firstResponse);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(firstResponse.body.issues.length, 1);
  assert.equal(firstResponse.body.issues[0].reopenCount, 2);
  assert.equal("predecessorIssueId" in firstResponse.body.issues[0], false);
  assert.equal("lifecycleRevision" in firstResponse.body.issues[0], false);
  assert.equal(firstResponse.body.page.hasMore, true);
  assert.ok(firstResponse.body.page.nextCursor);
  const secondResponse = response();
  await getIssues({ user: { agencyId: domain.agency._id }, query: { severity: "moderate", cursor: firstResponse.body.page.nextCursor } }, secondResponse);
  assert.equal(secondResponse.statusCode, 200);
  const invalidResponse = response();
  await getIssues({ user: { agencyId: domain.agency._id }, query: { status: "deleted" } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
});

test("report-filtered Issue lists retain legacy report_ids compatibility", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const issue = await Issue.findOne({ agency_id: domain.agency._id });
  await Issue.collection.updateOne(
    { _id: issue._id },
    { $set: { report_ids: [domain.report._id] } }
  );
  await Signal.updateMany(
    { issue_id: issue._id },
    { $unset: { issue_id: 1 } }
  );

  const legacyResponse = response();
  await getIssues(
    {
      user: { agencyId: domain.agency._id },
      query: { reportId: String(domain.report._id) },
    },
    legacyResponse
  );

  assert.equal(legacyResponse.statusCode, 200);
  assert.deepEqual(
    legacyResponse.body.issues.map((candidate) => candidate.id),
    [String(issue._id)]
  );
});

test("Issue detail is non-disclosing across agencies and remains snapshot-first after parent rename", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  const issue = await Issue.findOne({});
  await Client.updateOne({ _id: domain.client._id }, { $set: { name: "Renamed Client" } });
  const detailResponse = response();
  await getIssue({ user: { agencyId: domain.agency._id }, params: { issueId: String(issue._id) } }, detailResponse);
  assert.equal(detailResponse.body.issue.identity.client.value, "Acme");
  assert.equal(detailResponse.body.issue.identity.client.provenance, "snapshot");
  assert.equal("claim_token" in detailResponse.body.issue, false);
  assert.equal("html" in detailResponse.body.issue, false);
  const foreignResponse = response();
  await getIssue({ user: { agencyId: objectId() }, params: { issueId: String(issue._id) } }, foreignResponse);
  assert.equal(foreignResponse.statusCode, 404);
  const malformedResponse = response();
  await getIssue({ user: { agencyId: domain.agency._id }, params: { issueId: "bad" } }, malformedResponse);
  assert.equal(malformedResponse.statusCode, 404);
});

test("linked Signal endpoint paginates only same-agency occurrences and excludes unrestricted metadata", async () => {
  const domain = await createDomain();
  await process(await createRun(domain, { start: "2026-07-10" }));
  await process(await createRun(domain, { start: "2026-07-11" }));
  const issue = await Issue.findOne({});
  const signalResponse = response();
  await getIssueSignals({ user: { agencyId: domain.agency._id }, params: { issueId: String(issue._id) }, query: { limit: "1" } }, signalResponse);
  assert.equal(signalResponse.body.signals.length, 1);
  assert.equal(signalResponse.body.page.hasMore, true);
  assert.equal(signalResponse.body.signals[0].issueId, String(issue._id));
  assert.equal("metadata" in signalResponse.body.signals[0], false);
  assert.equal("context_snapshot" in signalResponse.body.signals[0], false);
});

test("historical migration dry-run classifies exact groups and apply preserves chronology and legacy unknowns", async () => {
  const domain = await createDomain();
  await createRun(domain, { start: "2026-07-10" });
  await createRun(domain, { start: "2026-07-11" });
  const legacy = await Signal.create({
    agency_id: domain.agency._id,
    client_id: domain.client._id,
    report_id: domain.report._id,
    type: "creative_fatigue",
    severity: "moderate",
    title: "Legacy signal",
  });
  const inspection = await inspectPhase2IssueMigration();
  assert.equal(inspection.counts.eligible, 2);
  assert.equal(inspection.counts.issueGroups, 1);
  assert.equal(inspection.counts.legacyUngrouped, 1);
  const applied = await applyPhase2IssueMigration({
    expected: { eligible: 2, issueGroups: 1, legacyUngrouped: 1 },
  });
  assert.equal(applied.processedSignals, 2);
  const linked = await Signal.find({ issue_id: { $type: "objectId" } }).sort({ detected_at: 1 });
  assert.deepEqual(linked.map((item) => item.issue_occurrence_number), [1, 2]);
  assert.equal((await Signal.findById(legacy._id)).issue_matching_status, "legacy_ungrouped");
  assert.equal((await Issue.findOne({})).absence_streak, 0);
  const repeated = await applyPhase2IssueMigration({
    expected: { eligible: 0, issueGroups: 0, legacyUngrouped: 1 },
  });
  assert.equal(repeated.processedSignals, 0);
});

test("historical migration expected-count mismatch and group failure perform no lineage writes", async () => {
  const domain = await createDomain();
  await createRun(domain, { start: "2026-07-10" });
  await assert.rejects(
    applyPhase2IssueMigration({
      expected: { eligible: 99, issueGroups: 1, legacyUngrouped: 0 },
    }),
    (error) => error.code === "PHASE2_ISSUE_MIGRATION_COUNT_MISMATCH"
  );
  assert.equal(await Issue.countDocuments({}), 0);
  const rollbackRunner = async ({ work }) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await work(session);
        throw new Error("forced group rollback");
      });
    } finally {
      await session.endSession();
    }
  };
  await assert.rejects(
    applyPhase2IssueMigration({
      expected: { eligible: 1, issueGroups: 1, legacyUngrouped: 0 },
      transactionRunner: rollbackRunner,
    }),
    /forced group rollback/
  );
  assert.equal(await Issue.countDocuments({}), 0);
  assert.equal(await Signal.countDocuments({ issue_id: { $type: "objectId" } }), 0);
  assert.equal(await ReportRun.countDocuments({ "issue_processing.status": "completed" }), 0);
});

test("migration post-apply verification rejects occurrence and legacy inconsistencies", async () => {
  const domain = await createDomain();
  await createRun(domain, { start: "2026-07-10" });
  await createRun(domain, { start: "2026-07-11" });
  const legacy = await Signal.create({
    agency_id: domain.agency._id,
    client_id: domain.client._id,
    report_id: domain.report._id,
    type: "creative_fatigue",
    severity: "moderate",
    title: "Legacy signal",
  });
  const inspection = await inspectPhase2IssueMigration();
  const expected = { eligible: 2, issueGroups: 1, legacyUngrouped: 1 };
  await applyPhase2IssueMigration({ expected });
  assert.equal(
    (await verifyPhase2IssueMigrationApply({ inspection, expected })).linkedEligible,
    2
  );

  const issue = await Issue.findOne({});
  await Issue.collection.updateOne(
    { _id: issue._id },
    { $set: { occurrence_count: 99 } }
  );
  await assert.rejects(
    verifyPhase2IssueMigrationApply({ inspection, expected }),
    (error) =>
      error.code === "PHASE2_ISSUE_MIGRATION_POST_VERIFY_FAILED" &&
      error.check === "occurrence_lineage"
  );
  await Issue.collection.updateOne(
    { _id: issue._id },
    { $set: { occurrence_count: 2 } }
  );
  const migratedRun = await ReportRun.findOne({
    "issue_processing.status": "completed",
  });
  await ReportRun.collection.updateOne(
    { _id: migratedRun._id },
    { $set: { "issue_processing.status": "failed_retryable" } }
  );
  await assert.rejects(
    verifyPhase2IssueMigrationApply({ inspection, expected }),
    (error) =>
      error.code === "PHASE2_ISSUE_MIGRATION_POST_VERIFY_FAILED" &&
      error.check === "report_run_processing"
  );
  await ReportRun.collection.updateOne(
    { _id: migratedRun._id },
    { $set: { "issue_processing.status": "completed" } }
  );
  await Signal.collection.updateOne(
    { _id: legacy._id },
    { $set: { issue_matching_status: null } }
  );
  await assert.rejects(
    verifyPhase2IssueMigrationApply({ inspection, expected }),
    (error) =>
      error.code === "PHASE2_ISSUE_MIGRATION_POST_VERIFY_FAILED" &&
      error.check === "legacy_classification"
  );
});

test("migration classifies unavailable Meta authority without Issue or Signal lineage writes", async () => {
  const scenarios = [
    {
      label: "inactive account",
      inspectionReason: "meta_account_inaccessible",
      mutate: ({ account }) =>
        MetaAdAccount.updateOne({ _id: account._id }, { $set: { is_active: false } }),
    },
    {
      label: "inaccessible account",
      inspectionReason: "meta_account_inaccessible",
      mutate: ({ account }) =>
        MetaAdAccount.updateOne(
          { _id: account._id },
          { $set: { is_accessible: false } }
        ),
    },
    {
      label: "revoked connection",
      inspectionReason: "workspace_meta_reconnect_required",
      mutate: ({ connection }) =>
        MetaConnection.updateOne(
          { _id: connection._id },
          { $set: { status: "revoked", is_active: true } }
        ),
    },
    {
      label: "non-authoritative connection",
      inspectionReason: "workspace_meta_connection_invalid",
      mutate: ({ connection, client }) =>
        MetaConnection.collection.updateOne(
          { _id: connection._id },
          {
            $set: {
              connection_scope: "legacy_client",
              client_id: client._id,
            },
          }
        ),
    },
  ];

  for (const scenario of scenarios) {
    await clearDomainCollections();
    const domain = await createDomain();
    const run = await createRun(domain, { start: "2026-07-10" });
    await scenario.mutate(domain);

    const inspection = await inspectPhase2IssueMigration();
    assert.equal(inspection.counts.eligible, 0, scenario.label);
    assert.equal(inspection.counts.issueGroups, 0, scenario.label);
    assert.equal(inspection.counts.legacyUngrouped, 1, scenario.label);
    assert.equal(inspection.reasons[scenario.inspectionReason], 1, scenario.label);

    await assert.rejects(
      applyPhase2IssueMigration({
        expected: { eligible: 1, issueGroups: 1, legacyUngrouped: 0 },
      }),
      (error) => error.code === "PHASE2_ISSUE_MIGRATION_COUNT_MISMATCH",
      scenario.label
    );
    assert.equal(await Issue.countDocuments({}), 0, scenario.label);
    let signal = await Signal.findOne({ report_run_id: run._id });
    assert.equal(signal.issue_id, null, scenario.label);
    assert.equal(signal.issue_matching_status, null, scenario.label);

    const result = await applyPhase2IssueMigration({
      expected: { eligible: 0, issueGroups: 0, legacyUngrouped: 1 },
    });
    assert.equal(result.processedSignals, 0, scenario.label);
    assert.equal(result.legacyUngrouped, 1, scenario.label);
    assert.equal(await Issue.countDocuments({}), 0, scenario.label);
    signal = await Signal.findOne({ report_run_id: run._id });
    assert.equal(signal.issue_id, null, scenario.label);
    assert.equal(signal.issue_matching_status, "legacy_ungrouped", scenario.label);
    assert.equal(signal.issue_matching_reason, "legacy_ungrouped", scenario.label);
    const persistedRun = await ReportRun.findById(run._id);
    assert.equal(persistedRun.issue_processing, undefined, scenario.label);
  }
});

test("migration treats ownership contradictions as integrity failures before mutation", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  const foreignClient = await Client.create({
    agency_id: domain.agency._id,
    name: "Migration foreign client",
    status: "stable",
  });
  await MetaAdAccount.updateOne(
    { _id: domain.account._id },
    { $set: { client_id: foreignClient._id } }
  );

  await assert.rejects(
    inspectPhase2IssueMigration(),
    (error) => error.code === "ISSUE_SCOPE_OWNERSHIP_CONFLICT"
  );
  assert.equal(await Issue.countDocuments({}), 0);
  const signal = await Signal.findOne({ report_run_id: run._id });
  assert.equal(signal.issue_id, null);
  assert.equal(signal.issue_matching_status, null);
  const persistedRun = await ReportRun.findById(run._id);
  assert.equal(persistedRun.issue_processing, undefined);
});

test("migration replay revalidates authority transactionally after inspection", async () => {
  const domain = await createDomain();
  const run = await createRun(domain, { start: "2026-07-10" });
  const inspection = await inspectPhase2IssueMigration();
  assert.equal(inspection.counts.eligible, 1);
  assert.equal(inspection.counts.issueGroups, 1);
  assert.equal(inspection.counts.legacyUngrouped, 0);
  let transactionCalls = 0;

  await assert.rejects(
    applyPhase2IssueMigration({
      expected: { eligible: 1, issueGroups: 1, legacyUngrouped: 0 },
      transactionRunner: async (options) => {
        transactionCalls += 1;
        await MetaConnection.updateOne(
          { _id: domain.connection._id },
          { $set: { status: "revoked", is_active: true } }
        );
        return runRequiredTransaction(options);
      },
    }),
    (error) =>
      error.code === "PHASE2_ISSUE_MIGRATION_AUTHORITY_CHANGED" &&
      error.reason === "workspace_meta_reconnect_required"
  );
  assert.equal(transactionCalls, 1);
  assert.equal(await Issue.countDocuments({}), 0);
  const signal = await Signal.findOne({ report_run_id: run._id });
  assert.equal(signal.issue_id, null);
  assert.equal(signal.issue_matching_status, null);
  const persistedRun = await ReportRun.findById(run._id);
  assert.equal(persistedRun.issue_processing, undefined);
});

test("Issue readiness failures block delivery while ordinary ineligibility remains deliverable", async () => {
  resetPhase2IssueIntegrityReadiness();
  const domain = await createDomain();
  const blockedRun = await createRun(domain, { start: "2026-07-10" });
  let dispatches = 0;
  const deliveryProcessor = async () => {
    dispatches += 1;
    return { reportRun: await ReportRun.findById(blockedRun._id) };
  };

  await assert.rejects(
    processReportRunIssuesBeforeDelivery({
      reportRunId: blockedRun._id,
      deliveryProcessor,
    }),
    (error) => error.code === "ISSUE_INDEXES_NOT_READY"
  );
  assert.equal(dispatches, 0);
  assert.equal(await Issue.countDocuments({}), 0);
  assert.equal(await Signal.countDocuments({ issue_id: { $type: "objectId" } }), 0);

  const emptyCollection = { listIndexes: () => ({ toArray: async () => [] }) };
  const missing = await initializePhase2IssueIntegrity({
    collections: { issues: emptyCollection, signals: emptyCollection },
  });
  assert.equal(missing.state, "blocked");
  await assert.rejects(
    processReportRunIssuesBeforeDelivery({
      reportRunId: blockedRun._id,
      deliveryProcessor,
    }),
    (error) => error.code === "ISSUE_INDEXES_NOT_READY"
  );
  assert.equal(dispatches, 0);

  const conflictingCollection = {
    listIndexes: () => ({
      toArray: async () => [
        {
          name: "phase2_issues_active_identity_unique",
          key: { wrong: 1 },
          unique: true,
        },
        {
          name: "phase2_signals_issue_occurrence_unique",
          key: { wrong: 1 },
          unique: true,
        },
      ],
    }),
  };
  const conflicting = await initializePhase2IssueIntegrity({
    collections: { issues: conflictingCollection, signals: conflictingCollection },
  });
  assert.equal(conflicting.state, "blocked");
  await assert.rejects(
    processReportRunIssuesBeforeDelivery({
      reportRunId: blockedRun._id,
      deliveryProcessor,
    }),
    (error) => error.code === "ISSUE_INDEXES_NOT_READY"
  );
  assert.equal(dispatches, 0);

  const ready = await initializePhase2IssueIntegrity({
    collections: { issues: Issue.collection, signals: Signal.collection },
  });
  assert.equal(ready.state, "ready");
  const ordinaryRun = await createRun(domain, { start: "2026-07-11" });
  await Signal.updateOne(
    { report_run_id: ordinaryRun._id },
    {
      $set: {
        type: "stable_performance",
        "metadata.archetype_id": "stable_performance",
      },
    }
  );
  let deliveryCalls = 0;
  const deliveryCallsByRun = [];
  const deliveryProcessorForOrdinaryRun = async ({ reportRunId }) => {
    deliveryCalls += 1;
    deliveryCallsByRun.push(String(reportRunId));
    return { reportRun: await ReportRun.findById(reportRunId) };
  };
  await processReportRunIssuesBeforeDelivery({
    reportRunId: ordinaryRun._id,
    deliveryProcessor: deliveryProcessorForOrdinaryRun,
  });
  assert.equal(deliveryCalls, 1);
  assert.deepEqual(deliveryCallsByRun, [String(ordinaryRun._id)]);
  assert.equal(
    (await ReportRun.findById(ordinaryRun._id)).issue_processing.status,
    "not_applicable"
  );
});

test("runReport blocks delivery on Issue integrity failure and remains retry-safe", async () => {
  const domain = await createDomain();
  const persisted = await createPersistedRunnerRun(domain, { negative: true });
  const foreignClient = await Client.create({
    agency_id: domain.agency._id,
    name: "Run integrity foreign client",
    status: "stable",
  });
  await MetaAdAccount.updateOne(
    { _id: domain.account._id },
    { $set: { client_id: foreignClient._id } }
  );

  const originalFetch = globalThis.fetch;
  const originalWebhook = globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL;
  let dispatchCalls = 0;
  const dispatchLog = [];
  globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL =
    "https://n8n.example.com/webhook/phase2-integrity-test";
  globalThis.fetch = async (...args) => {
    dispatchCalls += 1;
    dispatchLog.push(args);
    return { ok: true, status: 200 };
  };

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        runReport(domain.report._id, {
          force: true,
          triggerType: "manual",
          executionKey: persisted.executionKey,
          agencyId: domain.agency._id,
          userId: domain.report.created_by,
          now: persisted.now,
        }),
        (error) => error.code === "ISSUE_SCOPE_OWNERSHIP_CONFLICT"
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) {
      delete globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL;
    } else {
      globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhook;
    }
  }

  assert.equal(dispatchCalls, 0);
  assert.deepEqual(dispatchLog, []);
  assert.equal(await ReportRun.countDocuments({ execution_key: persisted.executionKey }), 1);
  assert.equal(await Issue.countDocuments({}), 0);
  assert.equal(await Signal.countDocuments({ report_run_id: persisted.reportRun._id }), 1);
  assert.equal(
    await Signal.countDocuments({
      report_run_id: persisted.reportRun._id,
      issue_id: { $type: "objectId" },
    }),
    0
  );

  const signal = await Signal.findOne({ report_run_id: persisted.reportRun._id });
  assert.equal(signal.issue_id, null);
  assert.equal(signal.issue_matching_status, "failed");
  assert.equal(signal.issue_matching_reason, "ownership_conflict");
  const reportRun = await ReportRun.findById(persisted.reportRun._id);
  assert.equal(reportRun.issue_processing.status, "failed_integrity");
  assert.equal(reportRun.issue_processing.result_classification, "failed_integrity");
  assert.equal(reportRun.issue_processing.failure_code, "ISSUE_SCOPE_OWNERSHIP_CONFLICT");
  assert.equal(reportRun.issue_processing.issue_id, null);
  assert.equal(reportRun.issue_processing.attempts, 1);
  assert.equal(reportRun.execution_stage, "failed");
  assert.equal(reportRun.failure.stage, "issues");
  assert.equal(reportRun.failure.code, "ISSUE_SCOPE_OWNERSHIP_CONFLICT");
  assert.equal(reportRun.internal_report.status, "generated");
  assert.equal(reportRun.internal_report.sent_at, null);
  assert.equal(reportRun.internal_report.dispatch.status, "pending");
  assert.equal(reportRun.internal_report.dispatch.attempt_count, 0);
  assert.equal(reportRun.internal_report.dispatch.sent_at, null);
  assert.equal(
    reportRun.internal_report.dispatch.idempotency_key,
    persisted.deliveryKey
  );
  const report = await Report.findById(domain.report._id);
  assert.equal(report.execution_lock, undefined);
});

test("runReport delivers ordinary not-applicable processing exactly once across idempotent replay", async () => {
  const domain = await createDomain();
  const persisted = await createPersistedRunnerRun(domain, { negative: false });
  const originalFetch = globalThis.fetch;
  const originalWebhook = globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL;
  let dispatchCalls = 0;
  const dispatchLog = [];
  globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL =
    "https://n8n.example.com/webhook/phase2-idempotency-test";
  globalThis.fetch = async (url, options) => {
    dispatchCalls += 1;
    dispatchLog.push({
      url,
      method: options.method,
      idempotencyKey: options.headers["x-idempotency-key"],
      body: JSON.parse(options.body),
    });
    return { ok: true, status: 200 };
  };

  let firstResult;
  let replayResult;
  try {
    firstResult = await runReport(domain.report._id, {
      force: true,
      triggerType: "manual",
      executionKey: persisted.executionKey,
      agencyId: domain.agency._id,
      userId: domain.report.created_by,
      now: persisted.now,
    });
    replayResult = await runReport(domain.report._id, {
      force: true,
      triggerType: "manual",
      executionKey: persisted.executionKey,
      agencyId: domain.agency._id,
      userId: domain.report.created_by,
      now: persisted.now,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) {
      delete globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL;
    } else {
      globalThis.process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhook;
    }
  }

  assert.equal(firstResult.skipped, false);
  assert.equal(replayResult.skipped, true);
  assert.equal(replayResult.reason, "execution_already_completed");
  assert.equal(dispatchCalls, 1);
  assert.equal(dispatchLog.length, 1);
  assert.equal(
    dispatchLog[0].url,
    "https://n8n.example.com/webhook/phase2-idempotency-test"
  );
  assert.equal(dispatchLog[0].method, "POST");
  assert.equal(dispatchLog[0].idempotencyKey, persisted.deliveryKey);
  assert.equal(dispatchLog[0].body.idempotency_key, persisted.deliveryKey);
  assert.equal(dispatchLog[0].body.reportType, "internal_report");
  assert.deepEqual(dispatchLog[0].body.recipients, ["team@example.com"]);

  assert.equal(await ReportRun.countDocuments({ execution_key: persisted.executionKey }), 1);
  assert.equal(await Issue.countDocuments({}), 0);
  assert.equal(await Signal.countDocuments({ report_run_id: persisted.reportRun._id }), 0);
  const reportRun = await ReportRun.findById(persisted.reportRun._id);
  assert.equal(reportRun.issue_processing.status, "not_applicable");
  assert.equal(reportRun.issue_processing.result_classification, "not_applicable");
  assert.equal(reportRun.issue_processing.issue_id, null);
  assert.equal(reportRun.issue_processing.attempts, 1);
  assert.equal(reportRun.execution_stage, "completed");
  assert.ok(reportRun.completed_at instanceof Date);
  assert.equal(reportRun.failure, null);
  assert.equal(reportRun.internal_report.status, "sent");
  assert.ok(reportRun.internal_report.sent_at instanceof Date);
  assert.equal(reportRun.internal_report.dispatch.status, "sent");
  assert.equal(reportRun.internal_report.dispatch.attempt_count, 1);
  assert.ok(reportRun.internal_report.dispatch.sent_at instanceof Date);
  assert.equal(
    reportRun.internal_report.dispatch.idempotency_key,
    persisted.deliveryKey
  );
  assert.deepEqual(
    reportRun.internal_report.recipients.map(({ email, status }) => ({ email, status })),
    [{ email: "team@example.com", status: "sent" }]
  );
  assert.equal(reportRun.client_report.dispatch.status, "not_required");
  assert.equal(reportRun.client_report.dispatch.attempt_count, 0);
  assert.equal(
    await Activity.countDocuments({
      idempotency_key: `report-run:${persisted.reportRun._id}:executed`,
    }),
    1
  );
  const report = await Report.findById(domain.report._id);
  assert.equal(report.execution_lock, undefined);
});
