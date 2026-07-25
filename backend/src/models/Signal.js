import mongoose from "mongoose";

import {
  ISSUE_FINGERPRINT_VERSION,
  ISSUE_MATCHING_VERSION,
  SIGNAL_ISSUE_MATCHING_STATUSES,
} from "../domain/phase2Issue.domain.js";
import { issueScopeSchema } from "./schemas/issueScope.schema.js";

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
    observation_key: {
      type: String,
      default: null,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    observation_identity_version: {
      type: Number,
      enum: [1, null],
      default: null,
      immutable: true,
    },
    context_snapshot: {
      type: signalContextSnapshotSchema,
      default: undefined,
    },
    scope: {
      type: issueScopeSchema,
      default: undefined,
      immutable: true,
    },
    fingerprint: {
      type: String,
      default: null,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    fingerprint_version: {
      type: Number,
      enum: [ISSUE_FINGERPRINT_VERSION, null],
      default: null,
      immutable: true,
    },
    issue_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Issue",
      default: null,
      immutable: true,
    },
    issue_occurrence_number: {
      type: Number,
      min: 1,
      default: null,
      immutable: true,
    },
    issue_fingerprint_snapshot: {
      type: String,
      default: null,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    matched_at: {
      type: Date,
      default: null,
      immutable: true,
    },
    matching_version: {
      type: Number,
      enum: [ISSUE_MATCHING_VERSION, null],
      default: null,
      immutable: true,
    },
    issue_matching_status: {
      type: String,
      enum: [...SIGNAL_ISSUE_MATCHING_STATUSES, null],
      default: null,
    },
    issue_matching_reason: {
      type: String,
      trim: true,
      default: null,
      maxlength: 128,
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
signalSchema.index({ agency_id: 1, client_id: 1, detected_at: -1, _id: -1 });
signalSchema.index({ agency_id: 1, report_id: 1, detected_at: -1 });
signalSchema.index({ agency_id: 1, report_id: 1, detected_at: -1, _id: -1 });
signalSchema.index({ agency_id: 1, severity: 1, detected_at: -1 });
signalSchema.index({ client_id: 1, severity: 1, detected_at: -1 });
signalSchema.index(
  { agency_id: 1, report_run_id: 1, observation_key: 1 },
  {
    name: "execution_integrity_report_run_signal_identity_unique",
    unique: true,
    partialFilterExpression: {
      report_run_id: { $type: "objectId" },
      observation_key: { $type: "string" },
    },
  }
);
signalSchema.index(
  { report_run_id: 1, detected_at: 1, _id: 1 },
  { name: "phase3_signals_report_run_chronology" }
);
signalSchema.index(
  { agency_id: 1, report_id: 1, issue_id: 1 },
  { name: "phase3_signals_report_issue_lookup" }
);
signalSchema.index(
  { agency_id: 1, issue_id: 1, detected_at: -1, _id: -1 },
  { name: "phase2_signals_issue_cursor" }
);
signalSchema.index(
  { issue_id: 1, issue_occurrence_number: 1 },
  {
    name: "phase2_signals_issue_occurrence_unique",
    unique: true,
    partialFilterExpression: {
      issue_id: { $type: "objectId" },
      issue_occurrence_number: { $type: "number" },
    },
  }
);
signalSchema.index(
  { agency_id: 1, detected_at: -1, _id: -1 },
  { name: "phase1e_signals_workspace_cursor", unique: false, sparse: false }
);
signalSchema.index(
  { agency_id: 1, type: 1, detected_at: -1, _id: -1 },
  { name: "phase1e_signals_type_cursor", unique: false, sparse: false }
);
signalSchema.index(
  { agency_id: 1, severity: 1, detected_at: -1, _id: -1 },
  { name: "phase1e_signals_severity_cursor", unique: false, sparse: false }
);

export const Signal =
  mongoose.models.Signal || mongoose.model("Signal", signalSchema);

export default Signal;
