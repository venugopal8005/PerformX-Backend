import { Activity } from "../models/Activity.js";
import { decorateActivity } from "../utils/activityDisplay.js";

export const getActivities = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;

    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Agency context missing from auth token",
      });
    }

    const query = {
      agency_id: agencyId,
      ...(req.query.client_id || req.query.clientId
        ? { client_id: req.query.client_id || req.query.clientId }
        : {}),
      ...(req.query.report_id || req.query.reportId
        ? { report_id: req.query.report_id || req.query.reportId }
        : {}),
      ...(req.query.type ? { type: req.query.type } : {}),
      ...(req.query.severity ? { severity: req.query.severity } : {}),
    };
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const activities = await Activity.find(query)
      .sort({ createdAt: -1 })
      .limit(limit);

    return res.json({
      success: true,
      activities: activities.map(decorateActivity),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch activities",
    });
  }
};
