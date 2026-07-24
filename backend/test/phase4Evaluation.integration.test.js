import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Activity,
  Client,
  Evaluation,
  EvaluationSeries,
  Intervention,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  WorkspaceMember,
} from "../src/models/index.js";
import { processInterventionEvaluation, reconcileEvaluations } from "../src/services/evaluation.service.js";
import { applyPhase4EvaluationIndexes, initializePhase4EvaluationIntegrity } from "../src/services/phase4EvaluationIndexes.service.js";

let replset;
const names = ["activities", "clients", "evaluations", "evaluation_series", "interventions", "issues", "meta_ad_accounts", "meta_connections", "reports", "report_runs", "workspace_members"];
before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of names) await mongoose.connection.createCollection(name).catch(() => {});
  const collections = { evaluations: mongoose.connection.collection("evaluations"), evaluation_series: mongoose.connection.collection("evaluation_series") };
  await applyPhase4EvaluationIndexes({ collections, logger: { log() {} } });
  await initializePhase4EvaluationIntegrity({ collections });
  await mongoose.connection.collection("activities").createIndex({ idempotency_key: 1 }, { unique: true, sparse: true });
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { for (const name of names) await mongoose.connection.collection(name).deleteMany({}); });

const oid = () => new mongoose.Types.ObjectId();
const defaultModels = { Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, MetaConnection, Report, ReportRun, WorkspaceMember };
const reportEvidence = ({ runId, agencyId, clientId, reportId, accountId, date, ctr }) => ({
  _id: runId,
  agency_id: agencyId,
  client_id: clientId,
  report_id: reportId,
  meta_ad_account_id: accountId,
  meta_binding_revision_snapshot: 1,
  trigger_type: "scheduled",
  evaluation_evidence: {
    version: 1,
    captured_at: new Date(`${date}T23:00:00Z`),
    normalization_version: 1,
    timezone: "UTC",
    currency: "USD",
    attribution_windows: ["7d_click"],
    meta_binding_revision: 1,
    comparison_mode: "scheduled_window",
    cadence: "daily",
    current_window: { start: date, end: date },
    previous_window: { start: date, end: date },
    campaign_snapshots: [{ campaign_id: "campaign-1", campaign_name: "Campaign", provenance: "scheduled_window", spend: 100, impressions: 1000, clicks: Math.round(ctr * 10), conversions: 10, conversion_value: 200, ctr, cpc: 100 / Math.round(ctr * 10), cpm: 100, cpa: 10, roas: 2, conversion_rate: 10, row_count: 1, source_level: "campaign", completeness: "complete", warnings: [] }],
    completeness: "complete",
    warnings: [],
  },
  ran_at: new Date(`${date}T23:00:00Z`),
});

