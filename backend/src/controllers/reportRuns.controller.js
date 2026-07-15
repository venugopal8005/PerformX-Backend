import { Client, Report, ReportRun } from "../models/index.js";
import {
  cancelClientReportDelivery,
  dispatchReportRunArtifact,
  resolveReportRecipients,
  runClientReportSafetyChecks,
} from "../services/reportDelivery.service.js";
import { assertExecutionIntegrityReady } from "../services/executionIntegrityIndexes.service.js";
import { buildReportRunQuickLook } from "../services/reportQuickLook.service.js";
import { metaErrorResponse } from "../services/metaContext.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";
import { isArchivedDocument } from "../utils/archiveScope.js";

const SCOPE = "ReportRuns";

const recipientEmails = (recipients = []) =>
  recipients
    .map((recipient) =>
      typeof recipient === "string" ? recipient : recipient?.email
    )
    .filter(Boolean);

const rejectArchivedReport = (report, res) => {
  if (!isArchivedDocument(report)) return false;
  res.status(409).json({
    success: false,
    code: "report_archived",
    message: "Archived reports cannot perform live report actions.",
  });
  return true;
};

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
    if (rejectArchivedReport(report, res)) return;

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
    if (rejectArchivedReport(report, res)) return;

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

    if (!recipients.length) {
      await ReportRun.updateOne(
        {
          _id: reportRun._id,
          "client_report.status": { $in: ["awaiting_approval", "held_for_review"] },
          "client_report.dispatch.status": { $ne: "sent" },
        },
        {
          $set: {
            "client_report.safety": safety,
            "client_report.status": "held_for_review",
          },
        }
      );
      const updatedRun = await ReportRun.findById(reportRun._id);

      if (updatedRun?.client_report?.status === "sent") {
        return res.json({
          success: true,
          message: "Client report was already sent.",
          reportRun: updatedRun,
        });
      }

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
        reportRun: updatedRun,
      });
    }

    if (!safety.passed) {
      if (!overrideSafety) {
        await ReportRun.updateOne(
          {
            _id: reportRun._id,
            "client_report.status": { $in: ["awaiting_approval", "held_for_review"] },
            "client_report.dispatch.status": { $ne: "sent" },
          },
          {
            $set: {
              "client_report.safety": safety,
              "client_report.status": "held_for_review",
            },
          }
        );
        const updatedRun = await ReportRun.findById(reportRun._id);

        if (updatedRun?.client_report?.status === "sent") {
          return res.json({
            success: true,
            message: "Client report was already sent.",
            reportRun: updatedRun,
          });
        }

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
          reportRun: updatedRun,
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

    assertExecutionIntegrityReady();

    const approvalAt = new Date();
    const safetyUpdate = { "client_report.safety": safety };
    await ReportRun.updateOne(
      { _id: reportRun._id },
      { $set: safetyUpdate }
    );

    const claimSet = {
      "client_report.approved_at": approvalAt,
      "client_report.approved_by": userId,
    };
    if (!safety.passed && overrideSafety) {
      claimSet["client_report.safetyOverride"] = true;
      claimSet["client_report.safetyOverrideBy"] = userId;
      claimSet["client_report.safetyOverrideAt"] = approvalAt;
      claimSet["client_report.safetyOverrideReasons"] = safety.reasons;
    }

    const dispatch = await dispatchReportRunArtifact({
      reportRunId: reportRun._id,
      audience: "client",
      allowFailedRetry: true,
      failureStatus: reviewableStatus,
      uncertainStatus: reviewableStatus,
      claimSet,
      metadata: {
        agencyId,
        clientId: report.client_id,
        reportId: report._id,
        approvedBy: userId,
        safetyOverride: !safety.passed && overrideSafety,
      },
    });

    if (["sent", "already_sent"].includes(dispatch.outcome)) {
      logAction(SCOPE, "CLIENT_REPORT_APPROVED_AND_SENT", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
        reportId: report._id,
        recipientCount: recipients.length,
        dispatchOutcome: dispatch.outcome,
        safetyOverride: !safety.passed && overrideSafety,
      }, "green");
      return res.json({
        success: true,
        message:
          dispatch.outcome === "already_sent"
            ? "Client report was already sent."
            : "Client report sent.",
        reportRun: dispatch.reportRun,
      });
    }

    if (dispatch.outcome === "in_progress") {
      return res.status(202).json({
        success: true,
        dispatchInProgress: true,
        message: "Client report delivery is already in progress.",
        reportRun: dispatch.reportRun,
      });
    }

    if (dispatch.outcome === "uncertain") {
      return res.status(409).json({
        success: false,
        deliveryUncertain: true,
        code: "CLIENT_REPORT_DELIVERY_UNCERTAIN",
        message:
          "Client report delivery could not be confirmed. It was not sent again automatically.",
        reportRun: dispatch.reportRun,
      });
    }

    if (dispatch.outcome === "not_required") {
      return res.status(409).json({
        success: false,
        code: "client_report_not_cancellable",
        message: "Client report delivery is no longer available for approval.",
        reportRun: dispatch.reportRun,
      });
    }

    const error = dispatch.error;
    return res.status(
      error?.category === "configuration"
        ? 503
        : error?.category === "validation"
          ? 400
          : 502
    ).json({
      success: false,
      code: error?.code || "CLIENT_REPORT_DELIVERY_FAILED",
      message: error?.message || "Client report email failed.",
      reportRun: dispatch.reportRun,
    });
  } catch (err) {
    logError(SCOPE, "APPROVE_CLIENT_REPORT_FAILED", err, {
      reportRunId: req.params?.reportRunId,
    });

    return res.status(err.status || 500).json({
      success: false,
      code: err.code || "CLIENT_REPORT_APPROVAL_FAILED",
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
    if (rejectArchivedReport(report, res)) return;

    const clientReport = reportRun.client_report;

    if (!clientReport?.html) {
      return res.status(400).json({
        success: false,
        message: "Client report was not generated for this run.",
      });
    }

    const cancellation = await cancelClientReportDelivery({
      reportRunId: reportRun._id,
      agencyId,
      userId,
    });

    if (cancellation.outcome === "already_cancelled") {
      logAction(SCOPE, "CLIENT_REPORT_ALREADY_CANCELLED", {
        agencyId,
        userId,
        reportRunId: reportRun._id,
      }, "yellow");
      return res.json({
        success: true,
        message: "Client report was already cancelled.",
        reportRun: cancellation.reportRun,
      });
    }

    const conflicts = {
      in_progress: {
        code: "client_report_dispatch_in_progress",
        message: "Client report delivery is already in progress.",
      },
      already_sent: {
        code: "client_report_already_sent",
        message: "Client report was already sent and cannot be cancelled.",
      },
      uncertain: {
        code: "client_report_delivery_uncertain",
        message:
          "Delivery confirmation is uncertain, so this report cannot be cancelled safely.",
      },
      not_cancellable: {
        code: "client_report_not_cancellable",
        message: "Client report is not in a cancellable state.",
      },
    };
    if (conflicts[cancellation.outcome]) {
      const conflict = conflicts[cancellation.outcome];
      return res.status(409).json({
        success: false,
        code: conflict.code,
        message: conflict.message,
        reportRun: cancellation.reportRun,
      });
    }

    logAction(SCOPE, "CLIENT_REPORT_CANCELLED", {
      agencyId,
      userId,
      reportRunId: reportRun._id,
      reportId: report._id,
    }, "yellow");

    return res.json({
      success: true,
      message: "Client report cancelled.",
      reportRun: cancellation.reportRun,
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
