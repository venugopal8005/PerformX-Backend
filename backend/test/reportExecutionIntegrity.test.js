import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import mongoose from "mongoose";

import { Activity, ReportRun, Signal } from "../src/models/index.js";
import { recordActivity } from "../src/services/activityRecorder.service.js";
import {
  cancelClientReportDelivery,
  dispatchReportRunArtifact,
} from "../src/services/reportDelivery.service.js";
import {
  acquireReportExecutionLease,
  buildExecutionKey,
  findOrCreateReportRun,
  releaseReportExecutionLease,
} from "../src/services/reportExecution.service.js";
import { saveSignalsFromNarrative } from "../src/services/signalGenerator.service.js";

const originalWebhookUrl = process.env.REPORT_EMAIL_WEBHOOK_URL;

const getPath = (value, path) =>
  path.split(".").reduce((current, key) => current?.[key], value);

const setPath = (value, path, nextValue) => {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((current, key) => {
    current[key] ||= {};
    return current[key];
  }, value);
  target[last] = nextValue;
};

const matches = (document, query) =>
  Object.entries(query).every(([path, expected]) => {
    if (path === "_id") return String(document._id) === String(expected);
    const actual = getPath(document, path);
    if (expected && typeof expected === "object" && "$in" in expected) {
      return expected.$in.includes(actual);
    }
    return actual === expected;
  });

class FakeReportModel {
  static report = {
    _id: "report-1",
    agency_id: "agency-1",
    client_id: "client-1",
    execution_lock: null,
  };

  static reset() {
    this.report = {
      _id: "report-1",
      agency_id: "agency-1",
      client_id: "client-1",
      execution_lock: null,
    };
  }

  static async findOneAndUpdate(query, update) {
    const leaseQuery = query.$and?.find((part) => part._id) || query;
    const archiveQuery = query.$and?.find((part) =>
      part.$or?.some((condition) => "is_archived" in condition)
    );
    const isOperational =
      this.report.is_archived === false || this.report.is_archived === undefined;
    if (archiveQuery && !isOperational) return null;
    const lock = this.report.execution_lock;
    if (leaseQuery.$or) {
      const expirationCondition = leaseQuery.$or.find(
        (condition) => condition["execution_lock.expires_at"]?.$lte
      );
      const now = expirationCondition["execution_lock.expires_at"].$lte;
      if (lock && new Date(lock.expires_at) > now) return null;
    } else if (
      String(this.report._id) !== String(leaseQuery._id) ||
      String(this.report.agency_id) !== String(leaseQuery.agency_id) ||
      String(this.report.client_id) !== String(leaseQuery.client_id) ||
      lock?.token !== leaseQuery["execution_lock.token"] ||
      new Date(lock?.expires_at) <=
        leaseQuery["execution_lock.expires_at"].$gt
    ) {
      return null;
    }
    if (update.$set.execution_lock) {
      this.report.execution_lock = structuredClone(update.$set.execution_lock);
    }
    if (update.$set["execution_lock.expires_at"]) {
      this.report.execution_lock.expires_at =
        update.$set["execution_lock.expires_at"];
    }
    return structuredClone(this.report);
  }

  static async findOne(query) {
    return String(this.report._id) === String(query._id) &&
      String(this.report.agency_id) === String(query.agency_id)
      ? structuredClone(this.report)
      : null;
  }

  static async updateOne(query, update) {
    const tokenQuery = query.$and?.find(
      (part) => part["execution_lock.token"]
    ) || query;
    const archiveQuery = query.$and?.find((part) =>
      part.$or?.some((condition) => "is_archived" in condition)
    );
    const isOperational =
      this.report.is_archived === false || this.report.is_archived === undefined;
    if (
      (archiveQuery && !isOperational) ||
      this.report.execution_lock?.token !== tokenQuery["execution_lock.token"]
    ) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (update.$unset?.execution_lock) this.report.execution_lock = null;
    if (update.$set?.["execution_lock.expires_at"]) {
      this.report.execution_lock.expires_at = update.$set["execution_lock.expires_at"];
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }
}

class FakeReportRunModel {
  static state;

