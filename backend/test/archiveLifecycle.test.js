import assert from "node:assert/strict";
import test from "node:test";

import {
  Client,
  MetaAdAccount,
  Report,
  ReportRun,
  Signal,
} from "../src/models/index.js";
import { getClients } from "../src/controllers/clients.controller.js";
import {
  createReport,
  getReports,
  updateReport,
} from "../src/controllers/reports.controller.js";
import { assignMetaAdAccount } from "../src/controllers/settings.controller.js";
import {
  archiveClientLifecycle,
  archiveReportLifecycle,
} from "../src/services/archiveLifecycle.service.js";
import {
  buildLegacyDispatchState,
  claimReportDelivery,
  inferLegacyDispatchStatus,
} from "../src/services/reportDelivery.service.js";
import {
  acquireClientLifecycleLease,
  acquireRequiredClientLifecycleLease,
  releaseClientLifecycleLease,
} from "../src/services/clientLifecycle.service.js";
import {
  getArchiveExecutionBlockReason,
  runDueReports,
  runReport,
} from "../src/services/reportRunner.service.js";
import { markExecutionIntegrityReady } from "../src/services/executionIntegrityIndexes.service.js";
import { getAssignedMetaAccountForClient } from "../src/services/metaContext.service.js";
import { getActivityDisplay } from "../src/utils/activityDisplay.js";
import {
  withOperationalClientScope,
  withOperationalReportScope,
} from "../src/utils/archiveScope.js";

const getPath = (value, path) =>
  path.split(".").reduce((current, key) => current?.[key], value);

const matches = (document, query = {}) =>
  Object.entries(query).every(([path, expected]) => {
    if (path === "$and") return expected.every((part) => matches(document, part));
    if (path === "$or") return expected.some((part) => matches(document, part));

    const actual = getPath(document, path);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) {
        return expected.$in.map(String).includes(String(actual));
      }
      if ("$exists" in expected) {
        return expected.$exists ? actual !== undefined : actual === undefined;
      }
      if ("$lte" in expected) return new Date(actual) <= new Date(expected.$lte);
      if ("$gt" in expected) return new Date(actual) > new Date(expected.$gt);
      if ("$ne" in expected) return actual !== expected.$ne;
    }

    return String(actual) === String(expected);
  });

const queryResult = (value) => ({
  select() {
    return this;
  },
  session() {
    return this;
  },
  lean() {
    return Promise.resolve(value);
  },
  then(resolve, reject) {
    return Promise.resolve(value).then(resolve, reject);
  },
});

const applyUpdate = (document, update = {}) => {
  Object.entries(update.$set || {}).forEach(([path, value]) => {
    const keys = path.split(".");
    const finalKey = keys.pop();
    const target = keys.reduce((current, key) => {
      current[key] ||= {};
      return current[key];
    }, document);
    target[finalKey] = value;
  });
  Object.keys(update.$unset || {}).forEach((path) => {
    const keys = path.split(".");
    const finalKey = keys.pop();
    const target = keys.reduce((current, key) => current?.[key], document);
    if (target) delete target[finalKey];
  });
  Object.entries(update.$inc || {}).forEach(([path, value]) => {
    const keys = path.split(".");
    const finalKey = keys.pop();
    const target = keys.reduce((current, key) => {
      current[key] ||= {};
      return current[key];
    }, document);
    target[finalKey] = Number(target[finalKey] || 0) + Number(value);
  });
};

const buildState = ({ reportLock = null, dispatchStatus = "pending" } = {}) => ({
  clients: [
    {
      _id: "client-1",
      agency_id: "agency-1",
      name: "Northstar",
      status: "stable",
    },
  ],
  reports: [
    {
      _id: "report-1",
      agency_id: "agency-1",
      client_id: "client-1",
      name: "Daily Monitor",
      status: "active",
      next_run_at: new Date("2026-07-16T04:00:00.000Z"),
      ...(reportLock ? { execution_lock: reportLock } : {}),
    },
  ],
  reportRuns: [
    {
      _id: "run-1",
      agency_id: "agency-1",
      client_id: "client-1",
      report_id: "report-1",
      client_report: {
        status: "awaiting_approval",
        subject: "Northstar performance update",
        html: "<p>Historical report body</p>",
        text: "Historical report body",
        recipients: ["client@example.com"],
        dispatch: {
          status: dispatchStatus,
          attempt_count: 0,
          idempotency_key: "client:run-1",
        },
      },
    },
  ],
  signals: [{ _id: "signal-1", report_id: "report-1", client_id: "client-1" }],
  activities: [{ _id: "activity-before", type: "report_executed" }],
  metaAccounts: [
    {
      _id: "account-1",
      agency_id: "agency-1",
      client_id: "client-1",
      assignment_scope: "client",
    },
  ],
  metaConnections: [
    {
      _id: "connection-1",
      agency_id: "agency-1",
      client_id: "client-1",
      is_active: true,
      status: "active",
      access_token: "secret",
    },
  ],
});

const recordSession = (writeSessions, operation, options = {}) => {
  if (writeSessions) writeSessions.push({ operation, session: options.session || null });
};

