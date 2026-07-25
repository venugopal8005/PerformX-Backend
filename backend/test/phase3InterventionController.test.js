import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  getIntervention,
  getInterventions,
  getIssueInterventions,
  interventionControllerInternals,
} from "../src/controllers/interventions.controller.js";
import { Intervention, Issue } from "../src/models/index.js";

let mongo;
const objectId = () => new mongoose.Types.ObjectId();
const containsEmailKey = (value) => {
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, "email")) return true;
  return Object.values(value).some(containsEmailKey);
};

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const rawIntervention = ({
  agencyId,
  clientId,
  issueId,
  recorderId,
  performedAt,
  actionType = "monitor_only",
  status = "active",
} = {}) => ({
  _id: objectId(),
  agency_id: agencyId,
  client_id: clientId,
  issue_id: issueId,
  meta_ad_account_id: objectId(),
  campaign_id: "campaign-controller",
  report_id_at_action: objectId(),
  report_run_id_at_action: objectId(),
  performed_by_user_id: recorderId,
  performed_by_snapshot: {
    version: 1,
    captured_at: performedAt,
    display_name: "Historical Performer",
    email: "performer@example.com",
    workspace_role: "member",
    provenance: "workspace_member",
  },
  recorded_by_user_id: recorderId,
  recorded_by_snapshot: {
    version: 1,
    captured_at: performedAt,
    display_name: "Historical Recorder",
    email: "recorder@example.com",
    workspace_role: "member",
    provenance: "workspace_member",
  },
  action_type: actionType,
  action_version: 1,
  action_payload: {},
  reason: "Persisted human evidence",
  note: null,
  performed_at: performedAt,
  recorded_at: performedAt,
  status,
  revision: 0,
  idempotency_key: `private-${objectId()}`,
  request_hash: "f".repeat(64),
  createdAt: performedAt,
  updatedAt: performedAt,
});

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { autoIndex: false, autoCreate: false });
});

beforeEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({}))
  );
});

after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test("global history requires a bounded approved filter and validates filter values", () => {
  const clientId = String(objectId());
  assert.throws(
    () => interventionControllerInternals.parseListFilters({}),
    (error) => error.code === "INTERVENTION_FILTER_REQUIRED" && error.status === 400
  );
  assert.throws(
    () => interventionControllerInternals.parseListFilters({ actionType: "invented_action" }),
    (error) => error.code === "INTERVENTION_VALIDATION_FAILED"
  );
  assert.deepEqual(
    interventionControllerInternals.parseListFilters({
      clientId,
      actionType: "monitor_only",
      status: "active",
    }),
    {
      client_id: clientId,
      action_type: "monitor_only",
      status: "active",
    }
  );
});

test("global history is agency-scoped, cursor-paginated, and safely serialized", async () => {
  const agencyId = objectId();
  const foreignAgencyId = objectId();
  const clientId = objectId();
  const issueId = objectId();
  const recorderId = objectId();
  const documents = [
    rawIntervention({ agencyId, clientId, issueId, recorderId, performedAt: new Date("2026-07-17T12:00:00Z") }),
    rawIntervention({ agencyId, clientId, issueId, recorderId, performedAt: new Date("2026-07-17T11:00:00Z") }),
    rawIntervention({ agencyId, clientId, issueId, recorderId, performedAt: new Date("2026-07-17T10:00:00Z") }),
    rawIntervention({ agencyId: foreignAgencyId, clientId, issueId, recorderId, performedAt: new Date("2026-07-17T13:00:00Z") }),
  ];
  await Intervention.collection.insertMany(documents);

  const first = response();
  await getInterventions(
    { user: { agencyId }, query: { clientId: String(clientId), limit: "2" } },
    first
  );
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.interventions.length, 2);
  assert.equal(first.body.page.hasMore, true);
  assert.ok(first.body.page.nextCursor);
  assert.equal(first.body.interventions[0].id, String(documents[0]._id));
  assert.equal("request_hash" in first.body.interventions[0], false);
  assert.equal("requestHash" in first.body.interventions[0], false);
  assert.equal("idempotencyKey" in first.body.interventions[0], false);
  assert.equal(first.body.interventions[0].performedBy.email, undefined);
  assert.equal(containsEmailKey(first.body), false);

  const second = response();
  await getInterventions(
    {
      user: { agencyId },
      query: {
        clientId: String(clientId),
        limit: "2",
        cursor: first.body.page.nextCursor,
      },
    },
    second
  );
  assert.equal(second.body.interventions.length, 1);
  assert.equal(second.body.interventions[0].id, String(documents[2]._id));
  assert.equal(second.body.page.hasMore, false);
});

