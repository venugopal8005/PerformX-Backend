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
  WorkspaceMember,
} from "../src/models/index.js";
import {
  getArchivedClients,
  getClientHistory,
} from "../src/controllers/clients.controller.js";
import {
  getArchivedReports,
  getReport,
  getReportHistory,
  getReports,
} from "../src/controllers/reports.controller.js";
import {
  getHistoricalArtifact,
  getHistoricalReportRun,
  getHistoricalReportRuns,
} from "../src/controllers/reportRuns.controller.js";
import { getSignals } from "../src/controllers/signals.controller.js";
import { getActivities } from "../src/controllers/activities.controller.js";
import { refreshMetaAdAccountCampaigns } from "../src/controllers/settings.controller.js";
import { requireWorkspaceMember } from "../src/middlewares/workspaceAccess.js";

let replicaSet;

const HOSTILE_HISTORY_VALUES = [
  "SECRET_EXECUTION_KEY",
  "SECRET_TOKEN",
  "SECRET_REFRESH_TOKEN",
  "SECRET_PROVIDER_TOKEN",
  "SECRET_DISPATCH_CLAIM",
  "SECRET_STACK_TRACE",
  "/secret/filesystem/path",
  "SECRET_QUERY_OPERATOR",
  "RAW_ROW_TOKEN",
  "RAW_ROW_DEBUG",
  "ENGINE_SECRET",
  "SECRET_ROW",
  "DATA_QUALITY_SECRET",
  "SIGNAL_SECRET",
  "ACTIVITY_SECRET",
  "PROVIDER_SECRET_ERROR",
  "FOREIGN_WORKSPACE_ACTOR_SECRET",
  "LEGACY_CLIENT_BODY_SECRET",
  "LEGACY_INTERNAL_BODY_SECRET",
];

const hostileNestedPayload = () =>
  JSON.parse(`{
    "access_token": "SECRET_TOKEN",
    "refresh_token": "SECRET_REFRESH_TOKEN",
    "stack": "SECRET_STACK_TRACE /secret/filesystem/path",
    "providerError": {
      "message": "PROVIDER_SECRET_ERROR",
      "response": { "token": "SECRET_PROVIDER_TOKEN" }
    },
    "dispatch": { "claim_token": "SECRET_DISPATCH_CLAIM" },
    "raw_rows": [{ "token": "RAW_ROW_TOKEN", "debug": "RAW_ROW_DEBUG" }],
    "debug": { "secret": "ENGINE_SECRET" },
    "__proto__": { "polluted": true },
    "constructor": { "prototype": { "polluted": true } },
    "prototype": { "polluted": true },
    "$where": "SECRET_QUERY_OPERATOR"
  }`);

const assertHostileValuesExcluded = (payload) => {
  const serialized = JSON.stringify(payload);
  for (const secret of HOSTILE_HISTORY_VALUES) {
    assert.equal(serialized.includes(secret), false, `${secret} escaped historical serialization`);
  }
};

const collectCursorPages = async (loadPage, itemsKey) => {
  const ids = [];
  let cursor;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const result = response();
    await loadPage(cursor, result);
    assert.equal(result.statusCode, 200);
    const items = result.payload[itemsKey];
    assert.equal(items.length <= 1, true);
    for (const item of items) {
      assert.equal(ids.includes(item.id), false, `Duplicate ${itemsKey} cursor item ${item.id}`);
      ids.push(item.id);
    }
    if (!result.payload.page.hasMore) {
      assert.equal(result.payload.page.nextCursor, null);
      return ids;
    }
    assert.ok(result.payload.page.nextCursor);
    cursor = result.payload.page.nextCursor;
  }
  assert.fail(`${itemsKey} cursor did not terminate`);
};

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

const requestFor = (domain, overrides = {}) => ({
  user: { id: domain.user._id, agencyId: domain.agency._id },
  query: {},
  params: {},
  body: {},
  ...overrides,
});

const contextSnapshot = ({ clientName, reportName, actorName = "History Owner" }) => ({
  version: 1,
  captured_at: new Date("2026-07-10T10:00:00.000Z"),
  source: "execution",
  workspace: { name: "Historical Agency" },
  client: { name: clientName },
  report: {
    name: reportName,
    configuration: {
      type: "daily",
      schedule: { timezone: "UTC", time_of_day: "09:00" },
      client_delivery_mode: "approval_required",
      generate_client_report: true,
      generate_internal_report: true,
    },
  },
  actor: { name: actorName },
});

const signalSnapshot = ({ clientName, reportName, accountId }) => ({
  version: 1,
  captured_at: new Date("2026-07-10T10:05:00.000Z"),
  source: "execution",
  workspace: { name: "Historical Agency" },
  client: { name: clientName },
  report: { name: reportName },
  meta_account: {
    meta_ad_account_id: accountId,
    external_account_id: "act_history",
    name: "Historical Meta",
  },
  campaigns: [{ campaign_id: "campaign-1", campaign_name: "Launch" }],
});

