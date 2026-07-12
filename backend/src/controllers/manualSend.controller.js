import { generateMetaReport } from "../services/generateMetaReport.service.js";
import { getReportEmailWebhookConfig } from "../services/reportDelivery.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "Reports";

export const manualSendReport = async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const agencyId = req.user.agencyId;
    const { reportId } = req.body;
    const webhook = getReportEmailWebhookConfig();

    logAction(SCOPE, "MANUAL_SEND_REQUEST", {
      userId,
      agencyId,
      reportId,
      reportEmailWebhookConfigured: webhook.configured,
      reportEmailWebhookHost: webhook.host,
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
    const delivery = reportData.delivery;

    if (!delivery?.confirmed) {
      const failure = delivery?.failures?.[0];

      logAction(SCOPE, "MANUAL_SEND_DELIVERY_FAILED", {
        userId,
        agencyId,
        clientId: reportData.clientId,
        reportId,
        reportType: failure?.reportType || "internal_report",
        internalStatus: delivery?.internalStatus || reportData.internalReport?.status,
        clientStatus: delivery?.clientStatus || reportData.clientReport?.status,
        notificationStatus: delivery?.notificationStatus || "not_required",
        recipientCount: reportData.internalReport?.recipients?.length || 0,
        errorCategory: failure?.category || "delivery",
        errorCode: failure?.code || "REPORT_EMAIL_DELIVERY_FAILED",
      }, "red");

      return res.status(
        failure?.category === "configuration"
          ? 503
          : failure?.category === "validation"
            ? 400
            : failure?.category === "timeout"
              ? 504
              : 502
      ).json({
        success: false,
        code: failure?.code || "REPORT_EMAIL_DELIVERY_FAILED",
        message: delivery?.message || "Report generated, but email delivery failed.",
        delivery,
        reportData,
      });
    }

    logAction(SCOPE, "MANUAL_SEND_DELIVERY_CONFIRMED", {
      userId,
      agencyId,
      clientId: reportData.clientId,
      reportId,
      internalStatus: delivery.internalStatus,
      clientStatus: delivery.clientStatus,
      notificationStatus: delivery.notificationStatus,
      recipientCount: reportData.internalReport?.recipients?.length || 0,
    }, "green");

    return res.json({
      success: true,
      message: delivery.message,
      delivery,
      reportData,
    });
  } catch (err) {
    logError(SCOPE, "MANUAL_SEND_FAILED", err, {
      reportId: req.body?.reportId,
    });

    return res.status(err.status || 500).json({
      success: false,
      code: err.code || "REPORT_RUN_FAILED",
      message: err.message,
    });
  }
};