const seed = async () => {
  const ids = { agency: oid(), client: oid(), issue: oid(), account: oid(), connection: oid(), report: oid(), intervention: oid(), actionRun: oid(), baselineRun: oid(), followRun: oid(), actor: oid() };
  const db = mongoose.connection;
  await db.collection("clients").insertOne({ _id: ids.client, agency_id: ids.agency, name: "Client", is_archived: false });
  await db.collection("meta_connections").insertOne({ _id: ids.connection, agency_id: ids.agency, connection_scope: "workspace", client_id: null, status: "active", is_active: true, token_expires_at: new Date("2030-01-01T00:00:00Z") });
  await db.collection("meta_ad_accounts").insertOne({ _id: ids.account, agency_id: ids.agency, meta_connection_id: ids.connection, client_id: ids.client, assignment_scope: "v1", ad_account_id: "act_1", is_active: true, is_accessible: true, binding_revision: 1 });
  await db.collection("reports").insertOne({ _id: ids.report, agency_id: ids.agency, client_id: ids.client, meta_ad_account_id: ids.account, name: "Daily", type: "daily", schedule: { timezone: "UTC", time_of_day: "10:00" }, monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Campaign" }] });
  await db.collection("issues").insertOne({
    _id: ids.issue,
    agency_id: ids.agency,
    client_id: ids.client,
    meta_ad_account_id: ids.account,
    scope: {
      version: 1,
      agency_id: ids.agency,
      client_id: ids.client,
      meta_ad_account_id: ids.account,
      entity: { level: "campaign", id: "campaign-1", campaign_id: "campaign-1" },
      classification: { archetype: "engagement", metric_family: "ctr" },
      comparison: { cadence: "daily", timezone: "UTC" },
    },
    latest_intervention_id: ids.intervention,
    monitoring_intervention_id: ids.intervention,
    monitoring_started_at: new Date("2026-01-02T12:00:00Z"),
    monitoring_reason: "actionable_intervention_recorded",
    intervention_revision: 1,
    intervention_count: 1,
    lifecycle_revision: 0,
    status: "monitoring",
  });
  await db.collection("report_runs").insertMany([
    { _id: ids.actionRun, agency_id: ids.agency, client_id: ids.client, report_id: ids.report, meta_ad_account_id: ids.account, meta_binding_revision_snapshot: 1, trigger_type: "scheduled", monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Campaign" }], ran_at: new Date("2026-01-02T08:00:00Z") },
    reportEvidence({ runId: ids.baselineRun, ...{ agencyId: ids.agency, clientId: ids.client, reportId: ids.report, accountId: ids.account }, date: "2026-01-01", ctr: 2 }),
    reportEvidence({ runId: ids.followRun, ...{ agencyId: ids.agency, clientId: ids.client, reportId: ids.report, accountId: ids.account }, date: "2026-01-03", ctr: 3 }),
  ]);
  await db.collection("interventions").insertOne({ _id: ids.intervention, agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, meta_ad_account_id: ids.account, campaign_id: "campaign-1", report_id_at_action: ids.report, report_run_id_at_action: ids.actionRun, recorded_by_user_id: ids.actor, action_type: "replace_creative", performed_at: new Date("2026-01-02T12:00:00Z"), status: "active", revision: 0, evaluation_intent: { mode: "auto_resolved", primary_metric: "ctr", watched_metrics: ["ctr"], resolution_source: "issue_metric_family", rule_version: 1 } });
  await db.collection("workspace_members").insertOne({ workspace_id: ids.agency, user_id: ids.actor, role: "owner", status: "active" });
  return ids;
};

test("transaction persists a ready Evaluation, advances Series, and writes bounded Activity", async () => {
  const ids = await seed();
  const result = await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun });
  assert.equal(result.created, true);
  assert.equal(result.evaluation.status, "ready");
  assert.equal(result.evaluation.observed_result, "improved");
  assert.equal(result.evaluation.confidence_level, "medium");
  const issue = await Issue.findById(ids.issue);
  assert.equal(String(issue.latest_evaluation_id), String(result.evaluation._id));
  assert.equal(issue.latest_evaluation_status, "ready");
  assert.equal(issue.latest_evaluation_result, "improved");
  assert.equal(issue.latest_evaluation_confidence, "medium");
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.absence_streak, 0);
  const series = await EvaluationSeries.findOne({ agency_id: ids.agency, intervention_id: ids.intervention });
  assert.equal(String(series.current_evaluation_id), String(result.evaluation._id));
  assert.equal(series.next_sequence, 2);
  assert.equal(await mongoose.connection.collection("activities").countDocuments({ type: "evaluation_created" }), 1);
});

test("insufficient follow-up evidence leaves the Intervention active and the Issue unresolved", async () => {
  const ids = await seed();
  await ReportRun.collection.deleteOne({ _id: ids.followRun });

  const result = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "reconciliation",
    now: new Date("2026-01-20T00:00:00Z"),
  });

  assert.equal(result.evaluation.status, "insufficient_data");
  assert.equal(result.evaluation.observed_result, null);
  assert.equal(result.evaluation.confidence_level, "low");
  assert.equal((await Intervention.findById(ids.intervention)).status, "active");
  const issue = await Issue.findById(ids.issue);
  assert.equal(issue.status, "monitoring");
  assert.equal(issue.latest_evaluation_status, "insufficient_data");
});

