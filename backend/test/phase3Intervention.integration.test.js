import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Activity,
  Agency,
  Client,
  Intervention,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
  User,
  WorkspaceMember,
} from "../src/models/index.js";
import {
  cancelIntervention,
  correctIntervention,
  createIntervention,
} from "../src/services/intervention.service.js";
import { archiveClientLifecycle } from "../src/services/archiveLifecycle.service.js";
import { assignMetaAdAccount } from "../src/controllers/settings.controller.js";
import {
  acquireRequiredClientLifecycleLeases,
  orderedUniqueClientIds,
} from "../src/services/clientLifecycle.service.js";
import { runRequiredTransaction } from "../src/services/requiredTransaction.service.js";
import {
  applyPhase3InterventionIndexes,
  initializePhase3InterventionIntegrity,
  resetPhase3InterventionIntegrityReadiness,
} from "../src/services/phase3InterventionIndexes.service.js";

let replicaSet;
let sequence = 0;
const objectId = () => new mongoose.Types.ObjectId();
const now = new Date("2026-07-17T12:00:00.000Z");
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const createScenario = async ({ operationalMeta = false } = {}) => {
  sequence += 1;
  const agency = await Agency.create({ name: `Phase Three ${sequence}`, slug: `phase-three-${sequence}` });
  const owner = await User.create({
    agency_id: agency._id,
    full_name: "Workspace Owner",
    email: `owner-${sequence}@example.com`,
    role: "owner",
  });
  const member = await User.create({
    agency_id: agency._id,
    full_name: "Performance Analyst",
    email: `member-${sequence}@example.com`,
    role: "member",
  });
  await WorkspaceMember.create([
    { workspace_id: agency._id, user_id: owner._id, role: "owner", status: "active" },
    { workspace_id: agency._id, user_id: member._id, role: "member", status: "active" },
  ]);
  const client = await Client.create({ agency_id: agency._id, name: "Acme", status: "stable" });
  const connection = await MetaConnection.create({
    agency_id: agency._id,
    connection_scope: "workspace",
    client_id: null,
    status: operationalMeta ? "active" : "revoked",
    is_active: operationalMeta,
  });
  const account = await MetaAdAccount.create({
    agency_id: agency._id,
    meta_connection_id: connection._id,
    client_id: client._id,
    assignment_scope: "v1",
    ad_account_id: `act_phase3_${sequence}`,
    name: "Acme Ads",
    is_active: operationalMeta,
    is_accessible: operationalMeta,
  });
  const report = await Report.create({
    agency_id: agency._id,
    client_id: client._id,
    meta_ad_account_id: account._id,
    created_by: owner._id,
    name: "Daily Monitor",
    type: "daily",
    status: "active",
    severity: "medium",
    monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Prospecting" }],
    schedule: { timezone: "UTC", time_of_day: "09:00" },
  });
  const run = await ReportRun.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    meta_ad_account_id: account._id,
    meta_account_external_id_snapshot: account.ad_account_id,
    meta_account_name_snapshot: account.name,
    trigger_type: "manual",
    execution_key: `phase3-run-${sequence}`,
    execution_stage: "completed",
    status: "ok",
    severity: "medium",
    monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Prospecting" }],
    context_snapshot: {
      version: 1,
      captured_at: new Date("2026-07-16T12:00:00.000Z"),
      source: "execution",
      workspace: { name: agency.name },
      client: { name: client.name },
      report: { name: report.name },
      actor: { name: owner.full_name },
    },
    ran_at: new Date("2026-07-16T12:00:00.000Z"),
  });
  const issueId = objectId();
  const signal = await Signal.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    report_run_id: run._id,
    issue_id: issueId,
    issue_occurrence_number: 1,
    issue_fingerprint_snapshot: "a".repeat(64),
    matched_at: new Date("2026-07-16T12:00:00.000Z"),
    matching_version: 1,
    issue_matching_status: "matched",
    campaign_id: "campaign-1",
    scope: {
      version: 1,
      agency_id: agency._id,
      client_id: client._id,
      meta_ad_account_id: account._id,
      entity: { level: "campaign", id: "campaign-1", campaign_id: "campaign-1" },
      classification: { archetype: "ctr_decline", metric_family: "ctr" },
      comparison: { cadence: "daily", timezone: "UTC" },
    },
    fingerprint: "a".repeat(64),
    fingerprint_version: 1,
    context_snapshot: {
      version: 1,
      captured_at: new Date("2026-07-16T12:00:00.000Z"),
      source: "execution",
      workspace: { name: agency.name },
      client: { name: client.name },
      report: { name: report.name },
      meta_account: {
        meta_ad_account_id: account._id,
        external_account_id: account.ad_account_id,
        name: account.name,
      },
      campaigns: [{ campaign_id: "campaign-1", campaign_name: "Prospecting" }],
    },
    type: "ctr_decline",
    severity: "critical",
    title: "CTR declined",
    description: "CTR declined materially.",
    recommendation: "Review creative fit.",
    detected_at: new Date("2026-07-16T12:00:00.000Z"),
  });
  const issue = await Issue.create({
    _id: issueId,
    agency_id: agency._id,
    client_id: client._id,
    meta_ad_account_id: account._id,
    fingerprint: "a".repeat(64),
    fingerprint_version: 1,
    active_fingerprint: "a".repeat(64),
    scope: signal.scope,
    archetype: "ctr_decline",
    metric_family: "ctr",
    origin_report_id: report._id,
    latest_report_id: report._id,
    report_ids: [report._id],
    status: "open",
    opened_at: new Date("2026-07-16T12:00:00.000Z"),
    last_seen_at: new Date("2026-07-16T12:00:00.000Z"),
    occurrence_count: 1,
    first_signal_id: signal._id,
    latest_signal_id: signal._id,
    latest_report_run_id: run._id,
    current_severity: "critical",
    previous_severity: "moderate",
    trend: "escalating",
    absence_streak: 2,
    last_observation_key: "observation-1",
    last_observation_end: new Date("2026-07-16T00:00:00.000Z"),
    latest_evidence: {
      kind: "signal",
      signal_id: signal._id,
      report_run_id: run._id,
      observed_at: signal.detected_at,
      severity: "critical",
      title: signal.title,
      summary: signal.description,
      provenance: "snapshot",
    },
    title: signal.title,
    summary: signal.description,
    lifecycle_revision: 7,
  });
  return { agency, owner, member, client, connection, account, report, run, signal, issue };
};

