import { MetaConnection } from "../models/meta/metaConnection.model.js";

export const selectAdAccount = async (req, res) => {
    console.log("select account request");
  try {
    const userId = req.user.id;
    const { ad_account_id } = req.body;

    if (!ad_account_id) {
      return res.status(400).send("ad_account_id required");
    }

    const updated = await MetaConnection.findOneAndUpdate(
      { user_id: userId },
      { ad_account_id },
      { new: true }
    );

    if (!updated) {
      return res.status(404).send("Meta connection not found");
    }

    res.json({
      selected:true,
      message: "Ad account selected",
      data:ad_account_id,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to select account");
    res.json({
      selected:false,
      message: "Ad account not selected",
      data:ad_account_id,
    });
  }
};