const createModels = (state, { writeSessions = null, failAt = null } = {}) => ({
  Client: {
    findOne(query) {
      return queryResult(state.clients.find((item) => matches(item, query)) || null);
    },
    async findOneAndUpdate(query, update, options = {}) {
      recordSession(writeSessions, "Client.findOneAndUpdate", options);
      if (failAt === "Client.findOneAndUpdate" && options.session) {
        throw new Error("simulated client archive write failure");
      }
      const item = state.clients.find((candidate) => matches(candidate, query));
      if (!item) return null;
      applyUpdate(item, update);
      return item;
    },
    async updateOne(query, update, options = {}) {
      recordSession(writeSessions, "Client.updateOne", options);
      const item = state.clients.find((candidate) => matches(candidate, query));
      if (!item) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(item, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
  },
  Report: {
    find(query) {
      return queryResult(state.reports.filter((item) => matches(item, query)));
    },
    findOne(query) {
      return queryResult(state.reports.find((item) => matches(item, query)) || null);
    },
    async updateMany(query, update, options = {}) {
      recordSession(writeSessions, "Report.updateMany", options);
      const selected = state.reports.filter((item) => matches(item, query));
      selected.forEach((item) => applyUpdate(item, update));
      return { matchedCount: selected.length, modifiedCount: selected.length };
    },
    async findOneAndUpdate(query, update, options = {}) {
      recordSession(writeSessions, "Report.findOneAndUpdate", options);
      const item = state.reports.find((candidate) => matches(candidate, query));
      if (!item) return null;
      applyUpdate(item, update);
      return item;
    },
  },
  ReportRun: {
    find(query) {
      return queryResult(state.reportRuns.filter((item) => matches(item, query)));
    },
    findOne(query) {
      return queryResult(state.reportRuns.find((item) => matches(item, query)) || null);
    },
    findById(id) {
      return queryResult(state.reportRuns.find((item) => String(item._id) === String(id)) || null);
    },
    async updateOne(query, update, options = {}) {
      recordSession(writeSessions, "ReportRun.updateOne", options);
      const item = state.reportRuns.find((candidate) => matches(candidate, query));
      if (!item) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(item, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(query, update, options = {}) {
      recordSession(writeSessions, "ReportRun.updateMany", options);
      const selected = state.reportRuns.filter((item) => matches(item, query));
      selected.forEach((item) => applyUpdate(item, update));
      return { matchedCount: selected.length, modifiedCount: selected.length };
    },
    async findOneAndUpdate(query, update, options = {}) {
      recordSession(writeSessions, "ReportRun.findOneAndUpdate", options);
      const item = state.reportRuns.find((candidate) => matches(candidate, query));
      if (!item) return null;
      applyUpdate(item, update);
      return item;
    },
  },
  MetaAdAccount: {
    async updateMany(query, update, options = {}) {
      recordSession(writeSessions, "MetaAdAccount.updateMany", options);
      if (failAt === "MetaAdAccount.updateMany") {
        throw new Error("simulated Meta ad account write failure");
      }
      const selected = state.metaAccounts.filter((item) => matches(item, query));
      selected.forEach((item) => applyUpdate(item, update));
      return { matchedCount: selected.length, modifiedCount: selected.length };
    },
  },
  MetaConnection: {
    async updateMany(query, update, options = {}) {
      recordSession(writeSessions, "MetaConnection.updateMany", options);
      const selected = state.metaConnections.filter((item) => matches(item, query));
      selected.forEach((item) => applyUpdate(item, update));
      return { matchedCount: selected.length, modifiedCount: selected.length };
    },
  },
  Activity: {
    async findOneAndUpdate(query, update, options = {}) {
      recordSession(writeSessions, "Activity.findOneAndUpdate", options);
      if (failAt === "Activity.findOneAndUpdate") {
        throw new Error("simulated activity write failure");
      }
      const existing = state.activities.find((item) => matches(item, query));
      if (existing) return existing;
      const activity = { _id: `activity-${state.activities.length}`, ...update.$setOnInsert };
      state.activities.push(activity);
      return activity;
    },
    findOne(query) {
      return queryResult(state.activities.find((item) => matches(item, query)) || null);
    },
  },
});

const standaloneMongoose = {
  connection: { client: { topology: { description: { type: "Single" } } } },
};

const createTransactionMongoose = (state, { sessions = [] } = {}) => ({
  connection: {
    client: { topology: { description: { type: "ReplicaSetWithPrimary" } } },
  },
  async startSession() {
    const session = { id: `session-${sessions.length + 1}` };
    session.withTransaction = async (work) => {
      const snapshot = structuredClone(state);
      try {
        return await work();
      } catch (error) {
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, snapshot);
        throw error;
      }
    };
    session.endSession = async () => {};
    sessions.push(session);
    return session;
  },
});

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

test("archive fields are additive and operational scopes include historical documents", () => {
  const client = new Client({});
  const report = new Report({});

  assert.equal(client.is_archived, false);
  assert.equal(client.archived_at, null);
  assert.equal(report.is_archived, false);
  assert.equal(report.archived_at, null);
  assert.equal(matches({ agency_id: "a" }, withOperationalClientScope({ agency_id: "a" })), true);
  assert.equal(matches({ agency_id: "a" }, withOperationalReportScope({ agency_id: "a" })), true);
  assert.equal(
    matches(
      { agency_id: "a", is_archived: true },
      withOperationalReportScope({ agency_id: "a" })
    ),
    false
  );
});

test("client lifecycle lease acquisition is atomic and release is token-owned", async () => {
  const state = buildState();
  const ClientModel = createModels(state).Client;
  const now = new Date("2026-07-15T12:00:00.000Z");

  const createLease = await acquireClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    operation: "report_create",
    now,
    ClientModel,
  });
  const archiveLease = await acquireClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    operation: "archive",
    now,
    ClientModel,
  });

  assert.equal(createLease.acquired, true);
  assert.equal(archiveLease.acquired, false);
  assert.equal(archiveLease.reason, "client_lifecycle_operation_in_progress");
  assert.equal(
    await releaseClientLifecycleLease({
      agencyId: "agency-1",
      clientId: "client-1",
      token: "not-the-owner",
      ClientModel,
    }),
    false
  );
  assert.equal(state.clients[0].lifecycle_lock.token, createLease.token);
  assert.equal(
    await releaseClientLifecycleLease({
      agencyId: "agency-1",
      clientId: "client-1",
      token: createLease.token,
      ClientModel,
    }),
    true
  );
  assert.equal(state.clients[0].lifecycle_lock, undefined);
});

