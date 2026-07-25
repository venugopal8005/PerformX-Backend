import mongoose from "mongoose";
import {
  REVIEW_ACTIVE_STATES, REVIEW_CLOSE_REASONS, REVIEW_ITEM_TYPES, REVIEW_PRIORITIES,
  REVIEW_PRIORITY_RANK, REVIEW_REASONS, REVIEW_STATES,
} from "../domain/phase5Review.domain.js";
import { reviewActorSnapshotSchema, reviewContextSnapshotSchema } from "./schemas/reviewSnapshots.schema.js";

const reviewItemSchema = new mongoose.Schema({
  agency_id: { type: mongoose.Schema.Types.ObjectId, ref: "Agency", required: true, immutable: true },
  client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, immutable: true },
  issue_id: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true, immutable: true },
  meta_ad_account_id: { type: mongoose.Schema.Types.ObjectId, ref: "MetaAdAccount", required: true, immutable: true },
  meta_binding_revision_snapshot: { type: Number, min: 0, required: true, immutable: true },
  campaign_id: { type: String, required: true, maxlength: 256, immutable: true },
  report_id: { type: mongoose.Schema.Types.ObjectId, ref: "Report", default: null },
  report_run_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReportRun", default: null },
  signal_id: { type: mongoose.Schema.Types.ObjectId, ref: "Signal", default: null },
  intervention_id: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", default: null },
  evaluation_series_id: { type: mongoose.Schema.Types.ObjectId, ref: "EvaluationSeries", default: null, immutable: true },
  evaluation_id: { type: mongoose.Schema.Types.ObjectId, ref: "Evaluation", default: null },
  previous_review_item_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewItem", default: null, immutable: true },
  type: { type: String, enum: REVIEW_ITEM_TYPES, required: true, immutable: true },
  generation: { type: Number, min: 1, required: true, immutable: true },
  active_key: { type: String, default: null, maxlength: 160 },
  reason: { type: String, enum: REVIEW_REASONS, required: true },
  state: { type: String, enum: REVIEW_STATES, required: true },
  priority: { type: String, enum: REVIEW_PRIORITIES, required: true },
  priority_rank: { type: Number, enum: Object.values(REVIEW_PRIORITY_RANK), required: true },
  priority_source: { type: String, required: true, maxlength: 128 },
  source_revision: { type: Number, min: 0, required: true },
  last_projected_event_key: { type: String, required: true, maxlength: 512 },
  last_projected_event_hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  opened_at: { type: Date, required: true, immutable: true },
  latest_evidence_at: { type: Date, required: true },
  acknowledged_at: { type: Date, default: null },
  acknowledged_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  acknowledged_by_snapshot: { type: reviewActorSnapshotSchema, default: null },
  snoozed_at: { type: Date, default: null },
  snoozed_until: { type: Date, default: null },
  snoozed_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  snoozed_by_snapshot: { type: reviewActorSnapshotSchema, default: null },
  snooze_note: { type: String, default: null, maxlength: 1000 },
  reviewed_at: { type: Date, default: null },
  reviewed_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewed_by_snapshot: { type: reviewActorSnapshotSchema, default: null },
  closed_at: { type: Date, default: null },
  close_reason: { type: String, enum: [...REVIEW_CLOSE_REASONS, null], default: null },
  action_sequence: { type: Number, min: 0, required: true, default: 0 },
  revision: { type: Number, min: 0, required: true, default: 0 },
  context_snapshot: { type: reviewContextSnapshotSchema, required: true, immutable: true },
}, {
  timestamps: true, collection: "review_items", strict: "throw", optimisticConcurrency: true,
  autoIndex: false, autoCreate: false,
});