const createInput = (overrides = {}) => ({
  idempotencyKey: `create-request-${sequence}-123456`,
  expectedIssueRevision: 7,
  actionType: "decrease_budget",
  actionPayload: { mode: "percent", amount: 20 },
  reason: "Protect efficiency while creative is refreshed",
  performedAt: "2026-07-17T11:00:00.000Z",
  ...overrides,
});

const lifecycleState = (issue) => ({
  status: issue.status,
  current_severity: issue.current_severity,
  previous_severity: issue.previous_severity,
  trend: issue.trend,
  absence_streak: issue.absence_streak,
  last_observation_key: issue.last_observation_key,
  last_observation_end: issue.last_observation_end?.toISOString(),
  latest_evidence: issue.latest_evidence.toObject(),
  lifecycle_revision: issue.lifecycle_revision,
});

const controllerResponse = () => ({
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

const assignAccount = async ({ scenario, clientId, confirmReassignment = true }) => {
  const res = controllerResponse();
  await assignMetaAdAccount(
    {
      user: { agencyId: scenario.agency._id, id: scenario.owner._id },
      params: { adAccountId: String(scenario.account._id) },
      body: {
        ...(clientId ? { clientId: String(clientId) } : {}),
        confirmReassignment,
      },
    },
    res
  );
  return res;
};

const interventionModels = (InterventionModel = Intervention) => ({
  Activity,
  Client,
  Intervention: InterventionModel,
  Issue,
  MetaAdAccount,
  Report,
  ReportRun,
  Signal,
  User,
  WorkspaceMember,
});

const interventionModelWithHiddenIdempotencyReads = (idempotencyKey) => {
  let hiddenReads = 0;
  let duplicateKeyErrors = 0;
  return {
    model: {
      findOne(filter = {}) {
        if (filter.idempotency_key === idempotencyKey && hiddenReads < 2) {
          hiddenReads += 1;
          return Intervention.findOne({ _id: objectId() });
        }
        return Intervention.findOne(filter);
      },
      async create(...args) {
        try {
          return await Intervention.create(...args);
        } catch (error) {
          if (error?.code === 11000) duplicateKeyErrors += 1;
          throw error;
        }
      },
    },
    duplicateKeyErrors: () => duplicateKeyErrors,
  };
};

before(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replicaSet.getUri(), { autoIndex: false, autoCreate: false });
  await applyPhase3InterventionIndexes({ collection: Intervention.collection, logger: { log() {} } });
  await Activity.collection.createIndex({ idempotency_key: 1 }, { unique: true, sparse: true });
  await initializePhase3InterventionIntegrity({ collection: Intervention.collection });
});

beforeEach(async () => {
  await Promise.all(Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})));
});

after(async () => {
  resetPhase3InterventionIntegrityReadiness();
  await mongoose.disconnect();
  await replicaSet?.stop();
});

test("creation records human evidence transactionally without changing Issue lifecycle", async () => {
  const scenario = await createScenario();
  const beforeState = lifecycleState(scenario.issue);
  const result = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  });
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.intervention.performed_by_snapshot.provenance, "workspace_member");
  assert.equal(result.intervention.scope_snapshot.campaign.name, "Prospecting");
  const updatedIssue = await Issue.findById(scenario.issue._id);
  assert.deepEqual(lifecycleState(updatedIssue), beforeState);
  assert.equal(updatedIssue.intervention_count, 1);
  assert.equal(updatedIssue.intervention_revision, 1);
  assert.equal(String(updatedIssue.latest_intervention_id), String(result.intervention._id));
  assert.equal(await Activity.countDocuments({ type: "intervention_recorded" }), 1);
});

