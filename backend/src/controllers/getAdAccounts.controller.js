import { MetaConnection } from "../models/meta/metaConnection.model.js";

export const getAdAccounts = async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    // 1. Get stored token
    const connection = await MetaConnection.findOne({ user_id: userId });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Meta not connected",
      });
    }

    // 2. Check token expiry
    if (new Date() > connection.expires_at) {
      return res.status(401).json({
        success: false,
        message: "Token expired. Please reconnect Meta.",
      });
    }

    const token = connection.access_token;

    // 3. Fetch ad accounts from Meta
    const response = await fetch(
      `https://graph.facebook.com/v19.0/me/adaccounts?fields=name,account_id,id&access_token=${token}`
    );

    const data = await response.json();

    // 4. Handle Meta API errors
    if (data.error) {
      console.error("Meta API Error:", data.error);

      return res.status(400).json({
        success: false,
        message: data.error.message,
        error: data.error,
      });
    }

    // 5. Normalize response
    return res.status(200).json({
      success: true,
      accounts: data.data || [],
    });

  } catch (err) {
    console.error("Get Ad Accounts Error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch ad accounts",
    });
  }
};