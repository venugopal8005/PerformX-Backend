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

    logAction(SCOPE, "MANUAL_SEND_N8N_TRIGGER", {
      reportId,
      recipients: reportData.recipients,
      adAccountId: reportData.adAccountId,
    }, "magenta");

    const n8nResponse = await fetch(
      "https://primary-production-dece4.up.railway.app/webhook/68991387-5464-42a6-a046-82379fb0c9c9",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reportData),
      }
    );

    if (!n8nResponse.ok) {
      throw new Error(`n8n webhook failed: ${n8nResponse.status}`);
    }

    logAction(SCOPE, "MANUAL_SEND_SUCCESS", {
      reportId,
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
