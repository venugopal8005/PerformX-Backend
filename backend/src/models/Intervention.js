import mongoose from "mongoose";

import {
  INTERVENTION_ACTION_TYPES,
  INTERVENTION_ACTION_VERSION,
  INTERVENTION_ACTOR_PROVENANCE,
  INTERVENTION_IDENTITY_PROVENANCE,
  INTERVENTION_LIMITS,
  INTERVENTION_STATUSES,
} from "../domain/phase3Intervention.domain.js";
import {
  EVALUATION_INTENT_MODES,
  EVALUATION_LIMITS,
  EVALUATION_METRICS,
} from "../domain/phase4Evaluation.domain.js";

const evaluationIntentSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: EVALUATION_INTENT_MODES, required: true },
    primary_metric: { type: String, enum: [...EVALUATION_METRICS, null], default: null },
    watched_metrics: {
      type: [{ type: String, enum: EVALUATION_METRICS }],
      default: [],
      validate: {
        validator: (value) => Array.isArray(value) && value.length <= EVALUATION_LIMITS.watchedMetrics,
        message: "Evaluation watched metrics exceed the allowed limit.",
      },
    },
    resolution_source: { type: String, trim: true, required: true, maxlength: 64 },
    rule_version: { type: Number, min: 1, required: true },
  },
  { _id: false, strict: "throw" }
);

const actorSnapshotSchema = new mongoose.Schema(
  {
    version: { type: Number, enum: [1], required: true },
    captured_at: { type: Date, required: true },
    display_name: {
      type: String,
      trim: true,
      required: true,
      maxlength: INTERVENTION_LIMITS.displayName,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
      maxlength: INTERVENTION_LIMITS.email,
    },
    workspace_role: {
      type: String,
      enum: ["owner", "member", null],
      default: null,
    },
    provenance: {
      type: String,
      enum: INTERVENTION_ACTOR_PROVENANCE,
      required: true,
    },
  },
  { _id: false, strict: "throw" }
);

const issueSnapshotSchema = new mongoose.Schema(
  {
    version: { type: Number, enum: [1], required: true },
    captured_at: { type: Date, required: true },
    provenance: { type: String, enum: ["persisted_issue"], required: true },
    title: { type: String, trim: true, required: true, maxlength: INTERVENTION_LIMITS.title },
    summary: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.text },
    archetype: { type: String, trim: true, required: true, maxlength: 128 },
    metric_family: { type: String, trim: true, required: true, maxlength: 128 },
    status: { type: String, enum: ["open", "monitoring", "resolved"], required: true },
    severity: { type: String, enum: ["stable", "moderate", "critical"], required: true },
    trend: { type: String, enum: ["escalating", "improving", "unchanged"], required: true },
    fingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    fingerprint_version: { type: Number, required: true },
    opened_at: { type: Date, required: true },
    last_seen_at: { type: Date, required: true },
    resolved_at: { type: Date, default: null },
    occurrence_count: { type: Number, min: 1, required: true },
    reopen_count: { type: Number, min: 0, required: true },
    latest_signal_id: { type: mongoose.Schema.Types.ObjectId, ref: "Signal", required: true },
    latest_report_run_id: { type: mongoose.Schema.Types.ObjectId, ref: "ReportRun", required: true },
    lifecycle_revision: { type: Number, min: 0, required: true },
  },
  { _id: false, strict: "throw" }
);

const objectIdentitySchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.title },
    provenance: { type: String, enum: INTERVENTION_IDENTITY_PROVENANCE, required: true },
  },
  { _id: false, strict: "throw" }
);

const metaIdentitySchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    external_account_id: { type: String, trim: true, default: null, maxlength: 256 },
    name: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.title },
    provenance: { type: String, enum: INTERVENTION_IDENTITY_PROVENANCE, required: true },
  },
  { _id: false, strict: "throw" }
);