const error = () => Object.assign(new Error("ReviewItem mutation requires an approved CAS operation."), { code: "REVIEW_ITEM_MUTATION_REJECTED", status: 500 });
const approvedQueries = new WeakMap();
const approved = new Set(["source_refresh", "acknowledge", "snooze", "human_review", "system_reopen", "system_close", "system_supersede"]);
const terminal = new Set(["reviewed", "closed", "superseded"]);
const commonSetPaths = ["state", "active_key", "last_projected_event_key", "last_projected_event_hash", "updatedAt"];
const allowedSetPaths = Object.freeze({
  source_refresh: new Set([...commonSetPaths, "priority", "priority_rank", "priority_source", "source_revision", "signal_id", "report_id", "report_run_id", "latest_evidence_at"]),
  acknowledge: new Set([...commonSetPaths, "acknowledged_at", "acknowledged_by_user_id", "acknowledged_by_snapshot"]),
  snooze: new Set([...commonSetPaths, "acknowledged_at", "acknowledged_by_user_id", "acknowledged_by_snapshot", "snoozed_at", "snoozed_until", "snoozed_by_user_id", "snoozed_by_snapshot", "snooze_note"]),
  human_review: new Set([...commonSetPaths, "acknowledged_at", "acknowledged_by_user_id", "acknowledged_by_snapshot", "snoozed_at", "snoozed_until", "snoozed_by_user_id", "snoozed_by_snapshot", "snooze_note", "reviewed_at", "reviewed_by_user_id", "reviewed_by_snapshot", "closed_at", "close_reason", "intervention_id"]),
  system_reopen: new Set([...commonSetPaths, "reason", "priority", "priority_rank", "priority_source", "source_revision", "signal_id", "report_id", "report_run_id", "latest_evidence_at", "acknowledged_at", "acknowledged_by_user_id", "acknowledged_by_snapshot", "snoozed_at", "snoozed_until", "snoozed_by_user_id", "snoozed_by_snapshot", "snooze_note", "reviewed_at", "reviewed_by_user_id", "reviewed_by_snapshot", "closed_at", "close_reason"]),
  system_close: new Set([...commonSetPaths, "acknowledged_at", "acknowledged_by_user_id", "acknowledged_by_snapshot", "snoozed_at", "snoozed_until", "snoozed_by_user_id", "snoozed_by_snapshot", "snooze_note", "reviewed_at", "reviewed_by_user_id", "reviewed_by_snapshot", "closed_at", "close_reason"]),
  system_supersede: new Set([...commonSetPaths, "acknowledged_at", "acknowledged_by_user_id", "acknowledged_by_snapshot", "snoozed_at", "snoozed_until", "snoozed_by_user_id", "snoozed_by_snapshot", "snooze_note", "reviewed_at", "reviewed_by_user_id", "reviewed_by_snapshot", "closed_at", "close_reason"]),
});
const validDate = (value) => value instanceof Date && Number.isFinite(value.getTime());
const validObjectId = (value) => mongoose.isObjectIdOrHexString(value);
const validNullableObjectId = (value) => value === null || validObjectId(value);
const validBoundedString = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const isNull = (value) => value === null;
const exactActiveKey = ({ type, issueId, evaluationSeriesId }) => type === "issue_review"
  ? `issue_review:${issueId}`
  : `evaluation_review:${evaluationSeriesId}`;
const identityFields = ["_id", "active_key", "agency_id", "client_id", "evaluation_series_id", "generation", "issue_id", "revision", "source_revision", "state", "type"];
const completeActor = (set, prefix) => validDate(set[`${prefix}_at`]) && Boolean(set[`${prefix}_by_user_id`]) && Boolean(set[`${prefix}_by_snapshot`]);
const cleared = (set, fields) => fields.every((field) => isNull(set[field]));
const acknowledgementFields = ["acknowledged_at", "acknowledged_by_user_id", "acknowledged_by_snapshot"];
const snoozeFields = ["snoozed_at", "snoozed_until", "snoozed_by_user_id", "snoozed_by_snapshot", "snooze_note"];
const reviewFields = ["reviewed_at", "reviewed_by_user_id", "reviewed_by_snapshot"];
const closureFields = ["closed_at", "close_reason"];
const commonRequired = ["state", "active_key", "last_projected_event_key", "last_projected_event_hash", "updatedAt"];
const requiredSetPaths = Object.freeze({
  source_refresh: [...commonRequired, "priority", "priority_rank", "priority_source", "source_revision", "signal_id", "report_id", "report_run_id", "latest_evidence_at"],
  acknowledge: [...commonRequired, ...acknowledgementFields],
  snooze: [...commonRequired, ...acknowledgementFields, ...snoozeFields],
  human_review: [...commonRequired, ...acknowledgementFields, ...snoozeFields, ...reviewFields, ...closureFields],
  system_reopen: [...commonRequired, ...acknowledgementFields, ...snoozeFields, ...reviewFields, ...closureFields],
  system_close: [...commonRequired, ...acknowledgementFields, ...snoozeFields, ...reviewFields, ...closureFields],
  system_supersede: [...commonRequired, ...acknowledgementFields, ...snoozeFields, ...reviewFields, ...closureFields],
});
const hasRequiredPaths = (set, operation) => requiredSetPaths[operation].every((path) => Object.hasOwn(set, path));
const validActorSnapshot = (value) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === ["captured_at", "display_name", "provenance", "version", "workspace_role"].sort().join(",") &&
  value.version === 1 && validDate(value.captured_at) && validBoundedString(value.display_name, 256) &&
  ["owner", "member"].includes(value.workspace_role) && value.provenance === "workspace_member";
