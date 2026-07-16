import mongoose from "mongoose";

import {
  ACTIVE_ISSUE_STATUSES,
  ISSUE_FINGERPRINT_VERSION,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUE_TEXT_MAX,
  ISSUE_TRENDS,
} from "../domain/phase2Issue.domain.js";
import { issueScopeSchema } from "./schemas/issueScope.schema.js";

const latestEvidenceSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["signal", "clean_observation"],
      required: true,
    },
    signal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Signal",
      default: null,
    },
    report_run_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportRun",
      required: true,
    },
    observed_at: { type: Date, required: true },
    severity: { type: String, enum: ISSUE_SEVERITIES, required: true },
    title: { type: String, trim: true, default: null, maxlength: 512 },
    summary: { type: String, trim: true, default: null, maxlength: ISSUE_TEXT_MAX },
    primary_metric: { type: String, trim: true, default: null, maxlength: 128 },
    delta: { type: Number, default: null },
    provenance: {
      type: String,
      enum: ["snapshot", "current_parent", "unknown"],
      default: "snapshot",
    },
  },
  { _id: false }
);

const issueSchema = new mongoose.Schema(
  {
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      immutable: true,
    },
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      immutable: true,
    },
    meta_ad_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MetaAdAccount",
      required: true,
      immutable: true,
    },
    fingerprint: {
      type: String,
      required: true,
      immutable: true,
      match: /^[a-f0-9]{64}$/,
    },
    fingerprint_version: {
      type: Number,
      enum: [ISSUE_FINGERPRINT_VERSION],
      required: true,
      immutable: true,
    },
    active_fingerprint: {
      type: String,
      default: null,
      match: /^[a-f0-9]{64}$/,
    },
    scope: { type: issueScopeSchema, required: true, immutable: true },
    archetype: {
      type: String,
      trim: true,
      required: true,
      immutable: true,
      maxlength: 128,
    },
    metric_family: {
      type: String,
      trim: true,
      required: true,
      immutable: true,
      maxlength: 128,
    },
    origin_report_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
      required: true,
      immutable: true,
    },
    latest_report_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
      required: true,
    },
    report_ids: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "Report" }],
      required: true,
      validate: {
        validator: (values) =>
          Array.isArray(values) &&
          values.length > 0 &&
          new Set(values.map(String)).size === values.length,
        message: "report_ids must contain unique Report references.",
      },
    },
    status: { type: String, enum: ISSUE_STATUSES, required: true, default: "open" },
    opened_at: { type: Date, required: true, immutable: true },
    last_seen_at: { type: Date, required: true },
    resolved_at: { type: Date, default: null },
    reopened_at: { type: Date, default: null },
    reopen_count: { type: Number, min: 0, default: 0, required: true },
    occurrence_count: { type: Number, min: 1, required: true },
    first_signal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Signal",
      required: true,
      immutable: true,
    },
    latest_signal_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Signal",
      required: true,
    },
    latest_report_run_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportRun",
      required: true,
    },
    current_severity: {
      type: String,
      enum: ISSUE_SEVERITIES,
      required: true,
    },
    previous_severity: {
      type: String,
      enum: [...ISSUE_SEVERITIES, null],
      default: null,
    },
    trend: { type: String, enum: ISSUE_TRENDS, default: "unchanged", required: true },
    absence_streak: { type: Number, min: 0, default: 0, required: true },
    last_observation_key: { type: String, trim: true, default: null, maxlength: 256 },
    last_observation_end: { type: Date, default: null },
    latest_evidence: { type: latestEvidenceSchema, required: true },
    title: { type: String, trim: true, required: true, maxlength: 512 },
    summary: { type: String, trim: true, default: null, maxlength: ISSUE_TEXT_MAX },
    predecessor_issue_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Issue",
      default: null,
      immutable: true,
    },
    lifecycle_revision: { type: Number, min: 0, default: 0, required: true },
  },
  {
    timestamps: true,
    collection: "issues",
    optimisticConcurrency: true,
  }
);

issueSchema.pre("validate", function validateLifecycle() {
  if (this.status === "resolved") {
    if (!this.resolved_at) this.invalidate("resolved_at", "Resolved Issues require resolved_at.");
    if (this.active_fingerprint !== null) {
      this.invalidate("active_fingerprint", "Resolved Issues cannot retain active_fingerprint.");
    }
  } else if (ACTIVE_ISSUE_STATUSES.includes(this.status)) {
    if (this.active_fingerprint !== this.fingerprint) {
      this.invalidate("active_fingerprint", "Active Issues require their canonical fingerprint.");
    }
    if (this.resolved_at !== null && this.resolved_at !== undefined) {
      this.invalidate("resolved_at", "Active Issues cannot retain resolved_at.");
    }
  }
});

issueSchema.index(
  { agency_id: 1, client_id: 1, fingerprint_version: 1, active_fingerprint: 1 },
  {
    name: "phase2_issues_active_identity_unique",
    unique: true,
    partialFilterExpression: { active_fingerprint: { $type: "string" } },
  }
);
issueSchema.index(
  { agency_id: 1, client_id: 1, fingerprint_version: 1, fingerprint: 1, resolved_at: -1, _id: -1 },
  { name: "phase2_issues_fingerprint_history" }
);
issueSchema.index(
  { agency_id: 1, last_seen_at: -1, _id: -1 },
  { name: "phase2_issues_workspace_cursor" }
);
issueSchema.index(
  { agency_id: 1, client_id: 1, last_seen_at: -1, _id: -1 },
  { name: "phase2_issues_client_cursor" }
);
issueSchema.index(
  { agency_id: 1, report_ids: 1, last_seen_at: -1, _id: -1 },
  { name: "phase2_issues_report_cursor" }
);
issueSchema.index(
  { agency_id: 1, status: 1, last_seen_at: -1, _id: -1 },
  { name: "phase2_issues_status_cursor" }
);
issueSchema.index(
  { agency_id: 1, current_severity: 1, last_seen_at: -1, _id: -1 },
  { name: "phase2_issues_severity_cursor" }
);
issueSchema.index(
  { agency_id: 1, client_id: 1, meta_ad_account_id: 1, last_seen_at: -1, _id: -1 },
  { name: "phase2_issues_account_cursor" }
);

export const Issue = mongoose.models.Issue || mongoose.model("Issue", issueSchema);
export default Issue;