test("Evaluation creation and Series advancement remain committed when Review projection fails", async () => {
  const ids = await seed();
  let reviewCalls = 0;
  const result = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
    reviewProcessor: async () => {
      reviewCalls += 1;
      throw Object.assign(new Error("injected Review projection failure"), { code: "REVIEW_TEST_FAILURE" });
    },
  });
  const series = await EvaluationSeries.findOne({ agency_id: ids.agency, intervention_id: ids.intervention });

  assert.equal(result.created, true);
  assert.equal(reviewCalls, 1);
  assert.equal(await Evaluation.countDocuments({ intervention_id: ids.intervention }), 1);
  assert.equal(String(series.current_evaluation_id), String(result.evaluation._id));
  assert.equal(series.next_sequence, 2);
});
test("same evidence is a no-op and preserves one immutable version", async () => {
  const ids = await seed();
  const first = await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun });
  const replay = await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "reconciliation" });
  assert.equal(replay.noChange, true);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);
});
test("new canonical evidence appends a successor and leaves prior evidence unchanged", async () => {
  const ids = await seed();
  const first = await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun });
  const newerRun = oid();
  await mongoose.connection.collection("report_runs").insertOne(reportEvidence({ runId: newerRun, agencyId: ids.agency, clientId: ids.client, reportId: ids.report, accountId: ids.account, date: "2026-01-03", ctr: 4 }));
  const second = await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: newerRun });
  assert.equal(second.created, true);
  assert.equal(String(second.evaluation.supersedes_evaluation_id), String(first.evaluation._id));
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 2);
  const unchanged = await Evaluation.findById(first.evaluation._id);
  assert.equal(unchanged.metric_results[0].follow_up_value, 3);
});
test("rule upgrade appends an immutable successor even when evidence is unchanged", async () => {
  const ids = await seed();
  const first = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
    ruleVersion: 1,
  });
  const second = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "rule_upgrade",
    ruleVersion: 2,
  });
  assert.equal(second.created, true);
  assert.equal(first.evaluation.evidence_hash, second.evaluation.evidence_hash);
  assert.equal(second.evaluation.rule_version, 2);
  assert.equal(String(second.evaluation.supersedes_evaluation_id), String(first.evaluation._id));
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 2);
  assert.equal((await Evaluation.findById(first.evaluation._id)).rule_version, 1);
});

