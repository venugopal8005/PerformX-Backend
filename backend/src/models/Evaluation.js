import mongoose from "mongoose";

import {
  EVALUATION_CONFIDENCE_LEVELS,
  EVALUATION_INTERPRETABILITY,
  EVALUATION_INTENT_MODES,
  EVALUATION_LIMITS,
  EVALUATION_METRICS,
  EVALUATION_RESULTS,
  EVALUATION_STATUSES,
  EVALUATION_TRIGGER_TYPES,
} from "../domain/phase4Evaluation.domain.js";

const boundedArray = (maximum, label) => ({
  validator: (value) => Array.isArray(value) && value.length <= maximum,
  message: `${label} exceed the allowed limit.`,
});

const windowSchema = new mongoose.Schema(
  {
    start: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    end: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    timezone: { type: String, required: true, maxlength: EVALUATION_LIMITS.timezone },
    cadence: { type: String, enum: ["daily", "weekly", "monthly"], required: true },
  },
  { _id: false, strict: "throw" }
);

const metricValueSchema = new mongoose.Schema(
  {
    spend: { type: Number, min: 0, required: true },
    impressions: { type: Number, min: 0, required: true },
    clicks: { type: Number, min: 0, required: true },
    conversions: { type: Number, min: 0, required: true },
    conversion_value: { type: Number, min: 0, default: null },
    ctr: { type: Number, min: 0, default: null },
    cpc: { type: Number, min: 0, default: null },
    cpm: { type: Number, min: 0, default: null },
    cpa: { type: Number, min: 0, default: null },
    roas: { type: Number, min: 0, default: null },
    conversion_rate: { type: Number, min: 0, default: null },
  },
  { _id: false, strict: "throw" }
);

const evidenceSnapshotSchema = new mongoose.Schema(
  {
    report_run_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReportRun", required: true },
    window: { type: windowSchema, required: true },
    campaign_id: { type: String, required: true, maxlength: EVALUATION_LIMITS.campaignId },
    campaign_name: { type: String, default: null, maxlength: EVALUATION_LIMITS.campaignName },
    currency: { type: String, required: true, maxlength: EVALUATION_LIMITS.currency },
    attribution_windows: {
      type: [{ type: String, maxlength: EVALUATION_LIMITS.attributionWindow }],
      default: [],
      validate: boundedArray(EVALUATION_LIMITS.attributionWindows, "Evaluation attribution windows"),
    },
    meta_binding_revision: { type: Number, min: 0, required: true },
    provenance: { type: String, enum: ["scheduled_window", "scheduled_manual_window"], required: true },
    values: { type: metricValueSchema, required: true },
    row_count: { type: Number, min: 0, required: true },
    source_level: { type: String, enum: ["ad", "campaign"], required: true },
    completeness: { type: String, enum: ["complete", "zero_delivery"], required: true },
  },
  { _id: false, strict: "throw" }
);

const intentSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: EVALUATION_INTENT_MODES, required: true },
    primary_metric: { type: String, enum: [...EVALUATION_METRICS, null], default: null },
    watched_metrics: {
      type: [{ type: String, enum: EVALUATION_METRICS }],
      default: [],
      validate: boundedArray(EVALUATION_LIMITS.watchedMetrics, "Evaluation intent watched metrics"),
    },
    resolution_source: { type: String, required: true, maxlength: 64 },
    rule_version: { type: Number, min: 1, required: true },
  },
  { _id: false, strict: "throw" }
);

const metricResultSchema = new mongoose.Schema(
  {
    metric: { type: String, enum: EVALUATION_METRICS, required: true },
    directionality: { type: String, enum: ["higher_is_better", "lower_is_better", "context_only"], required: true },
    unit: { type: String, enum: ["percent", "currency", "ratio", "count"], required: true },
    baseline_value: { type: Number, default: null },
    follow_up_value: { type: Number, default: null },
    absolute_delta: { type: Number, default: null },
    relative_delta: { type: Number, default: null },
    minimum_evidence_met: { type: Boolean, required: true },
    material: { type: Boolean, required: true },
    classification: { type: String, enum: ["improved", "worsened", "no_material_change", "context_only", "insufficient_data", "not_evaluable"], required: true },
    reason_codes: {
      type: [{ type: String, maxlength: 128 }],
      default: [],
      validate: boundedArray(EVALUATION_LIMITS.reasonCodes, "Evaluation metric reason codes"),
    },
  },
  { _id: false, strict: "throw" }
);

