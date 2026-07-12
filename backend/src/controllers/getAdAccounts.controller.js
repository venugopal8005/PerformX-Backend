import { MetaAdAccount } from "../models/index.js";

export const getAdAccounts = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Workspace context missing from authentication.",
      });
    }

    const accounts = await MetaAdAccount.find({
      agency_id: agencyId,
      is_active: true,
      is_accessible: true,
    })
      .populate("client_id", "name status")
      .sort({ name: 1 });

    return res.json({
      success: true,
      accounts: accounts.map((account) => ({
        id: account.ad_account_id,
        account_id: account.ad_account_id.replace(/^act_/, ""),
        meta_ad_account_id: account._id,
        name: account.name,
        currency: account.currency,
        timezone_name: account.timezone_name,
        assigned_client: account.client_id
          ? { id: account.client_id._id, name: account.client_id.name }
          : null,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load workspace Meta ad accounts.",
    });
  }
};