test("expired client lifecycle leases can be atomically replaced", async () => {
  const state = buildState();
  const ClientModel = createModels(state).Client;
  const now = new Date("2026-07-15T12:00:00.000Z");
  const first = await acquireRequiredClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    operation: "report_create",
    now,
    leaseMs: 1_000,
    ClientModel,
  });
  const replacement = await acquireClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    operation: "archive",
    now: new Date(now.getTime() + 1_001),
    ClientModel,
  });

  assert.equal(replacement.acquired, true);
  assert.notEqual(replacement.token, first.token);
  assert.equal(
    await releaseClientLifecycleLease({
      agencyId: "agency-1",
      clientId: "client-1",
      token: first.token,
      ClientModel,
    }),
    false
  );
  assert.equal(state.clients[0].lifecycle_lock.token, replacement.token);
});

test("report create ordering cannot commit after a client archive", async () => {
  const createFirstState = buildState();
  createFirstState.reports = [];
  createFirstState.reportRuns = [];
  const createFirstModels = createModels(createFirstState);
  const createLease = await acquireRequiredClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    operation: "report_create",
    ClientModel: createFirstModels.Client,
  });

  const blockedArchive = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "archiver",
    Models: createFirstModels,
    mongooseInstance: createTransactionMongoose(createFirstState),
  });
  assert.equal(blockedArchive.outcome, "lifecycle_in_progress");

  createFirstState.reports.push({
    _id: "created-report",
    agency_id: "agency-1",
    client_id: "client-1",
    name: "Created while lease owned",
    status: "active",
  });
  await releaseClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    token: createLease.token,
    ClientModel: createFirstModels.Client,
  });
  const archivedAfterCreate = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "archiver",
    Models: createFirstModels,
    mongooseInstance: createTransactionMongoose(createFirstState),
  });
  assert.equal(archivedAfterCreate.outcome, "archived");
  assert.equal(createFirstState.reports[0].is_archived, true);

  const archiveFirstState = buildState();
  archiveFirstState.reports = [];
  archiveFirstState.reportRuns = [];
  const archiveFirstModels = createModels(archiveFirstState);
  const archivedFirst = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "archiver",
    Models: archiveFirstModels,
    mongooseInstance: createTransactionMongoose(archiveFirstState),
  });
  assert.equal(archivedFirst.outcome, "archived");
  await assert.rejects(
    acquireRequiredClientLifecycleLease({
      agencyId: "agency-1",
      clientId: "client-1",
      operation: "report_create",
      ClientModel: archiveFirstModels.Client,
    }),
    (error) => error.code === "CLIENT_ARCHIVED" && error.status === 409
  );
  assert.equal(archiveFirstState.reports.length, 0);
});

test("create and reparent controllers reject an archive-owned destination lease before commit", async () => {
  const originals = {
    clientFindOne: Client.findOne,
    clientFindOneAndUpdate: Client.findOneAndUpdate,
    clientUpdateOne: Client.updateOne,
    reportCreate: Report.create,
    reportFindOne: Report.findOne,
  };
  const lockedClient = {
    _id: "client-2",
    agency_id: "agency-1",
    lifecycle_lock: {
      token: "archive-owner",
      operation: "archive",
      expires_at: new Date(Date.now() + 60_000),
    },
  };
  let reportCreates = 0;
  let reportSaves = 0;

  Client.findOneAndUpdate = async () => null;
  Client.findOne = async () => lockedClient;
  Client.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 });
  Report.create = async () => {
    reportCreates += 1;
  };
  Report.findOne = async () => ({
    _id: "report-1",
    agency_id: "agency-1",
    client_id: "client-1",
    status: "paused",
    type: "daily",
    schedule: { time: "09:00" },
    save: async () => {
      reportSaves += 1;
    },
  });

  try {
    const createRes = response();
    await createReport(
      {
        user: { id: "user-1", agencyId: "agency-1" },
        body: {
          client_id: "client-2",
          internal_recipients: ["team@example.com"],
          monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "One" }],
          type: "daily",
          schedule: { time: "09:00" },
        },
      },
      createRes
    );
    const updateRes = response();
    await updateReport(
      {
        user: { id: "user-1", agencyId: "agency-1" },
        body: {
          reportId: "report-1",
          updates: {
            client_id: "client-2",
            monitored_campaigns: [
              { campaign_id: "campaign-1", campaign_name: "One" },
            ],
          },
        },
      },
      updateRes
    );

    assert.equal(createRes.statusCode, 409);
    assert.equal(createRes.payload.code, "client_lifecycle_operation_in_progress");
    assert.equal(updateRes.statusCode, 409);
    assert.equal(updateRes.payload.code, "client_lifecycle_operation_in_progress");
    assert.equal(reportCreates, 0);
    assert.equal(reportSaves, 0);
  } finally {
    Client.findOne = originals.clientFindOne;
    Client.findOneAndUpdate = originals.clientFindOneAndUpdate;
    Client.updateOne = originals.clientUpdateOne;
    Report.create = originals.reportCreate;
    Report.findOne = originals.reportFindOne;
  }
});