const createDomain = async ({ suffix = "one" } = {}) => {
  const agency = await Agency.create({
    name: `Historical Agency ${suffix}`,
    slug: `historical-agency-${suffix}`,
  });
  const user = await User.create({
    agency_id: agency._id,
    full_name: "History Owner",
    email: `history-owner-${suffix}@example.com`,
    role: "owner",
  });
  agency.created_by = user._id;
  await agency.save();
  await WorkspaceMember.create({
    workspace_id: agency._id,
    user_id: user._id,
    role: "owner",
    status: "active",
  });
  const activeClient = await Client.create({
    agency_id: agency._id,
    name: `Active Client ${suffix}`,
    status: "stable",
  });
  const archivedAt = new Date("2026-07-12T12:00:00.000Z");
  const archivedClient = await Client.create({
    agency_id: agency._id,
    name: `Archived Client ${suffix}`,
    status: "moderate",
    is_archived: true,
    archived_at: archivedAt,
    archived_by: user._id,
  });
  const connection = await MetaConnection.create({
    agency_id: agency._id,
    connection_scope: "workspace",
    access_token: "never-read-test-token",
    status: "active",
    is_active: true,
  });
  const account = await MetaAdAccount.create({
    agency_id: agency._id,
    meta_connection_id: connection._id,
    client_id: archivedClient._id,
    assignment_scope: "v1",
    ad_account_id: `act_history_${suffix}`,
    name: "Current Meta Name",
    is_active: true,
    is_accessible: true,
  });
  const report = await Report.create({
    agency_id: agency._id,
    client_id: archivedClient._id,
    meta_ad_account_id: account._id,
    meta_account_external_id_snapshot: "act_history",
    meta_account_name_snapshot: "Historical Meta",
    created_by: user._id,
    name: `Archived Report ${suffix}`,
    type: "daily",
    status: "paused",
    severity: "medium",
    is_archived: true,
    archived_at: archivedAt,
    archived_by: user._id,
    internal_recipients: ["team@example.com"],
    client_recipients: ["client@example.com"],
    client_delivery_mode: "approval_required",
    monitored_campaigns: [
      { campaign_id: "campaign-1", campaign_name: "Current Campaign Name" },
    ],
    schedule: { timezone: "UTC", time_of_day: "09:00" },
  });
  const sameTimestamp = new Date("2026-07-11T10:00:00.000Z");
  const runs = await ReportRun.create([
    {
      agency_id: agency._id,
      client_id: archivedClient._id,
      report_id: report._id,
      meta_ad_account_id: account._id,
      meta_account_external_id_snapshot: "act_history",
      meta_account_name_snapshot: "Historical Meta",
      context_snapshot: contextSnapshot({
        clientName: "Snapshot Client Name",
        reportName: "Snapshot Report Name",
      }),
      execution_key: `manual:${report._id}:secret-one`,
      trigger_type: "manual",
      execution_stage: "completed",
      status: "ok",
      severity: "medium",
      summary: "Persisted summary",
      decision: "Keep spend steady",
      comparison: {
        ...hostileNestedPayload(),
        mode: "scheduled_window",
        period: {
          ...hostileNestedPayload(),
          current: { start: "2026-07-01", end: "2026-07-07" },
          raw_rows: ["SECRET_ROW"],
        },
        currentPeriodMetrics: {
          ...hostileNestedPayload(),
          spend: 100,
          clicks: 20,
          raw_rows: [{ access_token: "RAW_ROW_TOKEN", debug: "RAW_ROW_DEBUG" }],
        },
        previousPeriodMetrics: { spend: 90, clicks: 18 },
        deltas: { spend: 11.11, spend_change_percent: 11.11 },
        rowCounts: {
          current: 1,
          previous: 1,
          providerError: { message: "PROVIDER_SECRET_ERROR" },
        },
        rawRows: [{ secretRawMetaRow: true }],
      },
      narrative: {
        ...hostileNestedPayload(),
        status: "ok",
        executiveSummary: "Persisted narrative",
        decision: "Keep spend steady",
        dataQuality: {
          ...hostileNestedPayload(),
          level: "usable",
          warnings: ["Public warning"],
          providerError: { secret: "DATA_QUALITY_SECRET" },
        },
        trustGate: {
          ...hostileNestedPayload(),
          level: "medium",
          blocked: false,
          reasons: ["Public trust reason"],
          providerResponse: { access_token: "SECRET_TOKEN" },
        },
        userInsight: {
          ...hostileNestedPayload(),
          headline: "Public headline",
          decisionBrief: {
            ...hostileNestedPayload(),
            decision: "hold",
            primaryAction: "Keep spend steady",
            debug: { secret: "ENGINE_SECRET" },
          },
          debug: { secret: "ENGINE_SECRET" },
        },
        metrics: {
          ...hostileNestedPayload(),
          current: { spend: 100, raw_rows: ["RAW_ROW_DEBUG"] },
          previous: { spend: 90 },
          deltas: { spend: 11.11 },
          providerError: { message: "PROVIDER_SECRET_ERROR" },
        },
        debug: { secret: "ENGINE_SECRET" },
      },
      engine_output: { debug: { secret: "ENGINE_SECRET" } },
      internal_report: {
        status: "sent",
        subject: "INTERNAL SUBJECT",
        html: "<p>INTERNAL ONLY</p>",
        text: "INTERNAL ONLY",
        sent_at: sameTimestamp,
        recipients: [
          { email: "team@example.com", status: "failed", error: "PROVIDER_SECRET_ERROR" },
        ],
        delivery_error: {
          code: "provider_failed",
          category: "response",
          message: "PROVIDER_SECRET_ERROR",
        },
        dispatch: {
          idempotency_key: "internal-secret-key",
          status: "sent",
          attempt_count: 1,
          sent_at: sameTimestamp,
        },
      },
      client_report: {
        status: "sent",
        delivery_mode: "approval_required",
        subject: "CLIENT SUBJECT",
        html: "<p>CLIENT ONLY</p>",
        text: "CLIENT ONLY",
        sent_at: sameTimestamp,
        recipients: [
          { email: "client@example.com", status: "failed", error: "PROVIDER_SECRET_ERROR" },
        ],
        delivery_error: {
          code: "provider_failed",
          category: "response",
          message: "PROVIDER_SECRET_ERROR",
        },
        dispatch: {
          idempotency_key: "client-secret-key",
          status: "sent",
          attempt_count: 1,
          sent_at: sameTimestamp,
        },
        safety: { passed: true, reasons: [], warnings: ["Stored warning"] },
      },
      ran_at: sameTimestamp,
    },
    {
      agency_id: agency._id,
      client_id: archivedClient._id,
      report_id: report._id,
      meta_ad_account_id: account._id,
      meta_account_external_id_snapshot: "act_history",
      meta_account_name_snapshot: "Historical Meta",
      context_snapshot: contextSnapshot({
        clientName: "Older Snapshot Client",
        reportName: "Older Snapshot Report",
      }),
      execution_key: `manual:${report._id}:secret-two`,
      trigger_type: "manual",
      execution_stage: "completed",
      status: "ok",
      severity: "low",
      ran_at: sameTimestamp,
    },
  ]);
  const signal = await Signal.create({
    agency_id: agency._id,
    client_id: archivedClient._id,
    report_id: report._id,
    report_run_id: runs[0]._id,
    context_snapshot: signalSnapshot({
      clientName: "Snapshot Client Name",
      reportName: "Snapshot Report Name",
      accountId: account._id,
    }),
    type: "metric_anomaly",
    severity: "moderate",
    title: "Stored signal",
    description: "Stored evidence",
    recommendation: "Review the persisted result",
    metadata: {
      ...hostileNestedPayload(),
      decision: "Review",
      current_metrics: {
        clicks: 20,
        raw_rows: ["SIGNAL_SECRET"],
        providerError: { message: "PROVIDER_SECRET_ERROR" },
      },
      provider_error: "must-not-escape",
    },
    detected_at: sameTimestamp,
  });
  const activity = await Activity.create({
    agency_id: agency._id,
    client_id: archivedClient._id,
    report_id: report._id,
    user_id: user._id,
    type: "report_archived",
    title: "Archived report recorded",
    description: "History retained",
    severity: "stable",
    metadata: {
      ...hostileNestedPayload(),
      report_id: report._id,
      report_name: report.name,
      decision: { providerError: "ACTIVITY_SECRET" },
      provider_error: "must-not-escape",
    },
  });

  await ReportRun.collection.updateOne(
    { _id: runs[0]._id },
    {
      $set: {
        execution_token: "SECRET_TOKEN",
        execution_lock: { token: "SECRET_TOKEN", claim: "SECRET_EXECUTION_KEY" },
        delivery_idempotency_key: "SECRET_EXECUTION_KEY",
        provider_response: {
          message: "PROVIDER_SECRET_ERROR",
          response: {
            access_token: "SECRET_TOKEN",
            refresh_token: "SECRET_REFRESH_TOKEN",
            token: "SECRET_PROVIDER_TOKEN",
            stack: "SECRET_STACK_TRACE /secret/filesystem/path",
            $where: "SECRET_QUERY_OPERATOR",
          },
        },
        "internal_report.dispatch.claim_token": "SECRET_DISPATCH_CLAIM",
        "client_report.dispatch.claim_token": "SECRET_DISPATCH_CLAIM",
        "context_snapshot.report.configuration.debug": {
          secret: "ENGINE_SECRET",
        },
      },
    }
  );

  return {
    agency,
    user,
    activeClient,
    archivedClient,
    connection,
    account,
    report,
    runs,
    signal,
    activity,
  };
};

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replicaSet.getUri(), {
    dbName: `narrative_phase1e_${Date.now()}`,
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
    WorkspaceMember.init(),
  ]);
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
    WorkspaceMember.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await replicaSet?.stop();
}, { timeout: 30_000 });

