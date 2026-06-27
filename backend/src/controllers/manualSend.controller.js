import { generateMetaReport } from "../services/generateMetaReport.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "Reports";

export const manualSendReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const agencyId = req.user.agencyId;
    const { reportId } = req.body;

    logAction(SCOPE, "MANUAL_SEND_REQUEST", {
      userId,
      agencyId,
      reportId,
    }, "blue");

    if (!reportId) {
      return res.status(400).json({
        success: false,
        message: "reportId required",
      });
    }

    const reportData = await generateMetaReport(reportId, {
      force: true,
      agencyId,
      userId,
      triggerType: "manual",
    });

    logAction(SCOPE, "MANUAL_SEND_SUCCESS", {
      reportId,
      internalStatus: reportData.internalReport?.status,
      clientStatus: reportData.clientReport?.status,
    }, "green");

    return res.json({
      success: true,
      reportData,
    });
  } catch (err) {
    logError(SCOPE, "MANUAL_SEND_FAILED", err, {
      reportId: req.body?.reportId,
    });

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