const campaignIdentitySchema = new mongoose.Schema(
  {
    id: { type: String, trim: true, required: true, maxlength: INTERVENTION_LIMITS.campaignId },
    name: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.title },
    provenance: { type: String, enum: INTERVENTION_IDENTITY_PROVENANCE, required: true },
  },
  { _id: false, strict: "throw" }
);

const scopeSnapshotSchema = new mongoose.Schema(
  {
    version: { type: Number, enum: [1], required: true },
    captured_at: { type: Date, required: true },
    client: { type: objectIdentitySchema, required: true },
    meta_account: { type: metaIdentitySchema, required: true },
    campaign: { type: campaignIdentitySchema, required: true },
    report: { type: objectIdentitySchema, required: true },
  },
  { _id: false, strict: "throw" }
);

const signalSnapshotSchema = new mongoose.Schema(
  {
    version: { type: Number, enum: [1], required: true },
    captured_at: { type: Date, required: true },
    provenance: { type: String, enum: ["persisted_signal"], required: true },
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    report_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    report_run_id: { type: mongoose.Schema.Types.ObjectId, required: true },
    type: { type: String, trim: true, required: true, maxlength: 128 },
    severity: { type: String, enum: ["stable", "moderate", "critical"], required: true },
    title: { type: String, trim: true, required: true, maxlength: INTERVENTION_LIMITS.title },
    description: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.text },
    recommendation: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.text },
    detected_at: { type: Date, required: true },
    matched_at: { type: Date, default: null },
  },
  { _id: false, strict: "throw" }
);

const actionPayloadSchema = new mongoose.Schema(
  {
    budget_mode: { type: String, enum: ["percent", "absolute", null], default: null },
    budget_amount: { type: Number, min: 0, default: null },
    currency: { type: String, trim: true, default: null, maxlength: 3 },
    asset_count: { type: Number, min: 1, max: 100, default: null },
    change_summary: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.summary },
    targeting_dimension: {
      type: String,
      enum: ["audience", "location", "demographic", "placement", "optimization", "other", null],
      default: null,
    },
    exclusion_type: {
      type: String,
      enum: ["audience", "placement", "location", "publisher", "other", null],
      default: null,
    },
    bid_strategy: {
      type: String,
      enum: ["lowest_cost", "cost_cap", "bid_cap", "minimum_roas", "other", null],
      default: null,
    },
    tracking_area: {
      type: String,
      enum: ["pixel", "conversions_api", "event_mapping", "attribution", "utm", "other", null],
      default: null,
    },
    other_label: { type: String, trim: true, default: null, maxlength: INTERVENTION_LIMITS.label },
  },
  { _id: false, strict: "throw", minimize: false }
);

const cancellationSchema = new mongoose.Schema(
  {
    reason: { type: String, trim: true, required: true, maxlength: INTERVENTION_LIMITS.reason },
    cancelled_at: { type: Date, required: true },
    cancelled_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    cancelled_by_snapshot: { type: actorSnapshotSchema, required: true },
    idempotency_key: {
      type: String,
      trim: true,
      required: true,
      minlength: INTERVENTION_LIMITS.idempotencyKeyMin,
      maxlength: INTERVENTION_LIMITS.idempotencyKeyMax,
    },
    request_hash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  },
  { _id: false, strict: "throw" }
);

