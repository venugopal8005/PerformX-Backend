import mongoose from "mongoose";

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
reportRunSchema.index({ agency_id: 1, client_id: 1, ran_at: -1 });
reportRunSchema.index({ report_id: 1, status: 1, ran_at: -1 });

export const ReportRun =
  mongoose.models.ReportRun || mongoose.model("ReportRun", reportRunSchema);

export default ReportRun;