const validActor = (set, prefix) => completeActor(set, prefix) && validObjectId(set[`${prefix}_by_user_id`]) && validActorSnapshot(set[`${prefix}_by_snapshot`]);
const validSourceValues = (set, filter) => REVIEW_PRIORITIES.includes(set.priority) &&
  set.priority_rank === REVIEW_PRIORITY_RANK[set.priority] && validBoundedString(set.priority_source, 128) &&
  Number.isSafeInteger(set.source_revision) && set.source_revision >= filter.source_revision &&
  validNullableObjectId(set.signal_id) && validNullableObjectId(set.report_id) && validNullableObjectId(set.report_run_id) &&
  validDate(set.latest_evidence_at);
const hasExactFilter = (filter) => Object.keys(filter).sort().join(",") === identityFields.slice().sort().join(",") &&
  validObjectId(filter._id) && validObjectId(filter.agency_id) && validObjectId(filter.client_id) && validObjectId(filter.issue_id) && validBoundedString(filter.active_key, 160) &&
  ["issue_review", "evaluation_review"].includes(filter.type) && Number.isSafeInteger(filter.generation) && filter.generation >= 1 &&
  (filter.type === "issue_review" ? filter.evaluation_series_id === null : validObjectId(filter.evaluation_series_id)) &&
  Number.isSafeInteger(filter.source_revision) && filter.source_revision >= 0 && Number.isSafeInteger(filter.revision) && filter.revision >= 0 &&
  typeof filter.state === "string" && REVIEW_ACTIVE_STATES.includes(filter.state);
const validOperationSemantics = ({ operation, filter, set, inc }) => {
  const activeKey = exactActiveKey({ type: filter.type, issueId: filter.issue_id, evaluationSeriesId: filter.evaluation_series_id });
  if (filter.active_key !== activeKey) return false;
  if (!hasRequiredPaths(set, operation) || !validDate(set.updatedAt) || !validBoundedString(set.last_projected_event_key, 512) || !/^[a-f0-9]{64}$/.test(set.last_projected_event_hash || "")) return false;
  if (operation === "source_refresh") return set.state === filter.state && set.active_key === filter.active_key && inc.action_sequence == null && validSourceValues(set, filter);
  if (inc.action_sequence !== 1) return false;
  if (operation === "acknowledge") return filter.state === "open" && set.state === "acknowledged" && set.active_key === filter.active_key && validActor(set, "acknowledged");
  if (operation === "snooze") return REVIEW_ACTIVE_STATES.includes(filter.state) && set.state === "snoozed" && set.active_key === filter.active_key && validActor(set, "snoozed") && validDate(set.snoozed_until) && set.snoozed_until > set.snoozed_at && set.snoozed_until.getTime() - set.snoozed_at.getTime() <= 30 * 24 * 60 * 60 * 1000 && (set.snooze_note === null || typeof set.snooze_note === "string" && set.snooze_note.length <= 1000) && cleared(set, acknowledgementFields);
  if (operation === "human_review") return REVIEW_ACTIVE_STATES.includes(filter.state) && set.state === "reviewed" && set.active_key === null && validActor(set, "reviewed") && (!Object.hasOwn(set, "intervention_id") || validNullableObjectId(set.intervention_id)) && cleared(set, [...acknowledgementFields, ...snoozeFields, ...closureFields]);
  if (operation === "system_reopen") {
    const sourceFields = ["reason", "priority", "priority_rank", "priority_source", "source_revision", "signal_id", "report_id", "report_run_id", "latest_evidence_at"];
    const present = sourceFields.filter((path) => Object.hasOwn(set, path)).length;
    const sourceIsValid = present === 0 || present === sourceFields.length && REVIEW_REASONS.includes(set.reason) && validSourceValues(set, filter);
    return ["acknowledged", "snoozed"].includes(filter.state) && set.state === "open" && set.active_key === filter.active_key && sourceIsValid && cleared(set, [...acknowledgementFields, ...snoozeFields, ...reviewFields, ...closureFields]);
  }
  if (operation === "system_close") return REVIEW_ACTIVE_STATES.includes(filter.state) && set.state === "closed" && set.active_key === null && validDate(set.closed_at) && REVIEW_CLOSE_REASONS.includes(set.close_reason) && set.close_reason !== "evaluation_superseded" && cleared(set, [...acknowledgementFields, ...snoozeFields, ...reviewFields]);
  return operation === "system_supersede" && filter.type === "evaluation_review" && REVIEW_ACTIVE_STATES.includes(filter.state) && set.state === "superseded" && set.active_key === null && validDate(set.closed_at) && set.close_reason === "evaluation_superseded" && cleared(set, [...acknowledgementFields, ...snoozeFields, ...reviewFields]);
};