const interventionSchema = new mongoose.Schema(
  {
    agency_id: { type: mongoose.Schema.Types.ObjectId, ref: "Agency", required: true, immutable: true },
    client_id: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, immutable: true },
    issue_id: { type: mongoose.Schema.Types.ObjectId, ref: "Issue", required: true, immutable: true },
    meta_ad_account_id: { type: mongoose.Schema.Types.ObjectId, ref: "MetaAdAccount", required: true, immutable: true },
    campaign_id: { type: String, trim: true, required: true, immutable: true, maxlength: INTERVENTION_LIMITS.campaignId },
    report_id_at_action: { type: mongoose.Schema.Types.ObjectId, ref: "Report", required: true, immutable: true },
    report_run_id_at_action: { type: mongoose.Schema.Types.ObjectId, ref: "ReportRun", required: true, immutable: true },
    performed_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, immutable: true },
    performed_by_snapshot: { type: actorSnapshotSchema, required: true, immutable: true },
    recorded_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    recorded_by_snapshot: { type: actorSnapshotSchema, required: true, immutable: true },
    action_type: { type: String, enum: INTERVENTION_ACTION_TYPES, required: true, immutable: true },
    action_version: { type: Number, enum: [INTERVENTION_ACTION_VERSION], required: true, immutable: true },
    action_payload: { type: actionPayloadSchema, required: true, immutable: true },
    reason: { type: String, trim: true, default: null, immutable: true, maxlength: INTERVENTION_LIMITS.reason },
    note: { type: String, trim: true, default: null, immutable: true, maxlength: INTERVENTION_LIMITS.note },
    performed_at: { type: Date, required: true, immutable: true },
    recorded_at: { type: Date, required: true, immutable: true },
    issue_snapshot: { type: issueSnapshotSchema, required: true, immutable: true },
    scope_snapshot: { type: scopeSnapshotSchema, required: true, immutable: true },
    latest_signal_snapshot: { type: signalSnapshotSchema, required: true, immutable: true },
    issue_fingerprint_snapshot: { type: String, required: true, immutable: true, match: /^[a-f0-9]{64}$/ },
    evaluation_intent: { type: evaluationIntentSchema, default: undefined, immutable: true },
    status: { type: String, enum: INTERVENTION_STATUSES, required: true, default: "active" },
    supersedes_intervention_id: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", default: null, immutable: true },
    superseded_by_intervention_id: { type: mongoose.Schema.Types.ObjectId, ref: "Intervention", default: null },
    corrected_at: { type: Date, default: null },
    corrected_by_user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    corrected_by_snapshot: { type: actorSnapshotSchema, default: null },
    cancellation: { type: cancellationSchema, default: null },
    idempotency_key: {
      type: String,
      trim: true,
      required: true,
      immutable: true,
      minlength: INTERVENTION_LIMITS.idempotencyKeyMin,
      maxlength: INTERVENTION_LIMITS.idempotencyKeyMax,
    },
    request_hash: { type: String, required: true, immutable: true, select: false, match: /^[a-f0-9]{64}$/ },
    revision: { type: Number, min: 0, required: true, default: 0 },
    evaluation_fence_counter: { type: Number, min: 0, required: true, default: 0, select: false },
  },
  {
    timestamps: true,
    collection: "interventions",
    optimisticConcurrency: true,
    strict: "throw",
  }
);

const INTERNAL_QUERY_OPERATION_OPTION = "phase3InternalOperation";
const INTERNAL_QUERY_OPERATIONS = Object.freeze({
  supersede: Object.freeze({
    setPaths: Object.freeze([
      "status",
      "superseded_by_intervention_id",
      "corrected_at",
      "corrected_by_user_id",
      "corrected_by_snapshot",
      "updatedAt",
    ]),
  }),
  cancel: Object.freeze({
    setPaths: Object.freeze(["status", "cancellation", "updatedAt"]),
  }),
  evaluation_fence: Object.freeze({ setPaths: Object.freeze([]) }),
});

const exactPaths = (actual, expected) =>
  actual.length === expected.length && expected.every((path) => actual.includes(path));
const validObjectId = (value) => mongoose.isObjectIdOrHexString(value);
const validDate = (value) => {
  if (value == null || value === "") return false;
  const date = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(date.getTime());
};
const plainObject = (value) =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const validActorSnapshot = (value) =>
  plainObject(value) &&
  value.version === 1 &&
  typeof value.display_name === "string" &&
  Boolean(value.display_name.trim()) &&
  INTERVENTION_ACTOR_PROVENANCE.includes(value.provenance) &&
  validDate(value.captured_at);