  static reset(dispatchStatus = "pending") {
    this.state = {
      _id: "run-1",
      agency_id: "agency-1",
      execution_stage: "artifacts_ready",
      internal_report: {
        status: "generated",
        subject: "Internal report",
        html: "<p>Report</p>",
        text: "Report",
        recipients: [{ email: "team@example.com", status: "pending", error: null }],
        dispatch: {
          idempotency_key: "run-1:internal:batch",
          status: dispatchStatus,
          attempt_count: 0,
          attempt_id: null,
          claimed_at: null,
          claim_expires_at: null,
          last_attempt_at: null,
          sent_at: null,
          last_error: null,
        },
      },
      client_report: {
        status: "awaiting_approval",
        delivery_mode: "approval_required",
        subject: "Client report",
        html: "<p>Client report</p>",
        text: "Client report",
        approved_at: null,
        approved_by: null,
        recipients: [{ email: "client@example.com", status: "pending", error: null }],
        dispatch: {
          idempotency_key: "run-1:client:batch",
          status: "pending",
          attempt_count: 0,
          attempt_id: null,
          claimed_at: null,
          claim_expires_at: null,
          last_attempt_at: null,
          sent_at: null,
          last_error: null,
        },
      },
    };
  }

  static findById() {
    return { lean: async () => structuredClone(this.state) };
  }

  static async findOneAndUpdate(query, update) {
    if (!matches(this.state, query)) return null;
    this.apply(update);
    return structuredClone(this.state);
  }