reviewItemSchema.pre(["updateOne", "findOneAndUpdate", "updateMany", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"], function guard() {
  const operation = approvedQueries.get(this);
  approvedQueries.delete(this);
  if (!approved.has(operation) || this.op !== "findOneAndUpdate") throw error();
  const filter = this.getFilter?.() || {};
  const update = this.getUpdate?.() || {};
  if (Array.isArray(update) || !this.getOptions?.().session) throw error();
  if (!hasExactFilter(filter)) throw error();
  if (this.getOptions?.().upsert === true || Object.keys(update).some((key) => !["$set", "$setOnInsert", "$inc"].includes(key))) throw error();
  if (Object.keys(update.$set || {}).some((path) => !allowedSetPaths[operation].has(path))) throw error();
  if (Object.keys(update.$setOnInsert || {}).some((path) => !["createdAt", "__v"].includes(path))) throw error();
  if (!update.$inc || update.$inc.revision !== 1 || !update.$set) throw error();
  if (Object.keys(update.$inc).some((path) => !["revision", "action_sequence"].includes(path)) || (update.$inc.action_sequence != null && update.$inc.action_sequence !== 1)) throw error();
  if (!validOperationSemantics({ operation, filter, set: update.$set, inc: update.$inc })) throw error();
  this.setOptions({ runValidators: true, context: "query", strict: "throw" });
});
reviewItemSchema.pre("bulkWrite", function rejectBulk() { throw error(); });
reviewItemSchema.pre("deleteOne", { document: true, query: false }, function rejectDelete() { throw error(); });
reviewItemSchema.pre("save", function rejectExisting() { if (!this.isNew) throw error(); });
reviewItemSchema.statics.applyApprovedOperation = function applyApprovedOperation(operation, filter, update, options = {}) {
  const query = this.findOneAndUpdate(filter, update, options);
  approvedQueries.set(query, operation);
  return query;
};
reviewItemSchema.pre("validate", function validateState() {
  const expectedActiveKey = exactActiveKey({ type: this.type, issueId: this.issue_id, evaluationSeriesId: this.evaluation_series_id });
  if (REVIEW_ACTIVE_STATES.includes(this.state) && this.active_key !== expectedActiveKey) this.invalidate("active_key", "Active ReviewItems require active_key to match their exact source identity.");
  if (terminal.has(this.state) && this.active_key !== null) this.invalidate("active_key", "Terminal ReviewItems cannot retain active_key.");
  if (this.priority_rank !== REVIEW_PRIORITY_RANK[this.priority]) this.invalidate("priority_rank", "Priority rank does not match priority.");
  if (this.type === "issue_review" && (this.evaluation_series_id || this.evaluation_id)) this.invalidate("type", "Issue reviews cannot contain Evaluation identity.");
  if (this.type === "evaluation_review" && (!this.evaluation_series_id || !this.evaluation_id)) this.invalidate("evaluation_id", "Evaluation reviews require Evaluation identity.");
  const allNull = (fields) => fields.every((field) => this[field] == null);
  const allPresent = (fields) => fields.every((field) => this[field] != null);
  if (this.state === "open" && !allNull([...acknowledgementFields, ...snoozeFields, ...reviewFields, ...closureFields])) this.invalidate("state", "Open ReviewItems cannot contain lifecycle evidence.");
  if (this.state === "acknowledged" && (!allPresent(acknowledgementFields) || !allNull([...snoozeFields, ...reviewFields, ...closureFields]))) this.invalidate("state", "Acknowledged ReviewItems require only complete acknowledgement evidence.");
  if (this.state === "snoozed" && (!allPresent(snoozeFields.slice(0, 4)) || !allNull([...acknowledgementFields, ...reviewFields, ...closureFields]) || this.snoozed_until <= this.snoozed_at || this.snoozed_until.getTime() - this.snoozed_at.getTime() > 30 * 24 * 60 * 60 * 1000)) this.invalidate("state", "Snoozed ReviewItems require consistent bounded snooze evidence.");
  if (this.state === "reviewed" && (!allPresent(reviewFields) || !allNull([...acknowledgementFields, ...snoozeFields, ...closureFields]))) this.invalidate("state", "Reviewed ReviewItems require only complete review evidence.");
  if (this.state === "closed" && (!allPresent(closureFields) || !allNull([...acknowledgementFields, ...snoozeFields, ...reviewFields]) || this.close_reason === "evaluation_superseded")) this.invalidate("state", "Closed ReviewItems require consistent closure evidence.");
  if (this.state === "superseded" && (this.type !== "evaluation_review" || !allPresent(closureFields) || this.close_reason !== "evaluation_superseded" || !allNull([...acknowledgementFields, ...snoozeFields, ...reviewFields]))) this.invalidate("state", "Superseded ReviewItems require Evaluation supersession evidence.");
});

