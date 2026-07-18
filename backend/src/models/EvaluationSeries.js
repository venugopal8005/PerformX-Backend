import mongoose from "mongoose";

const processingLockSchema = new mongoose.Schema(
  {
    operation: { type: String, required: true, enum: ["intervention_recorded", "report_run", "manual_refresh", "reconciliation", "correction", "cancellation", "rule_upgrade"] },
    token: { type: String, required: true, maxlength: 64 },
    acquired_at: { type: Date, required: true },
    heartbeat_at: { type: Date, required: true },
    expires_at: { type: Date, required: true },
  },
  { _id: false, strict: "throw" }
);

const evaluationSeriesSchema = new mongoose.Schema(
  {
    agency_id: { type: mongoose.Schema.Types.ObjectId, ref: "Agency", required: true, immutable: true },
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, immutable: true },
    issue_id: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true, immutable: true },
    intervention_id: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", required: true, immutable: true },
    current_evaluation_id: { type: mongoose.Schema.Types.ObjectId, ref: "Evaluation", default: null },
    next_sequence: { type: Number, min: 1, required: true, default: 1 },
    revision: { type: Number, min: 0, required: true, default: 0 },
    processing_lock: { type: processingLockSchema, default: null, select: false },
    last_manual_refresh_bucket: { type: Date, default: null },
    last_manual_refresh_key: { type: String, default: null, maxlength: 128 },
    last_manual_refresh_hash: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
    last_processed_report_run_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReportRun", default: null },
  },
  {
    timestamps: true,
    collection: "evaluation_series",
    strict: "throw",
    optimisticConcurrency: true,
    autoIndex: false,
    autoCreate: false,
  }
);

const allowedOperations = new Set(["acquire", "heartbeat", "release", "advance"]);
const exactKeys = (actual, expected) => actual.length === expected.length && actual.every((key) => expected.includes(key));
const keysWithin = (actual, allowed) => actual.every((key) => allowed.includes(key));
const validTimestamp = (value) => value instanceof Date && Number.isFinite(value.getTime());
const validTimestampUpdate = (update) => {
  const setKeys = Object.keys(update.$set || {});
  const setOnInsertKeys = Object.keys(update.$setOnInsert || {});
  return (!setKeys.includes("updatedAt") || validTimestamp(update.$set.updatedAt)) &&
    (!setOnInsertKeys.includes("createdAt") || validTimestamp(update.$setOnInsert.createdAt)) &&
    keysWithin(setOnInsertKeys, ["createdAt"]);
};
const validIdentity = (value) => mongoose.isObjectIdOrHexString(value);
const validProcessingLock = (lock) =>
  lock &&
  ["intervention_recorded", "report_run", "manual_refresh", "reconciliation", "correction", "cancellation", "rule_upgrade"].includes(lock.operation) &&
  /^[a-f0-9]{64}$/.test(lock.token || "") &&
  validTimestamp(lock.acquired_at) &&
  validTimestamp(lock.heartbeat_at) &&
  validTimestamp(lock.expires_at) &&
  lock.expires_at > lock.acquired_at;
const validAvailableLockFilter = (filter) => {
  if (!filter || !exactKeys(Object.keys(filter), ["$or"]) || !Array.isArray(filter.$or) || filter.$or.length !== 3) return false;
  return filter.$or.some((item) => item.processing_lock === null) &&
    filter.$or.some((item) => item.processing_lock?.$exists === false) &&
    filter.$or.some((item) => validTimestamp(item["processing_lock.expires_at"]?.$lte));
};
const queryMutationError = () => {
  const error = new Error("EvaluationSeries mutation requires an approved fenced operation.");
  error.code = "EVALUATION_SERIES_QUERY_MUTATION_REJECTED";
  error.status = 500;
  return error;
};
const validExpiryPredicate = (value) => value && value.$gt instanceof Date && Number.isFinite(value.$gt.getTime());

evaluationSeriesSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"], function guardMutation() {
  const operation = this.getOptions?.().phase4SeriesOperation;
  if (this.options) delete this.options.phase4SeriesOperation;
  if (!allowedOperations.has(operation) || ["updateMany", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"].includes(this.op)) {
    throw queryMutationError();
  }

  const filter = this.getFilter?.() || {};
  const update = this.getUpdate?.() || {};
  if (Array.isArray(update)) throw queryMutationError();
  const operators = Object.keys(update);
  const expectedOperators = update.$setOnInsert ? ["$set", "$setOnInsert"] : ["$set"];
  if (!validTimestampUpdate(update)) throw queryMutationError();
  if (operation === "acquire") {
    const [ownership, availability] = Array.isArray(filter.$and) ? filter.$and : [];
    if (
      this.op !== "findOneAndUpdate" ||
      !exactKeys(operators, expectedOperators) ||
      !exactKeys(Object.keys(update.$set || {}).filter((key) => key !== "updatedAt"), ["processing_lock"]) ||
      !exactKeys(Object.keys(ownership || {}), ["agency_id", "intervention_id"]) ||
      !validIdentity(ownership.agency_id) ||
      !validIdentity(ownership.intervention_id) ||
      !validAvailableLockFilter(availability) ||
      !validProcessingLock(update.$set.processing_lock)
    ) throw queryMutationError();
    return;
  }
  if (operation === "heartbeat") {
    const allowedFilterKeys = ["agency_id", "intervention_id", "revision", "processing_lock.token", "processing_lock.expires_at"];
    if (
      this.op !== "findOneAndUpdate" ||
      !keysWithin(Object.keys(filter), allowedFilterKeys) ||
      !filter.agency_id ||
      !filter.intervention_id ||
      !filter["processing_lock.token"] ||
      !validExpiryPredicate(filter["processing_lock.expires_at"]) ||
      !exactKeys(operators, expectedOperators) ||
      !exactKeys(Object.keys(update.$set || {}).filter((key) => key !== "updatedAt"), ["processing_lock.heartbeat_at", "processing_lock.expires_at"])
    ) throw queryMutationError();
    return;
  }
  if (operation === "release") {
    if (
      this.op !== "updateOne" ||
      !exactKeys(Object.keys(filter), ["agency_id", "intervention_id", "processing_lock.token"]) ||
      !exactKeys(operators, expectedOperators) ||
      !exactKeys(Object.keys(update.$set || {}).filter((key) => key !== "updatedAt"), ["processing_lock"]) ||
      update.$set.processing_lock !== null
    ) throw queryMutationError();
    return;
  }
  if (operation === "advance") {
    const allowedFilterKeys = ["_id", "agency_id", "intervention_id", "revision", "current_evaluation_id", "processing_lock.token", "processing_lock.expires_at"];
    const allowedSetKeys = ["current_evaluation_id", "last_manual_refresh_bucket", "last_manual_refresh_key", "last_manual_refresh_hash", "last_processed_report_run_id"];
    const increments = update.$inc || {};
    if (
      this.op !== "findOneAndUpdate" ||
      !this.getOptions?.().session ||
      !keysWithin(Object.keys(filter), allowedFilterKeys) ||
      !filter._id ||
      !filter.agency_id ||
      !filter.intervention_id ||
      !Number.isSafeInteger(filter.revision) ||
      !filter["processing_lock.token"] ||
      !validExpiryPredicate(filter["processing_lock.expires_at"]) ||
      !exactKeys(operators, update.$setOnInsert ? ["$set", "$setOnInsert", "$inc"] : ["$set", "$inc"]) ||
      !keysWithin(Object.keys(update.$set || {}).filter((key) => key !== "updatedAt"), allowedSetKeys) ||
      !keysWithin(Object.keys(increments), ["revision", "next_sequence"]) ||
      increments.revision !== 1 ||
      (Object.hasOwn(increments, "next_sequence") && increments.next_sequence !== 1)
    ) throw queryMutationError();
  }
});
evaluationSeriesSchema.pre("bulkWrite", function rejectBulkMutation() {
  throw queryMutationError();
});
evaluationSeriesSchema.pre("deleteOne", { document: true, query: false }, function rejectDocumentDeletion() {
  throw queryMutationError();
});
evaluationSeriesSchema.pre("save", function rejectExistingMutation() {
  if (!this.isNew && this.isModified()) {
    const error = new Error("Existing EvaluationSeries documents cannot be mutated with save().");
    error.code = "EVALUATION_SERIES_QUERY_MUTATION_REJECTED";
    throw error;
  }
});

evaluationSeriesSchema.index({ agency_id: 1, intervention_id: 1 }, { name: "phase4_evaluation_series_intervention_unique", unique: true });
evaluationSeriesSchema.index({ agency_id: 1, current_evaluation_id: 1 }, { name: "phase4_evaluation_series_current_lookup", partialFilterExpression: { current_evaluation_id: { $type: "objectId" } } });
evaluationSeriesSchema.index({ "processing_lock.expires_at": 1 }, { name: "phase4_evaluation_series_lease_expiry", partialFilterExpression: { "processing_lock.expires_at": { $type: "date" } } });

export const EvaluationSeries = mongoose.models.EvaluationSeries || mongoose.model("EvaluationSeries", evaluationSeriesSchema);
export default EvaluationSeries;