test("Intervention model blocks general, nested, replacement, pipeline, and forged lifecycle query mutations", async () => {
  const scenario = await createScenario();
  const created = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  });
  const activeFilter = {
    _id: created.intervention._id,
    agency_id: scenario.agency._id,
    status: "active",
    revision: 0,
  };
  const rejected = (operation) =>
    assert.rejects(
      operation,
      (error) => error.code === "INTERVENTION_QUERY_MUTATION_REJECTED"
    );

  await rejected(
    Intervention.updateOne(
      { _id: created.intervention._id },
      { $set: { "action_payload.budget_amount": 99 } }
    )
  );
  await rejected(
    Intervention.updateOne(
      { _id: created.intervention._id },
      { $set: { "issue_snapshot.title": "Rewritten evidence" } }
    )
  );
  await rejected(
    Intervention.findOneAndUpdate(
      { _id: created.intervention._id },
      { $set: { reason: "Rewritten reason" } }
    )
  );
  await rejected(
    Intervention.updateMany(
      { agency_id: scenario.agency._id },
      { $set: { status: "cancelled" } }
    )
  );
  await rejected(
    Intervention.replaceOne(
      { _id: created.intervention._id },
      created.intervention.toObject()
    )
  );
  await rejected(
    Intervention.updateOne(
      activeFilter,
      { $set: { status: "cancelled" }, $inc: { revision: 1 } },
      { phase3InternalOperation: "invented_operation" }
    )
  );
  await rejected(
    Intervention.findOneAndUpdate(
      activeFilter,
      {
        $set: {
          status: "superseded",
          superseded_by_intervention_id: objectId(),
          corrected_at: now,
          corrected_by_user_id: scenario.member._id,
          corrected_by_snapshot: created.intervention.recorded_by_snapshot,
          updatedAt: now,
          reason: "Forbidden extra mutation",
        },
        $inc: { revision: 1 },
      },
      { phase3InternalOperation: "supersede", timestamps: false }
    )
  );
  await rejected(
    Intervention.updateOne(
      activeFilter,
      {
        $set: {
          status: "cancelled",
          cancellation: null,
          updatedAt: now,
        },
        $inc: { revision: 1 },
        $unset: { reason: 1 },
      },
      { phase3InternalOperation: "cancel", timestamps: false }
    )
  );
  await rejected(
    Intervention.updateOne(
      { ...activeFilter, _id: { $in: [created.intervention._id] } },
      {
        $set: {
          status: "cancelled",
          cancellation: null,
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
      { phase3InternalOperation: "cancel", timestamps: false }
    )
  );
  await rejected(
    Intervention.updateOne(
      activeFilter,
      {
        $set: {
          status: "cancelled",
          cancellation: null,
          updatedAt: now,
        },
        $inc: { revision: 1 },
      },
      { phase3InternalOperation: "cancel", timestamps: false }
    )
  );
  await rejected(
    Intervention.updateOne(
      activeFilter,
      [{ $set: { status: "cancelled" } }],
      {
        phase3InternalOperation: "cancel",
        timestamps: false,
        updatePipeline: true,
      }
    )
  );

  const storedActive = await Intervention.findById(created.intervention._id);
  assert.equal(storedActive.status, "active");
  assert.equal(storedActive.revision, 0);
  assert.equal(storedActive.action_payload.budget_amount, 20);
  assert.equal(storedActive.issue_snapshot.title, scenario.issue.title);

  const cancelled = await cancelIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    interventionId: created.intervention._id,
    input: {
      idempotencyKey: `model-cancel-${sequence}-123456789`,
      expectedRevision: 0,
      reason: "Original cancellation evidence",
    },
    now: new Date(now.getTime() + 1000),
  });
  await rejected(
    Intervention.updateOne(
      { _id: cancelled.intervention._id },
      { $set: { "cancellation.reason": "Overwritten cancellation" } }
    )
  );
  await rejected(
    Intervention.updateOne(
      { _id: cancelled.intervention._id },
      { $set: { corrected_at: new Date(now.getTime() + 2000) } }
    )
  );
  const storedCancelled = await Intervention.findById(cancelled.intervention._id);
  assert.equal(storedCancelled.cancellation.reason, "Original cancellation evidence");
  assert.equal(storedCancelled.corrected_at, null);
});

test("self, workspace member, and manual performer modes preserve attribution", async () => {
  const scenario = await createScenario();
  const self = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  });
  const issueAfterSelf = await Issue.findById(scenario.issue._id);
  const workspace = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput({
      idempotencyKey: `workspace-performer-${sequence}-123`,
      performedBy: { mode: "workspace_member", userId: scenario.owner._id },
      expectedIssueRevision: issueAfterSelf.lifecycle_revision,
    }),
    now: new Date(now.getTime() + 1000),
  });
  const manual = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput({
      idempotencyKey: `manual-performer-${sequence}-12345`,
      performedBy: { mode: "manual", displayName: "External Buyer", email: "BUYER@EXAMPLE.COM" },
    }),
    now: new Date(now.getTime() + 2000),
  });
  assert.equal(String(self.intervention.performed_by_user_id), String(scenario.member._id));
  assert.equal(String(workspace.intervention.performed_by_user_id), String(scenario.owner._id));
  assert.equal(manual.intervention.performed_by_user_id, null);
  assert.equal(manual.intervention.performed_by_snapshot.email, "buyer@example.com");
  assert.equal(manual.intervention.performed_by_snapshot.provenance, "manual");
});

