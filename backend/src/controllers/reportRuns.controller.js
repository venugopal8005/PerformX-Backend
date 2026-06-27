import { Client, Report, ReportRun } from "../models/index.js";
import {
  resolveReportRecipients,
  runClientReportSafetyChecks,
  sendReportEmail,
} from "../services/reportDelivery.service.js";
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

export const approveAndSendClientReport = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const userId = req.user?.id || req.user?.userId;

    logAction(SCOPE, "APPROVE_CLIENT_REPORT_REQUEST", {
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

    if (!safety.passed) {
      clientReport.status = "held_for_review";
      reportRun.markModified("client_report");
      await reportRun.save();

      logAction(SCOPE, "CLIENT_REPORT_APPROVAL_BLOCKED", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
        reasons: safety.reasons,
        warnings: safety.warnings,
      }, "yellow");

      return res.status(400).json({
        success: false,
        message: "Client report failed safety checks.",
        safety,
        reportRun,
      });
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
        },
      });

      clientReport.status = "sent";
      clientReport.sent_at = delivery.sentAt;
      clientReport.approved_at = new Date();
      clientReport.approved_by = userId;
      clientReport.recipients = delivery.recipients;
      reportRun.markModified("client_report");
      await reportRun.save();

      logAction(SCOPE, "CLIENT_REPORT_APPROVED_AND_SENT", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
        recipientCount: recipients.length,
      }, "green");

      return res.json({
        success: true,
        message: "Client report sent.",
        reportRun,
      });
    } catch (err) {
      clientReport.status = "failed";
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
