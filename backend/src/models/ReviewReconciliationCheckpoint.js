import mongoose from "mongoose";
import { REVIEW_CHECKPOINT_LEASE_MS, REVIEW_CHECKPOINT_STREAMS } from "../domain/phase5Review.domain.js";

const lockSchema = new mongoose.Schema({
  token: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  acquired_at: { type: Date, required: true },
  heartbeat_at: { type: Date, required: true },
  expires_at: { type: Date, required: true },
}, { _id: false, strict: "throw" });

const checkpointSchema = new mongoose.Schema({
  _id: { type: String, required: true, maxlength: 180 },
  agency_id: { type: mongoose.Schema.Types.ObjectId, ref: "Agency", default: null, immutable: true },
  stream: { type: String, enum: REVIEW_CHECKPOINT_STREAMS, required: true, immutable: true },
  enabled_at: { type: Date, required: true, immutable: true },
  cursor_time: { type: Date, default: null },
  cursor_id: { type: mongoose.Schema.Types.ObjectId, default: null },
  cycle_started_at: { type: Date, default: null },
  last_attempt_at: { type: Date, default: null },
  last_completed_at: { type: Date, default: null },
  processed_count: { type: Number, min: 0, default: 0, required: true },
  failed_count: { type: Number, min: 0, default: 0, required: true },
  poison_count: { type: Number, min: 0, default: 0, required: true },
  poison_source_id: { type: String, default: null, maxlength: 128 },
  poison_attempts: { type: Number, min: 0, default: 0, required: true },
  poison_last_at: { type: Date, default: null },
  poison_error_code: { type: String, default: null, maxlength: 128 },
  processing_lock: { type: lockSchema, default: null, select: false },
  revision: { type: Number, min: 0, default: 0, required: true },
}, { timestamps: true, collection: "review_reconciliation_checkpoints", strict: "throw", autoIndex: false, autoCreate: false });

