import {
  formatPerformanceEmail,
} from "../utils/performanceEmailFormatter.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "ReportDelivery";
const DEFAULT_WEBHOOK_TIMEOUT_MS = 30_000;
const MAX_WEBHOOK_TIMEOUT_MS = 120_000;

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

const toRecipientStatus = (recipients, status, error = null) =>
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

const createDeliveryError = (message, { code, category, status = 502, cause } = {}) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code || "EMAIL_WEBHOOK_FAILED";
  error.category = category || "unknown";
  error.status = status;
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

const deliveryLogContext = (reportType, recipients, metadata, webhook) => ({
  agencyId: metadata.agencyId || null,
  clientId: metadata.clientId || null,
  reportId: metadata.reportId || null,
  reportRunId: metadata.reportRunId || null,
  reportType,
  recipientCount: recipients.length,
  webhookConfigured: webhook.configured,
  webhookHost: webhook.host,
});

export const sendReportEmail = async ({
  recipients,
  subject,
  html,
  text,
  reportType,
  metadata = {},
}) => {
  const cleanedRecipients = normalizeEmailList(recipients);

  if (!cleanedRecipients.length) {
    throw createDeliveryError("No recipients selected.", {
      code: "EMAIL_RECIPIENTS_MISSING",
      category: "validation",
      status: 400,
    });
  }

  const webhook = getReportEmailWebhookConfig();
  const logContext = deliveryLogContext(
    reportType,
    cleanedRecipients,
    metadata,
    webhook
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
    const error = createDeliveryError(
      `Email webhook returned HTTP ${response.status}.`,
      {
        code: "EMAIL_WEBHOOK_RESPONSE_FAILED",
        category: "response",
        status: 502,
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

export const notifyInternalTeam = async ({
  recipients,
  subject,
  title,
  intro,
  reasons,
  reportUrl,
  metadata,
}) =>
  sendReportEmail({
    recipients,
    subject,
    html: buildNotificationHtml({ title, intro, reasons, reportUrl }),
    text: [intro, ...(reasons || [])].join("\n"),
    reportType: "internal_notification",
    metadata,
  });

const baseReportArtifact = ({ subject, html, text, recipients, deliveryMode }) => ({
  status: "generated",
  delivery_mode: deliveryMode,
  subject,
  html,
  text,
  sent_at: null,
  approved_at: null,
  approved_by: null,
  recipients: toRecipientStatus(recipients, "pending"),
  safety: {
    passed: null,
    reasons: [],
    warnings: [],
  },
});

const notificationArtifact = (status, error = null) => ({
  status,
  error,
});

export const summarizeReportDelivery = ({
  internalReport,
  clientReport,
  notification = null,
}) => {
  const failures = [];

  if (internalReport?.status !== "sent") {
    failures.push({
      reportType: "internal_report",
      status: internalReport?.status || "missing",
      code: internalReport?.delivery_error?.code || "INTERNAL_REPORT_DELIVERY_FAILED",
      category: internalReport?.delivery_error?.category || "delivery",
      message:
        internalReport?.recipients?.find((recipient) => recipient.error)?.error ||
        "Internal report was not delivered.",
    });
  }

  if (clientReport?.status === "failed") {
    failures.push({
      reportType: "client_report",
      status: "failed",
      code: clientReport?.delivery_error?.code || "CLIENT_REPORT_DELIVERY_FAILED",
      category: clientReport?.delivery_error?.category || "delivery",
      message:
        clientReport.recipients?.find((recipient) => recipient.error)?.error ||
        "Client report was not delivered.",
    });
  }

  if (notification?.status === "failed") {
    failures.push({
      reportType: "internal_notification",
      status: "failed",
      code: notification.code || "INTERNAL_NOTIFICATION_DELIVERY_FAILED",
      category: notification.category || "delivery",
      message: notification.error || "Internal notification was not delivered.",
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

const withDeliverySummary = ({ internalReport, clientReport, notification = null }) => ({
  internalReport,
  clientReport,
  notification,
  delivery: summarizeReportDelivery({ internalReport, clientReport, notification }),
});

export const processReportDelivery = async ({
  report,
  narrative,
  comparison,
  clientName,
  generatedAt,
  reportUrl,
  metadata = {},
}) => {
  const { internalRecipients, clientRecipients } = resolveReportRecipients(report);
  const deliveryMode = normalizeClientDeliveryMode(report.client_delivery_mode);
  const safetySettings = normalizeSafetySettings(report.safety_settings);

  logAction(SCOPE, "DELIVERY_PROCESS_STARTED", {
    agencyId: report.agency_id,
    clientId: report.client_id,
    reportId: report._id,
    reportName: report.name,
    clientName,
    deliveryMode,
    internalRecipientCount: internalRecipients.length,
    clientRecipientCount: clientRecipients.length,
    safetySettings,
  }, "cyan");

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
  };
  const clientReport = baseReportArtifact({
    ...artifacts.clientReport,
    recipients: clientRecipients,
    deliveryMode,
  });

  try {
    const delivery = await sendReportEmail({
      recipients: internalRecipients,
      subject: internalReport.subject,
      html: internalReport.html,
      text: internalReport.text,
      reportType: "internal_report",
      metadata,
    });

    internalReport.status = "sent";
    internalReport.sent_at = delivery.sentAt;
    internalReport.recipients = delivery.recipients;
    logAction(SCOPE, "INTERNAL_REPORT_SENT", {
      reportId: report._id,
      subject: internalReport.subject,
      recipientCount: internalRecipients.length,
    }, "green");
  } catch (err) {
    internalReport.status = "failed";
    internalReport.delivery_error = {
      code: err.code || "INTERNAL_REPORT_DELIVERY_FAILED",
      category: err.category || "delivery",
    };
    internalReport.recipients = toRecipientStatus(internalRecipients, "failed", err.message);
    logError(SCOPE, "INTERNAL_REPORT_SEND_FAILED", err, {
      reportId: report._id,
      subject: internalReport.subject,
      recipientCount: internalRecipients.length,
    });
  }

  if (deliveryMode === "generate_only") {
    clientReport.status = "generated";
    logAction(SCOPE, "CLIENT_REPORT_GENERATED_ONLY", {
      reportId: report._id,
      subject: clientReport.subject,
      recipientCount: clientRecipients.length,
    }, "magenta");
    return withDeliverySummary({ internalReport, clientReport });
  }

  if (deliveryMode === "approval_required") {
    clientReport.status = "awaiting_approval";
    logAction(SCOPE, "CLIENT_REPORT_AWAITING_APPROVAL", {
      reportId: report._id,
      subject: clientReport.subject,
      recipientCount: clientRecipients.length,
      reportUrl,
    }, "yellow");

    let notification;
    try {
      await notifyInternalTeam({
        recipients: internalRecipients,
        subject: `Client Report Ready for Approval - ${clientName} - ${artifacts.dateRange}`,
        title: "Client report is ready for approval",
        intro: "Narrative generated the client report and is waiting for approval before sending.",
        reasons: [],
        reportUrl,
        metadata: { ...metadata, notificationType: "approval_notification" },
      });
      notification = notificationArtifact("sent");
    } catch (err) {
      notification = {
        ...notificationArtifact("failed", err.message),
        code: err.code,
        category: err.category,
      };
      logError(SCOPE, "APPROVAL_NOTIFICATION_FAILED", err, {
        reportId: report._id,
        recipientCount: internalRecipients.length,
      });
    }

    return withDeliverySummary({ internalReport, clientReport, notification });
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
  logAction(SCOPE, "CLIENT_REPORT_SAFETY_CHECKED", {
    reportId: report._id,
    deliveryMode,
    passed: safety.passed,
    reasons: safety.reasons,
    warnings: safety.warnings,
  }, safety.passed ? "green" : "yellow");

  if (!safety.passed) {
    clientReport.status = "held_for_review";
    logAction(SCOPE, "CLIENT_REPORT_HELD_FOR_REVIEW", {
      reportId: report._id,
      subject: clientReport.subject,
      reasons: safety.reasons,
      notifyTeam: safetySettings.notify_team_when_held,
    }, "yellow");

    let notification;
    if (safetySettings.notify_team_when_held) {
      try {
        await notifyInternalTeam({
          recipients: internalRecipients,
          subject: `Client Report Held - ${clientName} - ${artifacts.dateRange}`,
          title: "Client report was held",
          intro: "Narrative did not send the client report because safety checks failed.",
          reasons: safety.reasons,
          reportUrl,
          metadata: { ...metadata, notificationType: "held_notification" },
        });
        notification = notificationArtifact("sent");
      } catch (err) {
        notification = {
          ...notificationArtifact("failed", err.message),
          code: err.code,
          category: err.category,
        };
        logError(SCOPE, "HELD_NOTIFICATION_FAILED", err, {
          reportId: report._id,
          recipientCount: internalRecipients.length,
          reasons: safety.reasons,
        });
      }
    }

    return withDeliverySummary({ internalReport, clientReport, notification });
  }

  try {
    const delivery = await sendReportEmail({
      recipients: clientRecipients,
      subject: clientReport.subject,
      html: clientReport.html,
      text: clientReport.text,
      reportType: "client_report",
      metadata,
    });

    clientReport.status = "sent";
    clientReport.sent_at = delivery.sentAt;
    clientReport.recipients = delivery.recipients;
    logAction(SCOPE, "CLIENT_REPORT_AUTO_SENT", {
      reportId: report._id,
      subject: clientReport.subject,
      recipientCount: clientRecipients.length,
    }, "green");
  } catch (err) {
    clientReport.status = "failed";
    clientReport.delivery_error = {
      code: err.code || "CLIENT_REPORT_DELIVERY_FAILED",
      category: err.category || "delivery",
    };
    clientReport.recipients = toRecipientStatus(clientRecipients, "failed", err.message);
    logError(SCOPE, "CLIENT_REPORT_AUTO_SEND_FAILED", err, {
      reportId: report._id,
      subject: clientReport.subject,
      recipientCount: clientRecipients.length,
    });
  }

  return withDeliverySummary({ internalReport, clientReport });
};
