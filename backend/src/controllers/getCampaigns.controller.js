import { MetaConnection } from "../models/meta/metaConnection.model.js";

export const getCampaigns = async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. get connection
    const connection = await MetaConnection.findOne({ user_id: userId });

    if (!connection) {
      return res.status(404).send("Meta not connected");
    }

    if (!connection.ad_account_id) {
      return res.status(400).send("Ad account not selected");
    }

    const { access_token, ad_account_id } = connection;

    // 2. fetch campaigns
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${ad_account_id}/campaigns?fields=name,status,objective&access_token=${access_token}`
    );

    const data = await response.json();

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to fetch campaigns");
  }
};