test("concurrent rule versions keep a contiguous series and never downgrade the current pointer", async () => {
  const ids = await seed();
  const settled = await Promise.all([
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "rule_upgrade", ruleVersion: 1 }),
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "rule_upgrade", ruleVersion: 2 }),
  ]);
  const history = await Evaluation.find({ intervention_id: ids.intervention }).sort({ sequence: 1 });
  const series = await EvaluationSeries.findOne({ intervention_id: ids.intervention });
  const current = await Evaluation.findById(series.current_evaluation_id);
  assert.equal(history.length >= 1 && history.length <= 2, true);
  assert.deepEqual(history.map((item) => item.sequence), Array.from({ length: history.length }, (_, index) => index + 1));
  assert.equal(current.rule_version, 2);
  assert.equal(series.next_sequence, history.length + 1);
  assert.equal(settled.some((item) => item.evaluation.rule_version === 2), true);

  const stale = await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "reconciliation", ruleVersion: 1 });
  assert.equal(stale.noChange, true);
  assert.equal(stale.staleRuleVersion, true);
  assert.equal((await Evaluation.findById((await EvaluationSeries.findOne({ intervention_id: ids.intervention })).current_evaluation_id)).rule_version, 2);
});
test("manual refresh is persisted-evidence only, idempotent, and rate bounded", async () => {
  const ids = await seed();
  const now = new Date("2026-01-04T00:00:00Z");
  const input = { agencyId: ids.agency, interventionId: ids.intervention, triggerType: "manual_refresh", actor: { userId: ids.actor }, expectedInterventionRevision: 0, idempotencyKey: "refresh-request-123456", now };
  const first = await processInterventionEvaluation(input);
  const replay = await processInterventionEvaluation(input);
  assert.equal(first.created, true);
  assert.equal(replay.noChange, true);
  await assert.rejects(processInterventionEvaluation({ ...input, idempotencyKey: "refresh-request-654321" }), (error) => error.code === "EVALUATION_REFRESH_RATE_LIMITED");
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);
});
test("concurrent automatic triggers converge without duplicate sequence or Activity", async () => {
  const ids = await seed();
  const results = await Promise.all([
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun }),
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "reconciliation" }),
  ]);
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);
  assert.equal(await mongoose.connection.collection("activities").countDocuments({ type: "evaluation_created" }), 1);
});
test("automatic ReportRun and manual refresh race converges on one immutable Evaluation", async () => {
  const ids = await seed();
  const results = await Promise.all([
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun }),
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "manual_refresh", actor: { userId: ids.actor }, expectedInterventionRevision: 0, idempotencyKey: "manual-auto-race-123456", now: new Date("2026-01-04T00:00:00Z") }),
  ]);
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);
  assert.equal((await EvaluationSeries.findOne({ intervention_id: ids.intervention })).next_sequence, 2);
});
test("two identical manual refreshes converge without sequence or Activity duplication", async () => {
  const ids = await seed();
  const input = { agencyId: ids.agency, interventionId: ids.intervention, triggerType: "manual_refresh", actor: { userId: ids.actor }, expectedInterventionRevision: 0, idempotencyKey: "manual-race-request-123456", now: new Date("2026-01-04T00:00:00Z") };
  const results = await Promise.all([processInterventionEvaluation(input), processInterventionEvaluation(input)]);
  assert.equal(results.filter((item) => item.created).length, 1);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);
  assert.equal(await mongoose.connection.collection("activities").countDocuments({ type: "evaluation_created" }), 1);
});
test("action-time campaign lineage mismatch fails before Evaluation creation", async () => {
  const ids = await seed();
  await mongoose.connection.collection("report_runs").updateOne(
    { _id: ids.actionRun },
    { $set: { monitored_campaigns: [{ campaign_id: "another-campaign", campaign_name: "Other" }] } }
  );
  await assert.rejects(
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun }),
    (error) => error.code === "EVALUATION_OWNERSHIP_CONFLICT"
  );
  assert.equal(await Evaluation.collection.countDocuments({ agency_id: ids.agency }), 0);
});
test("manual refresh does not recover an idempotency collision from another Intervention", async () => {
  const ids = await seed();
  const key = "refresh-request-conflict-123";
  await Evaluation.collection.insertOne({
    agency_id: ids.agency,
    intervention_id: oid(),
    idempotency_key: key,
  });
  await assert.rejects(
    processInterventionEvaluation({
      agencyId: ids.agency,
      interventionId: ids.intervention,
      triggerType: "manual_refresh",
      actor: { userId: ids.actor },
      expectedInterventionRevision: 0,
      idempotencyKey: key,
      now: new Date("2026-01-04T00:00:00Z"),
    }),
    (error) => error.code === "EVALUATION_IDEMPOTENCY_CONFLICT"
  );
});
test("persisted duplicate sequence conflict aborts advancement with a controlled integrity error", async () => {
  const ids = await seed();
  const conflictingEvaluationId = oid();
  const issueBefore = await Issue.collection.findOne({ _id: ids.issue });
  await Evaluation.collection.insertOne({
    _id: conflictingEvaluationId,
    agency_id: ids.agency,
    intervention_id: ids.intervention,
    sequence: 1,
    idempotency_key: `conflicting-sequence-${conflictingEvaluationId}`,
  });

  await assert.rejects(
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun }),
    (error) => error.code === "EVALUATION_INTEGRITY_CONFLICT"
  );

  const series = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
  assert.equal(String((await Evaluation.collection.findOne({ _id: conflictingEvaluationId }))._id), String(conflictingEvaluationId));
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);
  assert.equal(series.current_evaluation_id ?? null, null);
  assert.equal(series.next_sequence, 1);
  assert.equal(series.revision, 0);
  assert.equal(await Activity.collection.countDocuments({ type: { $in: ["evaluation_created", "evaluation_superseded"] } }), 0);
  assert.deepEqual(await Issue.collection.findOne({ _id: ids.issue }), issueBefore);
});
test("persisted duplicate supersession conflict cannot converge to an unrelated Evaluation", async () => {
  const ids = await seed();
  const initial = await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun });
  const seriesBefore = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
  const conflictingEvaluationId = oid();
  await Evaluation.collection.insertOne({
    _id: conflictingEvaluationId,
    agency_id: ids.agency,
    intervention_id: ids.intervention,
    sequence: 99,
    idempotency_key: `conflicting-supersession-${conflictingEvaluationId}`,
    supersedes_evaluation_id: initial.evaluation._id,
  });
  await assert.rejects(
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "rule_upgrade", ruleVersion: 2 }),
    (error) => error.code === "EVALUATION_INTEGRITY_CONFLICT"
  );

  const seriesAfter = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
  assert.equal(String(seriesAfter.current_evaluation_id), String(initial.evaluation._id));
  assert.equal(seriesAfter.next_sequence, seriesBefore.next_sequence);
  assert.equal(seriesAfter.revision, seriesBefore.revision);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 2);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention, sequence: 2 }), 0);
  assert.equal(await Activity.collection.countDocuments({ type: "evaluation_created" }), 1);
  assert.equal(await Activity.collection.countDocuments({ type: "evaluation_superseded" }), 0);
});
test("persisted cancellation appends one stable invalidation without live Meta connection", async () => {
  const ids = await seed();
  await processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: ids.followRun });
  const cancelledAt = new Date("2026-01-04T09:00:00Z");
  await mongoose.connection.collection("interventions").updateOne(
    { _id: ids.intervention },
    { $set: { status: "cancelled", cancellation: { cancelled_at: cancelledAt } }, $inc: { revision: 1 } }
  );
  await mongoose.connection.collection("meta_connections").updateOne(
    { _id: ids.connection },
    { $set: { status: "disconnected", is_active: false } }
  );
  const invalidated = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "cancellation",
    now: new Date("2026-01-04T10:00:00Z"),
  });
  const replay = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
    now: new Date("2026-01-05T10:00:00Z"),
  });
  assert.equal(invalidated.evaluation.status, "invalidated");
  assert.equal(invalidated.evaluation.invalidation_context.invalidated_at.toISOString(), cancelledAt.toISOString());
  assert.equal(replay.noChange, true);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 2);
});
test("action-time Report configuration outranks later mutable Report schedule changes", async () => {
  const ids = await seed();
  await mongoose.connection.collection("report_runs").updateOne(
    { _id: ids.actionRun },
    {
      $set: {
        context_snapshot: {
          version: 1,
          captured_at: new Date("2026-01-02T08:00:00Z"),
          source: "execution",
          report: { configuration: { type: "daily", schedule: { timezone: "UTC" } } },
        },
      },
    }
  );
  await mongoose.connection.collection("reports").updateOne(
    { _id: ids.report },
    { $set: { type: "weekly", "schedule.timezone": "Asia/Kolkata" } }
  );
  const result = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
  });
  assert.equal(result.evaluation.status, "ready");
  assert.equal(result.evaluation.baseline.window.cadence, "daily");
  assert.equal(result.evaluation.baseline.window.timezone, "UTC");
});

