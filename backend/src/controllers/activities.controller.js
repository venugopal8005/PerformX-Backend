import { Activity } from "../models/Activity.js";
import { withHistoricalEvidenceScope } from "../utils/archiveScope.js";
import { loadHistoricalActorMap } from "../utils/historicalActors.js";
import {
  finalizeHistoryPage,
  historyRequestError,
  isValidObjectId,
  parseHistoryLimit,
  withCursorScope,
} from "../utils/historyPagination.js";
import { serializeHistoricalActivity } from "../utils/historicalSerializers.js";

const parseDateRange = (from, to) => {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
    const error = new Error("Activity date range is invalid.");
    error.code = "INVALID_DATE_RANGE";
    error.status = 400;
    throw error;
  }
  if (start && end && start > end) {
    const error = new Error("Activity date range is invalid.");
    error.code = "INVALID_DATE_RANGE";
    error.status = 400;
    throw error;
  }
  return start || end
    ? { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) }
    : null;
};

export const getActivities = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;

    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Agency context missing from auth token",
      });
    }

    const actorId = req.query.actor_id || req.query.actorId;
    const clientId = req.query.client_id || req.query.clientId;
    const reportId = req.query.report_id || req.query.reportId;
    if (
      (actorId && !isValidObjectId(actorId)) ||
      (clientId && !isValidObjectId(clientId)) ||
      (reportId && !isValidObjectId(reportId))
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_HISTORY_FILTER",
        message: "Activity history filter is invalid.",
      });
    }
    const createdAt = parseDateRange(req.query.from, req.query.to);
    const query = withCursorScope(withHistoricalEvidenceScope(agencyId, {
      ...(clientId ? { client_id: clientId } : {}),
      ...(reportId ? { report_id: reportId } : {}),
      ...(actorId ? { user_id: actorId } : {}),
      ...(req.query.type ? { type: req.query.type } : {}),
      ...(req.query.severity ? { severity: req.query.severity } : {}),
      ...(createdAt ? { createdAt } : {}),
    }), "createdAt", req.query.cursor);
    const limit = parseHistoryLimit(req.query.limit, { defaultLimit: 50 });
    const documents = await Activity.find(query)
      .select(
        "_id agency_id client_id report_id user_id type title description severity metadata createdAt"
      )
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "createdAt" });
    const actorIds = [
      ...new Set(page.items.map((activity) => activity.user_id).filter(Boolean).map(String)),
    ];
    const actorById = await loadHistoricalActorMap({ agencyId, userIds: actorIds });

    return res.json({
      success: true,
      activities: page.items.map((activity) =>
        serializeHistoricalActivity(
          activity,
          actorById.get(String(activity.user_id)) || null,
          {
            actorSource: actorById.has(String(activity.user_id))
              ? "workspace_member"
              : "unknown",
          }
        )
      ),
      page: page.page,
    });
  } catch (err) {
    return historyRequestError(res, err, "Failed to fetch activities");
  }
};
