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
      enum: ["pending", "sent", "failed"],
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
      enum: ["configuration", "validation", "network", "timeout", "response", "delivery"],
      default: "delivery",
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
    recipients: {
      type: [deliveryRecipientSchema],
      default: [],
    },
    delivery_error: {
      type: deliveryErrorSchema,
      default: null,
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
    status: {
      type: String,
      enum: ["ok", "insufficient_data", "failed"],
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
      required: true,
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
reportRunSchema.index({ agency_id: 1, meta_ad_account_id: 1, ran_at: -1 });
reportRunSchema.index({ agency_id: 1, client_id: 1, ran_at: -1 });
reportRunSchema.index({ report_id: 1, status: 1, ran_at: -1 });

export const ReportRun =
  mongoose.models.ReportRun || mongoose.model("ReportRun", reportRunSchema);

export default ReportRun;
