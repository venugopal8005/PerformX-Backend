import { Signal } from "../models/Signal.js";
import { Client } from "../models/Client.js";
import { Report } from "../models/Report.js";
import { withHistoricalEvidenceScope } from "../utils/archiveScope.js";
import {
  finalizeHistoryPage,
  historyRequestError,
  isValidObjectId,
  parseHistoryLimit,
  withCursorScope,
} from "../utils/historyPagination.js";
import { serializeHistoricalSignal } from "../utils/historicalSerializers.js";

const parseDateRange = (from, to) => {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
    const error = new Error("Signal date range is invalid.");
    error.code = "INVALID_DATE_RANGE";
    error.status = 400;
    throw error;
  }
  if (start && end && start > end) {
    const error = new Error("Signal date range is invalid.");
    error.code = "INVALID_DATE_RANGE";
    error.status = 400;
    throw error;
  }
  return start || end
    ? { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) }
    : null;
};

export const getSignals = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;

    if (!agencyId) {
      return res.status(401).json({
        success: false,
        message: "Agency context missing from auth token",
      });
    }

    const reportRunId = req.query.report_run_id || req.query.reportRunId;
    const clientId = req.query.client_id || req.query.clientId;
    const reportId = req.query.report_id || req.query.reportId;
    if (
      (reportRunId && !isValidObjectId(reportRunId)) ||
      (clientId && !isValidObjectId(clientId)) ||
      (reportId && !isValidObjectId(reportId))
    ) {
      return res.status(400).json({
        success: false,
        code: "INVALID_HISTORY_FILTER",
        message: "Signal history filter is invalid.",
      });
    }
    const detectedAt = parseDateRange(req.query.from, req.query.to);
    const query = withCursorScope(withHistoricalEvidenceScope(agencyId, {
      ...(clientId ? { client_id: clientId } : {}),
      ...(reportId ? { report_id: reportId } : {}),
      ...(reportRunId ? { report_run_id: reportRunId } : {}),
      ...(req.query.type ? { type: req.query.type } : {}),
      ...(req.query.severity ? { severity: req.query.severity } : {}),
      ...(detectedAt ? { detected_at: detectedAt } : {}),
    }), "detected_at", req.query.cursor);
    const limit = parseHistoryLimit(req.query.limit, { defaultLimit: 50 });
    const documents = await Signal.find(query)
      .select(
        "_id agency_id client_id report_id report_run_id context_snapshot campaign_id type severity title description recommendation metadata detected_at createdAt issue_id issue_occurrence_number issue_fingerprint_snapshot matched_at matching_version issue_matching_status issue_matching_reason"
      )
      .sort({ detected_at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "detected_at" });
    const clientIds = [
      ...new Set(page.items.map((signal) => signal.client_id).filter(Boolean).map(String)),
    ];
    const reportIds = [
      ...new Set(page.items.map((signal) => signal.report_id).filter(Boolean).map(String)),
    ];
    const [clients, reports] = await Promise.all([
      clientIds.length
        ? Client.find({ _id: { $in: clientIds }, agency_id: agencyId })
            .select("_id name")
            .lean()
        : [],
      reportIds.length
        ? Report.find({ _id: { $in: reportIds }, agency_id: agencyId })
            .select("_id name")
            .lean()
        : [],
    ]);
    const clientById = new Map(clients.map((client) => [String(client._id), client]));
    const reportById = new Map(reports.map((report) => [String(report._id), report]));

    return res.json({
      success: true,
      signals: page.items.map((signal) =>
        serializeHistoricalSignal(signal, {
          client: clientById.get(String(signal.client_id)) || null,
          report: reportById.get(String(signal.report_id)) || null,
        })
      ),
      page: page.page,
    });
  } catch (err) {
    return historyRequestError(res, err, "Failed to fetch signals");
  }
};
