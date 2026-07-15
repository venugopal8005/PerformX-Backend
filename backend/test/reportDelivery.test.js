import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  buildDeliveryIdempotencyKey,
  prepareReportDelivery,
  sendReportEmail,
  summarizeReportDelivery,
} from "../src/services/reportDelivery.service.js";

const originalFetch = global.fetch;
const originalWebhookUrl = process.env.REPORT_EMAIL_WEBHOOK_URL;
const originalTimeout = process.env.REPORT_EMAIL_WEBHOOK_TIMEOUT_MS;

const okResponse = (status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
});

const reportFixture = (deliveryMode) => ({
  _id: "report-1",
  agency_id: "agency-1",
  client_id: "client-1",
  name: "Weekly Monitor",
  type: "weekly",
  internal_recipients: ["team@example.com"],
  client_recipients: ["client@example.com"],
  client_delivery_mode: deliveryMode,
  safety_settings: {
    notify_team_when_held: true,
  },
});

const narrativeFixture = {
  status: "ok",
  executiveSummary: "Performance remained stable with enough delivery data.",
  trustGate: { level: "high", blocked: false, flags: {} },
  dataQuality: { level: "strong", flags: {} },
  userInsight: {
    plainSummary: "Performance remained stable with enough delivery data.",
    decisionBrief: {
      decision: "hold",
      label: "Keep monitoring",
      primaryAction: "Keep the current setup and monitor the next report.",
      confidence: "high",
    },
  },
};

const comparisonFixture = {
  period: {
    current: { start: "2026-07-01", end: "2026-07-07" },
    previous: { start: "2026-06-24", end: "2026-06-30" },
  },
  currentPeriodMetrics: { spend: 1000, impressions: 20000, clicks: 500 },
  previousPeriodMetrics: { spend: 900, impressions: 18000, clicks: 450 },
  rowCounts: { current: 7, previous: 7, total: 14 },
};

beforeEach(() => {
  process.env.REPORT_EMAIL_WEBHOOK_URL = "https://n8n.example.com/webhook/report-secret";
  delete process.env.REPORT_EMAIL_WEBHOOK_TIMEOUT_MS;
});

afterEach(() => {
  global.fetch = originalFetch;

  if (originalWebhookUrl === undefined) delete process.env.REPORT_EMAIL_WEBHOOK_URL;
  else process.env.REPORT_EMAIL_WEBHOOK_URL = originalWebhookUrl;

  if (originalTimeout === undefined) delete process.env.REPORT_EMAIL_WEBHOOK_TIMEOUT_MS;
  else process.env.REPORT_EMAIL_WEBHOOK_TIMEOUT_MS = originalTimeout;
});

test("manual delivery posts the internal report payload to REPORT_EMAIL_WEBHOOK_URL", async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return okResponse(200);
  };

  const result = await sendReportEmail({
    recipients: ["team@example.com"],
    subject: "Internal report",
    html: "<html><body>Internal</body></html>",
    text: "Internal",
    reportType: "internal_report",
    metadata: { agencyId: "agency-1", reportId: "report-1" },
    idempotencyKey: "run-1:internal:batch",
  });

  const payload = JSON.parse(request.options.body);
  assert.equal(request.url, process.env.REPORT_EMAIL_WEBHOOK_URL);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["x-idempotency-key"], "run-1:internal:batch");
  assert.deepEqual(payload.recipients, ["team@example.com"]);
  assert.equal(payload.emailSubject, "Internal report");
  assert.equal(payload.emailHtml, "<html><body>Internal</body></html>");
  assert.equal(payload.senderName, "Narrative");
  assert.equal(payload.reportType, "internal_report");
  assert.equal(payload.idempotency_key, "run-1:internal:batch");
  assert.equal(result.recipients[0].status, "sent");
});

test("eligible client report uses the same webhook with client_report payload", async () => {
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return okResponse(202);
  };

  await sendReportEmail({
    recipients: ["client@example.com"],
    subject: "Client report",
    html: "<html><body>Client</body></html>",
    text: "Client",
    reportType: "client_report",
  });

  assert.deepEqual(payload.recipients, ["client@example.com"]);
  assert.equal(payload.reportType, "client_report");
  assert.equal(payload.emailSubject, "Client report");
  assert.equal(payload.emailHtml, "<html><body>Client</body></html>");
});

for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
  test(`webhook HTTP ${status} is ambiguous after request initiation`, async () => {
    global.fetch = async () => okResponse(status);

    await assert.rejects(
      sendReportEmail({
        recipients: ["team@example.com"],
        subject: "Report",
        html: "<p>Report</p>",
        reportType: "internal_report",
      }),
      (error) =>
        error.code === "EMAIL_WEBHOOK_RESPONSE_UNCERTAIN" &&
        error.category === "response" &&
        error.responseStatus === status &&
        error.ambiguous === true
    );
  });
}

for (const status of [200, 202, 204]) {
  test(`webhook HTTP ${status} is confirmed as accepted`, async () => {
    global.fetch = async () => okResponse(status);
    const result = await sendReportEmail({
      recipients: ["team@example.com"],
      subject: "Report",
      html: "<p>Report</p>",
      reportType: "internal_report",
    });
    assert.equal(result.recipients[0].status, "sent");
  });
}