test("archived Client list and history are scoped, counted, and deterministically paginated", async () => {
  const domain = await createDomain({ suffix: "clients" });
  const second = await Client.create({
    agency_id: domain.agency._id,
    name: "Second Archived Client",
    status: "stable",
    is_archived: true,
    archived_at: domain.archivedClient.archived_at,
    archived_by: new mongoose.Types.ObjectId(),
  });

  const firstPage = response();
  await getArchivedClients(requestFor(domain, { query: { limit: "1" } }), firstPage);
  assert.equal(firstPage.statusCode, 200);
  assert.equal(firstPage.payload.clients.length, 1);
  assert.equal(firstPage.payload.page.hasMore, true);
  assert.ok(firstPage.payload.page.nextCursor);

  const secondPage = response();
  await getArchivedClients(
    requestFor(domain, {
      query: { limit: "1", cursor: firstPage.payload.page.nextCursor },
    }),
    secondPage
  );
  assert.equal(secondPage.payload.clients.length, 1);
  assert.notEqual(secondPage.payload.clients[0].id, firstPage.payload.clients[0].id);
  assert.deepEqual(
    new Set([firstPage.payload.clients[0].id, secondPage.payload.clients[0].id]),
    new Set([String(domain.archivedClient._id), String(second._id)])
  );

  const history = response();
  await getClientHistory(
    requestFor(domain, { params: { clientId: domain.archivedClient._id } }),
    history
  );
  assert.equal(history.payload.client.is_archived, true);
  assert.equal(history.payload.counts.reports, 1);
  assert.equal(history.payload.counts.archivedReports, 1);
  assert.equal(history.payload.counts.reportRuns, 2);
  assert.equal(history.payload.counts.signals, 1);
  assert.equal(history.payload.counts.activities, 1);
  assert.equal(history.payload.capabilities.liveMeta, false);

  const activeHistory = response();
  await getClientHistory(
    requestFor(domain, { params: { clientId: domain.activeClient._id } }),
    activeHistory
  );
  assert.equal(activeHistory.payload.client.is_archived, false);

  const malformed = response();
  await getClientHistory(
    requestFor(domain, { params: { clientId: "not-an-object-id" } }),
    malformed
  );
  assert.equal(malformed.statusCode, 404);
  assert.equal(malformed.payload.code, "HISTORY_RECORD_NOT_FOUND");
});

test("archived Report history is snapshot-first, paginated, and excludes raw internals", async () => {
  const domain = await createDomain({ suffix: "reports" });
  const hostileFixture = await ReportRun.collection.findOne({ _id: domain.runs[0]._id });
  const rawFixture = JSON.stringify(hostileFixture);
  for (const requiredValue of [
    "SECRET_REFRESH_TOKEN",
    "SECRET_PROVIDER_TOKEN",
    "SECRET_DISPATCH_CLAIM",
    "SECRET_STACK_TRACE",
    "/secret/filesystem/path",
    "SECRET_QUERY_OPERATOR",
  ]) {
    assert.equal(rawFixture.includes(requiredValue), true, `${requiredValue} missing from fixture`);
  }
  assert.equal(Object.hasOwn(hostileFixture.comparison, "__proto__"), true);
  assert.equal(Object.hasOwn(hostileFixture.comparison, "constructor"), true);
  assert.equal(Object.hasOwn(hostileFixture.comparison, "prototype"), true);
  assert.equal(Object.hasOwn(hostileFixture.comparison, "$where"), true);
  domain.archivedClient.name = "Renamed Current Client";
  domain.report.name = "Renamed Current Report";
  await Promise.all([domain.archivedClient.save(), domain.report.save()]);

  const archived = response();
  await getArchivedReports(requestFor(domain, { query: {} }), archived);
  assert.equal(archived.payload.reports.length, 1);
  assert.notEqual(archived.payload.reports[0].client.name, "Renamed Current Client");
  assert.ok(
    ["Snapshot Client Name", "Older Snapshot Client"].includes(
      archived.payload.reports[0].client.name
    )
  );
  assert.equal(archived.payload.reports[0].metaAccount.name, "Historical Meta");
  assert.ok(
    ["Snapshot Report Name", "Older Snapshot Report"].includes(
      archived.payload.reports[0].name
    )
  );
  assert.equal(archived.payload.reports[0].identitySources.report, "snapshot");
  assert.equal(archived.payload.reports[0].reportRunCount, 2);

  const history = response();
  await getReportHistory(
    requestFor(domain, {
      params: { reportId: domain.report._id },
      query: { limit: "1" },
    }),
    history
  );
  assert.equal(history.statusCode, 200);
  assert.equal(history.payload.runs.length, 1);
  assert.equal(history.payload.signals.length, 1);
  assert.equal(history.payload.page.runs.hasMore, true);
  assert.notEqual(history.payload.report.client.name, "Renamed Current Client");
  assert.notEqual(history.payload.report.name, "Renamed Current Report");
  assert.equal(history.payload.report.identitySources.report, "snapshot");
  const serialized = JSON.stringify(history.payload);
  assert.equal(serialized.includes("secret-one"), false);
  assert.equal(serialized.includes("client-secret-key"), false);
  assert.equal(serialized.includes("secretRawMetaRow"), false);
  assert.equal(serialized.includes("must-not-escape"), false);
  assert.equal(serialized.includes("INTERNAL ONLY"), false);
  assertHostileValuesExcluded(history.payload);

  const malformedCursor = response();
  await getReportHistory(
    requestFor(domain, {
      params: { reportId: domain.report._id },
      query: { runsCursor: "not-a-cursor" },
    }),
    malformedCursor
  );
  assert.equal(malformedCursor.statusCode, 400);
  assert.equal(malformedCursor.payload.code, "INVALID_CURSOR");
});

test("ReportRun history supports archived and orphan evidence without mutable-parent authorization", async () => {
  const domain = await createDomain({ suffix: "runs" });

  const listOne = response();
  await getHistoricalReportRuns(
    requestFor(domain, {
      query: { reportId: domain.report._id, limit: "1" },
    }),
    listOne
  );
  const listTwo = response();
  await getHistoricalReportRuns(
    requestFor(domain, {
      query: {
        reportId: domain.report._id,
        limit: "1",
        cursor: listOne.payload.page.nextCursor,
      },
    }),
    listTwo
  );
  assert.equal(listOne.payload.runs.length, 1);
  assert.equal(listTwo.payload.runs.length, 1);
  assert.notEqual(listOne.payload.runs[0].id, listTwo.payload.runs[0].id);

  const allRuns = response();
  await getHistoricalReportRuns(
    requestFor(domain, { query: { reportId: domain.report._id } }),
    allRuns
  );
  const runWithArtifacts = allRuns.payload.runs.find(
    (run) => run.id === String(domain.runs[0]._id)
  );
  assert.deepEqual(runWithArtifacts.artifactAvailability, {
    client: true,
    internal: true,
  });
  assert.equal(JSON.stringify(runWithArtifacts).includes("CLIENT ONLY"), false);
  assert.equal(JSON.stringify(runWithArtifacts).includes("INTERNAL ONLY"), false);
  assertHostileValuesExcluded(runWithArtifacts);
  const runWithoutArtifacts = allRuns.payload.runs.find(
    (run) => run.id === String(domain.runs[1]._id)
  );
  assert.deepEqual(runWithoutArtifacts.artifactAvailability, {
    client: false,
    internal: false,
  });

  const detail = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: domain.runs[0]._id } }),
    detail
  );
  assert.equal(detail.payload.reportRun.client.name, "Snapshot Client Name");
  assert.deepEqual(detail.payload.reportRun.displayMetrics, { spend: 100, clicks: 20 });
  assert.deepEqual(detail.payload.reportRun.artifactAvailability, {
    client: true,
    internal: true,
  });
  assert.equal(detail.payload.reportRun.identitySources.client, "snapshot");
  assert.equal(detail.payload.reportRun.identitySources.report, "snapshot");
  assert.equal(detail.payload.reportRun.identitySources.metaAccount, "snapshot");
  assert.equal(detail.payload.reportRun.identityCompleteness, "complete");
  assert.equal(detail.payload.reportRun.narrative.executiveSummary, "Persisted narrative");
  assert.equal(detail.payload.reportRun.narrative.userInsight.headline, "Public headline");
  assert.equal(detail.payload.reportRun.comparison.currentPeriodMetrics.spend, 100);
  const detailText = JSON.stringify(detail.payload);
  assert.equal(detailText.includes("execution_key"), false);
  assert.equal(detailText.includes("idempotency_key"), false);
  assert.equal(detailText.includes("rawRows"), false);
  assert.equal(detailText.includes("CLIENT ONLY"), false);
  assert.equal(detailText.includes("INTERNAL ONLY"), false);
  assertHostileValuesExcluded(detail.payload);

  const detailWithoutArtifacts = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: domain.runs[1]._id } }),
    detailWithoutArtifacts
  );
  assert.deepEqual(detailWithoutArtifacts.payload.reportRun.artifactAvailability, {
    client: false,
    internal: false,
  });

  const orphanId = new mongoose.Types.ObjectId();
  const orphanClientId = new mongoose.Types.ObjectId();
  const orphanReportId = new mongoose.Types.ObjectId();
  await ReportRun.collection.insertOne({
    _id: orphanId,
    agency_id: domain.agency._id,
    client_id: orphanClientId,
    report_id: orphanReportId,
    context_snapshot: contextSnapshot({
      clientName: "Orphan Snapshot Client",
      reportName: "Orphan Snapshot Report",
    }),
    status: "ok",
    severity: "low",
    execution_stage: "completed",
    trigger_type: "manual",
    ran_at: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const orphan = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: orphanId } }),
    orphan
  );
  assert.equal(orphan.statusCode, 200);
  assert.equal(orphan.payload.reportRun.report.name, "Orphan Snapshot Report");
  assert.equal(orphan.payload.reportRun.identitySources.report, "snapshot");
  assert.equal(orphan.payload.reportRun.identityCompleteness, "partial");
});