test("report reparent ordering cannot commit to an archived destination", async () => {
  const buildReparentState = () => {
    const state = buildState();
    state.clients.push({
      _id: "client-2",
      agency_id: "agency-1",
      name: "Destination",
      status: "stable",
    });
    return state;
  };

  const reparentFirstState = buildReparentState();
  const reparentModels = createModels(reparentFirstState);
  const lease = await acquireRequiredClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-2",
    operation: "report_reparent",
    ClientModel: reparentModels.Client,
  });
  const blockedArchive = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-2",
    userId: "archiver",
    Models: reparentModels,
    mongooseInstance: createTransactionMongoose(reparentFirstState),
  });
  assert.equal(blockedArchive.outcome, "lifecycle_in_progress");
  reparentFirstState.reports[0].client_id = "client-2";
  await releaseClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-2",
    token: lease.token,
    ClientModel: reparentModels.Client,
  });
  const archivedAfterReparent = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-2",
    userId: "archiver",
    Models: reparentModels,
    mongooseInstance: createTransactionMongoose(reparentFirstState),
  });
  assert.equal(archivedAfterReparent.outcome, "archived");
  assert.equal(reparentFirstState.reports[0].is_archived, true);

  const archiveFirstState = buildReparentState();
  const archiveFirstModels = createModels(archiveFirstState);
  await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-2",
    userId: "archiver",
    Models: archiveFirstModels,
    mongooseInstance: createTransactionMongoose(archiveFirstState),
  });
  await assert.rejects(
    acquireRequiredClientLifecycleLease({
      agencyId: "agency-1",
      clientId: "client-2",
      operation: "report_reparent",
      ClientModel: archiveFirstModels.Client,
    }),
    (error) => error.code === "CLIENT_ARCHIVED"
  );
  assert.equal(archiveFirstState.reports[0].client_id, "client-1");
});

test("Meta assignment ordering is serialized with client archive", async () => {
  const assignmentFirstState = buildState();
  assignmentFirstState.metaAccounts[0].client_id = null;
  const assignmentModels = createModels(assignmentFirstState);
  const assignmentLease = await acquireRequiredClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    operation: "meta_assignment",
    ClientModel: assignmentModels.Client,
  });
  const blockedArchive = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "archiver",
    Models: assignmentModels,
    mongooseInstance: createTransactionMongoose(assignmentFirstState),
  });
  assert.equal(blockedArchive.outcome, "lifecycle_in_progress");
  assignmentFirstState.metaAccounts[0].client_id = "client-1";
  assignmentFirstState.metaAccounts[0].assignment_scope = "v1";
  await releaseClientLifecycleLease({
    agencyId: "agency-1",
    clientId: "client-1",
    token: assignmentLease.token,
    ClientModel: assignmentModels.Client,
  });
  const archivedAfterAssignment = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "archiver",
    Models: assignmentModels,
    mongooseInstance: createTransactionMongoose(assignmentFirstState),
  });
  assert.equal(archivedAfterAssignment.outcome, "archived");
  assert.equal(assignmentFirstState.metaAccounts[0].client_id, null);

  const archiveFirstState = buildState();
  archiveFirstState.metaAccounts[0].client_id = null;
  const archiveFirstModels = createModels(archiveFirstState);
  await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "archiver",
    Models: archiveFirstModels,
    mongooseInstance: createTransactionMongoose(archiveFirstState),
  });
  await assert.rejects(
    acquireRequiredClientLifecycleLease({
      agencyId: "agency-1",
      clientId: "client-1",
      operation: "meta_assignment",
      ClientModel: archiveFirstModels.Client,
    }),
    (error) => error.code === "CLIENT_ARCHIVED"
  );
  assert.equal(archiveFirstState.metaAccounts[0].client_id, null);
});

test("confirmed Meta reassignment cannot bypass an archive-owned lifecycle lease", async () => {
  const originals = {
    clientFindOne: Client.findOne,
    clientFindOneAndUpdate: Client.findOneAndUpdate,
    clientUpdateOne: Client.updateOne,
    accountFindOne: MetaAdAccount.findOne,
  };
  let accountSaves = 0;
  Client.findOneAndUpdate = async () => null;
  Client.findOne = async () => ({
    _id: "client-2",
    agency_id: "agency-1",
    lifecycle_lock: {
      token: "archive-owner",
      expires_at: new Date(Date.now() + 60_000),
    },
  });
  Client.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 });
  MetaAdAccount.findOne = async () => ({
    _id: "account-1",
    agency_id: "agency-1",
    client_id: "client-1",
    is_active: true,
    is_accessible: true,
    save: async () => {
      accountSaves += 1;
    },
  });

  try {
    const res = response();
    await assignMetaAdAccount(
      {
        user: { id: "user-1", agencyId: "agency-1" },
        params: { adAccountId: "account-1" },
        body: { clientId: "client-2", confirmReassignment: true },
      },
      res
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, "client_lifecycle_operation_in_progress");
    assert.equal(accountSaves, 0);
  } finally {
    Client.findOne = originals.clientFindOne;
    Client.findOneAndUpdate = originals.clientFindOneAndUpdate;
    Client.updateOne = originals.clientUpdateOne;
    MetaAdAccount.findOne = originals.accountFindOne;
  }
});

test("client archive retains history, archives reports, clears assignments, and is idempotent", async () => {
  const state = buildState();
  const Models = createModels(state);
  const now = new Date("2026-07-15T12:00:00.000Z");
  const originalCounts = {
    reports: state.reports.length,
    runs: state.reportRuns.length,
    signals: state.signals.length,
    activities: state.activities.length,
    accounts: state.metaAccounts.length,
    connections: state.metaConnections.length,
  };

  const first = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "user-1",
    now,
    Models,
    mongooseInstance: createTransactionMongoose(state),
  });

  assert.equal(first.outcome, "archived");
  assert.equal(state.clients[0].is_archived, true);
  assert.equal(state.clients[0].archived_at, now);
  assert.equal(state.clients[0].archived_by, "user-1");
  assert.equal(state.reports[0].is_archived, true);
  assert.equal(state.reports[0].status, "paused");
  assert.equal(state.reports[0].next_run_at, null);
  assert.equal(state.metaAccounts[0].client_id, null);
  assert.equal(state.metaAccounts[0].assignment_scope, null);
  assert.equal(state.metaConnections[0].is_active, false);
  assert.equal(state.metaConnections[0].status, "revoked");
  assert.equal("access_token" in state.metaConnections[0], false);
  assert.equal(state.reports.length, originalCounts.reports);
  assert.equal(state.reportRuns.length, originalCounts.runs);
  assert.equal(state.signals.length, originalCounts.signals);
  assert.equal(state.metaAccounts.length, originalCounts.accounts);
  assert.equal(state.metaConnections.length, originalCounts.connections);
  assert.equal(state.activities.length, originalCounts.activities + 1);
  assert.equal(state.activities.at(-1).type, "client_archived");

  const archivedAt = state.clients[0].archived_at;
  const archivedBy = state.clients[0].archived_by;
  const second = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "user-2",
    now: new Date("2026-07-15T13:00:00.000Z"),
    Models,
    mongooseInstance: createTransactionMongoose(state),
  });

  assert.equal(second.outcome, "already_archived");
  assert.equal(state.clients[0].archived_at, archivedAt);
  assert.equal(state.clients[0].archived_by, archivedBy);
  assert.equal(state.activities.length, originalCounts.activities + 1);
});

