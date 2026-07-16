import mongoose from "mongoose";

const deliveryRecipientSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "uncertain"],
      default: "pending",
    },
    error: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { _id: false }
);

const deliveryErrorSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      trim: true,
      default: null,
    },
    category: {
      type: String,
      enum: [
        "configuration",
        "validation",
        "network",
        "timeout",
        "response",
        "delivery",
        "uncertain",
      ],
      default: "delivery",
    },
    message: {
      type: String,
      trim: true,
      default: null,
    },
    http_status: {
      type: Number,
      min: 100,
      max: 599,
      default: null,
    },
  },
  { _id: false }
);

const dispatchStateSchema = new mongoose.Schema(
  {
    idempotency_key: {
      type: String,
      trim: true,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "dispatching", "sent", "failed", "uncertain", "not_required"],
      default: "pending",
      required: true,
    },
    attempt_count: {
      type: Number,
      min: 0,
      default: 0,
    },
    attempt_id: {
      type: String,
      trim: true,
      default: null,
    },
    claimed_at: {
      type: Date,
      default: null,
    },
    claim_expires_at: {
      type: Date,
      default: null,
    },
    last_attempt_at: {
      type: Date,
      default: null,
    },
    sent_at: {
      type: Date,
      default: null,
    },
    last_error: {
      type: deliveryErrorSchema,
      default: null,
    },
  },
  { _id: false }
);

const reportEmailArtifactSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        "generated",
        "awaiting_approval",
        "held_for_review",
        "sent",
        "cancelled",
        "failed",
      ],
      default: "generated",
    },
    delivery_mode: {
      type: String,
      enum: ["generate_only", "auto_send", "approval_required"],
      default: "generate_only",
    },
    subject: {
      type: String,
      trim: true,
      default: null,
    },
    html: {
      type: String,
      default: null,
    },
    text: {
      type: String,
      default: null,
    },
    sent_at: {
      type: Date,
      default: null,
    },
    approved_at: {
      type: Date,
      default: null,
    },
    approved_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    cancelled_at: {
      type: Date,
      default: null,
    },
    cancelled_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    recipients: {
      type: [deliveryRecipientSchema],
      default: [],
    },
    delivery_error: {
      type: deliveryErrorSchema,
      default: null,
    },
    dispatch: {
      type: dispatchStateSchema,
      default: undefined,
    },
    safety: {
      passed: {
        type: Boolean,
        default: null,
      },
      reasons: {
        type: [String],
        default: [],
      },
      warnings: {
        type: [String],
        default: [],
      },
    },
    safetyOverride: {
      type: Boolean,
      default: false,
    },
    safetyOverrideBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    safetyOverrideAt: {
      type: Date,
      default: null,
    },
    safetyOverrideReasons: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const internalReportArtifactSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["generated", "sent", "failed"],
      default: "generated",
    },
    subject: {
      type: String,
      trim: true,
      default: null,
    },
    html: {
      type: String,
      default: null,
    },
    text: {
      type: String,
      default: null,
    },
    sent_at: {
      type: Date,
      default: null,
    },
    recipients: {
      type: [deliveryRecipientSchema],
      default: [],
    },
    delivery_error: {
      type: deliveryErrorSchema,
      default: null,
    },
    dispatch: {
      type: dispatchStateSchema,
      default: undefined,
    },
  },
  { _id: false }
);

const notificationArtifactSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["approval", "held"],
      required: true,
    },
    status: {
      type: String,
      enum: ["generated", "sent", "failed"],
      default: "generated",
    },
    subject: {
      type: String,
      trim: true,
      default: null,
    },
    html: {
      type: String,
      default: null,
    },
    text: {
      type: String,
      default: null,
    },
    sent_at: {
      type: Date,
      default: null,
    },
    recipients: {
      type: [deliveryRecipientSchema],
      default: [],
    },
    delivery_error: {
      type: deliveryErrorSchema,
      default: null,
    },
    dispatch: {
      type: dispatchStateSchema,
      default: undefined,
    },
  },
  { _id: false }
);

const executionFailureSchema = new mongoose.Schema(
  {
    stage: {
      type: String,
      trim: true,
      default: null,
    },
    code: {
      type: String,
      trim: true,
      default: null,
    },
    message: {
      type: String,
      trim: true,
      default: null,
    },
    failed_at: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const monitoredCampaignSchema = new mongoose.Schema(
  {
    campaign_id: {
      type: String,
      trim: true,
      required: true,
    },
    campaign_name: {
      type: String,
      trim: true,
      required: true,
    },
  },
  { _id: false }
);

const reportConfigurationSnapshotSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["daily", "weekly", "monthly", null],
      default: null,
    },
    schedule: {
      timezone: { type: String, default: null },
      time_of_day: { type: String, default: null },
      day_of_week: { type: Number, default: null },
      day_of_month: { type: Number, default: null },
    },
    client_delivery_mode: {
      type: String,
      enum: ["generate_only", "auto_send", "approval_required", null],
      default: null,
    },
    generate_client_report: { type: Boolean, default: null },
    generate_internal_report: { type: Boolean, default: null },
  },
  { _id: false }
);

