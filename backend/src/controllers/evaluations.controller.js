import {
  Client,
  Evaluation,
  Intervention,
  Issue,
} from "../models/index.js";
import {
  EVALUATION_ERROR,
  EVALUATION_METRICS,
  EVALUATION_RESULTS,
  EVALUATION_STATUSES,
} from "../domain/phase4Evaluation.domain.js";
import { processInterventionEvaluation } from "../services/evaluation.service.js";
import { finalizeHistoryPage, isValidObjectId, parseHistoryLimit, withCursorScope } from "../utils/historyPagination.js";
import { serializeEvaluationDetail, serializeEvaluationListItem } from "../utils/evaluationSerializers.js";
import { logError } from "../utils/controllerLogger.js";

const agencyFor = (req) => req.user?.agencyId;
const userFor = (req) => req.user?.userId || req.user?.id || req.user?._id;
const controlled = new Set([...Object.values(EVALUATION_ERROR), "CLIENT_NOT_FOUND", "CLIENT_ARCHIVED", "client_lifecycle_operation_in_progress", "client_lifecycle_lease_lost", "META_REPORT_ACCOUNT_UNRESOLVED", "META_ACCOUNT_BINDING_STALE", "META_ACCOUNT_ASSIGNMENT_CONFLICT", "META_CONNECTION_UNAVAILABLE", "META_RECONNECT_REQUIRED", "INVALID_CURSOR", "INVALID_PAGINATION_LIMIT"]);
const notFound = (res, code = EVALUATION_ERROR.NOT_FOUND, message = "Evaluation not found.") => res.status(404).json({ success: false, code, message });
const requireAgency = (req, res) => {
  const agencyId = agencyFor(req);
  if (agencyId) return agencyId;
  res.status(401).json({ success: false, message: "Agency context missing from auth token" });
  return null;
};
const handleError = (res, error, operation) => {
  if (controlled.has(error?.code) && Number.isInteger(error?.status)) return res.status(error.status).json({ success: false, code: error.code, message: error.message });
  if (error?.name === "CastError" || error?.name === "ValidationError") return res.status(400).json({ success: false, code: EVALUATION_ERROR.VALIDATION, message: "Evaluation request is invalid." });
  logError("Evaluations", "EVALUATION_REQUEST_FAILED", error, { operation });
  return res.status(500).json({ success: false, code: "INTERNAL_SERVER_ERROR", message: "Unable to complete the Evaluation request." });
};
const supersededIds = async (agencyId, documents) => {
  const ids = documents.map((item) => item._id);
  if (!ids.length) return new Set();
  const successors = await Evaluation.find({ agency_id: agencyId, supersedes_evaluation_id: { $in: ids } }).select("supersedes_evaluation_id").lean();
  return new Set(successors.map((item) => String(item.supersedes_evaluation_id)));
};
const canRefresh = async ({ agencyId, intervention, req }) => {
  if (!intervention || intervention.status !== "active") return false;
  const client = await Client.findOne({ _id: intervention.client_id, agency_id: agencyId }).select("is_archived").lean();
  return client?.is_archived !== true && (String(intervention.recorded_by_user_id) === String(userFor(req)) || req.workspaceMembership?.role === "owner");
};

const decodeSequenceCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value.v !== 1 || !Number.isSafeInteger(value.s) || value.s < 1) throw new Error("invalid");
    return value.s;
  } catch {
    throw Object.assign(new Error("Evaluation cursor is invalid."), { code: "INVALID_CURSOR", status: 400 });
  }
};

const finalizeSequencePage = ({ documents, limit }) => {
  const hasMore = documents.length > limit;
  const items = hasMore ? documents.slice(0, limit) : documents;
  const sequence = items.at(-1)?.sequence;
  return {
    items,
    page: {
      nextCursor: hasMore && Number.isSafeInteger(sequence)
        ? Buffer.from(JSON.stringify({ v: 1, s: sequence })).toString("base64url")
        : null,
      hasMore,
      limit,
    },
  };
};

export const getInterventionEvaluations = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!isValidObjectId(req.params.interventionId)) return notFound(res, EVALUATION_ERROR.INTERVENTION_NOT_FOUND, "Intervention not found.");
    const intervention = await Intervention.findOne({ _id: req.params.interventionId, agency_id: agencyId }).select("_id").lean();
    if (!intervention) return notFound(res, EVALUATION_ERROR.INTERVENTION_NOT_FOUND, "Intervention not found.");
    const limit = parseHistoryLimit(req.query.limit);
    const cursorSequence = decodeSequenceCursor(req.query.cursor);
    const query = {
      agency_id: agencyId,
      intervention_id: intervention._id,
      ...(cursorSequence ? { sequence: { $lt: cursorSequence } } : {}),
    };
    const documents = await Evaluation.find(query).sort({ sequence: -1 }).limit(limit + 1).lean();
    const page = finalizeSequencePage({ documents, limit });
    const superseded = await supersededIds(agencyId, page.items);
    return res.json({ success: true, evaluations: page.items.map((item) => serializeEvaluationListItem(item, { superseded: superseded.has(String(item._id)) })), page: page.page });
  } catch (error) { return handleError(res, error, "intervention_history"); }
};

