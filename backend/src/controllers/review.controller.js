import mongoose from "mongoose";
import { REVIEW_ERROR } from "../domain/phase5Review.domain.js";
import { INTERVENTION_ERROR } from "../domain/phase3Intervention.domain.js";
import { acknowledgeReviewItem, interpretReviewItem, snoozeReviewItem } from "../services/reviewActions.service.js";
import { createReviewIntervention } from "../services/reviewIntervention.service.js";
import { getReviewItemDetail, listReviewActions, listReviewItems } from "../services/reviewQueue.service.js";
import { getBoundedReviewSummary } from "../services/reviewSummary.service.js";
import { serializeInterventionDetail, serializeInterventionListItem } from "../utils/interventionSerializers.js";
import { serializeReviewAction, serializeReviewItemDetail, serializeReviewItemList } from "../utils/reviewSerializers.js";
import { logError } from "../utils/controllerLogger.js";

const controlled = new Set([
  ...Object.values(REVIEW_ERROR), "REVIEW_PERMISSION_DENIED", "CLIENT_NOT_FOUND", "CLIENT_ARCHIVED",
  ...Object.values(INTERVENTION_ERROR),
  "client_lifecycle_operation_in_progress", "client_lifecycle_lease_lost", "INTERVENTION_IDEMPOTENCY_CONFLICT",
  "INTERVENTION_VALIDATION_FAILED", "INTERVENTION_INVALID_ACTION", "STALE_ISSUE_REVISION",
]);
const agency = (req) => req.user?.agencyId;
const unavailableAgency = (res) => res.status(401).json({ success: false, message: "Agency context missing from auth token" });
const publicCode = (code) => ({
  client_lifecycle_operation_in_progress: "CLIENT_LIFECYCLE_OPERATION_IN_PROGRESS",
  client_lifecycle_lease_lost: "CLIENT_LIFECYCLE_LEASE_LOST",
})[code] || code;
const handle = (res, error, operation) => {
  if (controlled.has(error?.code) && Number.isInteger(error?.status)) return res.status(error.status).json({ success: false, code: publicCode(error.code), message: error.message });
  if (error?.name === "CastError" || error?.name === "ValidationError") return res.status(400).json({ success: false, code: REVIEW_ERROR.VALIDATION, message: "Review request is invalid." });
  logError("Review", "REVIEW_REQUEST_FAILED", error, { operation });
  return res.status(500).json({ success: false, code: "INTERNAL_SERVER_ERROR", message: "Unable to complete the Review request." });
};

export const getReviewItems = async (req, res) => {
  try {
    if (!agency(req)) return unavailableAgency(res);
    const result = await listReviewItems({ agencyId: agency(req), filters: req.query });
    return res.json({ success: true, reviewItems: result.items.map(({ item, effective }) => serializeReviewItemList(item, effective)), page: result.page });
  } catch (error) { return handle(res, error, "list"); }
};

export const getClientReviewItems = async (req, res) => {
  try {
    if (!agency(req)) return unavailableAgency(res);
    const result = await listReviewItems({ agencyId: agency(req), clientId: req.params.clientId, filters: req.query });
    return res.json({ success: true, reviewItems: result.items.map(({ item, effective }) => serializeReviewItemList(item, effective)), page: result.page });
  } catch (error) { return handle(res, error, "client_list"); }
};

export const getReviewItem = async (req, res) => {
  try {
    if (!agency(req)) return unavailableAgency(res);
    const result = await getReviewItemDetail({ agencyId: agency(req), reviewItemId: req.params.reviewItemId });
    return res.json({ success: true, reviewItem: serializeReviewItemDetail(result.item, result.effective, { actions: result.actions, linkedIntervention: result.intervention ? serializeInterventionListItem(result.intervention) : null, linkedEvaluation: result.evaluation ? { id: String(result.evaluation._id), status: result.evaluation.status, observedResult: result.evaluation.observed_result, calculatedAt: result.evaluation.calculated_at } : null }) });
  } catch (error) { return handle(res, error, "detail"); }
};

export const getReviewActions = async (req, res) => {
  try {
    if (!agency(req)) return unavailableAgency(res);
    const result = await listReviewActions({ agencyId: agency(req), reviewItemId: req.params.reviewItemId, limit: req.query.limit, beforeSequence: req.query.cursor });
    return res.json({ success: true, actions: result.actions.map(serializeReviewAction), page: result.page });
  } catch (error) { return handle(res, error, "actions"); }
};

const transition = (service, operation) => async (req, res) => {
  try {
    if (!agency(req)) return unavailableAgency(res);
    const result = await service({ agencyId: agency(req), reviewItemId: req.params.reviewItemId, actor: req.user, input: req.body });
    const detail = await getReviewItemDetail({ agencyId: agency(req), reviewItemId: result.item._id });
    return res.status(result.idempotentReplay ? 200 : 201).json({ success: true, idempotentReplay: result.idempotentReplay, reviewItem: serializeReviewItemDetail(detail.item, detail.effective) });
  } catch (error) { return handle(res, error, operation); }
};
export const acknowledgeReview = transition(acknowledgeReviewItem, "acknowledge");
export const snoozeReview = transition(snoozeReviewItem, "snooze");
export const interpretReview = transition(interpretReviewItem, "interpret");

export const createReviewItemIntervention = async (req, res) => {
  try {
    if (!agency(req)) return unavailableAgency(res);
    if (!mongoose.isObjectIdOrHexString(req.params.reviewItemId)) return res.status(404).json({ success: false, code: REVIEW_ERROR.NOT_FOUND, message: "Review item not found." });
    const result = await createReviewIntervention({ agencyId: agency(req), reviewItemId: req.params.reviewItemId, actor: req.user, input: req.body });
    return res.status(result.idempotentReplay ? 200 : 201).json({ success: true, idempotentReplay: result.idempotentReplay, intervention: serializeInterventionDetail(result.intervention), reviewCompletionStatus: result.reviewCompletionStatus, reviewItem: result.reviewItem ? serializeReviewItemList(result.reviewItem, { effectiveState: result.reviewItem.state, effectivePriority: result.reviewItem.priority, mutationPermissions: {} }) : null });
  } catch (error) { return handle(res, error, "create_intervention"); }
};

const summary = (clientScoped) => async (req, res) => {
  try {
    if (!agency(req)) return unavailableAgency(res);
    const result = await getBoundedReviewSummary({ agencyId: agency(req), clientId: clientScoped ? req.params.clientId : null, cursor: req.query.cursor });
    return res.json({ success: true, summary: result });
  } catch (error) { return handle(res, error, clientScoped ? "client_summary" : "workspace_summary"); }
};
export const getReviewSummary = summary(false);
export const getClientReviewSummary = summary(true);