reviewItemSchema.index({ agency_id: 1, active_key: 1 }, { name: "phase5_review_active_identity_unique", unique: true, partialFilterExpression: { active_key: { $type: "string" } } });
reviewItemSchema.index({ agency_id: 1, issue_id: 1, generation: 1 }, { name: "phase5_review_issue_generation_unique", unique: true, partialFilterExpression: { type: "issue_review" } });
reviewItemSchema.index({ agency_id: 1, evaluation_series_id: 1, generation: 1 }, { name: "phase5_review_evaluation_generation_unique", unique: true, partialFilterExpression: { type: "evaluation_review" } });
reviewItemSchema.index({ agency_id: 1, state: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, { name: "phase5_review_workspace_queue" });
reviewItemSchema.index({ agency_id: 1, state: 1, type: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, { name: "phase5_review_workspace_type_queue" });
reviewItemSchema.index({ agency_id: 1, client_id: 1, state: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, { name: "phase5_review_client_queue" });
reviewItemSchema.index({ agency_id: 1, campaign_id: 1, state: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, { name: "phase5_review_campaign_queue" });
reviewItemSchema.index({ agency_id: 1, state: 1, _id: 1 }, { name: "phase5_review_authority_scan" });
reviewItemSchema.index({ agency_id: 1, evaluation_id: 1 }, { name: "phase5_review_evaluation_lookup", partialFilterExpression: { evaluation_id: { $type: "objectId" } } });
reviewItemSchema.index({ state: 1, snoozed_until: 1, _id: 1 }, { name: "phase5_review_snooze_expiry", partialFilterExpression: { state: "snoozed", snoozed_until: { $type: "date" } } });
reviewItemSchema.index({ agency_id: 1, createdAt: 1, _id: 1 }, { name: "phase5_review_workspace_summary_candidates", partialFilterExpression: { state: { $in: REVIEW_ACTIVE_STATES } } });
reviewItemSchema.index({ agency_id: 1, client_id: 1, createdAt: 1, _id: 1 }, { name: "phase5_review_client_summary_candidates", partialFilterExpression: { state: { $in: REVIEW_ACTIVE_STATES } } });

export const ReviewItem = mongoose.models.ReviewItem || mongoose.model("ReviewItem", reviewItemSchema);
export default ReviewItem;