test("creation is idempotent and semantic key reuse conflicts", async () => {
  const scenario = await createScenario();
  const input = createInput();
  const first = await createIntervention({ agencyId: scenario.agency._id, recorder: { id: scenario.member._id }, issueId: scenario.issue._id, input, now });
  const replay = await createIntervention({ agencyId: scenario.agency._id, recorder: { id: scenario.member._id }, issueId: scenario.issue._id, input, now });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(String(replay.intervention._id), String(first.intervention._id));
  await assert.rejects(
    createIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      issueId: scenario.issue._id,
      input: { ...input, reason: "Different semantic request" },
      now,
    }),
    (error) => error.code === "INTERVENTION_IDEMPOTENCY_CONFLICT"
  );
  assert.equal(await Intervention.countDocuments(), 1);
});

test("creation recovers from a persisted MongoDB duplicate-key race without duplicate side effects", async () => {
  const scenario = await createScenario();
  const input = createInput();
  const committed = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input,
    now,
  });
  const hidden = interventionModelWithHiddenIdempotencyReads(input.idempotencyKey);
  const recovered = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input,
    now,
    Models: interventionModels(hidden.model),
  });

  assert.equal(hidden.duplicateKeyErrors(), 1);
  assert.equal(recovered.idempotentReplay, true);
  assert.equal(String(recovered.intervention._id), String(committed.intervention._id));
  assert.equal(await Intervention.countDocuments({ issue_id: scenario.issue._id }), 1);
  assert.equal(await Activity.countDocuments({ type: "intervention_recorded" }), 1);
  const issue = await Issue.findById(scenario.issue._id);
  assert.equal(issue.intervention_count, 1);
  assert.equal(issue.intervention_revision, 1);
});

test("creation duplicate-key recovery returns semantic conflict and preserves committed state", async () => {
  const scenario = await createScenario();
  const input = createInput();
  const committed = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input,
    now,
  });
  const hidden = interventionModelWithHiddenIdempotencyReads(input.idempotencyKey);
  await assert.rejects(
    createIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      issueId: scenario.issue._id,
      input: { ...input, reason: "Different semantic request after the persisted race" },
      now,
      Models: interventionModels(hidden.model),
    }),
    (error) => error.code === "INTERVENTION_IDEMPOTENCY_CONFLICT"
  );

  assert.equal(hidden.duplicateKeyErrors(), 1);
  assert.equal(await Intervention.countDocuments({ issue_id: scenario.issue._id }), 1);
  assert.equal(await Activity.countDocuments({ type: "intervention_recorded" }), 1);
  const [stored, issue] = await Promise.all([
    Intervention.findById(committed.intervention._id),
    Issue.findById(scenario.issue._id),
  ]);
  assert.equal(stored.reason, input.reason);
  assert.equal(issue.intervention_count, 1);
  assert.equal(issue.intervention_revision, 1);
});

test("creation rejects stale Issue lineage and unavailable workspace actors before writing", async () => {
  const stale = await createScenario();
  await assert.rejects(
    createIntervention({
      agencyId: stale.agency._id,
      recorder: { id: stale.member._id },
      issueId: stale.issue._id,
      input: createInput({ expectedIssueRevision: 6 }),
      now,
    }),
    (error) => error.code === "INTERVENTION_ISSUE_STALE"
  );

  const inactive = await createScenario();
  await WorkspaceMember.updateOne(
    { workspace_id: inactive.agency._id, user_id: inactive.member._id },
    { $set: { status: "removed" } }
  );
  await assert.rejects(
    createIntervention({
      agencyId: inactive.agency._id,
      recorder: { id: inactive.member._id },
      issueId: inactive.issue._id,
      input: createInput(),
      now,
    }),
    (error) => error.code === "INTERVENTION_PERMISSION_DENIED"
  );

  const performer = await createScenario();
  const foreignAgency = await Agency.create({
    name: `Foreign ${sequence}`,
    slug: `foreign-${sequence}`,
  });
  const foreignUser = await User.create({
    agency_id: foreignAgency._id,
    full_name: "Foreign Member",
    email: `foreign-${sequence}@example.com`,
    role: "member",
  });
  await WorkspaceMember.create({
    workspace_id: foreignAgency._id,
    user_id: foreignUser._id,
    role: "member",
    status: "active",
  });
  await assert.rejects(
    createIntervention({
      agencyId: performer.agency._id,
      recorder: { id: performer.member._id },
      issueId: performer.issue._id,
      input: createInput({
        performedBy: { mode: "workspace_member", userId: foreignUser._id },
      }),
      now,
    }),
    (error) => error.code === "INTERVENTION_PERMISSION_DENIED"
  );
  assert.equal(await Intervention.countDocuments(), 0);
});

