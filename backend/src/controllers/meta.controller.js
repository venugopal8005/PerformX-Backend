import { MetaConnection } from "../models/meta/metaConnection.model.js";

export const meta = async (req, res) => {
  console.log("meta called");
  const redirectUri = "http://localhost:3000/api/meta/callback";

  const url = `https://www.facebook.com/v19.0/dialog/oauth?client_id=1583432426079339&redirect_uri=${redirectUri}&scope=ads_read`;

  res.redirect(url);
};

export const metaCallback = async (req, res) => {
  console.log("USER:", req.user);
  const code = req.query.code;
  const redirectUri = "http://localhost:3000/api/meta/callback";

  if (!code) {
    return res.status(400).send("No code provided");
  }

  try {
    // STEP 1: short-lived token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?client_id=1583432426079339&client_secret=a9b8acce0745bdbee337eecdae163b09&redirect_uri=${redirectUri}&code=${code}`
    );

    const tokenData = await tokenRes.json();
    const shortToken = tokenData.access_token;

    // STEP 2: long-lived token
    const longRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=1583432426079339&client_secret=a9b8acce0745bdbee337eecdae163b09&fb_exchange_token=${shortToken}`
    );

    const longData = await longRes.json();

    if (!longData.access_token) {
      console.error("Token exchange failed:", longData);
      return res.status(500).send("Failed to get long-lived token");
    }

    // STEP 3: calculate expiry
    const expiresAt = new Date(Date.now() + longData.expires_in * 1000);

    // ⚠️ CRITICAL: make sure user exists
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).send("User not authenticated");
    }

    // STEP 4: upsert into DB
    await MetaConnection.findOneAndUpdate(
      { user_id: userId },
      {
        access_token: longData.access_token,
        expires_at: expiresAt,
        is_active: true,
      },
      { upsert: true, new: true }
    );

    console.log("Meta connection stored for user:", userId);

    // res.status(200).json({
    //   success: true,
    //   message: "Meta connected & stored successfully"
    // });
    res.redirect("http://localhost:5173/app/reports/createNew?meta=connected");
  } catch (err) {
    console.error("OAuth error:", err);
    // res.status(500).json({
    //   success: false,
    //   message: "Error in OAuth flow"
    // });
    res.redirect("http://localhost:5173/app/reports/createNew?meta=NotConnected");

  }
};

export const ConnectionStatus = async (req, res) => {

  const userId = req.user?.id;

  console.log("status check ayaaa!!",req.user ,userId);
  
  const connection = await MetaConnection.findOne({ user_id : userId});
  console.log(connection);

  if (!connection || !connection.is_active) {
    return res.json({ connected: false });
  }

  // optional expiry check
  if (connection.expires_at < new Date()) {
    connection.is_active = false;
    await connection.save();
    return res.json({ connected: false });
  }

  res.json({ connected: true });
}