  static async updateOne(query, update) {
    if (!matches(this.state, query)) return { matchedCount: 0, modifiedCount: 0 };
    this.apply(update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  static apply(update) {
    Object.entries(update.$set || {}).forEach(([path, value]) => {
      setPath(this.state, path, structuredClone(value));
    });
    Object.entries(update.$inc || {}).forEach(([path, value]) => {
      setPath(this.state, path, Number(getPath(this.state, path) || 0) + value);
    });
  }
}

class FakeIdempotentModel {
  static records = new Map();
  static sequence = 0;

  static reset() {
    this.records = new Map();
    this.sequence = 0;
  }

  static async findOneAndUpdate(query, update) {
    const key = query.observation_key
      ? `${query.report_run_id}:${query.observation_key}`
      : String(query.report_run_id || query.idempotency_key);
    if (!this.records.has(key)) {
      this.sequence += 1;
      this.records.set(key, { _id: `record-${this.sequence}`, ...update.$setOnInsert });
    }
    return this.records.get(key);
  }

  static async findOne(query) {
    const key = query.observation_key
      ? `${query.report_run_id}:${query.observation_key}`
      : String(query.report_run_id || query.idempotency_key);
    return this.records.get(key) || null;
  }
}

class FakeExecutionRunModel {
  static reportRun = null;

  static reset() {
    this.reportRun = null;
  }

  static async findOne(query) {
    return this.reportRun?.execution_key === query.execution_key
      ? this.reportRun
      : null;
  }

  static async create(document) {
    await Promise.resolve();
    const value = Array.isArray(document) ? document[0] : document;
    if (this.reportRun?.execution_key === value.execution_key) {
      const error = new Error("duplicate execution key");
      error.code = 11000;
      throw error;
    }
    this.reportRun = { _id: "run-winner", ...value };
    return Array.isArray(document) ? [this.reportRun] : this.reportRun;
  }
}

beforeEach(() => {
  process.env.REPORT_EMAIL_WEBHOOK_URL = "https://n8n.example.com/webhook/report";
  FakeReportModel.reset();
  FakeReportRunModel.reset();
  FakeIdempotentModel.reset();
  FakeExecutionRunModel.reset();
});

afterEach(() => {
  if (originalWebhookUrl === undefined) delete process.env.REPORT_EMAIL_WEBHOOK_URL;
  else process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhookUrl;
});

test("scheduled execution key is stable for one persisted UTC slot", () => {
  const input = {
    reportId: "report-1",
    source: "scheduled",
    scheduledFor: "2026-07-15T03:30:00.000Z",
  };
  assert.equal(buildExecutionKey(input), buildExecutionKey(input));
  assert.equal(
    buildExecutionKey(input),
    "scheduled:report-1:2026-07-15T03:30:00.000Z"
  );
});

test("sequential manual executions receive different identities", () => {
  const first = buildExecutionKey({ reportId: "report-1", source: "manual" });
  const second = buildExecutionKey({ reportId: "report-1", source: "manual" });
  assert.notEqual(first, second);
});

test("an execution-key creation race resolves to one logical ReportRun", async () => {
  const lease = await acquireReportExecutionLease({
    reportId: "report-1",
    source: "scheduled",
    ReportModel: FakeReportModel,
  });
  const input = {
    report: { ...lease.report, created_by: "user-1", monitored_campaigns: [] },
    leaseToken: lease.token,
    executionKey: "scheduled:report-1:2026-07-15T03:30:00.000Z",
    source: "scheduled",
    scheduledFor: new Date("2026-07-15T03:30:00.000Z"),
    period: {},
    ReportModel: FakeReportModel,
    ReportRunModel: FakeExecutionRunModel,
    metaBindingFence: async () => ({
      account: {
        _id: "account-1",
        ad_account_id: "act_1",
        name: "Test Account",
      },
      bindingRevision: 0,
    }),
    transactionRunner: ({ work }) => work({ id: "fake-session" }),
  };
  const [first, second] = await Promise.all([
    findOrCreateReportRun(input),
    findOrCreateReportRun(input),
  ]);
  assert.equal(first.reportRun._id, second.reportRun._id);
  assert.equal([first, second].filter((item) => item.created).length, 1);
});

test("two concurrent report lease attempts have one winner", async () => {
  const [first, second] = await Promise.all([
    acquireReportExecutionLease({ reportId: "report-1", source: "manual", ReportModel: FakeReportModel }),
    acquireReportExecutionLease({ reportId: "report-1", source: "scheduled", ReportModel: FakeReportModel }),
  ]);
  assert.equal([first, second].filter((item) => item.acquired).length, 1);
});

test("an archived report cannot acquire an execution lease", async () => {
  FakeReportModel.report.is_archived = true;

  const result = await acquireReportExecutionLease({
    reportId: "report-1",
    source: "manual",
    ReportModel: FakeReportModel,
  });

  assert.equal(result.acquired, false);
  assert.equal(FakeReportModel.report.execution_lock, null);
});

test("a lease can only be released by its owning token", async () => {
  const lease = await acquireReportExecutionLease({
    reportId: "report-1",
    source: "manual",
    ReportModel: FakeReportModel,
  });
  assert.equal(
    await releaseReportExecutionLease({
      reportId: "report-1",
      token: "not-the-owner",
      ReportModel: FakeReportModel,
    }),
    false
  );
  assert.equal(
    await releaseReportExecutionLease({
      reportId: "report-1",
      token: lease.token,
      ReportModel: FakeReportModel,
    }),
    true
  );
});

test("two concurrent batch dispatches call the webhook once", async () => {
  let sends = 0;
  const sendEmail = async () => {
    sends += 1;
    await Promise.resolve();
    return {
      sentAt: new Date(),
      recipients: [{ email: "team@example.com", status: "sent", error: null }],
    };
  };
  const [first, second] = await Promise.all([
    dispatchReportRunArtifact({
      reportRunId: "run-1",
      audience: "internal",
      ReportRunModel: FakeReportRunModel,
      sendEmail,
    }),
    dispatchReportRunArtifact({
      reportRunId: "run-1",
      audience: "internal",
      ReportRunModel: FakeReportRunModel,
      sendEmail,
    }),
  ]);
  assert.equal(sends, 1);
  assert.ok([first.outcome, second.outcome].includes("sent"));
  assert.ok([first.outcome, second.outcome].includes("in_progress"));
});

test("a sent dispatch is not sent again", async () => {
  FakeReportRunModel.reset("sent");
  FakeReportRunModel.state.internal_report.status = "sent";
  let sends = 0;
  const result = await dispatchReportRunArtifact({
    reportRunId: "run-1",
    audience: "internal",
    ReportRunModel: FakeReportRunModel,
    sendEmail: async () => {
      sends += 1;
    },
  });
  assert.equal(result.outcome, "already_sent");
  assert.equal(sends, 0);
});

test("a known local pre-dispatch failure persists failed and may be retried", async () => {
  delete process.env.REPORT_EMAIL_WEBHOOK_URL;
  let sends = 0;
  const result = await dispatchReportRunArtifact({
    reportRunId: "run-1",
    audience: "internal",
    ReportRunModel: FakeReportRunModel,
    sendEmail: async () => {
      sends += 1;
    },
  });
  assert.equal(result.outcome, "failed");
  assert.equal(FakeReportRunModel.state.internal_report.dispatch.status, "failed");
  assert.equal(sends, 0);

  process.env.REPORT_EMAIL_WEBHOOK_URL = "https://n8n.example.com/webhook/report";
  let retryKey = null;
  const retry = await dispatchReportRunArtifact({
    reportRunId: "run-1",
    audience: "internal",
    allowFailedRetry: true,
    ReportRunModel: FakeReportRunModel,
    sendEmail: async ({ idempotencyKey }) => {
      retryKey = idempotencyKey;
      return {
        sentAt: new Date(),
        recipients: [{ email: "team@example.com", status: "sent", error: null }],
      };
    },
  });
  assert.equal(retry.outcome, "sent");
  assert.equal(retryKey, "run-1:internal:batch");
  assert.equal(FakeReportRunModel.state.internal_report.dispatch.attempt_count, 1);
});

test("an ambiguous webhook result persists uncertain and is never auto-claimed again", async () => {
  let sends = 0;
  const error = new Error("HTTP 500");
  error.code = "EMAIL_WEBHOOK_RESPONSE_UNCERTAIN";
  error.category = "response";
  error.ambiguous = true;
  const first = await dispatchReportRunArtifact({
    reportRunId: "run-1",
    audience: "internal",
    ReportRunModel: FakeReportRunModel,
    sendEmail: async () => {
      sends += 1;
      throw error;
    },
  });
  const second = await dispatchReportRunArtifact({
    reportRunId: "run-1",
    audience: "internal",
    allowFailedRetry: true,
    ReportRunModel: FakeReportRunModel,
    sendEmail: async () => {
      sends += 1;
    },
  });
  assert.equal(first.outcome, "uncertain");
  assert.equal(second.outcome, "uncertain");
  assert.equal(sends, 1);
  assert.equal(
    FakeReportRunModel.state.internal_report.dispatch.idempotency_key,
    "run-1:internal:batch"
  );
});

test("pending client report cancellation is atomic and idempotent", async () => {
  const first = await cancelClientReportDelivery({
    reportRunId: "run-1",
    agencyId: "agency-1",
    userId: "user-1",
    ReportRunModel: FakeReportRunModel,
  });
  const second = await cancelClientReportDelivery({
    reportRunId: "run-1",
    agencyId: "agency-1",
    ReportRunModel: FakeReportRunModel,
  });
  assert.equal(first.outcome, "cancelled");
  assert.equal(second.outcome, "already_cancelled");
  assert.equal(FakeReportRunModel.state.client_report.status, "cancelled");
  assert.equal(FakeReportRunModel.state.client_report.dispatch.status, "not_required");
  assert.equal(FakeReportRunModel.state.client_report.cancelled_by, "user-1");
  assert.ok(FakeReportRunModel.state.client_report.cancelled_at);
  assert.equal(
    FakeReportRunModel.state.client_report.dispatch.idempotency_key,
    "run-1:client:batch"
  );
});

test("active, sent, and uncertain client dispatches cannot be cancelled", async () => {
  for (const [dispatchStatus, artifactStatus, expected] of [
    ["dispatching", "awaiting_approval", "in_progress"],
    ["sent", "sent", "already_sent"],
    ["uncertain", "held_for_review", "uncertain"],
  ]) {
    FakeReportRunModel.reset();
    FakeReportRunModel.state.client_report.dispatch.status = dispatchStatus;
    FakeReportRunModel.state.client_report.status = artifactStatus;
    const result = await cancelClientReportDelivery({
      reportRunId: "run-1",
      agencyId: "agency-1",
      ReportRunModel: FakeReportRunModel,
    });
    assert.equal(result.outcome, expected);
    assert.equal(FakeReportRunModel.state.client_report.status, artifactStatus);
    assert.equal(
      FakeReportRunModel.state.client_report.dispatch.status,
      dispatchStatus
    );
  }
});

test("a definitively failed client dispatch may be cancelled", async () => {
  FakeReportRunModel.state.client_report.status = "held_for_review";
  FakeReportRunModel.state.client_report.dispatch.status = "failed";
  const result = await cancelClientReportDelivery({
    reportRunId: "run-1",
    agencyId: "agency-1",
    ReportRunModel: FakeReportRunModel,
  });
  assert.equal(result.outcome, "cancelled");
  assert.equal(FakeReportRunModel.state.client_report.dispatch.status, "not_required");
});

test("a not-required client dispatch is not rewritten as cancelled", async () => {
  FakeReportRunModel.state.client_report.status = "generated";
  FakeReportRunModel.state.client_report.dispatch.status = "not_required";

  const result = await cancelClientReportDelivery({
    reportRunId: "run-1",
    agencyId: "agency-1",
    userId: "user-1",
    ReportRunModel: FakeReportRunModel,
  });

  assert.equal(result.outcome, "not_cancellable");
  assert.equal(FakeReportRunModel.state.client_report.status, "generated");
  assert.equal(FakeReportRunModel.state.client_report.dispatch.status, "not_required");
  assert.equal(FakeReportRunModel.state.client_report.cancelled_at, undefined);
});

test("concurrent cancellation cannot overwrite a claimed or sent client dispatch", async () => {
  let signalStarted;
  let releaseSend;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const release = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const approval = dispatchReportRunArtifact({
    reportRunId: "run-1",
    audience: "client",
    claimSet: {
      "client_report.approved_by": "user-1",
      "client_report.approved_at": new Date("2026-07-15T00:00:00.000Z"),
    },
    ReportRunModel: FakeReportRunModel,
    sendEmail: async () => {
      signalStarted();
      await release;
      return {
        sentAt: new Date("2026-07-15T00:01:00.000Z"),
        recipients: [{ email: "client@example.com", status: "sent", error: null }],
      };
    },
  });
  await started;

  const cancellation = await cancelClientReportDelivery({
    reportRunId: "run-1",
    agencyId: "agency-1",
    ReportRunModel: FakeReportRunModel,
  });
  assert.equal(cancellation.outcome, "in_progress");
  assert.equal(FakeReportRunModel.state.client_report.dispatch.status, "dispatching");

  releaseSend();
  const approved = await approval;
  assert.equal(approved.outcome, "sent");
  assert.equal(FakeReportRunModel.state.client_report.status, "sent");
  assert.equal(FakeReportRunModel.state.client_report.dispatch.status, "sent");
  assert.equal(FakeReportRunModel.state.client_report.approved_by, "user-1");
});

test("only the winning concurrent approver is recorded", async () => {
  let sends = 0;
  const actors = ["user-1", "user-2"];
  const results = await Promise.all(
    actors.map((actor) =>
      dispatchReportRunArtifact({
        reportRunId: "run-1",
        audience: "client",
        claimSet: {
          "client_report.approved_by": actor,
          "client_report.approved_at": new Date(),
        },
        ReportRunModel: FakeReportRunModel,
        sendEmail: async () => {
          sends += 1;
          await Promise.resolve();
          return {
            sentAt: new Date(),
            recipients: [
              { email: "client@example.com", status: "sent", error: null },
            ],
          };
        },
      })
    )
  );
  const winnerIndex = results.findIndex((result) => result.outcome === "sent");
  assert.notEqual(winnerIndex, -1);
  assert.equal(sends, 1);
  assert.equal(
    FakeReportRunModel.state.client_report.approved_by,
    actors[winnerIndex]
  );

  const loser = await dispatchReportRunArtifact({
    reportRunId: "run-1",
    audience: "client",
    claimSet: {
      "client_report.approved_by": "late-loser",
      "client_report.approved_at": new Date(),
    },
    ReportRunModel: FakeReportRunModel,
    sendEmail: async () => {
      sends += 1;
    },
  });
  assert.equal(loser.outcome, "already_sent");
  assert.equal(
    FakeReportRunModel.state.client_report.approved_by,
    actors[winnerIndex]
  );
  assert.equal(sends, 1);
});

test("signal persistence is idempotent for one ReportRun", async () => {
  const input = {
    report: { _id: "report-1", agency_id: "agency-1", client_id: "client-1" },
    narrative: {
      status: "insufficient_data",
      reason: "Need more data",
      userInsight: { headline: "Data needed" },
    },
    comparison: { period: { current: { start: "2026-07-14", end: "2026-07-14" } } },
    reportRunId: "run-1",
    reportRun: {
      _id: "run-1",
      started_at: new Date("2026-07-14T00:00:00.000Z"),
      context_snapshot: {
        source: "execution",
        captured_at: new Date("2026-07-14T00:00:00.000Z"),
        workspace: { name: "Agency" },
        client: { name: "Client" },
        report: { name: "Report" },
      },
      monitored_campaigns: [],
    },
    SignalModel: FakeIdempotentModel,
  };
  const first = await saveSignalsFromNarrative(input);
  const second = await saveSignalsFromNarrative(input);
  assert.equal(first[0]._id, second[0]._id);
  assert.equal(FakeIdempotentModel.records.size, 1);
});

test("machine activity persistence is idempotent for one event key", async () => {
  const input = {
    agency_id: "agency-1",
    type: "report_executed",
    title: "Report executed",
    idempotency_key: "report-run:run-1:executed",
    ActivityModel: FakeIdempotentModel,
  };
  const first = await recordActivity(input);
  const second = await recordActivity(input);
  assert.equal(first._id, second._id);
  assert.equal(FakeIdempotentModel.records.size, 1);
});

test("historical documents validate without new idempotency fields", () => {
  const id = () => new mongoose.Types.ObjectId();
  assert.equal(
    new ReportRun({
      agency_id: id(),
      client_id: id(),
      report_id: id(),
      status: "ok",
      severity: "low",
      narrative: {},
    }).validateSync(),
    undefined
  );
  assert.equal(
    new Signal({
      agency_id: id(),
      client_id: id(),
      type: "metric_anomaly",
      severity: "moderate",
      title: "Signal",
    }).validateSync(),
    undefined
  );
  assert.equal(
    new Activity({
      agency_id: id(),
      type: "report_executed",
      title: "Executed",
      severity: "stable",
    }).validateSync(),
    undefined
  );
});

test("new idempotency indexes preserve execution and per-observation uniqueness", () => {
  const indexes = (model) => model.schema.indexes().map(([fields, options]) => ({ fields, options }));
  const reportRunIndex = indexes(ReportRun).find((item) => item.fields.execution_key === 1);
  const signalIndex = indexes(Signal).find(
    (item) =>
      item.fields.agency_id === 1 &&
      item.fields.report_run_id === 1 &&
      item.fields.observation_key === 1
  );
  const activityIndex = indexes(Activity).find((item) => item.fields.idempotency_key === 1);
  [reportRunIndex, activityIndex].forEach((index) => {
    assert.equal(index.options.unique, true);
    assert.equal(index.options.sparse, true);
  });
  assert.equal(signalIndex.options.unique, true);
  assert.deepEqual(signalIndex.options.partialFilterExpression, {
    report_run_id: { $type: "objectId" },
    observation_key: { $type: "string" },
  });
});

test("one ReportRun persists distinct metric Signals without retry duplication", async () => {
  const input = {
    report: { _id: "report-1", agency_id: "agency-1", client_id: "client-1" },
    narrative: {
      status: "ok",
      severity: { level: "high" },
      executiveSummary: "Several independent metrics need attention.",
      likelyCause: { id: "creative_fatigue", archetype: "Creative fatigue" },
      campaign: { id: "campaign-1" },
      rankedAnomalies: [
        { metric: "ctr", label: "CTR", delta: -30, direction: "bad", usable: true },
        { metric: "cpa", label: "CPA", delta: 45, direction: "bad", usable: true },
        { metric: "roas", label: "ROAS", delta: -25, direction: "bad", usable: true },
      ],
    },
    comparison: {
      period: {
        current: { start: "2026-07-14", end: "2026-07-14" },
        previous: { start: "2026-07-13", end: "2026-07-13" },
      },
    },
    reportRunId: "run-multiple",
    reportRun: {
      _id: "run-multiple",
      started_at: new Date("2026-07-14T00:00:00.000Z"),
      context_snapshot: {
        source: "execution",
        captured_at: new Date("2026-07-14T00:00:00.000Z"),
      },
      monitored_campaigns: [{ campaign_id: "campaign-1" }],
    },
    SignalModel: FakeIdempotentModel,
  };
  const [first, second] = await Promise.all([
    saveSignalsFromNarrative(input),
    saveSignalsFromNarrative(input),
  ]);
  assert.equal(first.length, 3);
  assert.equal(second.length, 3);
  assert.equal(FakeIdempotentModel.records.size, 3);
  assert.equal(new Set(first.map((signal) => signal.observation_key)).size, 3);
});
