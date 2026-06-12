import { MetaConnection } from "../models/MetaConnection.js";

export const getAdAccounts = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const clientId = req.query.client_id || req.query.clientId;

    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Agency context missing from auth token",
      });
    }

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: "client_id is required",
      });
    }

    const connection = await MetaConnection.findOne({
      agency_id: agencyId,
      client_id: clientId,
      is_active: true,
    }).select("+access_token");

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Meta not connected",
      });
    }

    if (connection.token_expires_at && new Date() > connection.token_expires_at) {
      return res.status(401).json({
        success: false,
        message: "Token expired. Please reconnect Meta.",
      });
    }

    const response = await fetch(
      `https://graph.facebook.com/v19.0/me/adaccounts?fields=name,account_id,id&access_token=${connection.access_token}`
    );
    const data = await response.json();

    if (data.error) {
      return res.status(400).json({
        success: false,
        message: data.error.message,
        error: data.error,
      });
    }

    return res.status(200).json({
      success: true,
      accounts: data.data || [],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch ad accounts",
    });
  }
};
