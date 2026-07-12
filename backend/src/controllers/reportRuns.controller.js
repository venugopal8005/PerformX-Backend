import { Client, Report, ReportRun } from "../models/index.js";
import {
  resolveReportRecipients,
  runClientReportSafetyChecks,
  sendReportEmail,
} from "../services/reportDelivery.service.js";
import { buildReportRunQuickLook } from "../services/reportQuickLook.service.js";
import { metaErrorResponse } from "../services/metaContext.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "ReportRuns";

const recipientEmails = (recipients = []) =>
  recipients
    .map((recipient) =>
      typeof recipient === "string" ? recipient : recipient?.email
    )
    .filter(Boolean);

const toRecipientStatus = (emails, status, error = null) =>
  emails.map((email) => ({
    email,
    status,
    error,
  }));

export const getReportRunQuickLook = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const userId = req.user?.id || req.user?.userId;

    logAction(SCOPE, "QUICK_LOOK_REQUEST", {
      agencyId,
      userId,
      reportRunId: req.params.reportRunId,
      range: req.query?.range || req.query?.quickRange || "last_available",
    }, "blue");

    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Agency context missing from auth token",
      });
    }

    const reportRun = await ReportRun.findOne({
      _id: req.params.reportRunId,
      agency_id: agencyId,
    }).lean();

    if (!reportRun) {
      return res.status(404).json({
        success: false,
        message: "Report run not found.",
      });
    }

    const report = await Report.findOne({
      _id: reportRun.report_id,
      agency_id: agencyId,
    }).lean();

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    const quickLook = await buildReportRunQuickLook({
      reportRun,
      report,
      query: req.query || {},
    });

    logAction(SCOPE, "QUICK_LOOK_READY", {
      agencyId,
      userId,
      reportRunId: reportRun._id,
      range: quickLook.range?.type,
      dataQuality: quickLook.dataQuality?.level,
      isFallback: quickLook.range?.isFallback,
    }, "green");

    return res.json({
      success: true,
      ...quickLook,
    });
  } catch (err) {
    logError(SCOPE, "QUICK_LOOK_FAILED", err, {
      reportRunId: req.params?.reportRunId,
      range: req.query?.range || req.query?.quickRange,
    });

    return res
      .status(err.status || 400)
      .json(metaErrorResponse(err, "Could not load quick look numbers."));
  }
};

