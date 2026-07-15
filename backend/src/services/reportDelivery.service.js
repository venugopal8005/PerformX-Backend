import crypto from "crypto";

import {
  formatPerformanceEmail,
} from "../utils/performanceEmailFormatter.js";
import { ReportRun } from "../models/index.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "ReportDelivery";
const DEFAULT_WEBHOOK_TIMEOUT_MS = 30_000;
const MAX_WEBHOOK_TIMEOUT_MS = 120_000;
const DELIVERY_CLAIM_MS = 3 * 60 * 1000;

const CLIENT_DELIVERY_MODES = new Set([
  "generate_only",
  "auto_send",
  "approval_required",
]);

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

export const normalizeEmailList = (value = []) => {
  const emails = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(new Set(emails.map(normalizeEmail).filter(Boolean)));
};

export const normalizeClientDeliveryMode = (value) => {
  const mode = String(value || "").trim();
  return CLIENT_DELIVERY_MODES.has(mode) ? mode : "generate_only";
};

export const defaultSafetySettings = {
  hold_client_report_on_low_trust: true,
  hold_client_report_on_missing_metrics: true,
  hold_client_report_on_insufficient_data: true,
  notify_team_when_held: true,
};

export const normalizeSafetySettings = (value = {}) => ({
  hold_client_report_on_low_trust:
    value.hold_client_report_on_low_trust ??
    value.holdClientReportOnLowTrust ??
    defaultSafetySettings.hold_client_report_on_low_trust,
  hold_client_report_on_missing_metrics:
    value.hold_client_report_on_missing_metrics ??
    value.holdClientReportOnMissingMetrics ??
    defaultSafetySettings.hold_client_report_on_missing_metrics,
  hold_client_report_on_insufficient_data:
    value.hold_client_report_on_insufficient_data ??
    value.holdClientReportOnInsufficientData ??
    defaultSafetySettings.hold_client_report_on_insufficient_data,
  notify_team_when_held:
    value.notify_team_when_held ??
    value.notifyTeamWhenHeld ??
    defaultSafetySettings.notify_team_when_held,
});

export const toRecipientStatus = (recipients, status, error = null) =>
  normalizeEmailList(recipients).map((email) => ({
    email,
    status,
    error,
  }));

export const resolveReportRecipients = (report) => {
  const legacyRecipients = normalizeEmailList(report.recipients || []);
  const internalRecipients = normalizeEmailList(report.internal_recipients || []);
  const clientRecipients = normalizeEmailList(report.client_recipients || []);

  return {
    internalRecipients: internalRecipients.length ? internalRecipients : legacyRecipients,
    clientRecipients,
  };
};

const stripHtml = (html = "") =>
  String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const formatPeriodLabel = (period = {}) => {
  if (!period) return "Unknown period";

  const current = period.current || period;
  const previous = period.previous;
  const currentStart = current.start || current.date_start || current.dateStart;
  const currentEnd = current.end || current.date_stop || current.dateStop;
  const previousStart = previous?.start || previous?.date_start || previous?.dateStart;
  const previousEnd = previous?.end || previous?.date_stop || previous?.dateStop;
  const currentLabel =
    currentStart && currentEnd && currentStart !== currentEnd
      ? `${currentStart} to ${currentEnd}`
      : currentStart || currentEnd || "";
  const previousLabel =
    previousStart && previousEnd && previousStart !== previousEnd
      ? `${previousStart} to ${previousEnd}`
      : previousStart || previousEnd || "";

  if (previousLabel && currentLabel) return `${previousLabel} vs ${currentLabel}`;
  return currentLabel || "Unknown period";
};

const cloneWithSanitizedText = (value) => {
  if (Array.isArray(value)) return value.map(cloneWithSanitizedText);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;

    return value
      .replace(/pause weakest ad immediately/gi, "review the weakest ad before scaling")
      .replace(/pause this ad/gi, "review or refresh this ad")
      .replace(/pause it/gi, "review it")
      .replace(/kill\b/gi, "stop investing in")
      .replace(/\bdebug\b/gi, "diagnostic");
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneWithSanitizedText(item)])
  );
};

export const buildReportArtifacts = ({
  report,
  narrative,
  comparison,
  clientName,
  generatedAt,
}) => {
  const dateRange = formatPeriodLabel(comparison?.period || narrative?.period);
  const internalSubject = `Internal Performance Report - ${clientName} - ${dateRange}`;
  const clientSubject = `Performance Report - ${clientName} - ${dateRange}`;
  const internalHtml = formatPerformanceEmail(narrative, {
    title: "Internal Team Report",
    subject: internalSubject,
    campaignName: report.name,
    generatedAt,
    includeDiagnostics: true,
  });
  const clientNarrative = cloneWithSanitizedText(narrative);
  const clientHtml = formatPerformanceEmail(clientNarrative, {
    title: "Performance Report",
    subject: clientSubject,
    campaignName: report.name,
    generatedAt,
    includeDiagnostics: false,
  });

  return {
    dateRange,
    internalReport: {
      subject: internalSubject,
      html: internalHtml,
      text: stripHtml(internalHtml),
    },
    clientReport: {
      subject: clientSubject,
      html: clientHtml,
      text: stripHtml(clientHtml),
    },
  };
};