const interventionQueryMutationError = (message) => {
  const error = new Error(message);
  error.code = "INTERVENTION_QUERY_MUTATION_REJECTED";
  error.status = 500;
  return error;
};

const validateInternalQueryMutation = function validateInternalQueryMutation() {
  const options = this.getOptions?.() || this.options || {};
  const operation = options[INTERNAL_QUERY_OPERATION_OPTION];
  if (this.options) delete this.options[INTERNAL_QUERY_OPERATION_OPTION];
  const command = this.op;

  if (!operation || !Object.hasOwn(INTERNAL_QUERY_OPERATIONS, operation)) {
    throw interventionQueryMutationError(
      operation
        ? "Unknown internal Intervention query operation."
        : "General Intervention query mutation is not permitted."
    );
  }
  if (command === "findOneAndReplace" || command === "replaceOne" || command === "updateMany") {
    throw interventionQueryMutationError(`${command} is not permitted for Interventions.`);
  }

  const filter = this.getFilter?.() || {};
  const filterPaths = Object.keys(filter);
  if (
    !exactPaths(filterPaths, ["_id", "agency_id", "status", "revision"]) ||
    !validObjectId(filter._id) ||
    !validObjectId(filter.agency_id) ||
    (operation === "evaluation_fence" ? !INTERVENTION_STATUSES.includes(filter.status) : filter.status !== "active") ||
    !Number.isSafeInteger(filter.revision) ||
    filter.revision < 0
  ) {
    throw interventionQueryMutationError(
      "Internal Intervention transitions require exact identity, agency, active status, and revision filters."
    );
  }

  const update = this.getUpdate?.();
  if (!update || Array.isArray(update) || typeof update !== "object") {
    throw interventionQueryMutationError("Intervention replacement and pipeline updates are not permitted.");
  }
  const operators = Object.keys(update);
  if (operation === "evaluation_fence") {
    if (!exactPaths(operators, ["$inc"]) || !plainObject(update.$inc) || !exactPaths(Object.keys(update.$inc), ["evaluation_fence_counter"]) || update.$inc.evaluation_fence_counter !== 1) {
      throw interventionQueryMutationError("Evaluation fence mutation is invalid.");
    }
    return;
  }
  if (!exactPaths(operators, ["$set", "$inc"])) {
    throw interventionQueryMutationError("Intervention update operators are not permitted.");
  }
  if (!update.$set || typeof update.$set !== "object" || Array.isArray(update.$set)) {
    throw interventionQueryMutationError("Internal Intervention transition fields are invalid.");
  }
  if (
    !update.$inc ||
    typeof update.$inc !== "object" ||
    Array.isArray(update.$inc) ||
    !exactPaths(Object.keys(update.$inc), ["revision"]) ||
    update.$inc.revision !== 1
  ) {
    throw interventionQueryMutationError("Internal Intervention revision increment is invalid.");
  }

  const contract = INTERNAL_QUERY_OPERATIONS[operation];
  if (!exactPaths(Object.keys(update.$set), contract.setPaths)) {
    throw interventionQueryMutationError("Internal Intervention transition fields are invalid.");
  }
  const expectedStatus = operation === "supersede" ? "superseded" : "cancelled";
  if (update.$set.status !== expectedStatus) {
    throw interventionQueryMutationError("Internal Intervention transition status is invalid.");
  }
  if (!validDate(update.$set.updatedAt)) {
    throw interventionQueryMutationError("Internal Intervention transition timestamp is invalid.");
  }
  if (operation === "supersede") {
    if (
      !validObjectId(update.$set.superseded_by_intervention_id) ||
      !validDate(update.$set.corrected_at) ||
      !validObjectId(update.$set.corrected_by_user_id) ||
      !validActorSnapshot(update.$set.corrected_by_snapshot)
    ) {
      throw interventionQueryMutationError("Internal Intervention correction evidence is incomplete.");
    }
  } else {
    const cancellation = update.$set.cancellation;
    if (
      !plainObject(cancellation) ||
      typeof cancellation.reason !== "string" ||
      !cancellation.reason.trim() ||
      !validDate(cancellation.cancelled_at) ||
      !validObjectId(cancellation.cancelled_by_user_id) ||
      !validActorSnapshot(cancellation.cancelled_by_snapshot) ||
      typeof cancellation.idempotency_key !== "string" ||
      !cancellation.idempotency_key.trim() ||
      !/^[a-f0-9]{64}$/.test(cancellation.request_hash || "")
    ) {
      throw interventionQueryMutationError("Internal Intervention cancellation evidence is incomplete.");
    }
  }
};

