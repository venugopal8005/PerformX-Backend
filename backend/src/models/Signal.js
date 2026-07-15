import mongoose from "mongoose";

const signalCampaignSnapshotSchema = new mongoose.Schema(
  {
    campaign_id: { type: String, required: true, trim: true },
    campaign_name: { type: String, trim: true, default: null },
  },
  { _id: false }
);

const signalContextSnapshotSchema = new mongoose.Schema(
  {
    version: { type: Number, enum: [1], required: true },
    captured_at: { type: Date, required: true },
    source: {
      type: String,
      enum: ["execution", "backfill_current_reference"],
      required: true,
    },
    workspace: { name: { type: String, trim: true, default: null } },
    client: { name: { type: String, trim: true, default: null } },
    report: { name: { type: String, trim: true, default: null } },
    meta_account: {
      meta_ad_account_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MetaAdAccount",
        default: null,
      },
      external_account_id: { type: String, trim: true, default: null },
      name: { type: String, trim: true, default: null },
    },
    campaigns: {
      type: [signalCampaignSnapshotSchema],
      default: [],
    },
  },
  { _id: false }
);

const signalSchema = new mongoose.Schema(
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
      default: null,
      index: true,
    },
    report_run_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportRun",
    },
    context_snapshot: {
      type: signalContextSnapshotSchema,
      default: undefined,
    },
    campaign_id: {
      type: String,
      trim: true,
      default: null,
    },
    type: {
      type: String,
      enum: [
        "creative_fatigue",
        "audience_saturation",
        "engagement_quality_drop",
        "aggressive_scaling",
        "conversion_funnel_breakdown",
        "auction_pressure",
        "delivery_instability",
        "traffic_quality_drop",
        "volume_loss",
        "healthy_scaling",
        "stable_performance",
        "data_quality_issue",
        "ctr_decline",
        "roas_drop",
        "cpm_spike",
        "frequency_spike",
        "audience_overlap",
        "pacing_warning",
        "metric_anomaly",
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ["stable", "moderate", "critical"],
      default: "stable",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
      default: null,
    },
    recommendation: {
      type: String,
      trim: true,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    detected_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    collection: "signals",
  }
);

signalSchema.index({ agency_id: 1, client_id: 1, detected_at: -1 });
signalSchema.index({ agency_id: 1, report_id: 1, detected_at: -1 });
signalSchema.index({ agency_id: 1, severity: 1, detected_at: -1 });
signalSchema.index({ client_id: 1, severity: 1, detected_at: -1 });
signalSchema.index({ report_run_id: 1 }, { unique: true, sparse: true });

export const Signal =
  mongoose.models.Signal || mongoose.model("Signal", signalSchema);

export default Signal;