const allZero = (metrics = {}) =>
  ["spend", "impressions", "clicks"].every((metric) => Number(metrics?.[metric] || 0) <= 0);

const addReason = (reasons, condition, reason) => {
  if (condition) reasons.push(reason);
};

export const runClientReportSafetyChecks = ({
  report,
  narrative,
  comparison,
  clientReport,
  clientName,
  recipients = [],
}) => {
  const settings = normalizeSafetySettings(report.safety_settings || {});
  const reasons = [];
  const warnings = [];
  const currentMetrics = comparison?.currentPeriodMetrics || {};
  const previousMetrics = comparison?.previousPeriodMetrics || {};
  const rowCounts = comparison?.rowCounts || {};
  const trustGate = narrative?.trustGate || narrative?.userInsight?.trustGate || {};
  const dataQuality = narrative?.dataQuality || {};
  const htmlText = stripHtml(clientReport?.html || "");
  const dateRange = formatPeriodLabel(comparison?.period || narrative?.period);
  const naCount = (htmlText.match(/\bN\/A\b|not available|unknown period/gi) || []).length;

  addReason(reasons, !narrative, "Report data is missing.");
  addReason(reasons, !comparison, "Meta comparison data is missing.");
  addReason(reasons, !comparison?.period?.current, "Report period is missing.");
  addReason(
    reasons,
    !comparison?.period?.previous && report.type !== "daily",
    "Compared period is missing."
  );
  addReason(
    reasons,
    rowCounts.current === 0 || rowCounts.previous === 0,
    "Meta returned too little data for the compared periods."
  );
  addReason(
    reasons,
    settings.hold_client_report_on_insufficient_data &&
      narrative?.status === "insufficient_data",
    "The engine returned insufficient_data."
  );
  addReason(
    reasons,
    settings.hold_client_report_on_missing_metrics &&
      allZero(currentMetrics) &&
      allZero(previousMetrics),
    "Spend, impressions, and clicks are all zero."
  );
  addReason(
    reasons,
    settings.hold_client_report_on_missing_metrics && naCount > 8,
    "The client report contains too many unavailable metric values."
  );
  addReason(
    reasons,
    !narrative?.userInsight?.plainSummary &&
      !narrative?.executiveSummary &&
      !narrative?.userInsight?.decisionBrief?.primaryAction,
    "The report has no useful insight or stable-performance message."
  );
  addReason(reasons, !clientName || clientName === "Client", "Client name is missing.");
  addReason(reasons, dateRange === "Unknown period", "Date range is missing.");
  addReason(reasons, trustGate.blocked === true, "The engine trust gate blocked client send.");
  addReason(
    reasons,
    settings.hold_client_report_on_low_trust && trustGate.level === "low",
    "The engine trust level is low."
  );
  addReason(
    reasons,
    settings.hold_client_report_on_insufficient_data &&
      ["insufficient", "insufficient_data", "limited"].includes(dataQuality.level),
    `Data quality is ${dataQuality.level}.`
  );
  addReason(
    reasons,
    trustGate.flags?.dataWindowMismatch ||
      dataQuality.flags?.dataWindowMismatch ||
      /data window mismatch/i.test(htmlText),
    "Report contains a data window mismatch."
  );
  addReason(reasons, /debug|raw json|diagnostic fields/i.test(htmlText), "Client report exposes diagnostic/debug content.");
  addReason(
    reasons,
    /pause weakest ad immediately/i.test(htmlText),
    "Client report contains blunt internal tactical language."
  );
  addReason(
    reasons,
    normalizeEmailList(recipients).length === 0,
    "No client recipients are selected."
  );

  if (trustGate.level && trustGate.level !== "high") {
    warnings.push(`Trust level: ${trustGate.level}`);
  }

  if (dataQuality.level && dataQuality.level !== "strong") {
    warnings.push(`Data quality: ${dataQuality.level}`);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    warnings,
  };
};

const webhookTimeoutMs = () => {
  const configured = Number(process.env.REPORT_EMAIL_WEBHOOK_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_WEBHOOK_TIMEOUT_MS;
  }

  return Math.min(configured, MAX_WEBHOOK_TIMEOUT_MS);
};

const createDeliveryError = (
  message,
  {
    code,
    category,
    status = 502,
    cause,
    responseStatus = null,
    ambiguous = false,
  } = {}
) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code || "EMAIL_WEBHOOK_FAILED";
  error.category = category || "unknown";
  error.status = status;
  error.responseStatus = responseStatus;
  error.ambiguous = ambiguous;
  return error;
};