for (const stage of ["evaluation_inserted", "series_advanced", "activity_recorded"]) {
  test(`transaction rollback after ${stage} leaves no partial Evaluation state`, async () => {
    const ids = await seed();
    await assert.rejects(processInterventionEvaluation({
      agencyId: ids.agency,
      interventionId: ids.intervention,
      triggerType: "report_run",
      sourceReportRunId: ids.followRun,
      transactionStageHook: async (currentStage) => {
        if (currentStage === stage) throw new Error(`injected ${stage} rollback`);
      },
    }), new RegExp(`injected ${stage} rollback`));
    assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 0);
    assert.equal(await mongoose.connection.collection("activities").countDocuments({ type: { $in: ["evaluation_created", "evaluation_superseded"] } }), 0);
    const series = await EvaluationSeries.collection.findOne({ agency_id: ids.agency, intervention_id: ids.intervention });
    assert.equal(series.current_evaluation_id ?? null, null);
    assert.equal(series.next_sequence, 1);
    assert.equal(series.revision, 0);
  });
}

test("failed Series CAS rolls back the inserted Evaluation and preserves authority", async () => {
  const ids = await seed();
  const SeriesModel = new Proxy(EvaluationSeries, {
    get(target, property) {
      if (property === "findOneAndUpdate") {
        return (filter, update, options) => options?.phase4SeriesOperation === "advance"
          ? Promise.resolve(null)
          : target.findOneAndUpdate(filter, update, options);
      }
      return Reflect.get(target, property, target);
    },
  });
  await assert.rejects(processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
    Models: { ...defaultModels, EvaluationSeries: SeriesModel },
  }), (error) => error.code === "EVALUATION_PROCESSING_LEASE_LOST");
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 0);
  const series = await EvaluationSeries.collection.findOne({ agency_id: ids.agency, intervention_id: ids.intervention });
  assert.equal(series.current_evaluation_id ?? null, null);
  assert.equal(series.next_sequence, 1);
  assert.equal(await mongoose.connection.collection("activities").countDocuments({ type: "evaluation_created" }), 0);
});