test("artifact preview separates client and internal audiences and permits archived parents", async () => {
  const domain = await createDomain({ suffix: "artifacts" });

  const client = response();
  await getHistoricalArtifact(
    requestFor(domain, {
      params: { reportRunId: domain.runs[0]._id, audience: "client" },
    }),
    client
  );
  assert.equal(client.payload.artifact.audience, "client");
  assert.equal(client.payload.artifact.subject, "CLIENT SUBJECT");
  assert.equal(client.payload.artifact.html, "<p>CLIENT ONLY</p>");
  assert.equal(JSON.stringify(client.payload).includes("INTERNAL ONLY"), false);
  assert.equal(JSON.stringify(client.payload).includes("client-secret-key"), false);

  const internal = response();
  await getHistoricalArtifact(
    requestFor(domain, {
      params: { reportRunId: domain.runs[0]._id, audience: "internal" },
    }),
    internal
  );
  assert.equal(internal.payload.artifact.subject, "INTERNAL SUBJECT");
  assert.equal(internal.payload.artifact.html, "<p>INTERNAL ONLY</p>");
  assert.equal(JSON.stringify(internal.payload).includes("CLIENT ONLY"), false);

  const invalid = response();
  await getHistoricalArtifact(
    requestFor(domain, {
      params: { reportRunId: domain.runs[0]._id, audience: "notification" },
    }),
    invalid
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.payload.code, "INVALID_ARTIFACT_AUDIENCE");
});

test("legacy artifact availability recognizes body, status, and timestamp evidence without leaking bodies", async () => {
  const domain = await createDomain({ suffix: "legacy-artifact-availability" });
  const now = new Date("2026-07-13T12:00:00.000Z");
  const cases = [
    { key: "client-html", client_report: { html: "LEGACY_CLIENT_BODY_SECRET" } },
    { key: "client-text", client_report: { text: "LEGACY_CLIENT_BODY_SECRET" } },
    { key: "internal-html", internal_report: { html: "LEGACY_INTERNAL_BODY_SECRET" } },
    { key: "internal-text", internal_report: { text: "LEGACY_INTERNAL_BODY_SECRET" } },
    { key: "status-only", client_report: { status: "generated" } },
    { key: "timestamp-only", internal_report: { sent_at: now } },
    { key: "absent" },
    {
      key: "both",
      client_report: { html: "LEGACY_CLIENT_BODY_SECRET" },
      internal_report: { text: "LEGACY_INTERNAL_BODY_SECRET" },
    },
  ].map((item, index) => ({
    _id: new mongoose.Types.ObjectId(),
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    report_id: domain.report._id,
    status: "ok",
    severity: "low",
    execution_stage: "completed",
    trigger_type: "manual",
    ran_at: new Date(now.getTime() + index * 1000),
    createdAt: now,
    updatedAt: now,
    ...item,
  }));
  await ReportRun.collection.insertMany(cases);

  const listed = response();
  await getHistoricalReportRuns(
    requestFor(domain, { query: { reportId: domain.report._id } }),
    listed
  );
  const availabilityById = new Map(
    listed.payload.runs.map((run) => [run.id, run.artifactAvailability])
  );
  const availabilityFor = (key) =>
    availabilityById.get(String(cases.find((item) => item.key === key)._id));
  assert.deepEqual(availabilityFor("client-html"), { client: true, internal: false });
  assert.deepEqual(availabilityFor("client-text"), { client: true, internal: false });
  assert.deepEqual(availabilityFor("internal-html"), { client: false, internal: true });
  assert.deepEqual(availabilityFor("internal-text"), { client: false, internal: true });
  assert.deepEqual(availabilityFor("status-only"), { client: true, internal: false });
  assert.deepEqual(availabilityFor("timestamp-only"), { client: false, internal: true });
  assert.deepEqual(availabilityFor("absent"), { client: false, internal: false });
  assert.deepEqual(availabilityFor("both"), { client: true, internal: true });
  assert.equal(JSON.stringify(listed.payload).includes("LEGACY_CLIENT_BODY_SECRET"), false);
  assert.equal(JSON.stringify(listed.payload).includes("LEGACY_INTERNAL_BODY_SECRET"), false);

  const both = cases.find((item) => item.key === "both");
  const detail = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: both._id } }),
    detail
  );
  assert.deepEqual(detail.payload.reportRun.artifactAvailability, {
    client: true,
    internal: true,
  });
  assert.equal(JSON.stringify(detail.payload).includes("LEGACY_CLIENT_BODY_SECRET"), false);
  assert.equal(JSON.stringify(detail.payload).includes("LEGACY_INTERNAL_BODY_SECRET"), false);

  const clientArtifact = response();
  await getHistoricalArtifact(
    requestFor(domain, {
      params: { reportRunId: both._id, audience: "client" },
    }),
    clientArtifact
  );
  assert.equal(clientArtifact.payload.artifact.html, "LEGACY_CLIENT_BODY_SECRET");
  assert.equal(JSON.stringify(clientArtifact.payload).includes("LEGACY_INTERNAL_BODY_SECRET"), false);

  const internalArtifact = response();
  await getHistoricalArtifact(
    requestFor(domain, {
      params: { reportRunId: both._id, audience: "internal" },
    }),
    internalArtifact
  );
  assert.equal(internalArtifact.payload.artifact.text, "LEGACY_INTERNAL_BODY_SECRET");
  assert.equal(JSON.stringify(internalArtifact.payload).includes("LEGACY_CLIENT_BODY_SECRET"), false);
});

