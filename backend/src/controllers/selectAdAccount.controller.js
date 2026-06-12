import { MetaConnection } from "../models/MetaConnection.js";

export const selectAdAccount = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const clientId = req.body.client_id || req.body.clientId;
    const { ad_account_id, ad_account_name } = req.body;

    if (!agencyId) {
      return res.status(401).json({
        selected: false,
        message: "Agency context missing from auth token",
      });
    }

    if (!clientId || !ad_account_id) {
      return res.status(400).json({
        selected: false,
        message: "client_id and ad_account_id are required",
      });
    }

    const updated = await MetaConnection.findOneAndUpdate(
      {
        agency_id: agencyId,
        client_id: clientId,
        is_active: true,
      },
      {
        ad_account_id,
        ad_account_name,
      },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({
        selected: false,
        message: "Meta connection not found",
      });
    }

    return res.json({
      selected: true,
      message: "Ad account selected",
      data: {
        ad_account_id: updated.ad_account_id,
        ad_account_name: updated.ad_account_name,
      },
    });
  } catch (err) {
    return res.status(500).json({
      selected: false,
      message: err.message || "Failed to select account",
    });
  }
};