const reportRunContextSnapshotSchema = new mongoose.Schema(
  {
    version: { type: Number, enum: [1], required: true },
    captured_at: { type: Date, required: true },
    source: {
      type: String,
      enum: ["execution", "backfill_current_reference"],
      required: true,
    },
    workspace: {
      name: { type: String, trim: true, default: null },
    },
    client: {
      name: { type: String, trim: true, default: null },
    },
    report: {
      name: { type: String, trim: true, default: null },
      configuration: {
        type: reportConfigurationSnapshotSchema,
        default: null,
      },
    },
    actor: {
      name: { type: String, trim: true, default: null },
    },
  },
  { _id: false }
);

const reportRunSchema = new mongoose.Schema(
  {
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      index: true,
    },
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    report_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
      required: true,
      index: true,
    },
    context_snapshot: {
      type: reportRunContextSnapshotSchema,
      default: undefined,
    },
    meta_ad_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MetaAdAccount",
      default: null,
      index: true,
    },
    meta_account_external_id_snapshot: {
      type: String,
      trim: true,
      default: null,
    },
    meta_account_name_snapshot: {
      type: String,
      trim: true,
      default: null,
    },
    meta_binding_revision_snapshot: {
      type: Number,
      min: 0,
      default: null,
    },
    meta_binding_performance_validated_at: {
      type: Date,
      default: null,
    },
    triggered_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    trigger_type: {
      type: String,
      enum: ["manual", "scheduled", "api"],
      default: "api",
      index: true,
    },
    execution_key: {
      type: String,
      trim: true,
    },
    scheduled_for: {
      type: Date,
      default: null,
      index: true,
    },
    execution_stage: {
      type: String,
      enum: ["claimed", "generating", "artifacts_ready", "delivering", "completed", "failed"],
      default: "completed",
      required: true,
      index: true,
    },
    execution_attempt_count: {
      type: Number,
      min: 0,
      default: 0,
    },
    started_at: {
      type: Date,
      default: Date.now,
    },
    artifacts_ready_at: {
      type: Date,
      default: null,
    },
    events_persisted_at: {
      type: Date,
      default: null,
    },
    events_persistence_status: {
      type: String,
      enum: ["persisted", "skipped_unvalidated_legacy_evidence"],
      default: null,
    },
    events_persistence_reason: {
      type: String,
      enum: ["meta_performance_evidence_not_validated"],
      default: null,
    },
    completed_at: {
      type: Date,
      default: null,
    },
    next_retry_at: {
      type: Date,
      default: null,
      index: true,
    },
    failure: {
      type: executionFailureSchema,
      default: null,
    },
    status: {
      type: String,
      enum: ["running", "ok", "insufficient_data", "failed"],
      default: "running",
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "low",
      required: true,
      index: true,
    },
    summary: {
      type: String,
      trim: true,
      default: null,
    },
    key_delta: {
      type: String,
      trim: true,
      default: null,
    },
    likely_cause: {
      type: String,
      trim: true,
      default: null,
    },
    decision: {
      type: String,
      trim: true,
      default: null,
    },
    next_signal: {
      type: String,
      trim: true,
      default: null,
    },
    period: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    comparison: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    narrative: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    monitored_campaigns: {
      type: [monitoredCampaignSchema],
      default: [],
    },
    signal_ids: {
      type: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Signal",
        },
      ],
      default: [],
    },
    email_subject: {
      type: String,
      trim: true,
      default: null,
    },
    email_html: {
      type: String,
      default: null,
    },
    internal_report: {
      type: internalReportArtifactSchema,
      default: null,
    },
    client_report: {
      type: reportEmailArtifactSchema,
      default: null,
    },
    notification: {
      type: notificationArtifactSchema,
      default: null,
    },
    engine_output: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ran_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "report_runs",
  }
);

reportRunSchema.index({ agency_id: 1, report_id: 1, ran_at: -1 });
reportRunSchema.index({ agency_id: 1, report_id: 1, ran_at: -1, _id: -1 });
reportRunSchema.index({ agency_id: 1, meta_ad_account_id: 1, ran_at: -1 });
reportRunSchema.index({ agency_id: 1, client_id: 1, ran_at: -1 });
reportRunSchema.index({ agency_id: 1, client_id: 1, ran_at: -1, _id: -1 });
reportRunSchema.index({ report_id: 1, status: 1, ran_at: -1 });
reportRunSchema.index({ execution_key: 1 }, { unique: true, sparse: true });

export const ReportRun =
  mongoose.models.ReportRun || mongoose.model("ReportRun", reportRunSchema);

export default ReportRun;
