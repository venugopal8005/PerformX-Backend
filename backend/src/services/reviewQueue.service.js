import crypto from "node:crypto";
import mongoose from "mongoose";
import {
  Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewAction, ReviewItem,
} from "../models/index.js";
import {
  REVIEW_ERROR, REVIEW_ITEM_TYPES, REVIEW_LIMITS, REVIEW_PRIORITIES, REVIEW_STATES, createReviewError,
} from "../domain/phase5Review.domain.js";
import { assertPhase5ReviewIntegrityReady } from "./phase5ReviewIndexes.service.js";
import { loadReviewAuthorityBatch, resolveReviewEffectiveState } from "./reviewAuthority.service.js";

const defaultModels = { Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewAction, ReviewItem };
const CURSOR_DOMAIN = "phase5-review-queue-v1";
const cursorSecret = () => {
  const value = process.env.JWT_SECRET;
  if (typeof value !== "string" || value.length < 16) throw createReviewError(REVIEW_ERROR.INDEXES_NOT_READY, "Review services are temporarily unavailable.", 503);
  return value;
};
const sign = (payload) => crypto.createHmac("sha256", cursorSecret()).update(`${CURSOR_DOMAIN}:${payload}`).digest("base64url");
const encodeCursor = (value) => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${sign(payload)}`;
};
const decodeCursor = (cursor, agencyId, scope) => {
  if (!cursor) return null;
  try {
    const [payload, signature, extra] = String(cursor).split(".");
    if (!payload || !signature || extra || Buffer.byteLength(payload, "base64url") > REVIEW_LIMITS.cursorBytes) throw new Error("invalid");
    const expected = sign(payload);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("invalid");
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (value.v !== 1 || value.agencyId !== String(agencyId) || value.scope !== scope || !Number.isSafeInteger(value.p) || !mongoose.isObjectIdOrHexString(value.i) || Number.isNaN(new Date(value.t).getTime())) throw new Error("invalid");
    return value;
  } catch {
    throw createReviewError(REVIEW_ERROR.INVALID_CURSOR, "Review cursor is invalid.", 400);
  }
};
const listValue = (value) => value == null ? [] : String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
const approved = (values, allowed, field) => {
  if (values.some((value) => !allowed.includes(value))) throw createReviewError(REVIEW_ERROR.VALIDATION, `${field} filter is invalid.`, 400);
  return values;
};
const limitFor = (value) => {
  if (value == null || value === "") return 25;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > REVIEW_LIMITS.timelineLimit) throw createReviewError(REVIEW_ERROR.VALIDATION, "limit is invalid.", 400);
  return parsed;
};
const cursorScope = (cursor) => cursor ? {
  $or: [
    { priority_rank: { $gt: cursor.p } },
    { priority_rank: cursor.p, latest_evidence_at: { $lt: new Date(cursor.t) } },
    { priority_rank: cursor.p, latest_evidence_at: new Date(cursor.t), _id: { $lt: cursor.i } },
  ],
} : {};

export const listReviewItems = async ({ agencyId, clientId = null, filters = {}, Models = defaultModels, assertReady = assertPhase5ReviewIntegrityReady, now = new Date() } = {}) => {
  assertReady();
  const states = approved(listValue(filters.state).length ? listValue(filters.state) : ["open", "acknowledged"], REVIEW_STATES, "state");
  const types = approved(listValue(filters.type), REVIEW_ITEM_TYPES, "type");
  const priorities = approved(listValue(filters.priority), REVIEW_PRIORITIES, "priority");
  const limit = limitFor(filters.limit);
  const scopedClient = clientId || filters.clientId || filters.client_id || null;
  if (scopedClient && !mongoose.isObjectIdOrHexString(scopedClient)) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Client not found.", 404);
  if (scopedClient) {
    const client = await Models.Client.findOne({ _id: scopedClient, agency_id: agencyId }).select("_id").lean();
    if (!client) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Client not found.", 404);
  }
  const campaignId = filters.campaignId || filters.campaign_id || null;
  if (campaignId != null && (typeof campaignId !== "string" || !campaignId.trim() || campaignId.length > REVIEW_LIMITS.campaignId)) throw createReviewError(REVIEW_ERROR.VALIDATION, "campaignId filter is invalid.", 400);
  const scope = JSON.stringify({ clientId: scopedClient ? String(scopedClient) : null, states, types, priorities, campaignId: campaignId || null });
  let cursor = decodeCursor(filters.cursor, agencyId, scope);
  const items = [];
  let scanned = 0;
  let hasMore = false;
  let lastScanned = null;
  for (let batch = 0; batch < REVIEW_LIMITS.maximumBatches && items.length < limit; batch += 1) {
    const query = {
      agency_id: agencyId,
      ...(scopedClient ? { client_id: scopedClient } : {}),
      state: { $in: states },
      ...(types.length ? { type: { $in: types } } : {}),
      ...(priorities.length ? { priority: { $in: priorities } } : {}),
      ...(campaignId ? { campaign_id: campaignId.trim() } : {}),
      ...cursorScope(cursor),
    };
    const candidates = await Models.ReviewItem.find(query).sort({ priority_rank: 1, latest_evidence_at: -1, _id: -1 }).limit(REVIEW_LIMITS.candidateBatch + 1).lean();
    hasMore = candidates.length > REVIEW_LIMITS.candidateBatch;
    const page = candidates.slice(0, REVIEW_LIMITS.candidateBatch);
    if (!page.length) { hasMore = false; break; }
    const authorities = await loadReviewAuthorityBatch({ agencyId, reviewItems: page, Models });
    for (const authority of authorities) {
      scanned += 1;
      lastScanned = authority.reviewItem;
      const effective = resolveReviewEffectiveState({ ...authority, now });
      if (!states.includes(effective.effectiveState) || !effective.isSourceCurrent) continue;
      items.push({ item: authority.reviewItem, effective });
      if (items.length === limit) break;
    }
    cursor = lastScanned ? { p: lastScanned.priority_rank, t: new Date(lastScanned.latest_evidence_at).toISOString(), i: String(lastScanned._id) } : cursor;
    if (!hasMore || items.length === limit) break;
  }
  const nextCursor = lastScanned && (hasMore || items.length === limit)
    ? encodeCursor({ v: 1, agencyId: String(agencyId), scope, p: lastScanned.priority_rank, t: new Date(lastScanned.latest_evidence_at).toISOString(), i: String(lastScanned._id) })
    : null;
  return { items, page: { limit, returned: items.length, scanned, nextCursor } };
};

export const getReviewItemDetail = async ({ agencyId, reviewItemId, Models = defaultModels, assertReady = assertPhase5ReviewIntegrityReady, now = new Date() } = {}) => {
  assertReady();
  if (!mongoose.isObjectIdOrHexString(reviewItemId)) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
  const item = await Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId }).lean();
  if (!item) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
  const authority = (await loadReviewAuthorityBatch({ agencyId, reviewItems: [item], Models }))[0];
  const effective = resolveReviewEffectiveState({ ...authority, now });
  const [actions, intervention, evaluation] = await Promise.all([
    Models.ReviewAction.find({ agency_id: agencyId, review_item_id: item._id }).sort({ sequence: -1 }).limit(25).lean(),
    item.intervention_id ? Models.Intervention.findOne({ _id: item.intervention_id, agency_id: agencyId }).lean() : null,
    item.evaluation_id ? Models.Evaluation.findOne({ _id: item.evaluation_id, agency_id: agencyId }).lean() : null,
  ]);
  return { item, effective, actions, intervention, evaluation };
};

export const listReviewActions = async ({ agencyId, reviewItemId, limit = 25, beforeSequence = null, Models = defaultModels, assertReady = assertPhase5ReviewIntegrityReady } = {}) => {
  assertReady();
  if (!mongoose.isObjectIdOrHexString(reviewItemId)) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
  const item = await Models.ReviewItem.findOne({ _id: reviewItemId, agency_id: agencyId }).select("_id").lean();
  if (!item) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Review item not found.", 404);
  const parsedLimit = limitFor(limit);
  const sequence = beforeSequence == null ? null : Number(beforeSequence);
  if (sequence != null && (!Number.isSafeInteger(sequence) || sequence < 1)) throw createReviewError(REVIEW_ERROR.INVALID_CURSOR, "Review action cursor is invalid.", 400);
  const documents = await Models.ReviewAction.find({ agency_id: agencyId, review_item_id: item._id, ...(sequence ? { sequence: { $lt: sequence } } : {}) }).sort({ sequence: -1 }).limit(parsedLimit + 1).lean();
  const hasMore = documents.length > parsedLimit;
  const actions = documents.slice(0, parsedLimit);
  return { actions, page: { limit: parsedLimit, nextCursor: hasMore ? String(actions.at(-1).sequence) : null } };
};

export const REVIEW_QUEUE_DEFAULT_MODELS = defaultModels;
