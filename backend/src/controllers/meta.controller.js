import { MetaConnection } from "../models/MetaConnection.js";
import { recordActivity } from "../services/activityRecorder.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "Meta";

const getMetaConfig = () => {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri =
    process.env.META_REDIRECT_URI || "http://localhost:3000/api/meta/callback";
  const clientRedirectUri =
    process.env.META_CLIENT_REDIRECT_URI ||
    "http://localhost:5173/reports";

  if (!appId || !appSecret) {
    throw new Error("META_APP_ID and META_APP_SECRET are required");
  }

  return {
    appId,
    appSecret,
    redirectUri,
    clientRedirectUri,
  };
};

const encodeState = (state) => {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
};

const decodeState = (state) => {
  if (!state) return {};
  return JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
};

const requireAgency = (req, res) => {
  const agencyId = req.user?.agencyId;

  if (!agencyId) {
    res.status(401).json({
      success: false,
      message: "Agency context missing from auth token",
    });
    return null;
  }

  return agencyId;
};

export const meta = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const userId = req.user?.id;
    const clientId = req.query.client_id || req.query.clientId;

    if (!clientId) {
      return res.status(400).json({
        success: false,
        message: "client_id is required",
      });
    }

    const { appId, redirectUri } = getMetaConfig();
    const state = encodeState({
      agencyId,
      clientId,
      userId,
    });
    const url = new URL("https://www.facebook.com/v19.0/dialog/oauth");

    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "ads_read");
    url.searchParams.set("state", state);

    logAction(SCOPE, "META_CONNECT_REDIRECT", {
      agencyId,
      clientId,
      userId,
    }, "magenta");

    return res.redirect(url.toString());
  } catch (err) {
    logError(SCOPE, "META_CONNECT_FAILED", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

export const metaCallback = async (req, res) => {
  const code = req.query.code;
  let state = {};

  try {
    state = decodeState(req.query.state);
  } catch {
    state = {};
  }

  const agencyId = state.agencyId || req.user?.agencyId;
  const clientId = state.clientId || req.query.client_id || req.query.clientId;
  const userId = state.userId || req.user?.id;

  try {
    const { appId, appSecret, redirectUri, clientRedirectUri } = getMetaConfig();

    if (!code) {
      return res.status(400).send("No code provided");
    }

    if (!agencyId || !clientId) {
      return res.status(401).send("Agency and client context are required");
    }

    const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("redirect_uri", redirectUri);
    tokenUrl.searchParams.set("code", code);

    const tokenRes = await fetch(tokenUrl.toString());
    const tokenData = await tokenRes.json();
    const shortToken = tokenData.access_token;

    if (!shortToken) {
      logAction(SCOPE, "META_SHORT_TOKEN_EXCHANGE_FAILED", {
        agencyId,
        clientId,
        tokenData,
      }, "red");

      return res.status(500).send("Failed to get short-lived token");
    }

    const longUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    longUrl.searchParams.set("grant_type", "fb_exchange_token");
    longUrl.searchParams.set("client_id", appId);
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("fb_exchange_token", shortToken);

    const longRes = await fetch(longUrl.toString());
    const longData = await longRes.json();

    if (!longData.access_token) {
      logAction(SCOPE, "META_LONG_TOKEN_EXCHANGE_FAILED", {
        agencyId,
        clientId,
        longData,
      }, "red");

      return res.status(500).send("Failed to get long-lived token");
    }

    const tokenExpiresAt = longData.expires_in
      ? new Date(Date.now() + longData.expires_in * 1000)
      : null;
    const connection = await MetaConnection.findOneAndUpdate(
      {
        agency_id: agencyId,
        client_id: clientId,
      },
      {
        access_token: longData.access_token,
        token_expires_at: tokenExpiresAt,
        is_active: true,
        connected_by: userId,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await recordActivity({
      agency_id: agencyId,
      client_id: clientId,
      user_id: userId,
      type: "meta_connected",
      title: "Meta account connected",
      description: "Meta access token was connected for this client.",
      severity: "stable",
      metadata: {
        connection_id: connection._id,
        token_expires_at: tokenExpiresAt,
      },
    });

    logAction(SCOPE, "META_CONNECTION_STORED", {
      agencyId,
      clientId,
      connectionId: connection._id,
    }, "green");

    return res.redirect(`${clientRedirectUri}?meta=connected&clientId=${clientId}`);
  } catch (err) {
    logError(SCOPE, "META_OAUTH_FAILED", err, {
      agencyId,
      clientId,
      hasCode: Boolean(code),
    });

    const fallbackRedirect =
      process.env.META_CLIENT_REDIRECT_URI ||
      "http://localhost:5173/reports";

    return res.redirect(`${fallbackRedirect}?meta=NotConnected`);
  }
};

export const ConnectionStatus = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const clientId = req.query.client_id || req.query.clientId;

    if (!clientId) {
      return res.status(400).json({
        connected: false,
        message: "client_id is required",
      });
    }

    const connection = await MetaConnection.findOne({
      agency_id: agencyId,
      client_id: clientId,
    });

    if (!connection || !connection.is_active) {
      return res.json({ connected: false });
    }

    if (connection.token_expires_at && connection.token_expires_at < new Date()) {
      connection.is_active = false;
      await connection.save();

      return res.json({ connected: false });
    }

    return res.json({
      connected: true,
      ad_account_id: connection.ad_account_id,
      ad_account_name: connection.ad_account_name,
    });
  } catch (err) {
    logError(SCOPE, "META_STATUS_FAILED", err, {
      agencyId: req.user?.agencyId,
    });

    return res.status(500).json({
      connected: false,
      message: "Failed to check Meta connection",
    });
  }
};
