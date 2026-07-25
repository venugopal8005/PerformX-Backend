import {
  Client,
  Issue,
  MetaAdAccount,
  Report,
  Signal,
} from "../models/index.js";
import {
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
} from "../domain/phase2Issue.domain.js";
import {
  finalizeHistoryPage,
  historyNotFound,
  historyRequestError,
  isValidObjectId,
  parseHistoryLimit,
  withCursorScope,
} from "../utils/historyPagination.js";
import {
  serializeIssueDetail,
  serializeIssueListItem,
  serializeIssueSignalOccurrence,
} from "../utils/issueSerializers.js";
import { getIssueTimeline as getIssueTimelineService } from "../services/issueTimeline.service.js";

const invalidFilter = (message = "Issue filter is invalid.") => {
  const error = new Error(message);
  error.code = "INVALID_HISTORY_FILTER";
  error.status = 400;
  return error;
};

const parseIdFilter = (value) => {
  if (!value) return null;
  if (!isValidObjectId(value)) throw invalidFilter();
  return value;
};

const loadIssueParents = async ({ issues, agencyId }) => {
  const signalIds = [...new Set(issues.map((item) => item.latest_signal_id).filter(Boolean).map(String))];
  const clientIds = [...new Set(issues.map((item) => item.client_id).filter(Boolean).map(String))];
  const reportIds = [...new Set(issues.map((item) => item.latest_report_id).filter(Boolean).map(String))];
  const accountIds = [...new Set(issues.map((item) => item.meta_ad_account_id).filter(Boolean).map(String))];
  const [signals, clients, reports, accounts] = await Promise.all([
    signalIds.length
      ? Signal.find({ _id: { $in: signalIds }, agency_id: agencyId })
          .select("_id context_snapshot")
          .lean()
      : [],
    clientIds.length
      ? Client.find({ _id: { $in: clientIds }, agency_id: agencyId }).select("_id name").lean()
      : [],
    reportIds.length
      ? Report.find({ _id: { $in: reportIds }, agency_id: agencyId }).select("_id name").lean()
      : [],
    accountIds.length
      ? MetaAdAccount.find({ _id: { $in: accountIds }, agency_id: agencyId }).select("_id name").lean()
      : [],
  ]);
  const map = (items) => new Map(items.map((item) => [String(item._id), item]));
  return { signals: map(signals), clients: map(clients), reports: map(reports), accounts: map(accounts) };
};

const parentsForIssue = (issue, maps) => ({
  signal: maps.signals.get(String(issue.latest_signal_id)) || null,
  client: maps.clients.get(String(issue.client_id)) || null,
  report: maps.reports.get(String(issue.latest_report_id)) || null,
  metaAccount: maps.accounts.get(String(issue.meta_ad_account_id)) || null,
});

export const getIssues = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    if (!agencyId) return res.status(401).json({ success: false, message: "Agency context missing from auth token" });
    const clientId = parseIdFilter(req.query.clientId || req.query.client_id);
    const reportId = parseIdFilter(req.query.reportId || req.query.report_id);
    const metaAdAccountId = parseIdFilter(req.query.metaAdAccountId || req.query.meta_ad_account_id);
    const status = req.query.status;
    const severity = req.query.severity;
    if (status && !ISSUE_STATUSES.includes(status)) throw invalidFilter("Issue status filter is invalid.");
    if (severity && !ISSUE_SEVERITIES.includes(severity)) throw invalidFilter("Issue severity filter is invalid.");
    const limit = parseHistoryLimit(req.query.limit);
    const reportIssueIds = reportId
      ? await Signal.distinct("issue_id", {
          agency_id: agencyId,
          report_id: reportId,
          issue_id: { $type: "objectId" },
        })
      : null;
    const query = withCursorScope({
      agency_id: agencyId,
      ...(clientId ? { client_id: clientId } : {}),
      ...(reportId
        ? {
            $or: [
              { _id: { $in: reportIssueIds } },
              // Compatibility only: pre-Phase 3 Issues may not have linked
              // Signals yet, so retain their persisted legacy lookup path.
              { report_ids: reportId },
            ],
          }
        : {}),
      ...(metaAdAccountId ? { meta_ad_account_id: metaAdAccountId } : {}),
      ...(status ? { status } : {}),
      ...(severity ? { current_severity: severity } : {}),
    }, "last_seen_at", req.query.cursor);
    const documents = await Issue.find(query)
      .sort({ last_seen_at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "last_seen_at" });
    const maps = await loadIssueParents({ issues: page.items, agencyId });
    return res.json({
      success: true,
      issues: page.items.map((issue) => serializeIssueListItem(issue, parentsForIssue(issue, maps))),
      page: page.page,
    });
  } catch (error) {
    return historyRequestError(res, error, "Failed to fetch Issues.");
  }
};

export const getIssue = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    if (!agencyId) return res.status(401).json({ success: false, message: "Agency context missing from auth token" });
    if (!isValidObjectId(req.params.issueId)) return historyNotFound(res, "Issue");
    const issue = await Issue.findOne({ _id: req.params.issueId, agency_id: agencyId }).lean();
    if (!issue) return historyNotFound(res, "Issue");
    const maps = await loadIssueParents({ issues: [issue], agencyId });
    return res.json({ success: true, issue: serializeIssueDetail(issue, parentsForIssue(issue, maps)) });
  } catch (error) {
    return historyRequestError(res, error, "Failed to fetch Issue.");
  }
};

export const getIssueSignals = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    if (!agencyId) return res.status(401).json({ success: false, message: "Agency context missing from auth token" });
    if (!isValidObjectId(req.params.issueId)) return historyNotFound(res, "Issue");
    const issue = await Issue.findOne({ _id: req.params.issueId, agency_id: agencyId }).select("_id").lean();
    if (!issue) return historyNotFound(res, "Issue");
    const limit = parseHistoryLimit(req.query.limit);
    const query = withCursorScope(
      { agency_id: agencyId, issue_id: issue._id },
      "detected_at",
      req.query.cursor
    );
    const documents = await Signal.find(query)
      .select("_id issue_id report_id report_run_id issue_occurrence_number issue_fingerprint_snapshot issue_matching_status issue_matching_reason type severity title description recommendation campaign_id detected_at matched_at")
      .sort({ detected_at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "detected_at" });
    return res.json({
      success: true,
      signals: page.items.map(serializeIssueSignalOccurrence),
      page: page.page,
    });
  } catch (error) {
    return historyRequestError(res, error, "Failed to fetch Issue Signals.");
  }
};

export const getIssueTimeline = async (req, res) => {
  try {
    const agencyId = req.user?.agencyId;
    if (!agencyId) return res.status(401).json({ success: false, message: "Agency context missing from auth token" });
    const result = await getIssueTimelineService({ agencyId, issueId: req.params.issueId, cursor: req.query.cursor, limit: req.query.limit });
    return res.json({ success: true, timeline: result.entries, page: result.page });
  } catch (error) {
    if (["REVIEW_NOT_FOUND", "INVALID_TIMELINE_CURSOR", "REVIEW_VALIDATION_FAILED"].includes(error?.code)) return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
    return historyRequestError(res, error, "Failed to fetch Issue timeline.");
  }
};
