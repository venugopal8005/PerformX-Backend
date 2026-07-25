import crypto from "node:crypto";

import { EvaluationSeries } from "../models/EvaluationSeries.js";
import {
  EVALUATION_ERROR,
  EVALUATION_LIMITS,
  createEvaluationError,
} from "../domain/phase4Evaluation.domain.js";

const availableLock = (now) => ({
  $or: [
    { processing_lock: null },
    { processing_lock: { $exists: false } },
    { "processing_lock.expires_at": { $lte: now } },
  ],
});

export const ensureEvaluationSeries = async ({ agencyId, clientId, issueId, interventionId, SeriesModel = EvaluationSeries } = {}) => {
  try {
    return await SeriesModel.create({ agency_id: agencyId, client_id: clientId, issue_id: issueId, intervention_id: interventionId });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await SeriesModel.findOne({ agency_id: agencyId, intervention_id: interventionId });
    if (!existing || String(existing.client_id) !== String(clientId) || String(existing.issue_id) !== String(issueId)) {
      throw createEvaluationError(EVALUATION_ERROR.OWNERSHIP, "EvaluationSeries ownership is inconsistent.", 409);
    }
    return existing;
  }
};

export const acquireEvaluationSeriesLease = async ({ agencyId, interventionId, operation, now = new Date(), SeriesModel = EvaluationSeries } = {}) => {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + EVALUATION_LIMITS.leaseMs);
  const series = await SeriesModel.findOneAndUpdate(
    { $and: [{ agency_id: agencyId, intervention_id: interventionId }, availableLock(now)] },
    { $set: { processing_lock: { operation, token, acquired_at: now, heartbeat_at: now, expires_at: expiresAt } } },
    { new: true, phase4SeriesOperation: "acquire" }
  ).select("+processing_lock");
  return series ? { acquired: true, series, token, expiresAt } : { acquired: false, series: null, token: null, expiresAt: null };
};

export const acquireRequiredEvaluationSeriesLease = async (options = {}) => {
  for (let attempt = 0; attempt <= EVALUATION_LIMITS.leaseRetries; attempt += 1) {
    const lease = await acquireEvaluationSeriesLease(options);
    if (lease.acquired) return lease;
    if (attempt === EVALUATION_LIMITS.leaseRetries) break;
    await new Promise((resolve) => setTimeout(resolve, EVALUATION_LIMITS.leaseRetryDelayMs));
  }
  throw createEvaluationError(EVALUATION_ERROR.LEASE_BUSY, "Evaluation processing is already in progress.", 409);
};

export const renewEvaluationSeriesLease = async ({ agencyId, interventionId, token, now = new Date(), SeriesModel = EvaluationSeries } = {}) => {
  if (!token) return null;
  return SeriesModel.findOneAndUpdate(
    { agency_id: agencyId, intervention_id: interventionId, "processing_lock.token": token, "processing_lock.expires_at": { $gt: now } },
    { $set: { "processing_lock.heartbeat_at": now, "processing_lock.expires_at": new Date(now.getTime() + EVALUATION_LIMITS.leaseMs) } },
    { new: true, phase4SeriesOperation: "heartbeat" }
  ).select("+processing_lock");
};

export const fenceEvaluationSeriesLeaseInTransaction = async ({ agencyId, interventionId, token, expectedRevision, session, now = new Date(), SeriesModel = EvaluationSeries } = {}) => {
  if (!session) throw createEvaluationError(EVALUATION_ERROR.TRANSACTION_REQUIRED, "Evaluation processing requires a transaction.", 503);
  const series = await SeriesModel.findOneAndUpdate(
    { agency_id: agencyId, intervention_id: interventionId, revision: expectedRevision, "processing_lock.token": token, "processing_lock.expires_at": { $gt: now } },
    { $set: { "processing_lock.heartbeat_at": now, "processing_lock.expires_at": new Date(now.getTime() + EVALUATION_LIMITS.leaseMs) } },
    { new: true, session, phase4SeriesOperation: "heartbeat" }
  ).select("+processing_lock");
  if (!series) throw createEvaluationError(EVALUATION_ERROR.LEASE_LOST, "Evaluation processing ownership was lost.", 409);
  return series;
};

export const releaseEvaluationSeriesLease = async ({ agencyId, interventionId, token, SeriesModel = EvaluationSeries } = {}) => {
  if (!token) return false;
  const result = await SeriesModel.updateOne(
    { agency_id: agencyId, intervention_id: interventionId, "processing_lock.token": token },
    { $set: { processing_lock: null } },
    { phase4SeriesOperation: "release" }
  );
  return result.modifiedCount === 1;
};

export const startEvaluationSeriesLeaseHeartbeat = ({ agencyId, interventionId, token, SeriesModel = EvaluationSeries, intervalMs = EVALUATION_LIMITS.heartbeatMs } = {}) => {
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (stopped) return;
      if (!await renewEvaluationSeriesLease({ agencyId, interventionId, token, SeriesModel })) lost = true;
    }).catch(() => { lost = true; });
  }, intervalMs);
  timer.unref?.();
  return {
    assertOwned() {
      if (lost) throw createEvaluationError(EVALUATION_ERROR.LEASE_LOST, "Evaluation processing ownership was lost.", 409);
    },
    async stop() { stopped = true; clearInterval(timer); await renewal; },
  };
};