const operations = new Set(["acquire", "heartbeat", "advance", "poison", "complete", "release"]);
const mutationError = () => Object.assign(new Error("Review reconciliation checkpoint mutation requires a named fenced operation."), { code: "REVIEW_CHECKPOINT_MUTATION_REJECTED", status: 500 });
const approvedQueries = new WeakMap();
const allowedSetPaths = Object.freeze({
  acquire: new Set(["last_attempt_at", "processing_lock", "updatedAt"]),
  heartbeat: new Set(["cycle_started_at", "processing_lock.heartbeat_at", "processing_lock.expires_at", "updatedAt"]),
  advance: new Set(["cursor_time", "cursor_id", "poison_source_id", "poison_attempts", "poison_last_at", "poison_error_code", "updatedAt"]),
  poison: new Set(["poison_source_id", "poison_attempts", "poison_last_at", "poison_error_code", "cursor_time", "cursor_id", "updatedAt"]),
  complete: new Set(["cursor_time", "cursor_id", "cycle_started_at", "last_completed_at", "poison_source_id", "poison_attempts", "poison_last_at", "poison_error_code", "updatedAt"]),
  release: new Set(["processing_lock", "updatedAt"]),
});
const allowedInsertPaths = new Set(["_id", "agency_id", "stream", "enabled_at", "createdAt", "__v"]);
const validDate = (value) => value instanceof Date && Number.isFinite(value.getTime());
const exactKeys = (value, expected) => Object.keys(value || {}).sort().join(",") === [...expected].sort().join(",");
const validAcquireFilter = (filter, at) => {
  if (!exactKeys(filter, ["_id", "revision", "$or"]) || typeof filter._id !== "string" || !Array.isArray(filter.$or) || filter.$or.length !== 3) return false;
  const revision = filter.revision;
  if (!(Number.isSafeInteger(revision) && revision >= 0) && !(exactKeys(revision, ["$exists"]) && revision.$exists === false)) return false;
  return filter.$or.some((item) => exactKeys(item, ["processing_lock"]) && item.processing_lock === null) &&
    filter.$or.some((item) => exactKeys(item, ["processing_lock"]) && exactKeys(item.processing_lock, ["$exists"]) && item.processing_lock.$exists === false) &&
    filter.$or.some((item) => exactKeys(item, ["processing_lock.expires_at"]) && validDate(item["processing_lock.expires_at"]?.$lte) && item["processing_lock.expires_at"].$lte.getTime() === at.getTime());
};
const validAcquire = ({ filter, update, options }) => {
  const set = update.$set || {};
  const inserted = update.$setOnInsert || {};
  const lock = set.processing_lock;
  const at = set.last_attempt_at;
  if (!exactKeys(set, Object.hasOwn(set, "updatedAt") ? ["last_attempt_at", "processing_lock", "updatedAt"] : ["last_attempt_at", "processing_lock"]) ||
      !exactKeys(inserted, Object.keys(inserted).filter((path) => allowedInsertPaths.has(path))) ||
      !["_id", "agency_id", "stream", "enabled_at"].every((path) => Object.hasOwn(inserted, path)) ||
      !validDate(at) || !lock || !/^[a-f0-9]{64}$/.test(lock.token || "") ||
      !validDate(lock.acquired_at) || !validDate(lock.heartbeat_at) || !validDate(lock.expires_at) ||
      lock.acquired_at.getTime() !== at.getTime() || lock.heartbeat_at.getTime() !== at.getTime() ||
      lock.expires_at.getTime() !== at.getTime() + REVIEW_CHECKPOINT_LEASE_MS ||
      !validDate(inserted.enabled_at) || inserted.enabled_at.getTime() !== at.getTime() ||
      inserted._id !== filter._id || !REVIEW_CHECKPOINT_STREAMS.includes(inserted.stream)) return false;
  const expectedId = inserted.agency_id ? `agency:${inserted.agency_id}:${inserted.stream}` : `global:${inserted.stream}`;
  if (expectedId !== filter._id || !validAcquireFilter(filter, at)) return false;
  const inserting = filter.revision?.$exists === false;
  return options.upsert === inserting;
};
const exactLiveFilter = (filter) => {
  const paths = Object.keys(filter).sort();
  return paths.join(",") === ["_id", "processing_lock.expires_at", "processing_lock.token", "revision"].sort().join(",") &&
    Boolean(filter["processing_lock.expires_at"]?.$gt);
};
const validHeartbeat = ({ filter, update }) => {
  const set = update.$set || {};
  const heartbeatAt = set["processing_lock.heartbeat_at"];
  const expiresAt = set["processing_lock.expires_at"];
  const expected = ["processing_lock.heartbeat_at", "processing_lock.expires_at"];
  if (Object.hasOwn(set, "cycle_started_at")) expected.push("cycle_started_at");
  if (Object.hasOwn(set, "updatedAt")) expected.push("updatedAt");
  return exactKeys(set, expected) && exactKeys(update.$inc, ["revision"]) &&
    validDate(heartbeatAt) && validDate(expiresAt) &&
    expiresAt.getTime() === heartbeatAt.getTime() + REVIEW_CHECKPOINT_LEASE_MS &&
    filter["processing_lock.expires_at"].$gt.getTime() === heartbeatAt.getTime() &&
    (!Object.hasOwn(set, "cycle_started_at") || validDate(set.cycle_started_at) && set.cycle_started_at.getTime() === heartbeatAt.getTime());
};
const validRelease = (update) => {
  const set = update.$set || {};
  const expected = ["processing_lock"];
  if (Object.hasOwn(set, "updatedAt")) expected.push("updatedAt");
  return exactKeys(set, expected) && set.processing_lock === null && exactKeys(update.$inc, ["revision"]);
};
checkpointSchema.pre(["updateOne", "findOneAndUpdate", "updateMany", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"], function guard() {
  const operation = approvedQueries.get(this);
  approvedQueries.delete(this);
  if (!operations.has(operation) || !["updateOne", "findOneAndUpdate"].includes(this.op)) throw mutationError();
  const update = this.getUpdate?.() || {};
  if (Array.isArray(update) || (!update.$set && !update.$setOnInsert)) throw mutationError();
  if (Object.keys(update).some((key) => !["$set", "$setOnInsert", "$inc"].includes(key))) throw mutationError();
  if (Object.keys(update.$set || {}).some((path) => !allowedSetPaths[operation].has(path))) throw mutationError();
  if (Object.keys(update.$setOnInsert || {}).some((path) => !allowedInsertPaths.has(path))) throw mutationError();
  if (update.$inc?.revision !== 1 || Object.keys(update.$inc || {}).some((path) => !["revision", "processed_count", "failed_count", "poison_count"].includes(path))) throw mutationError();
  if (operation === "acquire" && (this.op !== "findOneAndUpdate" || !validAcquire({ filter: this.getFilter?.() || {}, update, options: this.getOptions?.() || {} }))) throw mutationError();
  if (operation !== "acquire" && (
    this.getOptions?.().upsert === true ||
    Object.keys(update.$setOnInsert || {}).some((path) => !["createdAt", "__v"].includes(path))
  )) throw mutationError();
  if (["heartbeat", "advance", "poison", "complete", "release"].includes(operation)) {
    const filter = this.getFilter?.() || {};
    if (!exactLiveFilter(filter) || !filter["processing_lock.token"] || !Number.isSafeInteger(filter.revision)) throw mutationError();
    if (operation === "heartbeat" && !validHeartbeat({ filter, update })) throw mutationError();
    if (operation === "release" && !validRelease(update)) throw mutationError();
  }
  this.setOptions({ runValidators: true, context: "query", strict: "throw" });
});
checkpointSchema.pre("bulkWrite", function rejectBulk() { throw mutationError(); });
checkpointSchema.pre("deleteOne", { document: true, query: false }, function rejectDelete() { throw mutationError(); });
checkpointSchema.pre("save", function rejectExisting() { if (!this.isNew) throw mutationError(); });
checkpointSchema.statics.applyApprovedOperation = function applyApprovedOperation(operation, filter, update, options = {}) {
  const query = this.findOneAndUpdate(filter, update, options);
  approvedQueries.set(query, operation);
  return query;
};
checkpointSchema.index({ "processing_lock.expires_at": 1 }, { name: "phase5_review_checkpoint_lease", partialFilterExpression: { "processing_lock.expires_at": { $type: "date" } } });

export const ReviewReconciliationCheckpoint = mongoose.models.ReviewReconciliationCheckpoint || mongoose.model("ReviewReconciliationCheckpoint", checkpointSchema);
export default ReviewReconciliationCheckpoint;