test("unsupported archive topology fails closed without lifecycle mutation", async () => {
  const state = buildState();
  const before = structuredClone(state);

  await assert.rejects(
    archiveClientLifecycle({
      agencyId: "agency-1",
      clientId: "client-1",
      userId: "user-1",
      Models: createModels(state),
      mongooseInstance: standaloneMongoose,
    }),
    (error) => error.code === "archive_transaction_unavailable" && error.status === 503
  );

  assert.deepEqual(state, before);
});

test("client archive sends every lifecycle write through one transaction session", async () => {
  const state = buildState();
  const writeSessions = [];
  const sessions = [];
  const Models = createModels(state, { writeSessions });

  const result = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "user-1",
    Models,
    mongooseInstance: createTransactionMongoose(state, { sessions }),
  });

  assert.equal(result.outcome, "archived");
  assert.equal(sessions.length, 1);
  const transactionalWrites = writeSessions.filter((entry) => entry.session);
  const operations = transactionalWrites.map((entry) => entry.operation);
  assert.deepEqual(
    new Set(operations),
    new Set([
      "ReportRun.updateMany",
      "Report.updateMany",
      "MetaConnection.updateMany",
      "MetaAdAccount.updateMany",
      "Client.findOneAndUpdate",
      "Activity.findOneAndUpdate",
    ])
  );
  assert.equal(
    transactionalWrites.every((entry) => entry.session === sessions[0]),
    true
  );
});

test("client archive transaction rolls back failures without partial lifecycle state", async (t) => {
  for (const failAt of [
    "MetaAdAccount.updateMany",
    "Client.findOneAndUpdate",
    "Activity.findOneAndUpdate",
  ]) {
    await t.test(failAt, async () => {
      const state = buildState();
      const before = structuredClone(state);
      await assert.rejects(
        archiveClientLifecycle({
          agencyId: "agency-1",
          clientId: "client-1",
          userId: "user-1",
          Models: createModels(state, { failAt }),
          mongooseInstance: createTransactionMongoose(state),
        }),
        /simulated/
      );
      assert.deepEqual(state, before);
    });
  }
});

test("client archive refuses an active report lease without partial writes", async () => {
  const state = buildState({
    reportLock: {
      token: "active-lock",
      expires_at: new Date("2026-07-15T12:30:00.000Z"),
    },
  });

  const result = await archiveClientLifecycle({
    agencyId: "agency-1",
    clientId: "client-1",
    userId: "user-1",
    now: new Date("2026-07-15T12:00:00.000Z"),
    Models: createModels(state),
    mongooseInstance: createTransactionMongoose(state),
  });

  assert.equal(result.outcome, "execution_in_progress");
  assert.equal(state.clients[0].is_archived, undefined);
  assert.equal(state.reports[0].is_archived, undefined);
  assert.equal(state.metaAccounts[0].client_id, "client-1");
  assert.equal(state.activities.length, 1);
});

test("report archive preserves evidence, records one activity, and is idempotent", async () => {
  const state = buildState();
  const Models = createModels(state);
  const now = new Date("2026-07-15T12:00:00.000Z");

  const first = await archiveReportLifecycle({
    agencyId: "agency-1",
    reportId: "report-1",
    userId: "user-1",
    now,
    Models,
    mongooseInstance: createTransactionMongoose(state),
  });

  assert.equal(first.outcome, "archived");
  assert.equal(state.reports.length, 1);
  assert.equal(state.reports[0].is_archived, true);
  assert.equal(state.reports[0].archived_at, now);
  assert.equal(state.reports[0].archived_by, "user-1");
  assert.equal(state.reports[0].status, "paused");
  assert.equal(state.reports[0].next_run_at, null);
  assert.equal(state.reportRuns.length, 1);
  assert.equal(state.signals.length, 1);
  assert.equal(state.activities.filter((item) => item.type === "report_archived").length, 1);

  const second = await archiveReportLifecycle({
    agencyId: "agency-1",
    reportId: "report-1",
    userId: "user-2",
    now: new Date("2026-07-15T13:00:00.000Z"),
    Models,
    mongooseInstance: createTransactionMongoose(state),
  });

  assert.equal(second.outcome, "already_archived");
  assert.equal(state.reports[0].archived_at, now);
  assert.equal(state.reports[0].archived_by, "user-1");
  assert.equal(state.activities.filter((item) => item.type === "report_archived").length, 1);
});