export const approveAndSendClientReport = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const userId = req.user?.id || req.user?.userId;
    const overrideSafety = req.body?.overrideSafety === true;

    logAction(SCOPE, "APPROVE_CLIENT_REPORT_REQUEST", {
      agencyId,
      userId,
      reportRunId: req.params.reportRunId,
      overrideSafety,
    }, "blue");

    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Agency context missing from auth token",
      });
    }

    const reportRun = await ReportRun.findOne({
      _id: req.params.reportRunId,
      agency_id: agencyId,
    });

    if (!reportRun) {
      return res.status(404).json({
        success: false,
        message: "Report run not found.",
      });
    }

    const report = await Report.findOne({
      _id: reportRun.report_id,
      agency_id: agencyId,
    });

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    const clientReport = reportRun.client_report;

    if (!clientReport?.html) {
      return res.status(400).json({
        success: false,
        message: "Client report was not generated for this run.",
      });
    }

    if (clientReport.status === "sent") {
      logAction(SCOPE, "CLIENT_REPORT_ALREADY_SENT", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
      }, "green");

      return res.json({
        success: true,
        message: "Client report was already sent.",
        reportRun,
      });
    }

    if (!["awaiting_approval", "held_for_review"].includes(clientReport.status)) {
      return res.status(400).json({
        success: false,
        message: `Client report cannot be approved from status ${clientReport.status}.`,
      });
    }

    const reviewableStatus = clientReport.status;

    const client = await Client.findOne({
      _id: report.client_id,
      agency_id: agencyId,
    }).lean();
    const recipients =
      recipientEmails(clientReport.recipients).length > 0
        ? recipientEmails(clientReport.recipients)
        : resolveReportRecipients(report).clientRecipients;
    const safety = runClientReportSafetyChecks({
      report,
      narrative: reportRun.narrative || reportRun.engine_output,
      comparison: reportRun.comparison,
      clientReport,
      clientName: client?.name || report.name || "Client",
      recipients,
    });

    clientReport.safety = safety;

    if (!recipients.length) {
      clientReport.status = "held_for_review";
      reportRun.markModified("client_report");
      await reportRun.save();

      logAction(SCOPE, "CLIENT_REPORT_APPROVAL_BLOCKED_NO_RECIPIENTS", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
      }, "yellow");

      return res.status(400).json({
        success: false,
        message: "No client recipients are selected.",
        safety,
        reportRun,
      });
    }

    if (!safety.passed) {
      if (!overrideSafety) {
        clientReport.status = "held_for_review";
        reportRun.markModified("client_report");
        await reportRun.save();

        logAction(SCOPE, "CLIENT_REPORT_APPROVAL_REQUIRES_OVERRIDE", {
          agencyId,
          userId,
          reportRunId: reportRun._id,
          reportId: report._id,
          reasons: safety.reasons,
          warnings: safety.warnings,
        }, "yellow");

        return res.status(400).json({
          success: false,
          requiresOverride: true,
          message: "Safety checks failed. Manual confirmation required.",
          safety,
          reportRun,
        });
      }

      logAction(SCOPE, "CLIENT_REPORT_SAFETY_OVERRIDE_CONFIRMED", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
        reasons: safety.reasons,
        warnings: safety.warnings,
      }, "yellow");
    }

    try {
      const delivery = await sendReportEmail({
        recipients,
        subject: clientReport.subject,
        html: clientReport.html,
        text: clientReport.text,
        reportType: "client_report",
        metadata: {
          agencyId,
          clientId: report.client_id,
          reportId: report._id,
          reportRunId: reportRun._id,
          approvedBy: userId,
          safetyOverride: !safety.passed && overrideSafety,
        },
      });

      clientReport.status = "sent";
      clientReport.sent_at = delivery.sentAt;
      clientReport.approved_at = new Date();
      clientReport.approved_by = userId;
      clientReport.recipients = delivery.recipients;
      clientReport.delivery_error = null;

      if (!safety.passed && overrideSafety) {
        clientReport.safetyOverride = true;
        clientReport.safetyOverrideBy = userId;
        clientReport.safetyOverrideAt = new Date();
        clientReport.safetyOverrideReasons = safety.reasons;
      }

      reportRun.markModified("client_report");
      await reportRun.save();

      logAction(SCOPE, "CLIENT_REPORT_APPROVED_AND_SENT", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
        recipientCount: recipients.length,
        safetyOverride: !safety.passed && overrideSafety,
      }, "green");

      return res.json({
        success: true,
        message: "Client report sent.",
        reportRun,
      });
    } catch (err) {
      clientReport.status = safety.passed ? reviewableStatus : "held_for_review";
      clientReport.delivery_error = {
        code: err.code || "CLIENT_REPORT_DELIVERY_FAILED",
        category: err.category || "delivery",
      };
      clientReport.recipients = toRecipientStatus(recipients, "failed", err.message);
      reportRun.markModified("client_report");
      await reportRun.save();

      logError(SCOPE, "CLIENT_REPORT_APPROVAL_SEND_FAILED", err, {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
        recipientCount: recipients.length,
      });

      return res.status(502).json({
        success: false,
        message: err.message || "Client report email failed.",
        reportRun,
      });
    }
  } catch (err) {
    logError(SCOPE, "APPROVE_CLIENT_REPORT_FAILED", err, {
      reportRunId: req.params?.reportRunId,
    });

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to approve client report.",
    });
  }
};

export const cancelClientReport = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const userId = req.user?.id || req.user?.userId;

    logAction(SCOPE, "CANCEL_CLIENT_REPORT_REQUEST", {
      agencyId,
      userId,
      reportRunId: req.params.reportRunId,
    }, "blue");

    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Agency context missing from auth token",
      });
    }

    const reportRun = await ReportRun.findOne({
      _id: req.params.reportRunId,
      agency_id: agencyId,
    });

    if (!reportRun) {
      return res.status(404).json({
        success: false,
        message: "Report run not found.",
      });
    }

    const report = await Report.findOne({
      _id: reportRun.report_id,
      agency_id: agencyId,
    });

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found.",
      });
    }

    const clientReport = reportRun.client_report;

    if (!clientReport?.html) {
      return res.status(400).json({
        success: false,
        message: "Client report was not generated for this run.",
      });
    }

    if (clientReport.status === "sent") {
      logAction(SCOPE, "CLIENT_REPORT_CANCEL_BLOCKED_ALREADY_SENT", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
      }, "yellow");

      return res.status(400).json({
        success: false,
        message: "Client report was already sent and cannot be cancelled.",
      });
    }

    if (clientReport.status === "cancelled") {
      logAction(SCOPE, "CLIENT_REPORT_ALREADY_CANCELLED", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
      }, "yellow");

      return res.json({
        success: true,
        message: "Client report was already cancelled.",
        reportRun,
      });
    }

    clientReport.status = "cancelled";
    reportRun.markModified("client_report");
    await reportRun.save();

    logAction(SCOPE, "CLIENT_REPORT_CANCELLED", {
      agencyId,
      userId,
      reportRunId: reportRun._id,
      reportId: report._id,
    }, "yellow");

    return res.json({
      success: true,
      message: "Client report cancelled.",
      reportRun,
    });
  } catch (err) {
    logError(SCOPE, "CANCEL_CLIENT_REPORT_FAILED", err, {
      reportRunId: req.params?.reportRunId,
    });

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to cancel client report.",
    });
  }
};