export const getReportEmailWebhookConfig = () => {
  const rawUrl = String(process.env.REPORT_EMAIL_WEBHOOK_URL || "").trim();

  if (!rawUrl) {
    return {
      configured: false,
      host: null,
      url: null,
      timeoutMs: webhookTimeoutMs(),
    };
  }

  try {
    const parsed = new URL(rawUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("Unsupported protocol");

    return {
      configured: true,
      host: parsed.host,
      url: parsed.toString(),
      timeoutMs: webhookTimeoutMs(),
    };
  } catch {
    return {
      configured: false,
      host: null,
      url: null,
      timeoutMs: webhookTimeoutMs(),
      invalid: true,
    };
  }
};

const deliveryLogContext = (
  reportType,
  recipients,
  metadata,
  webhook,
  idempotencyKey
) => ({
  agencyId: metadata.agencyId || null,
  clientId: metadata.clientId || null,
  reportId: metadata.reportId || null,
  reportRunId: metadata.reportRunId || null,
  reportType,
  recipientCount: recipients.length,
  webhookConfigured: webhook.configured,
  webhookHost: webhook.host,
  idempotencyKeyPrefix: idempotencyKey?.slice(0, 24) || null,
});

export const sendReportEmail = async ({
  recipients,
  subject,
  html,
  text,
  reportType,
  metadata = {},
  idempotencyKey = null,
}) => {
  const cleanedRecipients = normalizeEmailList(recipients);

  if (!cleanedRecipients.length) {
    throw createDeliveryError("No recipients selected.", {
      code: "EMAIL_RECIPIENTS_MISSING",
      category: "validation",
      status: 400,
    });
  }

  if (!String(subject || "").trim()) {
    throw createDeliveryError("Email subject is required.", {
      code: "EMAIL_SUBJECT_MISSING",
      category: "validation",
      status: 400,
    });
  }

  if (!String(html || "").trim()) {
    throw createDeliveryError("Email HTML body is required.", {
      code: "EMAIL_BODY_MISSING",
      category: "validation",
      status: 400,
    });
  }

  const webhook = getReportEmailWebhookConfig();
  const logContext = deliveryLogContext(
    reportType,
    cleanedRecipients,
    metadata,
    webhook,
    idempotencyKey
  );

  logAction(SCOPE, "EMAIL_DELIVERY_PREPARED", logContext, "blue");

  if (!webhook.configured) {
    const error = createDeliveryError(
      webhook.invalid
        ? "REPORT_EMAIL_WEBHOOK_URL is invalid."
        : "REPORT_EMAIL_WEBHOOK_URL is not configured.",
      {
        code: webhook.invalid
          ? "EMAIL_WEBHOOK_URL_INVALID"
          : "EMAIL_WEBHOOK_NOT_CONFIGURED",
        category: "configuration",
        status: 503,
      }
    );
    logError(SCOPE, "EMAIL_DELIVERY_CONFIGURATION_FAILED", error, logContext);
    throw error;
  }

  let response;

  try {
    logAction(SCOPE, "EMAIL_WEBHOOK_REQUEST_STARTED", logContext, "cyan");

    response = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idempotencyKey
          ? { "x-idempotency-key": idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        email: cleanedRecipients[0],
        recipients: cleanedRecipients,
        emailSubject: subject,
        subject,
        emailHtml: html,
        html,
        text,
        senderName: metadata.senderName || "Narrative",
        ...metadata,
        reportType,
        ...(idempotencyKey
          ? { idempotency_key: idempotencyKey }
          : {}),
      }),
      signal: AbortSignal.timeout(webhook.timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    const error = createDeliveryError(
      timedOut
        ? `Email webhook timed out after ${webhook.timeoutMs}ms.`
        : "Email webhook network request failed.",
      {
        code: timedOut ? "EMAIL_WEBHOOK_TIMEOUT" : "EMAIL_WEBHOOK_NETWORK_FAILED",
        category: timedOut ? "timeout" : "network",
        status: timedOut ? 504 : 502,
        cause: err,
        ambiguous: true,
      }
    );
    logError(SCOPE, "EMAIL_WEBHOOK_REQUEST_FAILED", error, {
      ...logContext,
      errorCategory: error.category,
    });
    throw error;
  }

  logAction(SCOPE, "EMAIL_WEBHOOK_RESPONSE_RECEIVED", {
    ...logContext,
    responseStatus: response.status,
  }, response.ok ? "green" : "yellow");

  if (!response.ok) {
    // Delivery truth boundary: after fetch starts, a non-2xx response does not
    // prove the downstream workflow or Gmail did not process the message.
    const error = createDeliveryError(
      `Email webhook returned HTTP ${response.status}.`,
      {
        code: "EMAIL_WEBHOOK_RESPONSE_UNCERTAIN",
        category: "response",
        status: 502,
        responseStatus: response.status,
        ambiguous: true,
      }
    );
    logError(SCOPE, "EMAIL_WEBHOOK_RESPONSE_FAILED", error, {
      ...logContext,
      responseStatus: response.status,
      errorCategory: error.category,
    });
    throw error;
  }

  logAction(SCOPE, "EMAIL_DELIVERY_SUCCEEDED", {
    ...logContext,
    responseStatus: response.status,
  }, "green");

  return {
    sentAt: new Date(),
    recipients: toRecipientStatus(cleanedRecipients, "sent"),
  };
};

const buildNotificationHtml = ({ title, intro, reasons = [], reportUrl }) => `
<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:22px;">
      <h1 style="margin:0;font-size:22px;line-height:28px;">${escapeHtml(title)}</h1>
      <p style="font-size:14px;line-height:22px;color:#475569;">${escapeHtml(intro)}</p>
      ${reasons.length ? `
        <div style="margin-top:14px;padding:14px;border:1px solid #fde68a;background:#fffbeb;border-radius:12px;">
          <div style="font-size:13px;font-weight:700;color:#92400e;">Reasons</div>
          <ul style="margin:8px 0 0 18px;padding:0;color:#78350f;font-size:13px;line-height:21px;">
            ${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}
          </ul>
        </div>
      ` : ""}
      ${reportUrl ? `<p style="margin-top:18px;"><a href="${escapeHtml(reportUrl)}" style="color:#2563eb;font-weight:700;">Open report preview</a></p>` : ""}
    </div>
  </body>
</html>`;

export const buildDeliveryIdempotencyKey = ({
  reportRunId,
  audience,
  unit = "batch",
}) => `${reportRunId}:${audience}:${unit}`;

const buildDispatchState = ({ idempotencyKey, status = "pending" }) => ({
  idempotency_key: idempotencyKey,
  status,
  attempt_count: 0,
  attempt_id: null,
  claimed_at: null,
  claim_expires_at: null,
  last_attempt_at: null,
  sent_at: null,
  last_error: null,
});

const baseReportArtifact = ({
  subject,
  html,
  text,
  recipients,
  deliveryMode,
  dispatch,
}) => ({
  status: "generated",
  delivery_mode: deliveryMode,
  subject,
  html,
  text,
  sent_at: null,
  approved_at: null,
  approved_by: null,
  cancelled_at: null,
  cancelled_by: null,
  recipients: toRecipientStatus(recipients, "pending"),
  safety: {
    passed: null,
    reasons: [],
    warnings: [],
  },
  dispatch,
});

const buildNotificationArtifact = ({
  reportRunId,
  kind,
  recipients,
  subject,
  title,
  intro,
  reasons,
  reportUrl,
}) => {
  const html = buildNotificationHtml({ title, intro, reasons, reportUrl });
  return {
    kind,
    status: "generated",
    subject,
    html,
    text: [intro, ...(reasons || [])].join("\n"),
    sent_at: null,
    recipients: toRecipientStatus(recipients, "pending"),
    delivery_error: null,
    dispatch: buildDispatchState({
      idempotencyKey: buildDeliveryIdempotencyKey({
        reportRunId,
        audience: "notification",
        unit: `${kind}:batch`,
      }),
    }),
  };
};

export const prepareReportDelivery = ({
  reportRunId,
  report,
  narrative,
  comparison,
  clientName,
  generatedAt,
  reportUrl,
}) => {
  const { internalRecipients, clientRecipients } = resolveReportRecipients(report);
  const deliveryMode = normalizeClientDeliveryMode(report.client_delivery_mode);
  const safetySettings = normalizeSafetySettings(report.safety_settings);
  const artifacts = buildReportArtifacts({
    report,
    narrative,
    comparison,
    clientName,
    generatedAt,
  });
  const internalReport = {
    status: "generated",
    subject: artifacts.internalReport.subject,
    html: artifacts.internalReport.html,
    text: artifacts.internalReport.text,
    sent_at: null,
    recipients: toRecipientStatus(internalRecipients, "pending"),
    delivery_error: null,
    dispatch: buildDispatchState({
      idempotencyKey: buildDeliveryIdempotencyKey({
        reportRunId,
        audience: "internal",
      }),
    }),
  };
  const clientReport = baseReportArtifact({
    ...artifacts.clientReport,
    recipients: clientRecipients,
    deliveryMode,
    dispatch: buildDispatchState({
      idempotencyKey: buildDeliveryIdempotencyKey({
        reportRunId,
        audience: "client",
      }),
      status: deliveryMode === "generate_only" ? "not_required" : "pending",
    }),
  });
  let notification = null;

  if (deliveryMode === "generate_only") {
    return { internalReport, clientReport, notification, dateRange: artifacts.dateRange };
  }

  if (deliveryMode === "approval_required") {
    clientReport.status = "awaiting_approval";
    notification = buildNotificationArtifact({
      reportRunId,
      kind: "approval",
      recipients: internalRecipients,
      subject: `Client Report Ready for Approval - ${clientName} - ${artifacts.dateRange}`,
      title: "Client report is ready for approval",
      intro: "Narrative generated the client report and is waiting for approval before sending.",
      reasons: [],
      reportUrl,
    });
    return { internalReport, clientReport, notification, dateRange: artifacts.dateRange };
  }

  const safety = runClientReportSafetyChecks({
    report,
    narrative,
    comparison,
    clientReport,
    clientName,
    recipients: clientRecipients,
  });
  clientReport.safety = safety;

  if (!safety.passed) {
    clientReport.status = "held_for_review";
    if (safetySettings.notify_team_when_held) {
      notification = buildNotificationArtifact({
        reportRunId,
        kind: "held",
        recipients: internalRecipients,
        subject: `Client Report Held - ${clientName} - ${artifacts.dateRange}`,
        title: "Client report was held",
        intro: "Narrative did not send the client report because safety checks failed.",
        reasons: safety.reasons,
        reportUrl,
      });
    }
  }

  return { internalReport, clientReport, notification, dateRange: artifacts.dateRange };
};

const dispatchStatus = (artifact) => artifact?.dispatch?.status || null;

const failureFromArtifact = (reportType, artifact) => {
  const status = dispatchStatus(artifact);
  if (!["failed", "uncertain"].includes(status)) return null;
  const uncertain = status === "uncertain";
  return {
    reportType,
    status,
    code:
      artifact?.dispatch?.last_error?.code ||
      artifact?.delivery_error?.code ||
      (uncertain ? "EMAIL_DELIVERY_UNCERTAIN" : "EMAIL_DELIVERY_FAILED"),
    category: uncertain
      ? "uncertain"
      : artifact?.dispatch?.last_error?.category ||
        artifact?.delivery_error?.category ||
        "delivery",
    message:
      artifact?.dispatch?.last_error?.message ||
      artifact?.delivery_error?.message ||
      artifact?.recipients?.find((recipient) => recipient.error)?.error ||
      (uncertain
        ? "Email delivery may have occurred, but confirmation was lost. It was not retried."
        : "Email delivery failed."),
  };
};

export const summarizeReportDelivery = ({
  internalReport,
  clientReport,
  notification = null,
}) => {
  const failures = [];
  const internalFailure = failureFromArtifact("internal_report", internalReport);
  const clientFailure = failureFromArtifact("client_report", clientReport);
  const notificationFailure = failureFromArtifact("internal_notification", notification);
  if (internalFailure) failures.push(internalFailure);
  if (clientFailure) failures.push(clientFailure);
  if (notificationFailure) failures.push(notificationFailure);

  if (!internalFailure && internalReport?.status !== "sent") {
    failures.push({
      reportType: "internal_report",
      status: dispatchStatus(internalReport) || internalReport?.status || "missing",
      code: "INTERNAL_REPORT_DELIVERY_INCOMPLETE",
      category: "delivery",
      message: "Internal report delivery is incomplete.",
    });
  }

  const clientStatus = clientReport?.status || "not_generated";
  const clientMessage =
    clientStatus === "sent"
      ? " Client report sent."
      : clientStatus === "awaiting_approval"
        ? " Client report is awaiting approval."
        : clientStatus === "held_for_review"
          ? " Client report was held for review."
          : clientStatus === "generated"
            ? " Client report was generated without delivery."
            : "";

  return {
    confirmed: failures.length === 0 && internalReport?.status === "sent",
    failures,
    internalStatus: internalReport?.status || "missing",
    clientStatus,
    notificationStatus: notification?.status || "not_required",
    message:
      failures.length > 0
        ? failures[0].message
        : `Internal report sent.${clientMessage}`,
  };
};

const AUDIENCE_PATHS = {
  internal: "internal_report",
  client: "client_report",
  notification: "notification",
};

const getByPath = (value, path) =>
  path.split(".").reduce((current, key) => current?.[key], value);

const leanQuery = async (query) =>
  typeof query?.lean === "function" ? query.lean() : query;

export const inferLegacyDispatchStatus = (audience, artifact) => {
  if (artifact?.status === "sent") return "sent";
  if (artifact?.status === "cancelled") return "not_required";
  if (audience === "client" && artifact?.delivery_mode === "generate_only") {
    return "not_required";
  }
  if (
    artifact?.delivery_error?.category === "uncertain" ||
    artifact?.recipients?.some?.((recipient) => recipient?.status === "uncertain")
  ) {
    return "uncertain";
  }
  if (artifact?.status === "failed") return "failed";
  return "pending";
};

export const buildLegacyDispatchState = ({ reportRunId, audience, artifact }) => {
  const existingDispatch =
    artifact?.dispatch?.toObject?.() || artifact?.dispatch || {};
  const idempotencyKey = buildDeliveryIdempotencyKey({
    reportRunId,
    audience,
    unit:
      audience === "notification"
        ? `${artifact?.kind || "report"}:batch`
        : "batch",
  });

  return {
    ...buildDispatchState({ idempotencyKey }),
    ...existingDispatch,
    idempotency_key: existingDispatch.idempotency_key || idempotencyKey,
    status: inferLegacyDispatchStatus(audience, artifact),
  };
};

export const ensureReportDispatchState = async ({
  reportRunId,
  audience,
  ReportRunModel = ReportRun,
}) => {
  const path = AUDIENCE_PATHS[audience];
  if (!path) throw new Error(`Unknown report delivery audience: ${audience}`);

  let reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  const artifact = getByPath(reportRun, path);
  if (!artifact) {
    const error = new Error(`${audience} report artifact is missing.`);
    error.code = "REPORT_ARTIFACT_MISSING";
    error.status = 400;
    throw error;
  }
  if (artifact.dispatch?.status) return reportRun;

  await ReportRunModel.updateOne(
    {
      _id: reportRunId,
      $or: [
        { [`${path}.dispatch`]: { $exists: false } },
        { [`${path}.dispatch`]: null },
        { [`${path}.dispatch.status`]: { $exists: false } },
      ],
    },
    {
      $set: {
        [`${path}.dispatch`]: buildLegacyDispatchState({
          reportRunId,
          audience,
          artifact,
        }),
      },
    }
  );
  reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  return reportRun;
};

const currentDispatchOutcome = (artifact) => {
  const status = artifact?.dispatch?.status || "pending";
  if (status === "sent") return "already_sent";
  if (status === "uncertain") return "uncertain";
  if (status === "not_required") return "not_required";
  if (status === "dispatching") return "in_progress";
  if (status === "failed") return "failed";
  return "pending";
};

export const claimReportDelivery = async ({
  reportRunId,
  audience,
  allowFailedRetry = false,
  now = new Date(),
  attemptId = crypto.randomUUID(),
  claimSet = {},
  ReportRunModel = ReportRun,
}) => {
  const path = AUDIENCE_PATHS[audience];
  let reportRun = await ensureReportDispatchState({
    reportRunId,
    audience,
    ReportRunModel,
  });
  let artifact = getByPath(reportRun, path);
  const existingStatus = artifact.dispatch.status;

  if (existingStatus === "dispatching") {
    const claimExpiresAt = artifact.dispatch.claim_expires_at
      ? new Date(artifact.dispatch.claim_expires_at)
      : null;
    if (claimExpiresAt && claimExpiresAt <= now) {
      await ReportRunModel.updateOne(
        {
          _id: reportRunId,
          [`${path}.dispatch.status`]: "dispatching",
          [`${path}.dispatch.attempt_id`]: artifact.dispatch.attempt_id,
        },
        {
          $set: {
            [`${path}.dispatch.status`]: "uncertain",
            [`${path}.dispatch.last_error`]: {
              code: "EMAIL_DISPATCH_CONFIRMATION_LOST",
              category: "uncertain",
              message:
                "The delivery claim expired before confirmation. The email was not resent.",
            },
          },
        }
      );
      reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
      artifact = getByPath(reportRun, path);
      return {
        claimed: false,
        outcome: currentDispatchOutcome(artifact),
        reportRun,
        artifact,
      };
    }
    return { claimed: false, outcome: "in_progress", reportRun, artifact };
  }

  const eligibleStatuses = allowFailedRetry ? ["pending", "failed"] : ["pending"];
  if (!eligibleStatuses.includes(existingStatus)) {
    return {
      claimed: false,
      outcome: currentDispatchOutcome(artifact),
      reportRun,
      artifact,
    };
  }

  const claimed = await ReportRunModel.findOneAndUpdate(
    {
      _id: reportRunId,
      [`${path}.dispatch.status`]: { $in: eligibleStatuses },
    },
    {
      $set: {
        [`${path}.dispatch.status`]: "dispatching",
        [`${path}.dispatch.attempt_id`]: attemptId,
        [`${path}.dispatch.claimed_at`]: now,
        [`${path}.dispatch.claim_expires_at`]: new Date(
          now.getTime() + DELIVERY_CLAIM_MS
        ),
        [`${path}.dispatch.last_attempt_at`]: now,
        [`${path}.dispatch.last_error`]: null,
        ...claimSet,
      },
      $inc: {
        [`${path}.dispatch.attempt_count`]: 1,
      },
    },
    { new: true }
  );

  if (!claimed) {
    reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
    artifact = getByPath(reportRun, path);
    return {
      claimed: false,
      outcome: currentDispatchOutcome(artifact),
      reportRun,
      artifact,
    };
  }

  artifact = getByPath(claimed, path);
  return { claimed: true, outcome: "claimed", reportRun: claimed, artifact, attemptId };
};

const CANCELLABLE_CLIENT_REPORT_STATUSES = [
  "generated",
  "awaiting_approval",
  "held_for_review",
  "failed",
];
const CANCELLABLE_CLIENT_DISPATCH_STATUSES = [
  "pending",
  "failed",
];

export const cancelClientReportDelivery = async ({
  reportRunId,
  agencyId,
  userId = null,
  ReportRunModel = ReportRun,
}) => {
  await ensureReportDispatchState({
    reportRunId,
    audience: "client",
    ReportRunModel,
  });

  const cancelled = await ReportRunModel.findOneAndUpdate(
    {
      _id: reportRunId,
      ...(agencyId ? { agency_id: agencyId } : {}),
      "client_report.status": { $in: CANCELLABLE_CLIENT_REPORT_STATUSES },
      "client_report.dispatch.status": {
        $in: CANCELLABLE_CLIENT_DISPATCH_STATUSES,
      },
    },
    {
      $set: {
        "client_report.status": "cancelled",
        "client_report.dispatch.status": "not_required",
        "client_report.cancelled_at": new Date(),
        "client_report.cancelled_by": userId || null,
      },
    },
    { new: true }
  );

  if (cancelled) {
    return { outcome: "cancelled", reportRun: cancelled };
  }

  const reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  const clientReport = reportRun?.client_report;
  const dispatch = clientReport?.dispatch?.status;

  if (clientReport?.status === "cancelled") {
    return { outcome: "already_cancelled", reportRun };
  }
  if (clientReport?.status === "sent" || dispatch === "sent") {
    return { outcome: "already_sent", reportRun };
  }
  if (dispatch === "dispatching") {
    return { outcome: "in_progress", reportRun };
  }
  if (dispatch === "uncertain") {
    return { outcome: "uncertain", reportRun };
  }
  return { outcome: "not_cancellable", reportRun };
};

const sanitizedDeliveryError = (error, uncertain = false) => ({
  code: error?.code || (uncertain ? "EMAIL_DELIVERY_UNCERTAIN" : "EMAIL_DELIVERY_FAILED"),
  category: uncertain ? "uncertain" : error?.category || "delivery",
  message: String(error?.message || "Email delivery failed.").slice(0, 500),
  http_status: Number.isInteger(error?.responseStatus)
    ? error.responseStatus
    : null,
});

const markPredispatchFailure = async ({
  reportRunId,
  audience,
  error,
  failureStatus,
  ReportRunModel,
}) => {
  const path = AUDIENCE_PATHS[audience];
  const payload = sanitizedDeliveryError(error, false);
  const persisted = await ReportRunModel.updateOne(
    {
      _id: reportRunId,
      [`${path}.dispatch.status`]: { $in: ["pending", "failed"] },
    },
    {
      $set: {
        [`${path}.dispatch.status`]: "failed",
        [`${path}.dispatch.last_attempt_at`]: new Date(),
        [`${path}.dispatch.last_error`]: payload,
        [`${path}.status`]: failureStatus,
        [`${path}.delivery_error`]: payload,
      },
    }
  );
  const reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  const artifact = getByPath(reportRun, path);
  return {
    outcome:
      persisted.matchedCount === 1
        ? "failed"
        : currentDispatchOutcome(artifact),
    reportRun,
    artifact,
    error,
  };
};

export const dispatchReportRunArtifact = async ({
  reportRunId,
  audience,
  metadata = {},
  allowFailedRetry = false,
  failureStatus = "failed",
  uncertainStatus = "generated",
  claimSet = {},
  ReportRunModel = ReportRun,
  sendEmail = sendReportEmail,
}) => {
  const path = AUDIENCE_PATHS[audience];
  let reportRun = await ensureReportDispatchState({
    reportRunId,
    audience,
    ReportRunModel,
  });
  let artifact = getByPath(reportRun, path);
  const existingOutcome = currentDispatchOutcome(artifact);
  if (!["pending", "failed"].includes(existingOutcome)) {
    return claimReportDelivery({
      reportRunId,
      audience,
      allowFailedRetry,
      claimSet,
      ReportRunModel,
    });
  }
  if (existingOutcome === "failed" && !allowFailedRetry) {
    return {
      claimed: false,
      outcome: "failed",
      reportRun,
      artifact,
    };
  }
  const recipients = normalizeEmailList(
    artifact.recipients?.map((recipient) => recipient.email) || []
  );
  const webhook = getReportEmailWebhookConfig();

  if (!recipients.length || !artifact.subject || !artifact.html || !webhook.configured) {
    const error = !recipients.length
      ? createDeliveryError("No recipients selected.", {
          code: "EMAIL_RECIPIENTS_MISSING",
          category: "validation",
          status: 400,
        })
      : !artifact.subject || !artifact.html
        ? createDeliveryError("The persisted report email artifact is incomplete.", {
            code: "REPORT_ARTIFACT_INCOMPLETE",
            category: "validation",
            status: 400,
          })
        : createDeliveryError(
            webhook.invalid
              ? "REPORT_EMAIL_WEBHOOK_URL is invalid."
              : "REPORT_EMAIL_WEBHOOK_URL is not configured.",
            {
              code: webhook.invalid
                ? "EMAIL_WEBHOOK_URL_INVALID"
                : "EMAIL_WEBHOOK_NOT_CONFIGURED",
              category: "configuration",
              status: 503,
            }
          );
    return markPredispatchFailure({
      reportRunId,
      audience,
      error,
      failureStatus,
      ReportRunModel,
    });
  }

  const claim = await claimReportDelivery({
    reportRunId,
    audience,
    allowFailedRetry,
    claimSet,
    ReportRunModel,
  });
  if (!claim.claimed) return claim;

  artifact = claim.artifact;
  const reportType = audience === "notification" ? "internal_notification" : `${audience}_report`;
  const idempotencyKey = artifact.dispatch.idempotency_key;

  logAction(SCOPE, "EMAIL_DISPATCH_CLAIMED", {
    reportRunId,
    audience,
    idempotencyKeyPrefix: idempotencyKey.slice(0, 24),
    attemptCount: artifact.dispatch.attempt_count,
  }, "cyan");

  let delivery;
  try {
    delivery = await sendEmail({
      recipients,
      subject: artifact.subject,
      html: artifact.html,
      text: artifact.text,
      reportType,
      metadata: { ...metadata, reportRunId },
      idempotencyKey,
    });
  } catch (error) {
    const uncertain = error?.ambiguous === true;
    const outcome = uncertain ? "uncertain" : "failed";
    const recipientStatus = uncertain ? "uncertain" : "failed";
    const payload = sanitizedDeliveryError(error, uncertain);
    const persisted = await ReportRunModel.updateOne(
      {
        _id: reportRunId,
        [`${path}.dispatch.status`]: "dispatching",
        [`${path}.dispatch.attempt_id`]: claim.attemptId,
      },
      {
        $set: {
          [`${path}.dispatch.status`]: outcome,
          [`${path}.dispatch.claim_expires_at`]: null,
          [`${path}.dispatch.last_error`]: payload,
          [`${path}.status`]: uncertain ? uncertainStatus : failureStatus,
          [`${path}.recipients`]: toRecipientStatus(
            recipients,
            recipientStatus,
            payload.message
          ),
          [`${path}.delivery_error`]: payload,
        },
      }
    );
    reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
    artifact = getByPath(reportRun, path);
    const persistedOutcome =
      persisted.matchedCount === 1
        ? outcome
        : currentDispatchOutcome(artifact);
    logError(SCOPE, uncertain ? "EMAIL_DISPATCH_UNCERTAIN" : "EMAIL_DISPATCH_FAILED", error, {
      reportRunId,
      audience,
      idempotencyKeyPrefix: idempotencyKey.slice(0, 24),
    });
    return {
      outcome: persistedOutcome,
      reportRun,
      artifact,
      error,
    };
  }

  const sentAt = delivery.sentAt || new Date();
  try {
    const persisted = await ReportRunModel.updateOne(
      {
        _id: reportRunId,
        [`${path}.dispatch.status`]: "dispatching",
        [`${path}.dispatch.attempt_id`]: claim.attemptId,
      },
      {
        $set: {
          [`${path}.dispatch.status`]: "sent",
          [`${path}.dispatch.sent_at`]: sentAt,
          [`${path}.dispatch.claim_expires_at`]: null,
          [`${path}.dispatch.last_error`]: null,
          [`${path}.status`]: "sent",
          [`${path}.sent_at`]: sentAt,
          [`${path}.recipients`]: delivery.recipients,
          [`${path}.delivery_error`]: null,
        },
      }
    );
    if (persisted.matchedCount !== 1) {
      const error = new Error(
        "Email was accepted by the webhook, but its sent state could not be claimed."
      );
      error.code = "EMAIL_SENT_STATE_PERSIST_FAILED";
      throw error;
    }
  } catch (error) {
    error.code = error.code || "EMAIL_SENT_STATE_PERSIST_FAILED";
    error.ambiguous = true;
    throw error;
  }
  reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  return {
    outcome: "sent",
    reportRun,
    artifact: getByPath(reportRun, path),
    sentAt,
  };
};

export const processPersistedReportDelivery = async ({
  reportRunId,
  metadata = {},
  allowFailedRetry = false,
  ReportRunModel = ReportRun,
  sendEmail = sendReportEmail,
}) => {
  await ReportRunModel.updateOne(
    {
      _id: reportRunId,
      execution_stage: { $in: ["artifacts_ready", "delivering"] },
    },
    { $set: { execution_stage: "delivering" } }
  );

  const outcomes = [];
  outcomes.push(
    await dispatchReportRunArtifact({
      reportRunId,
      audience: "internal",
      metadata,
      allowFailedRetry,
      failureStatus: "failed",
      uncertainStatus: "generated",
      ReportRunModel,
      sendEmail,
    })
  );

  let reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  if (reportRun.notification) {
    outcomes.push(
      await dispatchReportRunArtifact({
        reportRunId,
        audience: "notification",
        metadata: {
          ...metadata,
          notificationType: `${reportRun.notification.kind}_notification`,
        },
        allowFailedRetry,
        failureStatus: "failed",
        uncertainStatus: "generated",
        ReportRunModel,
        sendEmail,
      })
    );
  }

  reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  const clientReport = reportRun.client_report;
  if (
    clientReport?.delivery_mode === "auto_send" &&
    clientReport?.safety?.passed === true
  ) {
    outcomes.push(
      await dispatchReportRunArtifact({
        reportRunId,
        audience: "client",
        metadata,
        allowFailedRetry,
        failureStatus: "failed",
        uncertainStatus: "generated",
        ReportRunModel,
        sendEmail,
      })
    );
  }

  reportRun = await leanQuery(ReportRunModel.findById(reportRunId));
  const delivery = summarizeReportDelivery({
    internalReport: reportRun.internal_report,
    clientReport: reportRun.client_report,
    notification: reportRun.notification,
  });

  return {
    reportRun,
    internalReport: reportRun.internal_report,
    clientReport: reportRun.client_report,
    notification: reportRun.notification,
    delivery,
    outcomes,
    hasSafeFailure: outcomes.some((item) => item.outcome === "failed"),
    hasUncertain: outcomes.some((item) => item.outcome === "uncertain"),
    hasInProgress: outcomes.some((item) => item.outcome === "in_progress"),
  };
};