test("report archive coordinates ReportRun, Report, and Activity in one session", async () => {
  const state = buildState();
  const sessions = [];
  const writeSessions = [];
  const result = await archiveReportLifecycle({
    agencyId: "agency-1",
    reportId: "report-1",
    userId: "user-1",
    Models: createModels(state, { writeSessions }),
    mongooseInstance: createTransactionMongoose(state, { sessions }),
  });

  assert.equal(result.outcome, "archived");
  assert.equal(sessions.length, 1);
  const operations = writeSessions.filter((entry) => entry.session);
  assert.deepEqual(
    new Set(operations.map((entry) => entry.operation)),
    new Set([
      "ReportRun.updateMany",
      "Report.findOneAndUpdate",
      "Activity.findOneAndUpdate",
    ])
  );
  assert.equal(operations.every((entry) => entry.session === sessions[0]), true);
});

test("report archive applies the client artifact state policy without deleting evidence", async (t) => {
  const expectations = {
    pending: { artifact: "cancelled", dispatch: "not_required" },
    failed: { artifact: "cancelled", dispatch: "not_required" },
    sent: { artifact: "awaiting_approval", dispatch: "sent" },
    uncertain: { artifact: "awaiting_approval", dispatch: "uncertain" },
    not_required: { artifact: "awaiting_approval", dispatch: "not_required" },
  };

  for (const [initialStatus, expected] of Object.entries(expectations)) {
    await t.test(initialStatus, async () => {
      const state = buildState({ dispatchStatus: initialStatus });
      const originalHtml = state.reportRuns[0].client_report.html;
      const result = await archiveReportLifecycle({
        agencyId: "agency-1",
        reportId: "report-1",
        userId: "user-1",
        Models: createModels(state),
        mongooseInstance: createTransactionMongoose(state),
      });

      assert.equal(result.outcome, "archived");
      assert.equal(state.reportRuns[0].client_report.status, expected.artifact);
      assert.equal(
        state.reportRuns[0].client_report.dispatch.status,
        expected.dispatch
      );
      assert.equal(state.reportRuns[0].client_report.html, originalHtml);
    });
  }
});

test("archive and approval share the canonical missing client dispatch policy", async (t) => {
  const cases = [
    { name: "sent", artifact: { status: "sent" }, inferred: "sent", final: "sent" },
    {
      name: "cancelled",
      artifact: { status: "cancelled" },
      inferred: "not_required",
      final: "not_required",
    },
    {
      name: "generate only",
      artifact: { status: "generated", delivery_mode: "generate_only" },
      inferred: "not_required",
      final: "not_required",
    },
    { name: "failed", artifact: { status: "failed" }, inferred: "failed", final: "not_required" },
    {
      name: "generated",
      artifact: { status: "generated", delivery_mode: "approval_required" },
      inferred: "pending",
      final: "not_required",
    },
    {
      name: "awaiting approval",
      artifact: { status: "awaiting_approval", delivery_mode: "approval_required" },
      inferred: "pending",
      final: "not_required",
    },
    {
      name: "held for review",
      artifact: { status: "held_for_review", delivery_mode: "auto_send" },
      inferred: "pending",
      final: "not_required",
    },
    {
      name: "uncertain evidence",
      artifact: {
        status: "failed",
        delivery_error: { category: "uncertain" },
      },
      inferred: "uncertain",
      final: "uncertain",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      assert.equal(inferLegacyDispatchStatus("client", scenario.artifact), scenario.inferred);
      assert.equal(
        buildLegacyDispatchState({
          reportRunId: "run-1",
          audience: "client",
          artifact: scenario.artifact,
        }).status,
        scenario.inferred
      );

      const state = buildState();
      state.reportRuns[0].client_report = {
        subject: "Historical report",
        html: "<p>Historical report</p>",
        recipients: ["client@example.com"],
        ...scenario.artifact,
      };
      const result = await archiveReportLifecycle({
        agencyId: "agency-1",
        reportId: "report-1",
        userId: "archiver",
        Models: createModels(state),
        mongooseInstance: createTransactionMongoose(state),
      });

      assert.equal(result.outcome, "archived");
      assert.equal(state.reportRuns[0].client_report.dispatch.status, scenario.final);
      if (["failed", "pending"].includes(scenario.inferred)) {
        assert.equal(state.reportRuns[0].client_report.status, "cancelled");
      }
    });
  }
});

test("archive materializes a dispatch object whose status alone is missing", async () => {
  const state = buildState();
  state.reportRuns[0].client_report.dispatch = {
    idempotency_key: "legacy-key",
    attempt_count: 2,
  };
  const result = await archiveReportLifecycle({
    agencyId: "agency-1",
    reportId: "report-1",
    userId: "archiver",
    Models: createModels(state),
    mongooseInstance: createTransactionMongoose(state),
  });

  assert.equal(result.outcome, "archived");
  assert.equal(state.reportRuns[0].client_report.dispatch.status, "not_required");
  assert.equal(state.reportRuns[0].client_report.dispatch.idempotency_key, "legacy-key");
  assert.equal(state.reportRuns[0].client_report.dispatch.attempt_count, 2);
});

test("approve claim and report archive have one durable ordering", async (t) => {
  await t.test("approve claim wins", async () => {
    const state = buildState();
    const Models = createModels(state);
    const claim = await claimReportDelivery({
      reportRunId: "run-1",
      audience: "client",
      ReportRunModel: Models.ReportRun,
    });
    assert.equal(claim.claimed, true);
    assert.equal(state.reportRuns[0].client_report.dispatch.status, "dispatching");

    const result = await archiveReportLifecycle({
      agencyId: "agency-1",
      reportId: "report-1",
      userId: "user-1",
      Models,
      mongooseInstance: createTransactionMongoose(state),
    });
    assert.equal(result.outcome, "dispatch_in_progress");
    assert.equal(state.reports[0].is_archived, undefined);
    assert.equal(state.reportRuns[0].client_report.dispatch.status, "dispatching");
  });

  await t.test("archive wins", async () => {
    const state = buildState();
    const Models = createModels(state);
    const result = await archiveReportLifecycle({
      agencyId: "agency-1",
      reportId: "report-1",
      userId: "user-1",
      Models,
      mongooseInstance: createTransactionMongoose(state),
    });
    assert.equal(result.outcome, "archived");
    assert.equal(state.reportRuns[0].client_report.dispatch.status, "not_required");

    const claim = await claimReportDelivery({
      reportRunId: "run-1",
      audience: "client",
      allowFailedRetry: true,
      ReportRunModel: Models.ReportRun,
    });
    assert.equal(claim.claimed, false);
    assert.equal(claim.outcome, "not_required");
    assert.equal(state.reports[0].is_archived, true);
  });
});

