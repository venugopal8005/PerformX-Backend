import { fetchMetaInsights } from "../services/metaInsights.service.js";
import {
  getAssignedMetaAccountForClient,
  metaErrorResponse,
  resolveValidatedMetaContextForReport,
} from "../services/metaContext.service.js";

export const getInsights = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const clientId = req.query.client_id || req.query.clientId;

    if (!agencyId || !clientId) {
      return res.status(400).json({
        success: false,
        message: "Workspace and client context are required.",
      });
    }

    const { metaAdAccount } = await getAssignedMetaAccountForClient({
      agencyId,
      clientId,
    });
    const context = await resolveValidatedMetaContextForReport({
      agency_id: agencyId,
      client_id: clientId,
      meta_ad_account_id: metaAdAccount._id,
    });
    const end = req.query.end || new Date().toISOString().slice(0, 10);
    const start =
      req.query.start ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const insights = await fetchMetaInsights({
      accessToken: context.accessToken,
      adAccountId: context.externalAdAccountId,
      dateRange: { start, end },
    });

    return res.json({ success: true, ...insights });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(metaErrorResponse(error, "Failed to fetch Meta insights."));
  }
};