export const getEvaluation = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!isValidObjectId(req.params.evaluationId)) return notFound(res);
    const evaluation = await Evaluation.findOne({ _id: req.params.evaluationId, agency_id: agencyId });
    if (!evaluation) return notFound(res);
    const [successor, intervention] = await Promise.all([
      Evaluation.exists({ agency_id: agencyId, supersedes_evaluation_id: evaluation._id }),
      Intervention.findOne({ _id: evaluation.intervention_id, agency_id: agencyId }),
    ]);
    return res.json({
      success: true,
      evaluation: serializeEvaluationDetail(evaluation, {
        superseded: Boolean(successor),
        supersededByEvaluationId: successor?._id || null,
        canRefresh: await canRefresh({ agencyId, intervention, req }),
      }),
    });
  } catch (error) { return handleError(res, error, "detail"); }
};

const filtersFor = (query) => {
  const issueId = query.issueId || query.issue_id;
  const clientId = query.clientId || query.client_id;
  const status = query.status;
  const observedResult = query.observedResult || query.observed_result;
  const primaryMetric = query.primaryMetric || query.primary_metric;
  if (!issueId && !clientId && !status && !observedResult && !primaryMetric) throw Object.assign(new Error("At least one approved Evaluation filter is required."), { code: EVALUATION_ERROR.FILTER_REQUIRED, status: 400 });
  if ((issueId && !isValidObjectId(issueId)) || (clientId && !isValidObjectId(clientId)) || (status && !EVALUATION_STATUSES.includes(status)) || (observedResult && !EVALUATION_RESULTS.includes(observedResult)) || (primaryMetric && !EVALUATION_METRICS.includes(primaryMetric))) throw Object.assign(new Error("Evaluation filter is invalid."), { code: EVALUATION_ERROR.VALIDATION, status: 400 });
  return { ...(issueId ? { issue_id: issueId } : {}), ...(clientId ? { client_id: clientId } : {}), ...(status ? { status } : {}), ...(observedResult ? { observed_result: observedResult } : {}), ...(primaryMetric ? { primary_metric: primaryMetric } : {}) };
};

const requireFilterParents = async ({ agencyId, filters }) => {
  const checks = [];
  if (filters.client_id) checks.push(Client.exists({ _id: filters.client_id, agency_id: agencyId }));
  if (filters.issue_id) checks.push(Issue.exists({ _id: filters.issue_id, agency_id: agencyId }));
  if (!checks.length) return;
  const parents = await Promise.all(checks);
  if (parents.some((parent) => !parent)) {
    throw Object.assign(new Error("Evaluation filter parent not found."), {
      code: EVALUATION_ERROR.NOT_FOUND,
      status: 404,
    });
  }
};

export const getEvaluations = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    const limit = parseHistoryLimit(req.query.limit);
    const filters = filtersFor(req.query);
    await requireFilterParents({ agencyId, filters });
    const query = withCursorScope({ agency_id: agencyId, ...filters }, "calculated_at", req.query.cursor);
    const documents = await Evaluation.find(query).sort({ calculated_at: -1, _id: -1 }).limit(limit + 1).lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "calculated_at" });
    const superseded = await supersededIds(agencyId, page.items);
    return res.json({ success: true, evaluations: page.items.map((item) => serializeEvaluationListItem(item, { superseded: superseded.has(String(item._id)) })), page: page.page });
  } catch (error) { return handleError(res, error, "history"); }
};

export const refreshInterventionEvaluation = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!isValidObjectId(req.params.interventionId)) return notFound(res, EVALUATION_ERROR.INTERVENTION_NOT_FOUND, "Intervention not found.");
    const result = await processInterventionEvaluation({ agencyId, interventionId: req.params.interventionId, triggerType: "manual_refresh", actor: req.user, expectedInterventionRevision: req.body?.expectedInterventionRevision, idempotencyKey: req.body?.idempotencyKey });
    const status = result.evaluation.status === "awaiting_follow_up" ? 202 : result.created ? 201 : 200;
    return res.status(status).json({ success: true, created: result.created, noChange: result.noChange, evaluation: serializeEvaluationDetail(result.evaluation, { canRefresh: true }) });
  } catch (error) { return handleError(res, error, "refresh"); }
};

export const evaluationControllerInternals = {
  decodeSequenceCursor,
  filtersFor,
  finalizeSequencePage,
  handleError,
  requireFilterParents,
};
