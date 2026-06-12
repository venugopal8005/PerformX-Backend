import mongoose from "mongoose";

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

export const Signal =
  mongoose.models.Signal || mongoose.model("Signal", signalSchema);

export default Signal;