test("client archive coordinates dispatch state across every operational report", async (t) => {
  const addSecondReport = (state, dispatchStatus) => {
    state.reports.push({
      _id: "report-2",
      agency_id: "agency-1",
      client_id: "client-1",
      name: "Weekly Monitor",
      status: "active",
    });
    const secondRun = structuredClone(state.reportRuns[0]);
    secondRun._id = "run-2";
    secondRun.report_id = "report-2";
    secondRun.client_report.dispatch.status = dispatchStatus;
    secondRun.client_report.dispatch.idempotency_key = "client:run-2";
    state.reportRuns.push(secondRun);
  };

  await t.test("any active dispatch blocks the whole archive", async () => {
    const state = buildState();
    addSecondReport(state, "pending");
    const Models = createModels(state);
    const claim = await claimReportDelivery({
      reportRunId: "run-2",
      audience: "client",
      ReportRunModel: Models.ReportRun,
    });
    assert.equal(claim.claimed, true);
    const result = await archiveClientLifecycle({
      agencyId: "agency-1",
      clientId: "client-1",
      userId: "user-1",
      Models,
      mongooseInstance: createTransactionMongoose(state),
    });

    assert.equal(result.outcome, "dispatch_in_progress");
    assert.equal(state.clients[0].is_archived, undefined);
    assert.equal(state.reports.every((report) => report.is_archived === undefined), true);
    assert.equal(state.metaAccounts[0].client_id, "client-1");
    assert.equal(state.reportRuns[0].client_report.dispatch.status, "pending");
    assert.equal(state.reportRuns[1].client_report.dispatch.status, "dispatching");
  });

  await t.test("archive wins and later claims fail for all reports", async () => {
    const state = buildState();
    addSecondReport(state, "failed");
    const Models = createModels(state);
    const result = await archiveClientLifecycle({
      agencyId: "agency-1",
      clientId: "client-1",
      userId: "user-1",
      Models,
      mongooseInstance: createTransactionMongoose(state),
    });

    assert.equal(result.outcome, "archived");
    assert.equal(state.reports.every((report) => report.is_archived === true), true);
    assert.equal(
      state.reportRuns.every(
        (run) => run.client_report.dispatch.status === "not_required"
      ),
      true
    );
    for (const run of state.reportRuns) {
      const claim = await claimReportDelivery({
        reportRunId: run._id,
        audience: "client",
        allowFailedRetry: true,
        ReportRunModel: Models.ReportRun,
      });
      assert.equal(claim.claimed, false);
      assert.equal(claim.outcome, "not_required");
    }
  });
});

test("report archive refuses active execution leases and active client dispatches", async () => {
  const leaseState = buildState({
    reportLock: {
      token: "active-lock",
      expires_at: new Date("2026-07-15T12:30:00.000Z"),
    },
  });
  const dispatchState = buildState({ dispatchStatus: "dispatching" });

  const leaseResult = await archiveReportLifecycle({
    agencyId: "agency-1",
    reportId: "report-1",
    userId: "user-1",
    now: new Date("2026-07-15T12:00:00.000Z"),
    Models: createModels(leaseState),
    mongooseInstance: createTransactionMongoose(leaseState),
  });
  const dispatchResult = await archiveReportLifecycle({
    agencyId: "agency-1",
    reportId: "report-1",
    userId: "user-1",
    now: new Date("2026-07-15T12:00:00.000Z"),
    Models: createModels(dispatchState),
    mongooseInstance: createTransactionMongoose(dispatchState),
  });

  assert.equal(leaseResult.outcome, "execution_in_progress");
  assert.equal(dispatchResult.outcome, "dispatch_in_progress");
  assert.equal(leaseState.reports[0].is_archived, undefined);
  assert.equal(dispatchState.reports[0].is_archived, undefined);
});

test("archive execution reasons are authoritative and independent of force mode", () => {
  assert.equal(
    getArchiveExecutionBlockReason({ report: { is_archived: true }, client: {} }),
    "report_archived"
  );
  assert.equal(
    getArchiveExecutionBlockReason({ report: {}, client: { is_archived: true } }),
    "client_archived"
  );
  assert.equal(getArchiveExecutionBlockReason({ report: {}, client: {} }), null);
});

test("archive activities have safe display labels and icons", () => {
  const clientDisplay = getActivityDisplay({
    type: "client_archived",
    severity: "stable",
  });
  const reportDisplay = getActivityDisplay({
    type: "report_archived",
    severity: "stable",
  });

  assert.equal(clientDisplay.label, "Client archived");
  assert.equal(clientDisplay.icon.name, "Archive");
  assert.equal(reportDisplay.label, "Monitor archived");
  assert.equal(reportDisplay.icon.name, "Archive");
});