interventionSchema.pre(
  ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"],
  validateInternalQueryMutation
);

interventionSchema.pre("bulkWrite", function rejectBulkMutation() {
  throw interventionQueryMutationError("Intervention bulk mutation is not permitted.");
});

interventionSchema.pre("save", function rejectExistingDocumentMutation() {
  if (!this.isNew && this.isModified()) {
    throw interventionQueryMutationError("Existing Intervention documents cannot be mutated with save().");
  }
});

interventionSchema.pre("validate", function validateLifecycle() {
  const hasAnyCorrectionEvidence = Boolean(
    this.superseded_by_intervention_id ||
      this.corrected_at ||
      this.corrected_by_user_id ||
      this.corrected_by_snapshot
  );
  const correctionComplete = Boolean(
    this.superseded_by_intervention_id &&
      this.corrected_at &&
      this.corrected_by_user_id &&
      this.corrected_by_snapshot
  );
  if (this.status === "active") {
    if (hasAnyCorrectionEvidence || this.cancellation) {
      this.invalidate("status", "Active Interventions cannot contain terminal lifecycle evidence.");
    }
  } else if (this.status === "superseded") {
    if (!correctionComplete || this.cancellation) {
      this.invalidate("status", "Superseded Interventions require complete correction evidence only.");
    }
  } else if (this.status === "cancelled") {
    if (!this.cancellation || hasAnyCorrectionEvidence) {
      this.invalidate("status", "Cancelled Interventions require cancellation evidence only.");
    }
  }
});

interventionSchema.index(
  { agency_id: 1, issue_id: 1, performed_at: -1, _id: -1 },
  { name: "phase3_interventions_issue_cursor" }
);
interventionSchema.index(
  { agency_id: 1, client_id: 1, performed_at: -1, _id: -1 },
  { name: "phase3_interventions_client_cursor" }
);
interventionSchema.index(
  { agency_id: 1, performed_by_user_id: 1, performed_at: -1, _id: -1 },
  {
    name: "phase3_interventions_actor_cursor",
    partialFilterExpression: { performed_by_user_id: { $type: "objectId" } },
  }
);
interventionSchema.index(
  { agency_id: 1, action_type: 1, performed_at: -1, _id: -1 },
  { name: "phase3_interventions_action_cursor" }
);
interventionSchema.index(
  { agency_id: 1, status: 1, performed_at: -1, _id: -1 },
  { name: "phase3_interventions_status_cursor" }
);
interventionSchema.index(
  { agency_id: 1, idempotency_key: 1 },
  { name: "phase3_interventions_idempotency_unique", unique: true }
);
interventionSchema.index(
  { agency_id: 1, supersedes_intervention_id: 1 },
  {
    name: "phase3_interventions_supersedes_unique",
    unique: true,
    partialFilterExpression: { supersedes_intervention_id: { $type: "objectId" } },
  }
);
interventionSchema.index(
  { agency_id: 1, "cancellation.idempotency_key": 1 },
  {
    name: "phase3_interventions_cancellation_key_unique",
    unique: true,
    partialFilterExpression: { "cancellation.idempotency_key": { $type: "string" } },
  }
);

export const Intervention =
  mongoose.models.Intervention || mongoose.model("Intervention", interventionSchema);

export default Intervention;