test("historical identity exposes snapshot, current-parent fallback, and unknown provenance", async () => {
  const domain = await createDomain({ suffix: "identity" });
  domain.archivedClient.name = "Mutable Client Fallback";
  domain.report.name = "Mutable Report Fallback";
  domain.account.name = "Mutable Meta Account";
  await Promise.all([
    domain.archivedClient.save(),
    domain.report.save(),
    domain.account.save(),
  ]);

  const fallbackRun = await ReportRun.create({
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    report_id: domain.report._id,
    meta_ad_account_id: domain.account._id,
    meta_account_external_id_snapshot: "act_fallback_snapshot",
    meta_account_name_snapshot: "Persisted Meta Snapshot",
    execution_key: `identity-fallback:${domain.report._id}`,
    trigger_type: "manual",
    execution_stage: "completed",
    status: "ok",
    severity: "low",
  });

  const fallbackDetail = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: fallbackRun._id } }),
    fallbackDetail
  );
  assert.equal(fallbackDetail.payload.reportRun.client.name, "Mutable Client Fallback");
  assert.equal(fallbackDetail.payload.reportRun.report.name, "Mutable Report Fallback");
  assert.equal(fallbackDetail.payload.reportRun.metaAccount.name, "Persisted Meta Snapshot");
  assert.deepEqual(fallbackDetail.payload.reportRun.identitySources, {
    agency: "unknown",
    client: "current_parent",
    report: "current_parent",
    metaAccount: "snapshot",
  });
  assert.equal(fallbackDetail.payload.reportRun.identityCompleteness, "partial");

  const unknownRunId = new mongoose.Types.ObjectId();
  await ReportRun.collection.insertOne({
    _id: unknownRunId,
    agency_id: domain.agency._id,
    client_id: new mongoose.Types.ObjectId(),
    report_id: new mongoose.Types.ObjectId(),
    status: "ok",
    severity: "low",
    execution_stage: "completed",
    trigger_type: "manual",
    ran_at: new Date("2026-07-09T00:00:00.000Z"),
    createdAt: new Date("2026-07-09T00:00:00.000Z"),
    updatedAt: new Date("2026-07-09T00:00:00.000Z"),
  });
  const unknownDetail = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: unknownRunId } }),
    unknownDetail
  );
  assert.equal(unknownDetail.payload.reportRun.client.name, null);
  assert.equal(unknownDetail.payload.reportRun.report.name, null);
  assert.deepEqual(unknownDetail.payload.reportRun.identitySources, {
    agency: "unknown",
    client: "unknown",
    report: "unknown",
    metaAccount: "unknown",
  });
  assert.equal(unknownDetail.payload.reportRun.identityCompleteness, "legacy_unknown");

  const listed = response();
  await getHistoricalReportRuns(
    requestFor(domain, { query: { reportId: domain.report._id } }),
    listed
  );
  const listedFallback = listed.payload.runs.find(
    (run) => run.id === String(fallbackRun._id)
  );
  assert.deepEqual(listedFallback.identitySources, fallbackDetail.payload.reportRun.identitySources);
  assert.equal(listedFallback.identityCompleteness, "partial");

  const currentMetaRun = await ReportRun.create({
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    report_id: domain.report._id,
    meta_ad_account_id: domain.account._id,
    execution_key: `identity-current-meta:${domain.report._id}`,
    trigger_type: "manual",
    execution_stage: "completed",
    status: "ok",
    severity: "low",
  });
  const currentMetaDetail = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: currentMetaRun._id } }),
    currentMetaDetail
  );
  assert.equal(currentMetaDetail.payload.reportRun.metaAccount.name, "Mutable Meta Account");
  assert.equal(
    currentMetaDetail.payload.reportRun.identitySources.metaAccount,
    "current_parent"
  );
  assert.equal(currentMetaDetail.payload.reportRun.identityCompleteness, "partial");
  const currentMetaList = response();
  await getHistoricalReportRuns(
    requestFor(domain, { query: { reportId: domain.report._id } }),
    currentMetaList
  );
  const listedCurrentMeta = currentMetaList.payload.runs.find(
    (run) => run.id === String(currentMetaRun._id)
  );
  assert.equal(listedCurrentMeta.metaAccount.name, "Mutable Meta Account");
  assert.equal(listedCurrentMeta.identitySources.metaAccount, "current_parent");
  assert.equal(listedCurrentMeta.identityCompleteness, "partial");

  const foreign = await createDomain({ suffix: "foreign-meta-identity" });
  const foreignMetaRunId = new mongoose.Types.ObjectId();
  await ReportRun.collection.insertOne({
    _id: foreignMetaRunId,
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    report_id: domain.report._id,
    meta_ad_account_id: foreign.account._id,
    status: "ok",
    severity: "low",
    execution_stage: "completed",
    trigger_type: "manual",
    ran_at: new Date(),
  });
  const foreignMetaDetail = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: foreignMetaRunId } }),
    foreignMetaDetail
  );
  assert.equal(foreignMetaDetail.payload.reportRun.metaAccount.name, null);
  assert.equal(foreignMetaDetail.payload.reportRun.identitySources.metaAccount, "unknown");

  const missingMetaRun = await ReportRun.create({
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    report_id: domain.report._id,
    meta_ad_account_id: new mongoose.Types.ObjectId(),
    execution_key: `identity-missing-meta:${domain.report._id}`,
    trigger_type: "manual",
    execution_stage: "completed",
    status: "ok",
    severity: "low",
  });
  const missingMetaDetail = response();
  await getHistoricalReportRun(
    requestFor(domain, { params: { reportRunId: missingMetaRun._id } }),
    missingMetaDetail
  );
  assert.equal(missingMetaDetail.payload.reportRun.metaAccount.name, null);
  assert.equal(missingMetaDetail.payload.reportRun.identitySources.metaAccount, "unknown");
});

test("Signal identity is snapshot-first and uses only same-agency current-parent fallbacks", async () => {
  const domain = await createDomain({ suffix: "signal-parent-fallback" });
  domain.archivedClient.name = "Renamed Signal Client";
  domain.report.name = "Renamed Signal Report";
  await Promise.all([domain.archivedClient.save(), domain.report.save()]);

  const fallbackSignal = await Signal.create({
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    report_id: domain.report._id,
    type: "metric_anomaly",
    severity: "moderate",
    title: "Fallback signal",
  });
  const foreign = await createDomain({ suffix: "foreign-signal-parent" });
  const foreignSignalId = new mongoose.Types.ObjectId();
  const missingSignalId = new mongoose.Types.ObjectId();
  await Signal.collection.insertMany([
    {
      _id: foreignSignalId,
      agency_id: domain.agency._id,
      client_id: foreign.archivedClient._id,
      report_id: foreign.report._id,
      type: "metric_anomaly",
      severity: "stable",
      title: "Foreign parent signal",
      detected_at: new Date(),
    },
    {
      _id: missingSignalId,
      agency_id: domain.agency._id,
      client_id: new mongoose.Types.ObjectId(),
      report_id: new mongoose.Types.ObjectId(),
      type: "metric_anomaly",
      severity: "stable",
      title: "Missing parent signal",
      detected_at: new Date(),
    },
  ]);

  const result = response();
  await getSignals(requestFor(domain), result);
  const byId = new Map(result.payload.signals.map((signal) => [signal.id, signal]));
  const snapshot = byId.get(String(domain.signal._id));
  assert.equal(snapshot.client.name, "Snapshot Client Name");
  assert.equal(snapshot.report.name, "Snapshot Report Name");
  assert.equal(snapshot.identitySources.client, "snapshot");
  assert.equal(snapshot.identitySources.report, "snapshot");

  const fallback = byId.get(String(fallbackSignal._id));
  assert.equal(fallback.client.name, "Renamed Signal Client");
  assert.equal(fallback.report.name, "Renamed Signal Report");
  assert.equal(fallback.identitySources.client, "current_parent");
  assert.equal(fallback.identitySources.report, "current_parent");
  assert.equal(fallback.identityCompleteness, "partial");

  const foreignResult = byId.get(String(foreignSignalId));
  assert.equal(foreignResult.client.name, null);
  assert.equal(foreignResult.report.name, null);
  assert.equal(foreignResult.identitySources.client, "unknown");
  assert.equal(foreignResult.identitySources.report, "unknown");

  const missing = byId.get(String(missingSignalId));
  assert.equal(missing.client.name, null);
  assert.equal(missing.report.name, null);
  assert.equal(missing.identityCompleteness, "legacy_unknown");
});

