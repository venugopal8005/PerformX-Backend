import {
  fetchCampaignsForMetaAccount,
  getAssignedMetaAccountForClient,
  metaErrorResponse,
  resolveMetaContextForAccount,
} from "../services/metaContext.service.js";

export const getCampaigns = async (req, res) => {
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
    const context = await resolveMetaContextForAccount({
      agencyId,
      metaAdAccountId: metaAdAccount._id,
    });
    const campaigns = await fetchCampaignsForMetaAccount({
      accessToken: context.accessToken,
      externalAdAccountId: context.externalAdAccountId,
    });

    return res.json({
      success: true,
      meta_ad_account: {
        id: metaAdAccount._id,
        ad_account_id: metaAdAccount.ad_account_id,
        name: metaAdAccount.name,
      },
      campaigns,
      data: campaigns,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json(metaErrorResponse(error, "Failed to fetch Meta campaigns."));
  }
};