test("archived Client and reassigned account block writes while revoked connection does not", async () => {
  const allowed = await createScenario();
  await createIntervention({ agencyId: allowed.agency._id, recorder: { id: allowed.member._id }, issueId: allowed.issue._id, input: createInput(), now });
  const archived = await createScenario();
  await Client.updateOne({ _id: archived.client._id }, { $set: { is_archived: true, archived_at: now } });
  await assert.rejects(
    createIntervention({ agencyId: archived.agency._id, recorder: { id: archived.member._id }, issueId: archived.issue._id, input: createInput(), now }),
    (error) => error.code === "CLIENT_ARCHIVED"
  );
  const reassigned = await createScenario();
  await MetaAdAccount.updateOne({ _id: reassigned.account._id }, { $set: { client_id: objectId() } });
  await assert.rejects(
    createIntervention({ agencyId: reassigned.agency._id, recorder: { id: reassigned.member._id }, issueId: reassigned.issue._id, input: createInput(), now }),
    (error) => error.code === "INTERVENTION_OWNERSHIP_CONFLICT"
  );
  const wrongCampaign = await createScenario();
  await Signal.updateOne(
    { _id: wrongCampaign.signal._id },
    {
      $set: {
        campaign_id: "campaign-other",
        "scope.entity.campaign_id": "campaign-other",
        "scope.entity.id": "campaign-other",
      },
    }
  );
  await assert.rejects(
    createIntervention({
      agencyId: wrongCampaign.agency._id,
      recorder: { id: wrongCampaign.member._id },
      issueId: wrongCampaign.issue._id,
      input: createInput(),
      now,
    }),
    (error) => error.code === "INTERVENTION_OWNERSHIP_CONFLICT"
  );
});

test("correction creates immutable successor and owner permission preserves Issue lifecycle", async () => {
  const scenario = await createScenario();
  const beforeState = lifecycleState(scenario.issue);
  const created = await createIntervention({ agencyId: scenario.agency._id, recorder: { id: scenario.member._id }, issueId: scenario.issue._id, input: createInput(), now });
  const corrected = await correctIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.owner._id },
    interventionId: created.intervention._id,
    input: {
      idempotencyKey: `correction-${sequence}-123456789`,
      expectedRevision: 0,
      actionType: "monitor_only",
      actionPayload: {},
      reason: "Correction: budget was not changed",
      performedAt: "2026-07-17T11:00:00.000Z",
    },
    now: new Date(now.getTime() + 1000),
  });
  const original = await Intervention.findById(created.intervention._id);
  assert.equal(original.status, "superseded");
  assert.equal(String(original.superseded_by_intervention_id), String(corrected.intervention._id));
  assert.equal(String(corrected.intervention.supersedes_intervention_id), String(original._id));
  assert.equal(corrected.intervention.issue_snapshot.title, original.issue_snapshot.title);
  const issue = await Issue.findById(scenario.issue._id);
  assert.deepEqual(lifecycleState(issue), beforeState);
  assert.equal(issue.intervention_count, 2);
  assert.equal(issue.intervention_revision, 2);
  assert.equal(await Activity.countDocuments({ type: "intervention_corrected" }), 1);
});

test("correction permission, replay, and semantic conflict fail closed", async () => {
  const scenario = await createScenario();
  const created = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.owner._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  });
  const input = {
    idempotencyKey: `correction-contract-${sequence}-123456`,
    expectedRevision: 0,
    actionType: "monitor_only",
    actionPayload: {},
    reason: "Correct the original record",
    performedAt: "2026-07-17T11:00:00.000Z",
  };
  let failEvaluation = true;
  const evaluated = [];
  const evaluationProcessor = async ({ interventionId }) => {
    if (failEvaluation) throw new Error("injected correction invalidation failure");
    evaluated.push(String(interventionId));
  };
  await assert.rejects(
    correctIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      interventionId: created.intervention._id,
      input,
      now: new Date(now.getTime() + 1000),
    }),
    (error) => error.code === "INTERVENTION_PERMISSION_DENIED"
  );
  const first = await correctIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.owner._id },
    interventionId: created.intervention._id,
    input,
    now: new Date(now.getTime() + 1000),
    evaluationProcessor,
  });
  failEvaluation = false;
  const replay = await correctIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.owner._id },
    interventionId: created.intervention._id,
    input,
    now: new Date(now.getTime() + 1000),
    evaluationProcessor,
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(String(replay.intervention._id), String(first.intervention._id));
  assert.deepEqual(new Set(evaluated), new Set([String(created.intervention._id), String(first.intervention._id)]));
  await assert.rejects(
    correctIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.owner._id },
      interventionId: created.intervention._id,
      input: { ...input, reason: "Different correction" },
      now: new Date(now.getTime() + 1000),
    }),
    (error) => error.code === "INTERVENTION_IDEMPOTENCY_CONFLICT"
  );
});