test("Report history resolves each Signal Client fallback from its own same-agency reference", async () => {
  const domain = await createDomain({ suffix: "report-signal-client-fallback" });
  domain.archivedClient.name = "Report Client B";
  await domain.archivedClient.save();

  const [signalClientA, renamedSnapshotClient, archivedSignalClient] = await Client.create([
    {
      agency_id: domain.agency._id,
      name: "Signal Client A",
      status: "stable",
    },
    {
      agency_id: domain.agency._id,
      name: "Renamed Signal Client",
      status: "stable",
    },
    {
      agency_id: domain.agency._id,
      name: "Archived Signal Client",
      status: "stable",
      is_archived: true,
      archived_at: new Date(),
    },
  ]);
  const foreignAgency = await Agency.create({
    name: "Foreign Signal Fallback Agency",
    slug: "foreign-signal-fallback-agency",
  });
  const foreignClient = await Client.create({
    agency_id: foreignAgency._id,
    name: "Foreign Signal Client Secret",
    status: "stable",
  });

  const [mismatchedSignal, snapshotSignal, archivedClientSignal] = await Signal.create([
    {
      agency_id: domain.agency._id,
      client_id: signalClientA._id,
      report_id: domain.report._id,
      type: "metric_anomaly",
      severity: "moderate",
      title: "Signal uses Client A",
    },
    {
      agency_id: domain.agency._id,
      client_id: renamedSnapshotClient._id,
      report_id: domain.report._id,
      context_snapshot: signalSnapshot({
        clientName: "Historical Signal Client",
        reportName: "Historical Signal Report",
        accountId: domain.account._id,
      }),
      type: "metric_anomaly",
      severity: "moderate",
      title: "Snapshot Client wins",
    },
    {
      agency_id: domain.agency._id,
      client_id: archivedSignalClient._id,
      report_id: domain.report._id,
      type: "metric_anomaly",
      severity: "moderate",
      title: "Archived Client fallback",
    },
  ]);
  const foreignSignalId = new mongoose.Types.ObjectId();
  const missingSignalId = new mongoose.Types.ObjectId();
  const nullSignalId = new mongoose.Types.ObjectId();
  await Signal.collection.insertMany([
    {
      _id: foreignSignalId,
      agency_id: domain.agency._id,
      client_id: foreignClient._id,
      report_id: domain.report._id,
      type: "metric_anomaly",
      severity: "stable",
      title: "Foreign Client reference",
      detected_at: new Date(),
    },
    {
      _id: missingSignalId,
      agency_id: domain.agency._id,
      client_id: new mongoose.Types.ObjectId(),
      report_id: domain.report._id,
      type: "metric_anomaly",
      severity: "stable",
      title: "Missing Client reference",
      detected_at: new Date(),
    },
    {
      _id: nullSignalId,
      agency_id: domain.agency._id,
      client_id: null,
      report_id: domain.report._id,
      type: "metric_anomaly",
      severity: "stable",
      title: "Null Client reference",
      detected_at: new Date(),
    },
  ]);

  const originalClientFind = Client.find;
  let batchFallbackQueries = 0;
  Client.find = function wrappedClientFind(filter, ...args) {
    if (filter?._id?.$in && String(filter.agency_id) === String(domain.agency._id)) {
      batchFallbackQueries += 1;
    }
    return originalClientFind.call(this, filter, ...args);
  };

  const result = response();
  try {
    await getReportHistory(
      requestFor(domain, { params: { reportId: domain.report._id }, query: {} }),
      result
    );
  } finally {
    Client.find = originalClientFind;
  }

  assert.equal(result.statusCode, 200);
  assert.equal(batchFallbackQueries, 1);
  const byId = new Map(result.payload.signals.map((signal) => [signal.id, signal]));

  const mismatched = byId.get(String(mismatchedSignal._id));
  assert.equal(mismatched.client.id, String(signalClientA._id));
  assert.equal(mismatched.client.name, "Signal Client A");
  assert.notEqual(mismatched.client.name, "Report Client B");
  assert.equal(mismatched.identitySources.client, "current_parent");
  assert.equal(mismatched.identityCompleteness, "partial");

  const snapshot = byId.get(String(snapshotSignal._id));
  assert.equal(snapshot.client.name, "Historical Signal Client");
  assert.equal(snapshot.identitySources.client, "snapshot");

  const archived = byId.get(String(archivedClientSignal._id));
  assert.equal(archived.client.id, String(archivedSignalClient._id));
  assert.equal(archived.client.name, "Archived Signal Client");
  assert.equal(archived.identitySources.client, "current_parent");

  const foreign = byId.get(String(foreignSignalId));
  assert.equal(foreign.client.id, String(foreignClient._id));
  assert.equal(foreign.client.name, null);
  assert.equal(foreign.identitySources.client, "unknown");
  assert.equal(JSON.stringify(result.payload).includes("Foreign Signal Client Secret"), false);

  const missing = byId.get(String(missingSignalId));
  assert.equal(missing.client.name, null);
  assert.equal(missing.identitySources.client, "unknown");

  const nullClient = byId.get(String(nullSignalId));
  assert.equal(nullClient.client.id, null);
  assert.equal(nullClient.client.name, null);
  assert.equal(nullClient.identitySources.client, "unknown");
  assert.deepEqual(Object.keys(result.payload).sort(), [
    "page",
    "report",
    "runs",
    "signals",
    "success",
  ]);
});

test("Signal and Activity history retain compatible arrays with additive cursors and filters", async () => {
  const domain = await createDomain({ suffix: "feeds" });
  await Signal.create({
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    report_id: domain.report._id,
    report_run_id: domain.runs[1]._id,
    type: "stable_performance",
    severity: "stable",
    title: "Second stored signal",
    detected_at: domain.signal.detected_at,
  });

  const signalPage = response();
  await getSignals(
    requestFor(domain, {
      query: { reportId: domain.report._id, limit: "1" },
    }),
    signalPage
  );
  assert.equal(Array.isArray(signalPage.payload.signals), true);
  assert.equal(signalPage.payload.page.hasMore, true);
  const filteredSignal = response();
  await getSignals(
    requestFor(domain, {
      query: { reportRunId: domain.runs[0]._id },
    }),
    filteredSignal
  );
  assert.equal(filteredSignal.payload.signals.length, 1);
  assert.equal(
    JSON.stringify(filteredSignal.payload).includes("must-not-escape"),
    false
  );
  assert.equal(filteredSignal.payload.signals[0].metadata.current_metrics.clicks, 20);
  assertHostileValuesExcluded(filteredSignal.payload);

  const activities = response();
  await getActivities(
    requestFor(domain, {
      query: {
        clientId: domain.archivedClient._id,
        actorId: domain.user._id,
        from: "2026-01-01T00:00:00.000Z",
        to: "2027-01-01T00:00:00.000Z",
      },
    }),
    activities
  );
  assert.equal(Array.isArray(activities.payload.activities), true);
  assert.equal(activities.payload.activities[0].actor.displayName, "History Owner");
  assert.ok(activities.payload.activities[0].display.icon.name);
  assert.equal(JSON.stringify(activities.payload).includes("must-not-escape"), false);
  assert.equal(activities.payload.activities[0].metadata.report_name, domain.report.name);
  assertHostileValuesExcluded(activities.payload);

  await User.deleteOne({ _id: domain.user._id });
  const removedActor = response();
  await getActivities(
    requestFor(domain, { query: { clientId: domain.archivedClient._id } }),
    removedActor
  );
  assert.equal(removedActor.payload.activities[0].actor, null);
});

