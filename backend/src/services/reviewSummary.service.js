import crypto from "node:crypto";
import mongoose from "mongoose";
import { Client, Evaluation, EvaluationSeries, Issue, MetaAdAccount, ReviewItem } from "../models/index.js";
import { REVIEW_ACTIVE_STATES, REVIEW_ERROR, REVIEW_LIMITS, createReviewError } from "../domain/phase5Review.domain.js";
import { assertPhase5ReviewIntegrityReady } from "./phase5ReviewIndexes.service.js";
import { loadReviewAuthorityBatch, resolveReviewEffectiveState } from "./reviewAuthority.service.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";

const defaultModels = { Client, Evaluation, EvaluationSeries, Issue, MetaAdAccount, ReviewItem };
const empty = () => ({ active: 0, actionable: 0, snoozed: 0, critical: 0, high: 0, normal: 0, issueReview: 0, evaluationReview: 0 });
const secret = () => {
  const value = process.env.JWT_SECRET;
  if (typeof value !== "string" || value.length < 16) {
    throw createReviewError(REVIEW_ERROR.INDEXES_NOT_READY, "Review summaries are temporarily unavailable.", 503);
  }
  return value;
};
const sign = (payload) => crypto.createHmac("sha256", secret()).update(`phase5-review-summary-v1:${payload}`).digest("base64url");
const encode = (value) => { const payload = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${payload}.${sign(payload)}`; };
const decode = (cursor, { agencyId, scope }) => {
  if (!cursor) return null;
  try {
    const [payload, signature, extra] = String(cursor).split(".");
    if (!payload || !signature || extra || Buffer.byteLength(payload, "base64url") > REVIEW_LIMITS.cursorBytes) throw new Error("invalid");
    const expected = sign(payload);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("invalid");
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (value.v !== 1 || value.agencyId !== String(agencyId) || value.scope !== scope || !mongoose.isObjectIdOrHexString(value.i) || Number.isNaN(new Date(value.t).getTime()) || Number.isNaN(new Date(value.snapshotAt).getTime())) throw new Error("invalid");
    return value;
  } catch { throw createReviewError(REVIEW_ERROR.INVALID_CURSOR, "Review summary cursor is invalid.", 400); }
};
const observe = (counts, item, effective) => {
  if (!["open", "acknowledged", "snoozed"].includes(effective.effectiveState) || !effective.isSourceCurrent) return;
  counts.active += 1;
  if (!effective.actionable) { counts.snoozed += 1; return; }
  counts.actionable += 1; counts[effective.effectivePriority] += 1;
  counts[item.type === "issue_review" ? "issueReview" : "evaluationReview"] += 1;
};

export const getBoundedReviewSummary = async ({ agencyId, clientId = null, cursor = null, now = new Date(), Models = defaultModels, transactionRunner = runRequiredTransaction, assertReady = assertPhase5ReviewIntegrityReady } = {}) => {
  assertReady();
  if (clientId && !mongoose.isObjectIdOrHexString(clientId)) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Client not found.", 404);
  const scope = clientId ? `client:${clientId}` : "workspace";
  const decoded = decode(cursor, { agencyId, scope });
  const snapshotAt = decoded ? new Date(decoded.snapshotAt) : now;
  return transactionRunner({ unavailableCode: REVIEW_ERROR.TRANSACTION_REQUIRED, unavailableMessage: "Review summaries require a transaction-capable database deployment.", work: async (session) => {
    let client = null;
    if (clientId) {
      client = await Models.Client.findOne({ _id: clientId, agency_id: agencyId }).session(session).lean();
      if (!client) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Client not found.", 404);
      if (client.is_archived) return { asOf: snapshotAt.toISOString(), archived: true, completeness: "complete", counts: empty(), observedCounts: empty(), scannedCandidates: 0, nextCursor: null };
    }
    const cursorScope = decoded ? { $or: [{ createdAt: { $gt: new Date(decoded.t) } }, { createdAt: new Date(decoded.t), _id: { $gt: decoded.i } }] } : {};
    const query = { agency_id: agencyId, ...(clientId ? { client_id: clientId } : {}), state: { $in: REVIEW_ACTIVE_STATES }, createdAt: { $lte: snapshotAt }, ...cursorScope };
    const items = await Models.ReviewItem.find(query).sort({ createdAt: 1, _id: 1 }).limit(REVIEW_LIMITS.maximumCandidates).session(session).lean();
    const last = items.at(-1);
    const lookahead = items.length === REVIEW_LIMITS.maximumCandidates && last
      ? await Models.ReviewItem.findOne({
          $and: [
            query,
            { $or: [{ createdAt: { $gt: last.createdAt } }, { createdAt: last.createdAt, _id: { $gt: last._id } }] },
          ],
        }).select("_id").session(session).lean()
      : null;
    const hasMore = Boolean(lookahead);
    const observed = empty();
    for (let offset = 0; offset < items.length; offset += REVIEW_LIMITS.candidateBatch) {
      const authorities = await loadReviewAuthorityBatch({ agencyId, reviewItems: items.slice(offset, offset + REVIEW_LIMITS.candidateBatch), Models, session });
      authorities.forEach((authority) => observe(observed, authority.reviewItem, resolveReviewEffectiveState({ ...authority, now: snapshotAt })));
    }
    return { asOf: snapshotAt.toISOString(), ...(clientId ? { archived: false } : {}), completeness: hasMore || decoded ? "partial" : "complete", counts: hasMore || decoded ? null : observed, observedCounts: observed, scannedCandidates: items.length, nextCursor: hasMore && last ? encode({ v: 1, agencyId: String(agencyId), scope, snapshotAt: snapshotAt.toISOString(), t: new Date(last.createdAt).toISOString(), i: String(last._id) }) : null };
  } });
};

export const reviewSummaryInternals = { decode, empty, observe };
