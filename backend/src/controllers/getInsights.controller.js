import { MetaConnection } from "../models/MetaConnection.js";
import { getMetaAccessToken } from "../utils/metaToken.js";

export const getInsights = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    const clientId = req.query.client_id || req.query.clientId;

    if (!agencyId || !clientId) {
      return res.status(400).send("agency and client context required");
    }

    const connection = await MetaConnection.findOne({
      agency_id: agencyId,
      client_id: clientId,
      is_active: true,
    }).select("+access_token +access_token_encrypted");

    if (!connection) {
      return res.status(404).send("Meta not connected");
    }

    if (!connection.ad_account_id) {
      return res.status(400).send("Ad account not selected");
    }

    const accessToken = getMetaAccessToken(connection);

    if (!accessToken) {
      return res.status(401).send("Meta token missing. Please reconnect Meta.");
    }

    const response = await fetch(
      `https://graph.facebook.com/v19.0/${connection.ad_account_id}/insights?fields=campaign_name,adset_name,ad_name,impressions,clicks,ctr,cpc,spend,reach,frequency,actions,purchase_roas&date_preset=maximum&level=ad&access_token=${accessToken}`
    );
    const data = await response.json();

    return res.json(data);
  } catch (err) {
    return res.status(500).send("Failed to fetch insights");
  }
};
