import mongoose from "mongoose";
import { REVIEW_ACTION_TYPES, REVIEW_DECISION_TYPES, REVIEW_HUMAN_ACTIONS, REVIEW_STATES } from "../domain/phase5Review.domain.js";
import { reviewActorSnapshotSchema, reviewActionSourceSnapshotSchema } from "./schemas/reviewSnapshots.schema.js";

const reviewActionSchema = new mongoose.Schema({
  agency_id: { type: mongoose.Schema.Types.ObjectId, ref: "Agency", required: true, immutable: true },
  client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, immutable: true },
  issue_id: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true, immutable: true },
  review_item_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReviewItem", required: true, immutable: true },
  sequence: { type: Number, min: 1, required: true, immutable: true },
  action_type: { type: String, enum: REVIEW_ACTION_TYPES, required: true, immutable: true },
  actor_type: { type: String, enum: ["human", "system"], required: true, immutable: true },
  decision_type: { type: String, enum: [...REVIEW_DECISION_TYPES, null], default: null, immutable: true },
  actor_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
  actor_snapshot: { type: reviewActorSnapshotSchema, default: null, immutable: true },
  prior_state: { type: String, enum: REVIEW_STATES, required: true, immutable: true },
  resulting_state: { type: String, enum: REVIEW_STATES, required: true, immutable: true },
  item_revision_before: { type: Number, min: 0, required: true, immutable: true },
  item_revision_after: { type: Number, min: 1, required: true, immutable: true },
  source_revision: { type: Number, min: 0, required: true, immutable: true },
  source_snapshot: { type: reviewActionSourceSnapshotSchema, required: true, immutable: true },
  signal_id: { type: mongoose.Schema.Types.ObjectId, ref: "Signal", default: null, immutable: true },
  intervention_id: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", default: null, immutable: true },
  evaluation_id: { type: mongoose.Schema.Types.ObjectId, ref: "Evaluation", default: null, immutable: true },
  note: { type: String, default: null, maxlength: 2000, immutable: true },
  occurred_at: { type: Date, required: true, immutable: true },
  recorded_at: { type: Date, required: true, immutable: true },
  idempotency_key: { type: String, required: true, minlength: 16, maxlength: 512, immutable: true },
  request_hash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true, select: false },
}, { timestamps: true, collection: "review_actions", strict: "throw", autoIndex: false, autoCreate: false });

const mutationError = () => Object.assign(new Error("ReviewAction documents are append-only."), { code: "REVIEW_ACTION_MUTATION_REJECTED", status: 500 });
reviewActionSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"], function reject() { throw mutationError(); });
reviewActionSchema.pre("bulkWrite", function rejectBulk() { throw mutationError(); });
reviewActionSchema.pre("deleteOne", { document: true, query: false }, function rejectDelete() { throw mutationError(); });
reviewActionSchema.pre("save", function rejectExisting() { if (!this.isNew) throw mutationError(); });
reviewActionSchema.pre("validate", function validateAction() {
  const human = this.actor_type === "human";
  const active = ["open", "acknowledged", "snoozed"];
  if (human !== REVIEW_HUMAN_ACTIONS.includes(this.action_type)) this.invalidate("actor_type", "ReviewAction actor type does not match action.");
  if (human && (!this.actor_user_id || !this.actor_snapshot)) this.invalidate("actor_snapshot", "Human ReviewActions require actor identity.");
  if (!human && (this.actor_user_id || this.actor_snapshot)) this.invalidate("actor_snapshot", "System ReviewActions cannot contain human actor identity.");
  if (this.item_revision_after !== this.item_revision_before + 1) this.invalidate("item_revision_after", "ReviewAction revision must advance exactly once.");
  if (!Number.isSafeInteger(this.sequence) || this.sequence < 1) this.invalidate("sequence", "ReviewAction sequence must be positive.");
  if (["acknowledged", "snoozed"].includes(this.action_type) && this.decision_type !== null) this.invalidate("decision_type", "This Review action cannot contain a decision type.");
  if (this.action_type === "interpretation_recorded" && (this.decision_type !== "interpretation_only" || !this.note?.trim() || this.intervention_id)) this.invalidate("decision_type", "Interpretation actions require an interpretation-only decision and note.");
  if (this.action_type === "intervention_recorded" && (!["campaign_action", "monitor_only", "no_action"].includes(this.decision_type) || !this.intervention_id)) this.invalidate("decision_type", "Intervention actions require an Intervention decision and source.");
  if (!human && this.decision_type !== null) this.invalidate("decision_type", "System ReviewActions cannot contain a decision type.");
  const transitionValid = {
    acknowledged: this.prior_state === "open" && this.resulting_state === "acknowledged",
    snoozed: active.includes(this.prior_state) && this.resulting_state === "snoozed",
    interpretation_recorded: active.includes(this.prior_state) && this.resulting_state === "reviewed",
    intervention_recorded: active.includes(this.prior_state) && this.resulting_state === "reviewed",
    opened_from_issue: this.prior_state === "open" && this.resulting_state === "open" && Boolean(this.signal_id),
    opened_from_evaluation: this.prior_state === "open" && this.resulting_state === "open" && Boolean(this.evaluation_id),
    reopened_by_evidence: ["acknowledged", "snoozed"].includes(this.prior_state) && this.resulting_state === "open" && Boolean(this.signal_id),
    reopened_by_severity: ["acknowledged", "snoozed"].includes(this.prior_state) && this.resulting_state === "open" && Boolean(this.signal_id),
    closed_source_resolved: active.includes(this.prior_state) && this.resulting_state === "closed",
    closed_client_archived: active.includes(this.prior_state) && this.resulting_state === "closed",
    closed_account_reassigned: active.includes(this.prior_state) && this.resulting_state === "closed",
    superseded_by_evaluation: active.includes(this.prior_state) && this.resulting_state === "superseded" && Boolean(this.evaluation_id),
    invalidated_by_source: active.includes(this.prior_state) && this.resulting_state === "closed",
    snooze_expired: this.prior_state === "snoozed" && this.resulting_state === "open",
    reconciliation_recovered: this.prior_state === "open" && this.resulting_state === "open",
  }[this.action_type];
  if (!transitionValid) this.invalidate("resulting_state", "ReviewAction state transition is invalid.");
});
reviewActionSchema.index({ agency_id: 1, review_item_id: 1, sequence: -1 }, { name: "phase5_review_action_sequence", unique: true });
reviewActionSchema.index({ agency_id: 1, idempotency_key: 1 }, { name: "phase5_review_action_idempotency", unique: true });
reviewActionSchema.index({ agency_id: 1, issue_id: 1, occurred_at: -1, _id: -1 }, { name: "phase5_review_action_issue_cursor" });

export const ReviewAction = mongoose.models.ReviewAction || mongoose.model("ReviewAction", reviewActionSchema);
export default ReviewAction;