test("invalid cursor and pagination values return controlled 400 responses", async () => {
  const agencyId = objectId();
  const clientId = objectId();
  const invalidCursor = response();
  await getInterventions(
    { user: { agencyId }, query: { clientId: String(clientId), cursor: "not-a-cursor" } },
    invalidCursor
  );
  assert.equal(invalidCursor.statusCode, 400);
  assert.equal(invalidCursor.body.code, "INVALID_CURSOR");

  const invalidLimit = response();
  await getInterventions(
    { user: { agencyId }, query: { clientId: String(clientId), limit: "0" } },
    invalidLimit
  );
  assert.equal(invalidLimit.statusCode, 400);
  assert.equal(invalidLimit.body.code, "INVALID_PAGINATION_LIMIT");
});

test("Issue history stays readable without consulting mutable Client archive state", async () => {
  const agencyId = objectId();
  const issueId = objectId();
  const clientId = objectId();
  const recorderId = objectId();
  await Issue.collection.insertOne({ _id: issueId, agency_id: agencyId, client_id: clientId });
  const intervention = rawIntervention({
    agencyId,
    clientId,
    issueId,
    recorderId,
    performedAt: new Date("2026-07-17T12:00:00Z"),
  });
  await Intervention.collection.insertOne(intervention);
  const res = response();
  await getIssueInterventions(
    { user: { agencyId }, params: { issueId: String(issueId) }, query: {} },
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.interventions[0].id, String(intervention._id));
  assert.equal(containsEmailKey(res.body), false);
});

test("foreign and missing route identities return the same non-disclosing 404", async () => {
  const agencyId = objectId();
  const foreignAgencyId = objectId();
  const clientId = objectId();
  const issueId = objectId();
  const recorderId = objectId();
  const intervention = rawIntervention({
    agencyId: foreignAgencyId,
    clientId,
    issueId,
    recorderId,
    performedAt: new Date("2026-07-17T12:00:00Z"),
  });
  await Intervention.collection.insertOne(intervention);
  const foreign = response();
  const missing = response();
  await getIntervention(
    { user: { agencyId }, params: { interventionId: String(intervention._id) } },
    foreign
  );
  await getIntervention(
    { user: { agencyId }, params: { interventionId: String(objectId()) } },
    missing
  );
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(foreign.body, missing.body);
  assert.equal(JSON.stringify(foreign.body).includes(String(foreignAgencyId)), false);
});

test("detail serializer exposes immutable snapshots and permission booleans without private helpers", async () => {
  const agencyId = objectId();
  const clientId = objectId();
  const issueId = objectId();
  const recorderId = objectId();
  const intervention = rawIntervention({
    agencyId,
    clientId,
    issueId,
    recorderId,
    performedAt: new Date("2026-07-17T12:00:00Z"),
  });
  await Intervention.collection.insertOne(intervention);
  const res = response();
  await getIntervention(
    {
      user: { agencyId, id: recorderId },
      workspaceMembership: { role: "member" },
      params: { interventionId: String(intervention._id) },
    },
    res
  );
  assert.equal(res.body.intervention.permissions.canCorrect, true);
  assert.equal(res.body.intervention.permissions.canCancel, true);
  assert.equal(res.body.intervention.recordedBy.displayName, "Historical Recorder");
  assert.equal(containsEmailKey(res.body), false);
  assert.equal("request_hash" in res.body.intervention, false);
  assert.equal("idempotency_key" in res.body.intervention, false);
  assert.equal("__v" in res.body.intervention, false);
});

test("routes require authentication and active membership and expose no destructive update", async () => {
  const [issueRoutes, interventionRoutes] = await Promise.all([
    fs.readFile(new URL("../src/routes/issues.routes.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../src/routes/interventions.routes.js", import.meta.url), "utf8"),
  ]);
  assert.match(
    issueRoutes,
    /post\("\/:issueId\/interventions", protect, requireWorkspaceMember, createIssueIntervention\)/
  );
  assert.match(interventionRoutes, /get\("\/", protect, requireWorkspaceMember, getInterventions\)/);
  assert.match(interventionRoutes, /get\("\/:interventionId", protect, requireWorkspaceMember, getIntervention\)/);
  assert.match(interventionRoutes, /post\("\/:interventionId\/cancel", protect, requireWorkspaceMember, cancelIntervention\)/);
  assert.match(
    interventionRoutes,
    /post\(\s*"\/:interventionId\/corrections",\s*protect,\s*requireWorkspaceMember,\s*correctIntervention\s*\)/
  );
  assert.doesNotMatch(interventionRoutes, /\.delete\(/);
  assert.doesNotMatch(interventionRoutes, /\.patch\(/);
  assert.doesNotMatch(interventionRoutes, /\.put\(/);
});

test("unexpected controller failures do not disclose raw internal errors", () => {
  const res = response();
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    interventionControllerInternals.handleError(
      res,
      new Error("private internal failure detail"),
      "test"
    );
  } finally {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "INTERNAL_SERVER_ERROR");
  assert.equal(JSON.stringify(res.body).includes("private internal"), false);
});