test("cancellation is write-once, idempotent, and does not alter Issue caches or lifecycle", async () => {
  const scenario = await createScenario();
  const created = await createIntervention({ agencyId: scenario.agency._id, recorder: { id: scenario.member._id }, issueId: scenario.issue._id, input: createInput(), now });
  const issueBefore = await Issue.findById(scenario.issue._id);
  const beforeState = lifecycleState(issueBefore);
  const input = { idempotencyKey: `cancel-${sequence}-123456789`, expectedRevision: 0, reason: "Entry was recorded in error" };
  let failEvaluation = true;
  let recoveredEvaluations = 0;
  const evaluationProcessor = async () => {
    if (failEvaluation) throw new Error("injected cancellation invalidation failure");
    recoveredEvaluations += 1;
  };
  const cancelled = await cancelIntervention({ agencyId: scenario.agency._id, recorder: { id: scenario.member._id }, interventionId: created.intervention._id, input, now: new Date(now.getTime() + 1000), evaluationProcessor });
  failEvaluation = false;
  const replay = await cancelIntervention({ agencyId: scenario.agency._id, recorder: { id: scenario.member._id }, interventionId: created.intervention._id, input, now: new Date(now.getTime() + 1000), evaluationProcessor });
  assert.equal(cancelled.intervention.status, "cancelled");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(recoveredEvaluations, 1);
  const issueAfter = await Issue.findById(scenario.issue._id);
  assert.deepEqual(lifecycleState(issueAfter), beforeState);
  assert.equal(issueAfter.intervention_count, issueBefore.intervention_count);
  assert.equal(String(issueAfter.latest_intervention_id), String(issueBefore.latest_intervention_id));
  assert.equal(await Activity.countDocuments({ type: "intervention_cancelled" }), 1);
});

test("cancellation permission and semantic idempotency conflict are enforced", async () => {
  const scenario = await createScenario();
  const created = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.owner._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  });
  const input = {
    idempotencyKey: `cancel-contract-${sequence}-123456789`,
    expectedRevision: 0,
    reason: "Incorrectly recorded action",
  };
  await assert.rejects(
    cancelIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      interventionId: created.intervention._id,
      input,
      now: new Date(now.getTime() + 1000),
    }),
    (error) => error.code === "INTERVENTION_PERMISSION_DENIED"
  );
  await cancelIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.owner._id },
    interventionId: created.intervention._id,
    input,
    now: new Date(now.getTime() + 1000),
  });
  await assert.rejects(
    cancelIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.owner._id },
      interventionId: created.intervention._id,
      input: { ...input, reason: "Different cancellation evidence" },
      now: new Date(now.getTime() + 1000),
    }),
    (error) => error.code === "INTERVENTION_IDEMPOTENCY_CONFLICT"
  );
});

test("simultaneous double-click creation resolves to one Intervention and one replay", async () => {
  const scenario = await createScenario();
  const options = {
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  };
  const results = await Promise.all([
    createIntervention(options),
    createIntervention(options),
  ]);
  assert.deepEqual(results.map((item) => item.idempotentReplay).sort(), [false, true]);
  assert.equal(String(results[0].intervention._id), String(results[1].intervention._id));
  assert.equal(await Intervention.countDocuments({ issue_id: scenario.issue._id }), 1);
  assert.equal(await Activity.countDocuments({ type: "intervention_recorded" }), 1);
});

test("two simultaneous distinct actions serialize through the Client lease without losing evidence", async () => {
  const scenario = await createScenario();
  const [first, second] = await Promise.all([
    createIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      issueId: scenario.issue._id,
      input: createInput(),
      now,
    }),
    createIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      issueId: scenario.issue._id,
      input: createInput({
        idempotencyKey: `simultaneous-distinct-${sequence}-123456`,
        actionType: "monitor_only",
        actionPayload: {},
        reason: "Observe the next complete delivery window",
      }),
      now: new Date(now.getTime() + 1000),
    }),
  ]);
  assert.notEqual(String(first.intervention._id), String(second.intervention._id));
  const issue = await Issue.findById(scenario.issue._id);
  assert.equal(issue.intervention_count, 2);
  assert.equal(issue.intervention_revision, 2);
  assert.equal(await Intervention.countDocuments({ issue_id: scenario.issue._id }), 2);
});

test("correction race creates exactly one direct successor", async () => {
  const scenario = await createScenario();
  const created = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  });
  const correction = (suffix, reason) =>
    correctIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      interventionId: created.intervention._id,
      input: {
        idempotencyKey: `correction-race-${sequence}-${suffix}-123456`,
        expectedRevision: 0,
        actionType: "monitor_only",
        actionPayload: {},
        reason,
        performedAt: "2026-07-17T11:00:00.000Z",
      },
      now: new Date(now.getTime() + 1000),
    });
  const results = await Promise.allSettled([
    correction("first", "First correction evidence"),
    correction("second", "Second correction evidence"),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(
    results.find((item) => item.status === "rejected").reason.code,
    "INTERVENTION_INVALID_STATE"
  );
  assert.equal(
    await Intervention.countDocuments({ supersedes_intervention_id: created.intervention._id }),
    1
  );
});

test("cancellation race records one write-once terminal event", async () => {
  const scenario = await createScenario();
  const created = await createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
  });
  const cancel = (suffix) =>
    cancelIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      interventionId: created.intervention._id,
      input: {
        idempotencyKey: `cancel-race-${sequence}-${suffix}-123456789`,
        expectedRevision: 0,
        reason: `Cancellation evidence ${suffix}`,
      },
      now: new Date(now.getTime() + 1000),
    });
  const results = await Promise.allSettled([cancel("first"), cancel("second")]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  const stored = await Intervention.findById(created.intervention._id);
  assert.equal(stored.status, "cancelled");
  assert.equal(stored.revision, 1);
  assert.equal(await Activity.countDocuments({ type: "intervention_cancelled" }), 1);
});