test("Activity actor enrichment requires historical workspace membership and drives honest completeness", async () => {
  const domain = await createDomain({ suffix: "activity-actor-scope" });
  const removedActor = await User.create({
    agency_id: domain.agency._id,
    full_name: "Removed Historical Actor",
    email: "removed-history-actor@example.com",
    role: "member",
  });
  await WorkspaceMember.create({
    workspace_id: domain.agency._id,
    user_id: removedActor._id,
    role: "member",
    status: "removed",
    removed_at: new Date(),
  });
  const invitedOnly = await User.create({
    agency_id: domain.agency._id,
    full_name: "Invited Only Actor",
    email: "invited-history-actor@example.com",
    role: "member",
  });
  const foreignAgency = await Agency.create({
    name: "Foreign Actor Workspace",
    slug: "foreign-actor-workspace",
  });
  const foreignActor = await User.create({
    agency_id: foreignAgency._id,
    full_name: "FOREIGN_WORKSPACE_ACTOR_SECRET",
    email: "foreign-history-actor@example.com",
    role: "member",
  });
  const missingActorId = new mongoose.Types.ObjectId();

  const [completeActivity, removedActivity, invitedActivity, foreignActivity, missingActivity] =
    await Activity.create([
      {
        agency_id: domain.agency._id,
        client_id: domain.archivedClient._id,
        report_id: domain.report._id,
        user_id: domain.user._id,
        type: "report_executed",
        title: "Complete persisted activity identity",
        severity: "stable",
        metadata: {
          client_name: "Persisted Client Identity",
          report_name: "Persisted Report Identity",
        },
      },
      {
        agency_id: domain.agency._id,
        client_id: domain.archivedClient._id,
        user_id: removedActor._id,
        type: "client_updated",
        title: "Removed member activity",
        severity: "stable",
        metadata: { client_name: "Persisted Client Identity" },
      },
      {
        agency_id: domain.agency._id,
        client_id: domain.archivedClient._id,
        user_id: invitedOnly._id,
        type: "client_updated",
        title: "Invited-only activity",
        severity: "stable",
        metadata: { client_name: "Persisted Client Identity" },
      },
      {
        agency_id: domain.agency._id,
        client_id: domain.archivedClient._id,
        user_id: foreignActor._id,
        type: "client_updated",
        title: "Foreign actor activity",
        severity: "stable",
      },
      {
        agency_id: domain.agency._id,
        client_id: domain.archivedClient._id,
        user_id: missingActorId,
        type: "client_updated",
        title: "Missing actor activity",
        severity: "stable",
      },
    ]);

  const result = response();
  await getActivities(requestFor(domain, { query: { clientId: domain.archivedClient._id } }), result);
  const byId = new Map(result.payload.activities.map((activity) => [activity.id, activity]));

  const complete = byId.get(String(completeActivity._id));
  assert.equal(complete.actor.displayName, "History Owner");
  assert.equal(complete.actorSource, "workspace_member");
  assert.equal(complete.identitySources.client, "snapshot");
  assert.equal(complete.identitySources.report, "snapshot");
  assert.equal(complete.identityCompleteness, "complete");

  const removed = byId.get(String(removedActivity._id));
  assert.equal(removed.actor.displayName, "Removed Historical Actor");
  assert.equal(removed.actorSource, "workspace_member");
  assert.equal(removed.identityCompleteness, "complete");

  const invited = byId.get(String(invitedActivity._id));
  assert.equal(invited.actor, null);
  assert.equal(invited.actorSource, "unknown");
  assert.equal(invited.identityCompleteness, "partial");

  const foreign = byId.get(String(foreignActivity._id));
  assert.equal(foreign.actor, null);
  assert.equal(foreign.actorSource, "unknown");
  assert.equal(foreign.identityCompleteness, "legacy_unknown");

  const missing = byId.get(String(missingActivity._id));
  assert.equal(missing.actor, null);
  assert.equal(missing.identityCompleteness, "legacy_unknown");
  assert.equal(JSON.stringify(result.payload).includes("FOREIGN_WORKSPACE_ACTOR_SECRET"), false);
});

test("committed cursor regression covers equal and null or missing timestamps for every history model", async () => {
  const domain = await createDomain({ suffix: "null-cursors" });
  const equalTime = new Date("2026-07-08T08:00:00.000Z");
  const now = new Date("2026-07-08T09:00:00.000Z");

  const clientIds = [domain.archivedClient._id, ...Array.from({ length: 4 }, () => new mongoose.Types.ObjectId())];
  await Client.collection.insertMany([
    { _id: clientIds[1], agency_id: domain.agency._id, name: "Equal Client A", status: "stable", is_archived: true, archived_at: equalTime },
    { _id: clientIds[2], agency_id: domain.agency._id, name: "Equal Client B", status: "stable", is_archived: true, archived_at: equalTime },
    { _id: clientIds[3], agency_id: domain.agency._id, name: "Null Client", status: "stable", is_archived: true, archived_at: null },
    { _id: clientIds[4], agency_id: domain.agency._id, name: "Missing Client", status: "stable", is_archived: true },
  ]);

  const reportIds = [domain.report._id, ...Array.from({ length: 4 }, () => new mongoose.Types.ObjectId())];
  await Report.collection.insertMany([
    { _id: reportIds[1], agency_id: domain.agency._id, client_id: domain.archivedClient._id, name: "Equal Report A", type: "daily", status: "paused", severity: "low", is_archived: true, archived_at: equalTime },
    { _id: reportIds[2], agency_id: domain.agency._id, client_id: domain.archivedClient._id, name: "Equal Report B", type: "daily", status: "paused", severity: "low", is_archived: true, archived_at: equalTime },
    { _id: reportIds[3], agency_id: domain.agency._id, client_id: domain.archivedClient._id, name: "Null Report", type: "daily", status: "paused", severity: "low", is_archived: true, archived_at: null },
    { _id: reportIds[4], agency_id: domain.agency._id, client_id: domain.archivedClient._id, name: "Missing Report", type: "daily", status: "paused", severity: "low", is_archived: true },
  ]);

  const runIds = [
    ...domain.runs.map((run) => run._id),
    new mongoose.Types.ObjectId(),
    new mongoose.Types.ObjectId(),
  ];
  await ReportRun.collection.insertMany([
    { _id: runIds[2], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, status: "ok", severity: "low", execution_stage: "completed", trigger_type: "manual", ran_at: null, createdAt: now, updatedAt: now },
    { _id: runIds[3], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, status: "ok", severity: "low", execution_stage: "completed", trigger_type: "manual", createdAt: now, updatedAt: now },
  ]);

  const signalIds = [domain.signal._id, ...Array.from({ length: 3 }, () => new mongoose.Types.ObjectId())];
  await Signal.collection.insertMany([
    { _id: signalIds[1], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, type: "metric_anomaly", severity: "stable", title: "Equal Signal", detected_at: domain.signal.detected_at },
    { _id: signalIds[2], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, type: "metric_anomaly", severity: "stable", title: "Null Signal", detected_at: null },
    { _id: signalIds[3], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, type: "metric_anomaly", severity: "stable", title: "Missing Signal" },
  ]);

  const activityIds = [domain.activity._id, ...Array.from({ length: 4 }, () => new mongoose.Types.ObjectId())];
  await Activity.collection.insertMany([
    { _id: activityIds[1], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, type: "report_executed", severity: "stable", title: "Equal Activity A", createdAt: equalTime },
    { _id: activityIds[2], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, type: "report_executed", severity: "stable", title: "Equal Activity B", createdAt: equalTime },
    { _id: activityIds[3], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, type: "report_executed", severity: "stable", title: "Null Activity", createdAt: null },
    { _id: activityIds[4], agency_id: domain.agency._id, client_id: domain.archivedClient._id, report_id: domain.report._id, type: "report_executed", severity: "stable", title: "Missing Activity" },
  ]);

  const collectedClients = await collectCursorPages(
    (cursor, result) => getArchivedClients(requestFor(domain, { query: { limit: "1", ...(cursor ? { cursor } : {}) } }), result),
    "clients"
  );
  const collectedReports = await collectCursorPages(
    (cursor, result) => getArchivedReports(requestFor(domain, { query: { limit: "1", ...(cursor ? { cursor } : {}) } }), result),
    "reports"
  );
  const collectedRuns = await collectCursorPages(
    (cursor, result) => getHistoricalReportRuns(requestFor(domain, { query: { reportId: domain.report._id, limit: "1", ...(cursor ? { cursor } : {}) } }), result),
    "runs"
  );
  const collectedSignals = await collectCursorPages(
    (cursor, result) => getSignals(requestFor(domain, { query: { reportId: domain.report._id, limit: "1", ...(cursor ? { cursor } : {}) } }), result),
    "signals"
  );
  const collectedActivities = await collectCursorPages(
    (cursor, result) => getActivities(requestFor(domain, { query: { reportId: domain.report._id, limit: "1", ...(cursor ? { cursor } : {}) } }), result),
    "activities"
  );

  assert.deepEqual(new Set(collectedClients), new Set(clientIds.map(String)));
  assert.deepEqual(new Set(collectedReports), new Set(reportIds.map(String)));
  assert.deepEqual(new Set(collectedRuns), new Set(runIds.map(String)));
  assert.deepEqual(new Set(collectedSignals), new Set(signalIds.map(String)));
  assert.deepEqual(new Set(collectedActivities), new Set(activityIds.map(String)));
});