for (const lifecycle of ["superseded", "cancelled"]) {
  test(`${lifecycle} transition during Evaluation fencing rejects the stale successor and reconciles invalidation`, async () => {
    const ids = await seed();
    const initial = await processInterventionEvaluation({
      agencyId: ids.agency,
      interventionId: ids.intervention,
      triggerType: "report_run",
      sourceReportRunId: ids.followRun,
    });
    const nextRun = oid();
    await ReportRun.collection.insertOne(reportEvidence({ runId: nextRun, agencyId: ids.agency, clientId: ids.client, reportId: ids.report, accountId: ids.account, date: "2026-01-04", ctr: 4 }));
    const changedAt = new Date("2026-01-04T09:00:00Z");
    let transitionPersisted = false;
    const InterventionModel = new Proxy(Intervention, {
      get(target, property) {
        if (property === "findOneAndUpdate") {
          return (filter, update, options) => options?.phase3InternalOperation === "evaluation_fence"
            ? {
                select: async () => {
                  if (!transitionPersisted) {
                    transitionPersisted = true;
                    await Intervention.collection.updateOne(
                      { _id: ids.intervention, agency_id: ids.agency },
                      {
                        $set: lifecycle === "cancelled"
                          ? { status: "cancelled", cancellation: { cancelled_at: changedAt } }
                          : { status: "superseded", corrected_at: changedAt },
                        $inc: { revision: 1 },
                      }
                    );
                  }
                  return null;
                },
              }
            : target.findOneAndUpdate(filter, update, options);
        }
        return Reflect.get(target, property, target);
      },
    });

    await assert.rejects(processInterventionEvaluation({
      agencyId: ids.agency,
      interventionId: ids.intervention,
      triggerType: "report_run",
      sourceReportRunId: nextRun,
      Models: { ...defaultModels, Intervention: InterventionModel },
    }), (error) => error.code === "EVALUATION_INTERVENTION_REVISION_STALE");

    const afterRejected = await Evaluation.find({ intervention_id: ids.intervention }).sort({ sequence: 1 });
    const seriesAfterRejected = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
    assert.equal(afterRejected.length, 1);
    assert.equal(String(afterRejected[0]._id), String(initial.evaluation._id));
    assert.equal(String(seriesAfterRejected.current_evaluation_id), String(initial.evaluation._id));
    assert.equal(seriesAfterRejected.next_sequence, 2);
    assert.equal((await Intervention.collection.findOne({ _id: ids.intervention })).status, lifecycle);

    const recovered = await reconcileEvaluations({ agencyId: ids.agency, batchSize: 1, maxBatches: 1, Models: defaultModels });
    assert.equal(recovered.failed, 0);
    const history = await Evaluation.find({ intervention_id: ids.intervention }).sort({ sequence: 1 });
    const finalSeries = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
    assert.equal(history.length, 2);
    assert.equal(history[1].status, "invalidated");
    assert.equal(history[1].invalidation_context.reason, `intervention_${lifecycle}`);
    assert.equal(String(finalSeries.current_evaluation_id), String(history[1]._id));
    assert.equal(finalSeries.next_sequence, 3);
    assert.equal(await Activity.collection.countDocuments({ type: "evaluation_invalidated" }), 1);
  });
}