test("runReport skips archived report and client states before creating evidence or delivery", async () => {
  const originals = {
    reportFindById: Report.findById,
    clientFindOne: Client.findOne,
    reportRunCreate: ReportRun.create,
    signalCreate: Signal.create,
    fetch: globalThis.fetch,
  };
  let reportRunCreates = 0;
  let signalCreates = 0;
  let webhookCalls = 0;

  markExecutionIntegrityReady([]);
  ReportRun.create = async () => {
    reportRunCreates += 1;
    throw new Error("ReportRun should not be created for archived execution.");
  };
  Signal.create = async () => {
    signalCreates += 1;
    throw new Error("Signal should not be created for archived execution.");
  };
  globalThis.fetch = async () => {
    webhookCalls += 1;
    throw new Error("Webhook should not be called for archived execution.");
  };

  try {
    Report.findById = async () => ({
      _id: "report-1",
      agency_id: "agency-1",
      client_id: "client-1",
      is_archived: true,
      status: "active",
    });
    Client.findOne = () => queryResult({ _id: "client-1", is_archived: false });

    const archivedReportResult = await runReport("report-1", {
      agencyId: "agency-1",
      force: true,
      triggerType: "manual",
    });

    Report.findById = async () => ({
      _id: "report-1",
      agency_id: "agency-1",
      client_id: "client-1",
      is_archived: false,
      status: "active",
    });
    Client.findOne = () => queryResult({ _id: "client-1", is_archived: true });

    const archivedClientResult = await runReport("report-1", {
      agencyId: "agency-1",
      force: true,
      triggerType: "api",
    });

    assert.equal(archivedReportResult.reason, "report_archived");
    assert.equal(archivedClientResult.reason, "client_archived");
    assert.equal(reportRunCreates, 0);
    assert.equal(signalCreates, 0);
    assert.equal(webhookCalls, 0);
  } finally {
    Report.findById = originals.reportFindById;
    Client.findOne = originals.clientFindOne;
    ReportRun.create = originals.reportRunCreate;
    Signal.create = originals.signalCreate;
    globalThis.fetch = originals.fetch;
  }
});

test("runDueReports applies operational archive scope before scheduler execution", async () => {
  const originalFind = Report.find;
  let schedulerQuery = null;
  markExecutionIntegrityReady([]);

  Report.find = (query) => {
    schedulerQuery = query;
    return {
      sort: async () => [],
    };
  };

  try {
    const result = await runDueReports({
      agencyId: "agency-1",
      now: new Date("2026-07-15T12:00:00.000Z"),
    });

    assert.equal(result.checkedCount, 0);
    assert.equal(
      matches(
        {
          agency_id: "agency-1",
          status: "active",
          next_run_at: new Date("2026-07-15T11:00:00.000Z"),
          is_archived: true,
        },
        schedulerQuery
      ),
      false
    );
    assert.equal(
      matches(
        {
          agency_id: "agency-1",
          status: "active",
          next_run_at: new Date("2026-07-15T11:00:00.000Z"),
        },
        schedulerQuery
      ),
      true
    );
  } finally {
    Report.find = originalFind;
  }
});

test("normal client and report list controllers apply operational archive scopes", async () => {
  const originals = {
    clientFind: Client.find,
    accountFind: MetaAdAccount.find,
    reportFind: Report.find,
    runFind: ReportRun.find,
  };
  let clientQuery = null;
  let reportQuery = null;
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

  Client.find = (query) => {
    clientQuery = query;
    return { sort: async () => [] };
  };
  MetaAdAccount.find = () => ({ lean: async () => [] });
  Report.find = (query) => {
    reportQuery = query;
    return {
      populate() {
        return this;
      },
      sort: async () => [],
    };
  };
  ReportRun.find = () => ({
    sort() {
      return this;
    },
    lean: async () => [],
  });

  try {
    const clientRes = response();
    const reportRes = response();
    await getClients({ user: { agencyId: "agency-1" } }, clientRes);
    await getReports({ user: { agencyId: "agency-1" }, query: {} }, reportRes);

    assert.equal(clientRes.statusCode, 200);
    assert.deepEqual(clientRes.payload.clients, []);
    assert.equal(reportRes.statusCode, 200);
    assert.deepEqual(reportRes.payload, []);
    assert.equal(
      matches({ agency_id: "agency-1", is_archived: true }, clientQuery),
      false
    );
    assert.equal(matches({ agency_id: "agency-1" }, clientQuery), true);
    assert.equal(
      matches({ agency_id: "agency-1", is_archived: true }, reportQuery),
      false
    );
    assert.equal(matches({ agency_id: "agency-1" }, reportQuery), true);
  } finally {
    Client.find = originals.clientFind;
    MetaAdAccount.find = originals.accountFind;
    Report.find = originals.reportFind;
    ReportRun.find = originals.runFind;
  }
});

test("archived clients are rejected by Meta assignment and report account resolution", async () => {
  const originals = {
    clientFindOne: Client.findOne,
    clientFindOneAndUpdate: Client.findOneAndUpdate,
    clientUpdateOne: Client.updateOne,
    accountFindOne: MetaAdAccount.findOne,
  };
  const archivedClient = {
    _id: "client-1",
    agency_id: "agency-1",
    name: "Northstar",
    is_archived: true,
  };

  Client.findOne = async () => archivedClient;
  Client.findOneAndUpdate = async () => null;
  Client.updateOne = async () => ({ matchedCount: 0, modifiedCount: 0 });
  MetaAdAccount.findOne = async () => ({
    _id: "account-1",
    agency_id: "agency-1",
    is_active: true,
    is_accessible: true,
  });

  const res = {
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
  };

  try {
    await assignMetaAdAccount(
      {
        user: { agencyId: "agency-1" },
        params: { adAccountId: "account-1" },
        body: { clientId: "client-1" },
      },
      res
    );

    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.code, "CLIENT_ARCHIVED");
    await assert.rejects(
      getAssignedMetaAccountForClient({
        agencyId: "agency-1",
        clientId: "client-1",
      }),
      (error) => error.code === "CLIENT_ARCHIVED" && error.status === 409
    );
  } finally {
    Client.findOne = originals.clientFindOne;
    Client.findOneAndUpdate = originals.clientFindOneAndUpdate;
    Client.updateOne = originals.clientUpdateOne;
    MetaAdAccount.findOne = originals.accountFindOne;
  }
});