test("stale Client lease holder is fenced before any Intervention evidence is written", async () => {
  const scenario = await createScenario();
  const staleRunner = async ({ work }) => {
    await Client.updateOne(
      { _id: scenario.client._id },
      { $set: { "lifecycle_lock.token": "replacement-lease-holder" } }
    );
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  };
  await assert.rejects(
    createIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      issueId: scenario.issue._id,
      input: createInput(),
      now,
      transactionRunner: staleRunner,
    }),
    (error) => error.code === "client_lifecycle_lease_lost"
  );
  assert.equal(await Intervention.countDocuments(), 0);
  assert.equal(await Activity.countDocuments({ type: "intervention_recorded" }), 0);
  const client = await Client.findById(scenario.client._id).select("+lifecycle_lock");
  assert.equal(client.lifecycle_lock.token, "replacement-lease-holder");
});

test("transaction failure rolls back Intervention, Issue cache, and Activity together", async () => {
  const scenario = await createScenario();
  const rollbackRunner = async ({ work }) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await work(session);
        throw new Error("forced Phase 3 rollback");
      });
    } finally {
      await session.endSession();
    }
  };
  await assert.rejects(
    createIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      issueId: scenario.issue._id,
      input: createInput(),
      now,
      transactionRunner: rollbackRunner,
    }),
    /forced Phase 3 rollback/
  );
  const issue = await Issue.findById(scenario.issue._id);
  assert.equal(await Intervention.countDocuments(), 0);
  assert.equal(await Activity.countDocuments({ type: "intervention_recorded" }), 0);
  assert.equal(issue.intervention_count, 0);
  assert.equal(issue.intervention_revision, 0);
});

test("Client archival and Intervention creation cannot both cross the lifecycle fence", async () => {
  const scenario = await createScenario();
  const raceNow = new Date();
  const [write, archive] = await Promise.allSettled([
    createIntervention({
      agencyId: scenario.agency._id,
      recorder: { id: scenario.member._id },
      issueId: scenario.issue._id,
      input: createInput(),
      now: raceNow,
    }),
    archiveClientLifecycle({
      agencyId: scenario.agency._id,
      clientId: scenario.client._id,
      userId: scenario.owner._id,
      now: raceNow,
    }),
  ]);
  if (archive.status === "fulfilled" && archive.value.outcome === "archived") {
    assert.equal(write.status, "rejected");
    assert.equal(write.reason.code, "CLIENT_ARCHIVED");
    assert.equal(await Intervention.countDocuments(), 0);
  } else {
    assert.equal(write.status, "fulfilled");
    assert.equal(archive.status, "fulfilled");
    assert.equal(archive.value.outcome, "lifecycle_in_progress");
    assert.equal(await Intervention.countDocuments(), 1);
  }
});

test("Intervention source lease blocks source-to-destination Meta reassignment", async () => {
  const scenario = await createScenario({ operationalMeta: true });
  const destination = await Client.create({
    agency_id: scenario.agency._id,
    name: "Destination Client",
    status: "stable",
  });
  const transactionEntered = deferred();
  const releaseTransaction = deferred();
  const writePromise = createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
    transactionRunner: async (options) => {
      transactionEntered.resolve();
      await releaseTransaction.promise;
      return runRequiredTransaction(options);
    },
  });
  await transactionEntered.promise;
  const assignment = await assignAccount({ scenario, clientId: destination._id });
  assert.equal(assignment.statusCode, 409);
  assert.equal(assignment.payload.code, "client_lifecycle_operation_in_progress");
  releaseTransaction.resolve();
  await writePromise;

  const account = await MetaAdAccount.findById(scenario.account._id);
  assert.equal(String(account.client_id), String(scenario.client._id));
  assert.equal(await Intervention.countDocuments({ issue_id: scenario.issue._id }), 1);
});

test("Intervention source lease blocks Meta account unassignment", async () => {
  const scenario = await createScenario({ operationalMeta: true });
  const transactionEntered = deferred();
  const releaseTransaction = deferred();
  const writePromise = createIntervention({
    agencyId: scenario.agency._id,
    recorder: { id: scenario.member._id },
    issueId: scenario.issue._id,
    input: createInput(),
    now,
    transactionRunner: async (options) => {
      transactionEntered.resolve();
      await releaseTransaction.promise;
      return runRequiredTransaction(options);
    },
  });
  await transactionEntered.promise;
  const unassignment = await assignAccount({ scenario, clientId: null });
  assert.equal(unassignment.statusCode, 409);
  assert.equal(unassignment.payload.code, "client_lifecycle_operation_in_progress");
  releaseTransaction.resolve();
  await writePromise;

  const account = await MetaAdAccount.findById(scenario.account._id);
  assert.equal(String(account.client_id), String(scenario.client._id));
  assert.equal(await Intervention.countDocuments({ issue_id: scenario.issue._id }), 1);
});