const materialThresholdSchema = new mongoose.Schema(
  {
    relative: { type: Number, min: 0, required: true },
    absolute: { type: Number, min: 0, required: true },
  },
  { _id: false, strict: "throw" }
);

const noiseBoundarySchema = new mongoose.Schema(
  {
    relative: { type: Number, min: 0, required: true },
    absolute: { type: Number, min: 0, required: true },
    requires_both: { type: Boolean, required: true },
  },
  { _id: false, strict: "throw" }
);

const minimumEvidenceSchema = new mongoose.Schema(
  {
    spend: { type: Number, min: 0, default: null },
    impressions: { type: Number, min: 0, default: null },
    clicks: { type: Number, min: 0, default: null },
    conversions: { type: Number, min: 0, default: null },
  },
  { _id: false, strict: "throw" }
);

const thresholdSnapshotSchema = new mongoose.Schema(
  {
    metric: { type: String, enum: EVALUATION_METRICS, required: true },
    directionality: { type: String, enum: ["higher_is_better", "lower_is_better", "context_only"], required: true },
    unit: { type: String, enum: ["percent", "currency", "ratio", "count"], required: true },
    material_improvement: { type: materialThresholdSchema, required: true },
    material_worsening: { type: materialThresholdSchema, required: true },
    noise_boundary: { type: noiseBoundarySchema, required: true },
    minimum_evidence: { type: minimumEvidenceSchema, required: true },
    requires_attribution: { type: Boolean, required: true },
    requires_conversion_value: { type: Boolean, required: true },
  },
  { _id: false, strict: "throw" }
);

const invalidationSchema = new mongoose.Schema(
  {
    reason: { type: String, enum: ["intervention_superseded", "intervention_cancelled"], required: true },
    invalidated_at: { type: Date, required: true },
    source_intervention_id: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", required: true },
  },
  { _id: false, strict: "throw" }
);

const evaluationSchema = new mongoose.Schema(
  {
    agency_id: { type: mongoose.Schema.Types.ObjectId, ref: "Agency", required: true, immutable: true },
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, immutable: true },
    issue_id: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true, immutable: true },
    intervention_id: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", required: true, immutable: true },
    meta_ad_account_id: { type: mongoose.Schema.Types.ObjectId, ref: "MetaAdAccount", required: true, immutable: true },
    campaign_id: { type: String, required: true, immutable: true, maxlength: EVALUATION_LIMITS.campaignId },
    report_id_at_action: { type: mongoose.Schema.Types.ObjectId, ref: "Report", required: true, immutable: true },
    action_type: { type: String, required: true, maxlength: 64, immutable: true },
    sequence: { type: Number, min: 1, required: true, immutable: true },
    schema_version: { type: Number, enum: [1], required: true, immutable: true },
    rule_version: { type: Number, min: 1, required: true, immutable: true },
    evidence_version: { type: Number, min: 1, required: true, immutable: true },
    normalization_version: { type: Number, min: 1, required: true, immutable: true },
    trigger_type: { type: String, enum: EVALUATION_TRIGGER_TYPES, required: true, immutable: true },
    source_report_run_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReportRun", default: null, immutable: true },
    status: { type: String, enum: EVALUATION_STATUSES, required: true, immutable: true },
    intent: { type: intentSchema, required: true, immutable: true },
    primary_metric: { type: String, enum: [...EVALUATION_METRICS, null], default: null, immutable: true },
    watched_metrics: {
      type: [{ type: String, enum: EVALUATION_METRICS }],
      default: [],
      immutable: true,
      validate: boundedArray(EVALUATION_LIMITS.watchedMetrics, "Evaluation watched metrics"),
    },
    baseline: { type: evidenceSnapshotSchema, default: null, immutable: true },
    follow_up: { type: evidenceSnapshotSchema, default: null, immutable: true },
    metric_results: {
      type: [metricResultSchema],
      default: [],
      immutable: true,
      validate: boundedArray(EVALUATION_LIMITS.watchedMetrics, "Evaluation metric results"),
    },
    threshold_snapshots: {
      type: [thresholdSnapshotSchema],
      default: [],
      immutable: true,
      validate: boundedArray(EVALUATION_LIMITS.watchedMetrics, "Evaluation threshold snapshots"),
    },
    observed_result: { type: String, enum: [...EVALUATION_RESULTS, null], default: null, immutable: true },
    confidence_level: { type: String, enum: EVALUATION_CONFIDENCE_LEVELS, required: true, immutable: true },
    confidence_score: { type: Number, min: 0, max: 100, default: null, immutable: true },
    confidence_factors: {
      type: [{ type: String, maxlength: 128 }],
      default: [],
      immutable: true,
      validate: boundedArray(EVALUATION_LIMITS.confidenceFactors, "Evaluation confidence factors"),
    },
    confidence_version: { type: Number, min: 1, required: true, immutable: true },
    interpretability: { type: String, enum: EVALUATION_INTERPRETABILITY, required: true, immutable: true },
    reason_codes: {
      type: [{ type: String, maxlength: 128 }],
      default: [],
      immutable: true,
      validate: boundedArray(EVALUATION_LIMITS.reasonCodes, "Evaluation reason codes"),
    },
    overlap_intervention_ids: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Intervention" }],
      default: [],
      immutable: true,
      validate: boundedArray(EVALUATION_LIMITS.overlapInterventions, "Evaluation overlap Intervention IDs"),
    },
    evidence_completeness: { type: String, enum: ["complete", "partial", "unavailable"], required: true, immutable: true },
    summary: { type: String, required: true, maxlength: EVALUATION_LIMITS.summary, immutable: true },
    evidence_hash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
    idempotency_key: { type: String, required: true, maxlength: EVALUATION_LIMITS.idempotencyKeyMax, immutable: true },
    supersedes_evaluation_id: { type: mongoose.Schema.Types.ObjectId, ref: "Evaluation", default: null, immutable: true },
    invalidation_context: { type: invalidationSchema, default: null, immutable: true },
    calculated_at: { type: Date, required: true, immutable: true },
  },
  {
    timestamps: true,
    collection: "evaluations",
    strict: "throw",
    optimisticConcurrency: true,
    autoIndex: false,
    autoCreate: false,
  }
);

