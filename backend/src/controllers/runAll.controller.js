import { runDueReports } from "../services/reportRunner.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "Reports";

export const runAllReports = async (req, res) => {
  try {
    const now = new Date();

    logAction(SCOPE, "RUN_ALL_REPORTS_REQUEST", {
      now,
      triggeredBy: "n8n",
    }, "blue");

    const result = await runDueReports({
      now,
      agencyId: req.schedulerAuthorized ? undefined : req.user?.agencyId,
      triggerType: "scheduled",
    });

    logAction(SCOPE, "RUN_ALL_REPORTS_SUCCESS", {
      checkedCount: result.checkedCount,
      ranCount: result.ranCount,
    }, "green");

    return res.json({
      success: true,
      checkedCount: result.checkedCount,
      count: result.ranCount,
      reports: result.results.map((item) => ({
        reportId: item.report._id,
        reportName: item.report.name,
        agencyId: item.report.agency_id,
        clientId: item.report.client_id,
        recipients: item.recipients,
        email: item.recipients?.[0] || null,
        adAccountId: item.connection?.ad_account_id,
        narrative: item.narrative,
        signals: item.signals,
        emailSubject: item.emailSubject,
        emailHtml: item.emailHtml,
        internalReport: item.internalReport,
        clientReport: item.clientReport,
        reportRunId: item.reportRun?._id,
        comparison: item.comparison,
      })),
    });
  } catch (err) {
    logError(SCOPE, "RUN_ALL_REPORTS_FAILED", err);

    return res.status(500).json({
      success: false,
      message: "run-all failed",
    });
  }
};