test("multi-Client lease acquisition is deterministic and releases partial acquisition", async () => {
  const scenario = await createScenario({ operationalMeta: true });
  const secondClient = await Client.create({
    agency_id: scenario.agency._id,
    name: "Second Lease Client",
    status: "stable",
  });
  const ordered = orderedUniqueClientIds([
    secondClient._id,
    scenario.client._id,
    secondClient._id,
  ]);
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left.localeCompare(right)));
  assert.equal(ordered.length, 2);

  const blockedClientId = ordered[1];
  const firstClientId = ordered[0];
  await Client.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(blockedClientId) },
    {
      $set: {
        lifecycle_lock: {
          token: "existing-owner",
          operation: "archive",
          acquired_at: new Date(),
          expires_at: new Date(Date.now() + 60_000),
        },
      },
    }
  );
  await assert.rejects(
    acquireRequiredClientLifecycleLeases({
      agencyId: scenario.agency._id,
      clientIds: [secondClient._id, scenario.client._id],
      operation: "meta_assignment",
    }),
    (error) => error.code === "client_lifecycle_operation_in_progress"
  );
  const [firstClient, blockedClient] = await Promise.all([
    Client.collection.findOne({ _id: new mongoose.Types.ObjectId(firstClientId) }),
    Client.collection.findOne({ _id: new mongoose.Types.ObjectId(blockedClientId) }),
  ]);
  assert.equal(firstClient.lifecycle_lock, undefined);
  assert.equal(blockedClient.lifecycle_lock.token, "existing-owner");
});

test("simultaneous reassignment attempts serialize and release every Client lease", async () => {
  const scenario = await createScenario({ operationalMeta: true });
  const [firstDestination, secondDestination] = await Client.create([
    { agency_id: scenario.agency._id, name: "Destination One", status: "stable" },
    { agency_id: scenario.agency._id, name: "Destination Two", status: "stable" },
  ]);
  const queryEntered = deferred();
  const releaseQuery = deferred();
  const originalFindOne = MetaConnection.findOne;
  let findCalls = 0;
  MetaConnection.findOne = function delayedFindOne(...args) {
    findCalls += 1;
    const query = originalFindOne.apply(this, args);
    if (findCalls !== 1) return query;
    return {
      then(resolve, reject) {
        queryEntered.resolve();
        return releaseQuery.promise
          .then(() => query)
          .then(resolve, reject);
      },
    };
  };
  try {
    const first = assignAccount({ scenario, clientId: firstDestination._id });
    await queryEntered.promise;
    const second = await assignAccount({ scenario, clientId: secondDestination._id });
    assert.equal(second.statusCode, 409);
    assert.equal(second.payload.code, "client_lifecycle_operation_in_progress");
    releaseQuery.resolve();
    const firstResult = await first;
    assert.equal(firstResult.statusCode, 200);
  } finally {
    releaseQuery.resolve();
    MetaConnection.findOne = originalFindOne;
  }

  const [account, clients] = await Promise.all([
    MetaAdAccount.findById(scenario.account._id),
    Client.collection
      .find({ _id: { $in: [scenario.client._id, firstDestination._id, secondDestination._id] } })
      .toArray(),
  ]);
  assert.equal(String(account.client_id), String(firstDestination._id));
  assert.equal(clients.every((client) => !client.lifecycle_lock), true);
});

test("assignment rejects a stale source binding transactionally without partial destination state", async () => {
  const scenario = await createScenario({ operationalMeta: true });
  const [destination, unexpectedSource] = await Client.create([
    { agency_id: scenario.agency._id, name: "Expected Destination", status: "stable" },
    { agency_id: scenario.agency._id, name: "Unexpected Source", status: "stable" },
  ]);
  const queryEntered = deferred();
  const releaseQuery = deferred();
  const originalFindOne = MetaConnection.findOne;
  let findCalls = 0;
  MetaConnection.findOne = function delayedFindOne(...args) {
    findCalls += 1;
    const query = originalFindOne.apply(this, args);
    if (findCalls !== 1) return query;
    return {
      then(resolve, reject) {
        queryEntered.resolve();
        return releaseQuery.promise
          .then(() => query)
          .then(resolve, reject);
      },
    };
  };
  try {
    const assignmentPromise = assignAccount({ scenario, clientId: destination._id });
    await queryEntered.promise;
    await MetaAdAccount.collection.updateOne(
      { _id: scenario.account._id },
      { $set: { client_id: unexpectedSource._id } }
    );
    releaseQuery.resolve();
    const assignment = await assignmentPromise;
    assert.equal(assignment.statusCode, 409);
    assert.equal(assignment.payload.code, "META_ASSIGNMENT_STALE_SOURCE");
  } finally {
    releaseQuery.resolve();
    MetaConnection.findOne = originalFindOne;
  }

  const [account, destinationAccounts, clients] = await Promise.all([
    MetaAdAccount.findById(scenario.account._id),
    MetaAdAccount.countDocuments({ agency_id: scenario.agency._id, client_id: destination._id }),
    Client.collection
      .find({ _id: { $in: [scenario.client._id, destination._id] } })
      .toArray(),
  ]);
  assert.equal(String(account.client_id), String(unexpectedSource._id));
  assert.equal(destinationAccounts, 0);
  assert.equal(clients.every((client) => !client.lifecycle_lock), true);
});
