import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { Agency, Client, Evaluation, Issue, Report, ReportRun, Signal } from "../src/models/index.js";
import { runReport } from "../src/services/reportRunner.service.js";
import { markExecutionIntegrityReady } from "../src/services/executionIntegrityIndexes.service.js";
import { projectSourceSafely } from "../src/services/reviewProjection.service.js";

let replset;
const oid = () => new mongoose.Types.ObjectId();

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of ["agencies", "clients", "evaluations", "issues", "reports", "report_runs", "signals"]) {
    await mongoose.connection.createCollection(name).catch(() => {});
  }
  markExecutionIntegrityReady([]);
});

after(async () => {
  await mongoose.disconnect();
  await replset.stop();
});

beforeEach(async () => {
  await Promise.all([Agency, Client, Evaluation, Issue, Report, ReportRun, Signal].map((Model) => Model.collection.deleteMany({})));
});

const seedCompletedEvidence = async (label) => {
  const agency = await Agency.create({ name: `Phase Four ${label}`, slug: `phase-four-${label}` });
  const client = await Client.create({ agency_id: agency._id, name: "Acme", status: "stable" });
  const actorId = oid();
  const report = await Report.create({
    agency_id: agency._id,
    client_id: client._id,
    created_by: actorId,
    name: "Daily Monitor",
    type: "daily",
    status: "active",
    severity: "low",
    monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Campaign One" }],
    schedule: { timezone: "UTC", time_of_day: "09:00" },
    next_run_at: new Date("2026-07-18T09:00:00Z"),
  });
  const executionKey = `phase4-runner:${label}:${oid()}`;
  const now = new Date("2026-07-18T12:00:00Z");
  const run = await ReportRun.create({
    agency_id: agency._id,
    client_id: client._id,
    report_id: report._id,
    trigger_type: "manual",
    execution_key: executionKey,
    execution_stage: "artifacts_ready",
    execution_attempt_count: 1,
    started_at: now,
    artifacts_ready_at: now,
    events_persisted_at: now,
    events_persistence_status: "persisted",
    status: "ok",
    severity: "medium",
    summary: "Persisted performance summary.",
    comparison: { mode: "scheduled_window", period: { type: "daily", current: { start: "2026-07-18", end: "2026-07-18" }, previous: { start: "2026-07-17", end: "2026-07-17" } } },
    narrative: { status: "ok", severity: { level: "medium" }, executiveSummary: "Persisted performance summary.", dataQuality: { level: "strong" }, trustGate: { blocked: false } },
    monitored_campaigns: [{ campaign_id: "campaign-1", campaign_name: "Campaign One" }],
    internal_report: {
      status: "generated",
      subject: "Narrative report",
      html: "<p>Persisted report</p>",
      text: "Persisted report",
      recipients: [{ email: "team@example.com", status: "pending" }],
      dispatch: { idempotency_key: `${executionKey}:internal:batch`, status: "pending", attempt_count: 0 },
    },
    client_report: {
      status: "cancelled",
      delivery_mode: "generate_only",
      subject: "Client report",
      html: "<p>Client report</p>",
      recipients: [],
      dispatch: { idempotency_key: `${executionKey}:client:batch`, status: "not_required", attempt_count: 0 },
    },
    ran_at: now,
  });
  const signalId = oid();
  const issueId = oid();
  await Signal.collection.insertOne({ _id: signalId, agency_id: agency._id, client_id: client._id, report_id: report._id, report_run_id: run._id, issue_id: issueId, type: "creative_fatigue", severity: "moderate", title: "Creative fatigue", description: "CTR decreased.", detected_at: now });
  await Issue.collection.insertOne({ _id: issueId, agency_id: agency._id, client_id: client._id, status: "open", occurrence_count: 1, current_signal_id: signalId });
  return { agency, client, report, run, executionKey, now, signalId, issueId };
};

