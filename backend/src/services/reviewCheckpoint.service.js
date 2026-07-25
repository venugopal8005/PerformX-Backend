import crypto from "node:crypto";
import { ReviewReconciliationCheckpoint } from "../models/index.js";
import { REVIEW_CHECKPOINT_LEASE_MS, REVIEW_CHECKPOINT_STREAMS, REVIEW_ERROR, createReviewError } from "../domain/phase5Review.domain.js";

export const REVIEW_LEASE_MS = REVIEW_CHECKPOINT_LEASE_MS;
export const REVIEW_HEARTBEAT_MS = 60 * 1000;
const checkpointId = (agencyId, stream) => `${agencyId ? `agency:${agencyId}` : "global"}:${stream}`;
const validStream = (stream) => {
  if (!REVIEW_CHECKPOINT_STREAMS.includes(stream)) throw createReviewError(REVIEW_ERROR.VALIDATION, "Review reconciliation stream is invalid.");
};
const liveFilter = (lease, now) => ({ _id: lease.id, revision: lease.revision, "processing_lock.token": lease.token, "processing_lock.expires_at": { $gt: now } });

export const acquireReviewCheckpoint = async ({ agencyId = null, stream, now = new Date(), CheckpointModel = ReviewReconciliationCheckpoint } = {}) => {
  validStream(stream);
  const id = checkpointId(agencyId, stream);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + REVIEW_LEASE_MS);
  try {
    const current = await CheckpointModel.findById(id).select("revision").lean();
    const revision = current ? current.revision : { $exists: false };
    const checkpoint = await CheckpointModel.applyApprovedOperation(
      "acquire",
      { _id: id, revision, $or: [{ processing_lock: null }, { processing_lock: { $exists: false } }, { "processing_lock.expires_at": { $lte: now } }] },
      { $setOnInsert: { _id: id, agency_id: agencyId, stream, enabled_at: now }, $set: { last_attempt_at: now, processing_lock: { token, acquired_at: now, heartbeat_at: now, expires_at: expiresAt } }, $inc: { revision: 1 } },
      { upsert: !current, new: true, setDefaultsOnInsert: true }
    ).select("+processing_lock");
    if (!checkpoint || checkpoint.processing_lock?.token !== token) return null;
    const lease = { id, token, revision: checkpoint.revision, checkpoint };
    if (!checkpoint.cycle_started_at) await mutate({ lease, operation: "heartbeat", now, CheckpointModel, set: { cycle_started_at: now, "processing_lock.heartbeat_at": now, "processing_lock.expires_at": expiresAt } });
    return lease;
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
};

const mutate = async ({ lease, operation, set = {}, inc = {}, now = new Date(), CheckpointModel = ReviewReconciliationCheckpoint }) => {
  const checkpoint = await CheckpointModel.applyApprovedOperation(operation, liveFilter(lease, now), { $set: set, ...(Object.keys(inc).length ? { $inc: { ...inc, revision: 1 } } : { $inc: { revision: 1 } }) }, { new: true }).select("+processing_lock");
  if (!checkpoint) throw createReviewError("REVIEW_RECONCILIATION_LEASE_LOST", "Review reconciliation lease was lost.", 409);
  lease.revision = checkpoint.revision;
  lease.checkpoint = checkpoint;
  return checkpoint;
};
export const heartbeatReviewCheckpoint = ({ lease, clock = () => new Date(), CheckpointModel }) => {
  const now = clock();
  return mutate({ lease, operation: "heartbeat", now, CheckpointModel, set: { "processing_lock.heartbeat_at": now, "processing_lock.expires_at": new Date(now.getTime() + REVIEW_LEASE_MS) } });
};
export const advanceReviewCheckpoint = ({ lease, cursorTime, cursorId, now = new Date(), processed = 1, CheckpointModel }) => mutate({ lease, operation: "advance", now, CheckpointModel, set: { cursor_time: cursorTime, cursor_id: cursorId, poison_source_id: null, poison_attempts: 0, poison_last_at: null, poison_error_code: null }, inc: { processed_count: processed } });
export const markReviewCheckpointPoison = ({ lease, sourceId, code, attempts, now = new Date(), advance = false, cursorTime = null, cursorId = null, CheckpointModel }) => mutate({ lease, operation: "poison", now, CheckpointModel, set: { poison_source_id: String(sourceId), poison_attempts: attempts, poison_last_at: now, poison_error_code: String(code || "REVIEW_RECONCILIATION_ITEM_FAILED").slice(0, 128), ...(advance ? { cursor_time: cursorTime, cursor_id: cursorId } : {}) }, inc: { failed_count: 1, ...(advance ? { poison_count: 1 } : {}) } });
export const completeReviewCheckpoint = ({ lease, now = new Date(), CheckpointModel }) => mutate({ lease, operation: "complete", now, CheckpointModel, set: { cursor_time: null, cursor_id: null, cycle_started_at: null, last_completed_at: now, poison_source_id: null, poison_attempts: 0, poison_last_at: null, poison_error_code: null } });
export const releaseReviewCheckpoint = async ({ lease, clock = () => new Date(), CheckpointModel = ReviewReconciliationCheckpoint } = {}) => {
  if (!lease) return false;
  try {
    const now = clock();
    await mutate({ lease, operation: "release", now, CheckpointModel, set: { processing_lock: null } });
    return true;
  } catch (error) { if (error?.code === "REVIEW_RECONCILIATION_LEASE_LOST") return false; throw error; }
};
export const reviewCheckpointInternals = { checkpointId, liveFilter };
