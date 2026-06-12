import { runReport as runOperationalReport } from "../services/reportRunner.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "Reports";

export const runReport = async (req, res) => {
  try {
    const { reportId } = req.query;

    logAction(SCOPE, "RUN_REPORT_REQUEST", {
      reportId,
    }, "blue");

    if (!reportId) {
      return res.status(400).json({
        success: false,
        message: "reportId required",
      });
    }

    const result = await runOperationalReport(reportId, {
      force: req.query.force === "true",
    });

    if (result.skipped) {
      return res.status(200).json({
        success: true,
        skipped: true,
        message: result.reason,
      });
    }

    return res.status(200).json({
      success: true,
      reportId: result.report._id,
      recipients: result.recipients,
      email: result.recipients?.[0] || null,
      narrative: result.narrative,
      signals: result.signals,
      emailSubject: result.emailSubject,
      emailHtml: result.emailHtml,
      comparison: result.comparison,
    });
  } catch (err) {
    logError(SCOPE, "RUN_REPORT_FAILED", err, {
      reportId: req.query?.reportId,
    });

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to run report",
    });
  }
};
