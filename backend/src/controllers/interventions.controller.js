import mongoose from "mongoose";

import { Intervention, Issue } from "../models/index.js";
import {
  INTERVENTION_ACTION_TYPES,
  INTERVENTION_ERROR,
  INTERVENTION_STATUSES,
} from "../domain/phase3Intervention.domain.js";
import {
  cancelIntervention as cancelInterventionService,
  correctIntervention as correctInterventionService,
  createIntervention as createInterventionService,
  interventionPermissions,
} from "../services/intervention.service.js";
import {
  finalizeHistoryPage,
  isValidObjectId,
  parseHistoryLimit,
  withCursorScope,
} from "../utils/historyPagination.js";
import {
  serializeInterventionDetail,
  serializeInterventionListItem,
} from "../utils/interventionSerializers.js";
import { logError } from "../utils/controllerLogger.js";

const controlledCodes = new Set([
  ...Object.values(INTERVENTION_ERROR),
  "CLIENT_NOT_FOUND",
  "CLIENT_ARCHIVED",
  "client_lifecycle_operation_in_progress",
  "client_lifecycle_lease_lost",
  "INVALID_CURSOR",
  "INVALID_PAGINATION_LIMIT",
]);

const agencyFor = (req) => req.user?.agencyId;
const userIdFor = (req) => req.user?.userId || req.user?.id || req.user?._id;
const notFound = (res) =>
  res.status(404).json({
    success: false,
    code: INTERVENTION_ERROR.NOT_FOUND,
    message: "Intervention not found.",
  });
const issueNotFound = (res) =>
  res.status(404).json({
    success: false,
    code: INTERVENTION_ERROR.ISSUE_NOT_FOUND,
    message: "Issue not found.",
  });

const handleError = (res, error, operation) => {
  if (
    controlledCodes.has(error?.code) &&
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status < 600
  ) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }
  if (error?.name === "ValidationError" || error?.name === "CastError") {
    return res.status(400).json({
      success: false,
      code: INTERVENTION_ERROR.VALIDATION,
      message: "Intervention request is invalid.",
    });
  }
  logError("Interventions", "INTERVENTION_REQUEST_FAILED", error, { operation });
  return res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "Unable to complete the Intervention request.",
  });
};

const requireAgency = (req, res) => {
  const agencyId = agencyFor(req);
  if (agencyId) return agencyId;
  res.status(401).json({ success: false, message: "Agency context missing from auth token" });
  return null;
};

const detailPermissions = (req, intervention) =>
  interventionPermissions({
    intervention,
    userId: userIdFor(req),
    workspaceRole: req.workspaceMembership?.role,
  });

export const createIssueIntervention = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!isValidObjectId(req.params.issueId)) {
      return res.status(404).json({ success: false, code: INTERVENTION_ERROR.ISSUE_NOT_FOUND, message: "Issue not found." });
    }
    const result = await createInterventionService({
      agencyId,
      recorder: req.user,
      issueId: req.params.issueId,
      input: req.body,
    });
    return res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      idempotentReplay: result.idempotentReplay,
      intervention: serializeInterventionDetail(result.intervention, {
        permissions: detailPermissions(req, result.intervention),
      }),
    });
  } catch (error) {
    return handleError(res, error, "create");
  }
};

export const getIssueInterventions = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!isValidObjectId(req.params.issueId)) return issueNotFound(res);
    const issue = await Issue.findOne({ _id: req.params.issueId, agency_id: agencyId }).select("_id").lean();
    if (!issue) return issueNotFound(res);
    const limit = parseHistoryLimit(req.query.limit);
    const query = withCursorScope(
      { agency_id: agencyId, issue_id: issue._id },
      "performed_at",
      req.query.cursor
    );
    const documents = await Intervention.find(query)
      .sort({ performed_at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "performed_at" });
    return res.json({
      success: true,
      interventions: page.items.map(serializeInterventionListItem),
      page: page.page,
    });
  } catch (error) {
    return handleError(res, error, "issue_history");
  }
};

export const getIntervention = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!isValidObjectId(req.params.interventionId)) return notFound(res);
    const intervention = await Intervention.findOne({
      _id: req.params.interventionId,
      agency_id: agencyId,
    });
    if (!intervention) return notFound(res);
    return res.json({
      success: true,
      intervention: serializeInterventionDetail(intervention, {
        permissions: detailPermissions(req, intervention),
      }),
    });
  } catch (error) {
    return handleError(res, error, "detail");
  }
};

const parseListFilters = (query) => {
  const clientId = query.clientId || query.client_id;
  const performedByUserId = query.performedByUserId || query.performed_by_user_id;
  const actionType = query.actionType || query.action_type;
  const status = query.status;
  if (!clientId && !performedByUserId && !actionType && !status) {
    const error = new Error("At least one approved Intervention filter is required.");
    error.code = INTERVENTION_ERROR.FILTER_REQUIRED;
    error.status = 400;
    throw error;
  }
  if ((clientId && !isValidObjectId(clientId)) || (performedByUserId && !isValidObjectId(performedByUserId))) {
    const error = new Error("Intervention filter is invalid.");
    error.code = INTERVENTION_ERROR.VALIDATION;
    error.status = 400;
    throw error;
  }
  if (actionType && !INTERVENTION_ACTION_TYPES.includes(actionType)) {
    const error = new Error("Intervention action filter is invalid.");
    error.code = INTERVENTION_ERROR.VALIDATION;
    error.status = 400;
    throw error;
  }
  if (status && !INTERVENTION_STATUSES.includes(status)) {
    const error = new Error("Intervention status filter is invalid.");
    error.code = INTERVENTION_ERROR.VALIDATION;
    error.status = 400;
    throw error;
  }
  return {
    ...(clientId ? { client_id: clientId } : {}),
    ...(performedByUserId ? { performed_by_user_id: performedByUserId } : {}),
    ...(actionType ? { action_type: actionType } : {}),
    ...(status ? { status } : {}),
  };
};

export const getInterventions = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    const filters = parseListFilters(req.query);
    const limit = parseHistoryLimit(req.query.limit);
    const query = withCursorScope(
      { agency_id: agencyId, ...filters },
      "performed_at",
      req.query.cursor
    );
    const documents = await Intervention.find(query)
      .sort({ performed_at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "performed_at" });
    return res.json({
      success: true,
      interventions: page.items.map(serializeInterventionListItem),
      page: page.page,
    });
  } catch (error) {
    return handleError(res, error, "history");
  }
};

export const correctIntervention = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!mongoose.isObjectIdOrHexString(req.params.interventionId)) return notFound(res);
    const result = await correctInterventionService({
      agencyId,
      recorder: req.user,
      interventionId: req.params.interventionId,
      input: req.body,
    });
    return res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      idempotentReplay: result.idempotentReplay,
      intervention: serializeInterventionDetail(result.intervention, {
        permissions: detailPermissions(req, result.intervention),
      }),
    });
  } catch (error) {
    return handleError(res, error, "correct");
  }
};

export const cancelIntervention = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!mongoose.isObjectIdOrHexString(req.params.interventionId)) return notFound(res);
    const result = await cancelInterventionService({
      agencyId,
      recorder: req.user,
      interventionId: req.params.interventionId,
      input: req.body,
    });
    return res.json({
      success: true,
      idempotentReplay: result.idempotentReplay,
      intervention: serializeInterventionDetail(result.intervention, {
        permissions: detailPermissions(req, result.intervention),
      }),
    });
  } catch (error) {
    return handleError(res, error, "cancel");
  }
};

export const interventionControllerInternals = { parseListFilters, handleError };