test("cross-workspace history is non-disclosing and membership remains required", async () => {
  const own = await createDomain({ suffix: "own" });
  const other = await createDomain({ suffix: "other" });

  const clientHistory = response();
  await getClientHistory(
    requestFor(own, { params: { clientId: other.archivedClient._id } }),
    clientHistory
  );
  assert.equal(clientHistory.statusCode, 404);
  assert.equal(clientHistory.payload.code, "HISTORY_RECORD_NOT_FOUND");

  const reportHistory = response();
  await getReportHistory(
    requestFor(own, { params: { reportId: other.report._id }, query: {} }),
    reportHistory
  );
  assert.equal(reportHistory.statusCode, 404);

  const runHistory = response();
  await getHistoricalReportRun(
    requestFor(own, { params: { reportRunId: other.runs[0]._id } }),
    runHistory
  );
  assert.equal(runHistory.statusCode, 404);

  const artifact = response();
  await getHistoricalArtifact(
    requestFor(own, {
      params: { reportRunId: other.runs[0]._id, audience: "client" },
    }),
    artifact
  );
  assert.equal(artifact.statusCode, 404);

  let nextCalled = false;
  const memberRes = response();
  await requireWorkspaceMember(requestFor(own), memberRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);

  await WorkspaceMember.updateOne(
    { workspace_id: own.agency._id, user_id: own.user._id },
    { $set: { status: "removed", removed_at: new Date() } }
  );
  const removedRes = response();
  await requireWorkspaceMember(requestFor(own), removedRes, () => {});
  assert.equal(removedRes.statusCode, 403);

  const invitedUser = await User.create({
    agency_id: own.agency._id,
    full_name: "Invited Only",
    email: "invited-only@example.com",
    role: "member",
  });
  const invitedRes = response();
  await requireWorkspaceMember(
    {
      user: { id: invitedUser._id, agencyId: own.agency._id },
    },
    invitedRes,
    () => {}
  );
  assert.equal(invitedRes.statusCode, 403);
});

test("unexpected historical database errors are logged but return a generic response", async () => {
  const domain = await createDomain({ suffix: "errors" });
  const originalFind = ReportRun.find;
  ReportRun.find = () => {
    throw new Error("MONGO_INTERNAL_SECRET collection=test.report_runs");
  };

  try {
    const result = response();
    await getHistoricalReportRuns(
      requestFor(domain, { query: { reportId: domain.report._id } }),
      result
    );
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.payload, {
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to load historical data",
    });
    assert.equal(JSON.stringify(result.payload).includes("MONGO_INTERNAL_SECRET"), false);
    assert.equal(JSON.stringify(result.payload).includes("stack"), false);
  } finally {
    ReportRun.find = originalFind;
  }
});

test("workspace membership middleware keeps unexpected database details private", async () => {
  const domain = await createDomain({ suffix: "membership-errors" });
  const originalFindOne = WorkspaceMember.findOne;
  WorkspaceMember.findOne = () => {
    throw new Error(
      "MONGO_INTERNAL_SECRET secret_collection_name /secret/filesystem/path SECRET_STACK_TRACE"
    );
  };

  try {
    const result = response();
    await requireWorkspaceMember(requestFor(domain), result, () => {
      assert.fail("Unexpected membership errors must not continue the request");
    });
    assert.equal(result.statusCode, 500);
    assert.deepEqual(result.payload, {
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "Unable to verify workspace access",
    });
    const serialized = JSON.stringify(result.payload);
    for (const secret of [
      "MONGO_INTERNAL_SECRET",
      "secret_collection_name",
      "/secret/filesystem/path",
      "SECRET_STACK_TRACE",
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  } finally {
    WorkspaceMember.findOne = originalFindOne;
  }
});

test("operational reads hide reports under archived Clients and campaign refresh stops before Meta", async () => {
  const domain = await createDomain({ suffix: "safety" });
  const inconsistentReport = await Report.create({
    agency_id: domain.agency._id,
    client_id: domain.archivedClient._id,
    meta_ad_account_id: domain.account._id,
    created_by: domain.user._id,
    name: "Inconsistent Operational Report",
    type: "daily",
    status: "active",
    severity: "low",
    schedule: { timezone: "UTC", time_of_day: "09:00" },
  });

  const list = response();
  await getReports(requestFor(domain, { query: {} }), list);
  assert.equal(list.payload.some((report) => String(report._id) === String(inconsistentReport._id)), false);

  const detail = response();
  await getReport(
    requestFor(domain, { params: { reportId: inconsistentReport._id } }),
    detail
  );
  assert.equal(detail.statusCode, 404);

  const historical = response();
  await getReportHistory(
    requestFor(domain, { params: { reportId: inconsistentReport._id }, query: {} }),
    historical
  );
  assert.equal(historical.statusCode, 200);
  assert.equal(historical.payload.report.client.is_archived, true);

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Meta must not be called");
  };
  try {
    const refresh = response();
    await refreshMetaAdAccountCampaigns(
      requestFor(domain, { params: { adAccountId: domain.account._id } }),
      refresh
    );
    assert.equal(refresh.statusCode, 409);
    assert.equal(refresh.payload.code, "CLIENT_ARCHIVED");
    assert.equal(fetchCalls, 0);
    const unchanged = await MetaAdAccount.findById(domain.account._id).lean();
    assert.equal(unchanged.campaigns_last_synced_at, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