for (const fixture of [
  {
    name: "empty recipients",
    input: { recipients: [], subject: "Report", html: "<p>Report</p>" },
    code: "EMAIL_RECIPIENTS_MISSING",
  },
  {
    name: "missing subject",
    input: { recipients: ["team@example.com"], subject: "", html: "<p>Report</p>" },
    code: "EMAIL_SUBJECT_MISSING",
  },
  {
    name: "missing HTML body",
    input: { recipients: ["team@example.com"], subject: "Report", html: "" },
    code: "EMAIL_BODY_MISSING",
  },
]) {
  test(`${fixture.name} fails before fetch`, async () => {
    let fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return okResponse(200);
    };
    await assert.rejects(
      sendReportEmail({ ...fixture.input, reportType: "internal_report" }),
      (error) => error.code === fixture.code && error.ambiguous === false
    );
    assert.equal(fetchCalled, false);
  });
}

test("missing REPORT_EMAIL_WEBHOOK_URL fails without using an obsolete fallback", async () => {
  delete process.env.REPORT_EMAIL_WEBHOOK_URL;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return okResponse(200);
  };

  await assert.rejects(
    sendReportEmail({
      recipients: ["team@example.com"],
      subject: "Report",
      html: "<p>Report</p>",
      reportType: "internal_report",
    }),
    (error) =>
      error.code === "EMAIL_WEBHOOK_NOT_CONFIGURED" &&
      error.category === "configuration"
  );
  assert.equal(fetchCalled, false);
});

test("network failure is not reported as delivery success", async () => {
  global.fetch = async () => {
    throw new TypeError("connection refused");
  };

  await assert.rejects(
    sendReportEmail({
      recipients: ["team@example.com"],
      subject: "Report",
      html: "<p>Report</p>",
      reportType: "internal_report",
    }),
    (error) =>
      error.code === "EMAIL_WEBHOOK_NETWORK_FAILED" &&
      error.category === "network" &&
      error.ambiguous === true
  );
});

for (const message of ["getaddrinfo ENOTFOUND", "ECONNRESET"]) {
  test(`${message} remains uncertain after fetch starts`, async () => {
    global.fetch = async () => {
      throw new TypeError(message);
    };
    await assert.rejects(
      sendReportEmail({
        recipients: ["team@example.com"],
        subject: "Report",
        html: "<p>Report</p>",
        reportType: "internal_report",
      }),
      (error) => error.code === "EMAIL_WEBHOOK_NETWORK_FAILED" && error.ambiguous
    );
  });
}

test("webhook timeout is not reported as delivery success", async () => {
  process.env.REPORT_EMAIL_WEBHOOK_TIMEOUT_MS = "10";
  global.fetch = async (_url, options) =>
    new Promise((resolve, reject) => {
      const keepAlive = setTimeout(resolve, 1_000);
      options.signal.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(options.signal.reason);
      });
    });

  await assert.rejects(
    sendReportEmail({
      recipients: ["team@example.com"],
      subject: "Report",
      html: "<p>Report</p>",
      reportType: "internal_report",
    }),
    (error) =>
      error.code === "EMAIL_WEBHOOK_TIMEOUT" &&
      error.category === "timeout" &&
      error.ambiguous === true
  );
});

test("generate_only prepares internal delivery and marks client dispatch not required", () => {
  const result = prepareReportDelivery({
    reportRunId: "run-1",
    report: reportFixture("generate_only"),
    narrative: narrativeFixture,
    comparison: comparisonFixture,
    clientName: "Example Client",
    generatedAt: "12 Jul 2026",
    reportUrl: "https://app.example.com/reports/report-1",
  });

  assert.equal(result.internalReport.status, "generated");
  assert.equal(result.internalReport.dispatch.status, "pending");
  assert.equal(result.clientReport.status, "generated");
  assert.equal(result.clientReport.dispatch.status, "not_required");
});

test("approval_required prepares a pending client dispatch and durable notification", () => {
  const result = prepareReportDelivery({
    reportRunId: "run-1",
    report: reportFixture("approval_required"),
    narrative: narrativeFixture,
    comparison: comparisonFixture,
    clientName: "Example Client",
    generatedAt: "12 Jul 2026",
    reportUrl: "https://app.example.com/reports/report-1",
  });

  assert.equal(result.clientReport.status, "awaiting_approval");
  assert.equal(result.clientReport.dispatch.status, "pending");
  assert.equal(result.notification.kind, "approval");
  assert.equal(result.notification.dispatch.status, "pending");
});

test("auto_send prepares a pending client dispatch only when safety passes", () => {
  const result = prepareReportDelivery({
    reportRunId: "run-1",
    report: reportFixture("auto_send"),
    narrative: narrativeFixture,
    comparison: comparisonFixture,
    clientName: "Example Client",
    generatedAt: "12 Jul 2026",
    reportUrl: "https://app.example.com/reports/report-1",
  });

  assert.equal(result.clientReport.safety.passed, true);
  assert.equal(result.clientReport.status, "generated");
  assert.equal(result.clientReport.dispatch.status, "pending");
});

test("delivery idempotency key is deterministic for an artifact batch", () => {
  assert.equal(
    buildDeliveryIdempotencyKey({
      reportRunId: "run-1",
      audience: "client",
    }),
    "run-1:client:batch"
  );
});

test("delivery summary rejects a failed expected email", () => {
  const delivery = summarizeReportDelivery({
    internalReport: {
      status: "failed",
      dispatch: {
        status: "failed",
        last_error: { code: "HTTP_400", category: "response", message: "HTTP 400" },
      },
      recipients: [{ email: "team@example.com", status: "failed", error: "HTTP 500" }],
    },
    clientReport: { status: "generated", recipients: [] },
  });

  assert.equal(delivery.confirmed, false);
  assert.equal(delivery.failures[0].reportType, "internal_report");
});
