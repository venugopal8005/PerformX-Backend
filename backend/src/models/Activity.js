import mongoose from "mongoose";

const activitySchema = new mongoose.Schema(
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
      default: null,
      index: true,
    },
    report_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
      default: null,
      index: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "report_sent",
        "report_executed",
        "report_failed",
        "client_created",
        "client_updated",
        "client_deleted",
        "signal_detected",
        "decision_generated",
        "report_created",
        "campaign_synced",
        "meta_connected",
        "meta_reconnected",
        "meta_disconnected",
        "meta_accounts_synced",
        "meta_account_assigned",
        "meta_account_reassigned",
        "meta_account_unassigned",
        "report_paused",
        "report_started",
      ],
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
    severity: {
      type: String,
      enum: ["stable", "moderate", "critical"],
      default: "stable",
      required: true,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    collection: "activities",
  }
);

activitySchema.index({ agency_id: 1, createdAt: -1 });
activitySchema.index({ agency_id: 1, client_id: 1, createdAt: -1 });
activitySchema.index({ agency_id: 1, report_id: 1, createdAt: -1 });
activitySchema.index({ agency_id: 1, type: 1, createdAt: -1 });
activitySchema.index({ agency_id: 1, severity: 1, createdAt: -1 });

export const Activity =
  mongoose.models.Activity || mongoose.model("Activity", activitySchema);

export default Activity;