for (const failure of [
  { label: "indexes", code: "EVALUATION_INDEXES_NOT_READY" },
  { label: "transaction", code: "EVALUATION_TRANSACTION_REQUIRED" },
  { label: "validation", code: "EVALUATION_VALIDATION_FAILED" },
  { label: "duplicate", code: "EVALUATION_INTEGRITY_CONFLICT" },
  { label: "unexpected", code: "EVALUATION_INTERNAL_ERROR" },
]) {
  test(`real ReportRunner isolates ${failure.label} Evaluation failure after persisted events`, async () => {
    const seeded = await seedCompletedEvidence(failure.label);
    const signalBefore = await Signal.collection.findOne({ _id: seeded.signalId });
    const issueBefore = await Issue.collection.findOne({ _id: seeded.issueId });
    const originalFetch = globalThis.fetch;
    const originalWebhook = process.env.REPORT_EMAIL_WEBHOOK_URL;
    const dispatches = [];
    let evaluationCalls = 0;
    let issueCalls = 0;
    process.env.REPORT_EMAIL_WEBHOOK_URL = "https://n8n.example.test/phase4-report";
    globalThis.fetch = async (url, options) => {
      dispatches.push({ url: String(url), body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    };
    let result;
    try {
      result = await runReport(seeded.report._id, {
        force: true,
        triggerType: "manual",
        executionKey: seeded.executionKey,
        agencyId: seeded.agency._id,
        userId: seeded.report.created_by,
        now: seeded.now,
        issueProcessor: async ({ reportRunId }) => {
          issueCalls += 1;
          assert.equal(String(reportRunId), String(seeded.run._id));
          assert.deepEqual(await Signal.collection.findOne({ _id: seeded.signalId }), signalBefore);
          assert.deepEqual(await Issue.collection.findOne({ _id: seeded.issueId }), issueBefore);
        },
        evaluationProcessor: async ({ reportRunId }) => {
          evaluationCalls += 1;
          assert.equal(String(reportRunId), String(seeded.run._id));
          throw Object.assign(new Error(`bounded ${failure.label} evaluation error`), { code: failure.code });
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWebhook === undefined) delete process.env.REPORT_EMAIL_WEBHOOK_URL;
      else process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhook;
    }

    const persistedRun = await ReportRun.findById(seeded.run._id);
    assert.equal(result.skipped, false);
    assert.equal(result.reportRun.execution_stage, "completed");
    assert.equal(persistedRun.execution_stage, "completed");
    assert.equal(persistedRun.status, "ok");
    assert.equal(persistedRun.failure, null);
    assert.equal(evaluationCalls, 1);
    assert.equal(issueCalls, 1);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].url, "https://n8n.example.test/phase4-report");
    assert.equal(dispatches[0].body.emailHtml, "<p>Persisted report</p>");
    assert.deepEqual(dispatches[0].body.recipients, ["team@example.com"]);
    assert.deepEqual(await Signal.collection.findOne({ _id: seeded.signalId }), signalBefore);
    assert.deepEqual(await Issue.collection.findOne({ _id: seeded.issueId }), issueBefore);
    assert.equal(await Evaluation.collection.countDocuments({ agency_id: seeded.agency._id }), 0);
    assert.equal("error" in result, false);
  });
}

test("real ReportRunner completes and dispatches exactly once when Review projection is unavailable", async () => {
  const seeded = await seedCompletedEvidence("phase5-review-unavailable");
  const originalFetch = globalThis.fetch;
  const originalWebhook = process.env.REPORT_EMAIL_WEBHOOK_URL;
  let dispatches = 0;
  let metaCalls = 0;
  process.env.REPORT_EMAIL_WEBHOOK_URL = "https://n8n.example.test/phase5-report";
  globalThis.fetch = async (url) => {
    if (String(url).includes("graph.facebook.com")) metaCalls += 1;
    else dispatches += 1;
    return { ok: true, status: 200 };
  };
  const options = {
    force: true,
    triggerType: "manual",
    executionKey: seeded.executionKey,
    agencyId: seeded.agency._id,
    userId: seeded.report.created_by,
    now: seeded.now,
    issueProcessor: async () => {
      const projection = await projectSourceSafely(async () => {
        throw Object.assign(new Error("Review indexes unavailable"), { code: "REVIEW_INDEXES_NOT_READY" });
      }, { reportRunId: seeded.run._id });
      assert.deepEqual(projection, { deferred: true });
    },
    evaluationProcessor: async () => ({ skipped: true }),
  };

  try {
    const first = await runReport(seeded.report._id, options);
    const replay = await runReport(seeded.report._id, options);
    assert.equal(first.reportRun.execution_stage, "completed");
    assert.equal(replay.reportRun.execution_stage, "completed");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWebhook === undefined) delete process.env.REPORT_EMAIL_WEBHOOK_URL;
    else process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhook;
  }

  assert.equal((await ReportRun.findById(seeded.run._id)).execution_stage, "completed");
  assert.equal(dispatches, 1);
  assert.equal(metaCalls, 0);
});