test("archived Client authority prevents a stale Evaluation successor and preserves history", async () => {
  const ids = await seed();
  const initial = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
  });
  const seriesBefore = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
  const historyBefore = await Evaluation.collection.find({ intervention_id: ids.intervention }).sort({ sequence: 1 }).toArray();
  const issueBefore = await Issue.collection.findOne({ _id: ids.issue });
  const interventionBefore = await Intervention.collection.findOne({ _id: ids.intervention });
  const nextRun = oid();
  await ReportRun.collection.insertOne(reportEvidence({ runId: nextRun, agencyId: ids.agency, clientId: ids.client, reportId: ids.report, accountId: ids.account, date: "2026-01-04", ctr: 4 }));
  let archivePersisted = false;
  const ClientModel = new Proxy(Client, {
    get(target, property) {
      if (property === "findOneAndUpdate") {
        return async (filter, update, options) => {
          if (options?.session && !archivePersisted) {
            archivePersisted = true;
            await Client.collection.updateOne(
              { _id: ids.client, agency_id: ids.agency },
              { $set: { is_archived: true, archived_at: new Date("2026-01-04T08:00:00Z"), archived_by: ids.actor }, $unset: { lifecycle_lock: 1 } }
            );
            return null;
          }
          return target.findOneAndUpdate(filter, update, options);
        };
      }
      return Reflect.get(target, property, target);
    },
  });

  await assert.rejects(
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: nextRun, Models: { ...defaultModels, Client: ClientModel } }),
    (error) => error.code === "CLIENT_ARCHIVED"
  );

  const seriesAfter = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
  assert.equal(String(seriesAfter.current_evaluation_id), String(initial.evaluation._id));
  assert.equal(seriesAfter.next_sequence, seriesBefore.next_sequence);
  assert.equal(seriesAfter.revision, seriesBefore.revision);
  assert.deepEqual(await Evaluation.collection.find({ intervention_id: ids.intervention }).sort({ sequence: 1 }).toArray(), historyBefore);
  assert.deepEqual(await Issue.collection.findOne({ _id: ids.issue }), issueBefore);
  assert.deepEqual(await Intervention.collection.findOne({ _id: ids.intervention }), interventionBefore);
  assert.ok(await ReportRun.collection.findOne({ _id: ids.actionRun }));
});

test("changed account binding authority prevents a stale Evaluation successor", async () => {
  const ids = await seed();
  const initial = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
  });
  const seriesBefore = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
  const historyBefore = await Evaluation.collection.find({ intervention_id: ids.intervention }).sort({ sequence: 1 }).toArray();
  const issueBefore = await Issue.collection.findOne({ _id: ids.issue });
  const otherClientId = oid();
  const nextRun = oid();
  await Client.collection.insertOne({ _id: otherClientId, agency_id: ids.agency, name: "Other Client", is_archived: false });
  await ReportRun.collection.insertOne(reportEvidence({ runId: nextRun, agencyId: ids.agency, clientId: ids.client, reportId: ids.report, accountId: ids.account, date: "2026-01-04", ctr: 4 }));
  let reassignmentPersisted = false;
  const MetaAdAccountModel = new Proxy(MetaAdAccount, {
    get(target, property) {
      if (property === "findOneAndUpdate") {
        return (filter, update, options) => options?.session
          ? {
              select: async () => {
                if (!reassignmentPersisted) {
                  reassignmentPersisted = true;
                  await MetaAdAccount.collection.updateOne(
                    { _id: ids.account, agency_id: ids.agency },
                    { $set: { client_id: otherClientId }, $inc: { binding_revision: 1 } }
                  );
                }
                return null;
              },
            }
          : target.findOneAndUpdate(filter, update, options);
      }
      return Reflect.get(target, property, target);
    },
  });

  await assert.rejects(
    processInterventionEvaluation({ agencyId: ids.agency, interventionId: ids.intervention, triggerType: "report_run", sourceReportRunId: nextRun, Models: { ...defaultModels, MetaAdAccount: MetaAdAccountModel } }),
    (error) => error.code === "META_REPORT_BINDING_INVALID"
  );

  const seriesAfter = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
  assert.equal(String(seriesAfter.current_evaluation_id), String(initial.evaluation._id));
  assert.equal(seriesAfter.next_sequence, seriesBefore.next_sequence);
  assert.equal(seriesAfter.revision, seriesBefore.revision);
  assert.deepEqual(await Evaluation.collection.find({ intervention_id: ids.intervention }).sort({ sequence: 1 }).toArray(), historyBefore);
  assert.deepEqual(await Issue.collection.findOne({ _id: ids.issue }), issueBefore);
  assert.equal(await Activity.collection.countDocuments({ type: "evaluation_created", "metadata.evaluation_id": { $ne: initial.evaluation._id } }), 0);
});