const mutationError = () => {
  const error = new Error("Evaluation documents are append-only and cannot be mutated.");
  error.code = "EVALUATION_QUERY_MUTATION_REJECTED";
  error.status = 500;
  return error;
};
evaluationSchema.pre(["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"], function rejectMutation() {
  throw mutationError();
});
evaluationSchema.pre("bulkWrite", function rejectBulkMutation() {
  throw mutationError();
});
evaluationSchema.pre("deleteOne", { document: true, query: false }, function rejectDocumentDeletion() {
  throw mutationError();
});
evaluationSchema.pre("save", function rejectExistingMutation() {
  if (!this.isNew && this.isModified()) throw mutationError();
});

evaluationSchema.index({ agency_id: 1, intervention_id: 1, sequence: -1 }, { name: "phase4_evaluations_intervention_history", unique: true });
evaluationSchema.index({ agency_id: 1, issue_id: 1, calculated_at: -1, _id: -1 }, { name: "phase4_evaluations_issue_cursor" });
evaluationSchema.index({ agency_id: 1, client_id: 1, calculated_at: -1, _id: -1 }, { name: "phase4_evaluations_client_cursor" });
evaluationSchema.index({ agency_id: 1, status: 1, calculated_at: -1, _id: -1 }, { name: "phase4_evaluations_status_cursor" });
evaluationSchema.index({ agency_id: 1, observed_result: 1, calculated_at: -1, _id: -1 }, { name: "phase4_evaluations_result_cursor", partialFilterExpression: { observed_result: { $type: "string" } } });
evaluationSchema.index({ agency_id: 1, primary_metric: 1, calculated_at: -1, _id: -1 }, { name: "phase4_evaluations_metric_cursor", partialFilterExpression: { primary_metric: { $type: "string" } } });
evaluationSchema.index({ agency_id: 1, idempotency_key: 1 }, { name: "phase4_evaluations_idempotency_unique", unique: true });
evaluationSchema.index({ agency_id: 1, supersedes_evaluation_id: 1 }, { name: "phase4_evaluations_supersedes_unique", unique: true, partialFilterExpression: { supersedes_evaluation_id: { $type: "objectId" } } });
evaluationSchema.index({ agency_id: 1, source_report_run_id: 1, intervention_id: 1, rule_version: 1 }, { name: "phase4_evaluations_report_run_trigger_unique", unique: true, partialFilterExpression: { source_report_run_id: { $type: "objectId" }, trigger_type: "report_run" } });

export const Evaluation = mongoose.models.Evaluation || mongoose.model("Evaluation", evaluationSchema);
export default Evaluation;
