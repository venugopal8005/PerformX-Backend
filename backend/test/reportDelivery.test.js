import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import {
  processReportDelivery,
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
  });

  const payload = JSON.parse(request.options.body);
  assert.equal(request.url, process.env.REPORT_EMAIL_WEBHOOK_URL);
  assert.equal(request.options.method, "POST");
  assert.deepEqual(payload.recipients, ["team@example.com"]);
  assert.equal(payload.emailSubject, "Internal report");
  assert.equal(payload.emailHtml, "<html><body>Internal</body></html>");
  assert.equal(payload.senderName, "Narrative");
  assert.equal(payload.reportType, "internal_report");
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

test("webhook non-2xx response is a delivery failure", async () => {
  global.fetch = async () => okResponse(500);

  await assert.rejects(
    sendReportEmail({
      recipients: ["team@example.com"],
      subject: "Report",
      html: "<p>Report</p>",
      reportType: "internal_report",
    }),
    (error) =>
      error.code === "EMAIL_WEBHOOK_RESPONSE_FAILED" &&
      error.category === "response"
  );
});

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
      error.category === "network"
  );
});

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
    (error) => error.code === "EMAIL_WEBHOOK_TIMEOUT" && error.category === "timeout"
  );
});

test("generate_only sends the internal report and does not send a client email", async () => {
  const reportTypes = [];
  global.fetch = async (_url, options) => {
    reportTypes.push(JSON.parse(options.body).reportType);
    return okResponse(200);
  };

  const result = await processReportDelivery({
    report: reportFixture("generate_only"),
    narrative: narrativeFixture,
    comparison: comparisonFixture,
    clientName: "Example Client",
    generatedAt: "12 Jul 2026",
    reportUrl: "https://app.example.com/reports/report-1",
  });

  assert.deepEqual(reportTypes, ["internal_report"]);
  assert.equal(result.internalReport.status, "sent");
  assert.equal(result.clientReport.status, "generated");
  assert.equal(result.delivery.confirmed, true);
});

test("approval_required holds client delivery and sends only internal email types", async () => {
  const reportTypes = [];
  global.fetch = async (_url, options) => {
    reportTypes.push(JSON.parse(options.body).reportType);
    return okResponse(200);
  };

  const result = await processReportDelivery({
    report: reportFixture("approval_required"),
    narrative: narrativeFixture,
    comparison: comparisonFixture,
    clientName: "Example Client",
    generatedAt: "12 Jul 2026",
    reportUrl: "https://app.example.com/reports/report-1",
  });

  assert.deepEqual(reportTypes, ["internal_report", "internal_notification"]);
  assert.equal(result.clientReport.status, "awaiting_approval");
  assert.equal(result.delivery.confirmed, true);
});

test("auto_send posts an eligible client report after the internal report", async () => {
  const reportTypes = [];
  global.fetch = async (_url, options) => {
    reportTypes.push(JSON.parse(options.body).reportType);
    return okResponse(200);
  };

  const result = await processReportDelivery({
    report: reportFixture("auto_send"),
    narrative: narrativeFixture,
    comparison: comparisonFixture,
    clientName: "Example Client",
    generatedAt: "12 Jul 2026",
    reportUrl: "https://app.example.com/reports/report-1",
  });

  assert.deepEqual(reportTypes, ["internal_report", "client_report"]);
  assert.equal(result.clientReport.status, "sent");
  assert.equal(result.delivery.confirmed, true);
});

test("delivery summary rejects a failed expected email", () => {
  const delivery = summarizeReportDelivery({
    internalReport: {
      status: "failed",
      recipients: [{ email: "team@example.com", status: "failed", error: "HTTP 500" }],
    },
    clientReport: { status: "generated", recipients: [] },
  });

  assert.equal(delivery.confirmed, false);
  assert.equal(delivery.failures[0].reportType, "internal_report");
});