test("an expired holder cannot advance Series and a later holder commits without orphan state", async () => {
  const ids = await seed();
  const live = new Date();
  let clockReads = 0;
  await assert.rejects(
    processInterventionEvaluation({
      agencyId: ids.agency,
      interventionId: ids.intervention,
      triggerType: "report_run",
      sourceReportRunId: ids.followRun,
      leaseClock: () => clockReads++ === 0 ? live : new Date(live.getTime() + 2 * 60_000),
    }),
    (error) => error.code === "EVALUATION_PROCESSING_LEASE_LOST"
  );
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 0);
  assert.equal(await mongoose.connection.collection("activities").countDocuments({ type: "evaluation_created" }), 0);
  const afterExpiredHolder = await EvaluationSeries.collection.findOne({ agency_id: ids.agency, intervention_id: ids.intervention });
  assert.equal(afterExpiredHolder.current_evaluation_id ?? null, null);
  assert.equal(afterExpiredHolder.next_sequence, 1);
  assert.equal(afterExpiredHolder.revision, 0);

  const winner = await processInterventionEvaluation({
    agencyId: ids.agency,
    interventionId: ids.intervention,
    triggerType: "report_run",
    sourceReportRunId: ids.followRun,
  });
  const finalSeries = await EvaluationSeries.collection.findOne({ agency_id: ids.agency, intervention_id: ids.intervention });
  assert.equal(winner.created, true);
  assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);
  assert.equal(String(finalSeries.current_evaluation_id), String(winner.evaluation._id));
  assert.equal(finalSeries.next_sequence, 2);
});

for (const lifecycle of ["superseded", "cancelled"]) {
  test(`reconciliation recovers a previously failed ${lifecycle} invalidation`, async () => {
    const ids = await seed();
    const initial = await processInterventionEvaluation({
      agencyId: ids.agency,
      interventionId: ids.intervention,
      triggerType: "report_run",
      sourceReportRunId: ids.followRun,
    });
    const issueBefore = await Issue.collection.findOne({ _id: ids.issue });
    const changedAt = new Date("2026-01-04T09:00:00Z");
    await Intervention.collection.updateOne(
      { _id: ids.intervention },
      {
        $set: lifecycle === "cancelled"
          ? { status: "cancelled", cancellation: { cancelled_at: changedAt } }
          : { status: "superseded", corrected_at: changedAt },
        $inc: { revision: 1 },
      }
    );

    const first = await reconcileEvaluations({
      agencyId: ids.agency,
      batchSize: 1,
      maxBatches: 1,
      Models: defaultModels,
      processOne: async () => { throw new Error("injected lifecycle invalidation interruption"); },
    });
    assert.equal(first.interrupted, true);
    assert.equal(await Evaluation.collection.countDocuments({ intervention_id: ids.intervention }), 1);

    const recovered = await reconcileEvaluations({
      agencyId: ids.agency,
      batchSize: 1,
      maxBatches: 1,
      Models: defaultModels,
    });
    assert.equal(recovered.failed, 0);
    const history = await Evaluation.find({ intervention_id: ids.intervention }).sort({ sequence: 1 });
    const series = await EvaluationSeries.collection.findOne({ intervention_id: ids.intervention });
    assert.equal(history.length, 2);
    assert.equal(String(history[0]._id), String(initial.evaluation._id));
    assert.equal(history[1].status, "invalidated");
    assert.equal(history[1].invalidation_context.reason, `intervention_${lifecycle}`);
    assert.equal(String(series.current_evaluation_id), String(history[1]._id));
    assert.equal(series.next_sequence, 3);
    assert.equal(await Activity.collection.countDocuments({ type: "evaluation_invalidated" }), 1);
    const issueAfter = await Issue.collection.findOne({ _id: ids.issue });
    assert.equal(issueAfter.status, issueBefore.status);
    assert.equal(issueAfter.lifecycle_revision, issueBefore.lifecycle_revision);
    assert.equal(issueAfter.intervention_revision, issueBefore.intervention_revision);
    assert.equal(String(issueAfter.latest_intervention_id), String(issueBefore.latest_intervention_id));
    assert.equal(issueAfter.evaluation_revision, issueBefore.evaluation_revision + 1);
    assert.equal(String(issueAfter.latest_evaluation_id), String(history[1]._id));
    assert.equal(issueAfter.latest_evaluation_status, "invalidated");
    assert.equal(issueAfter.latest_evaluation_result, null);
    assert.equal(issueAfter.latest_evaluation_confidence, "unavailable");
    assert.equal((await Intervention.collection.findOne({ _id: ids.intervention })).status, lifecycle);
  });
}
