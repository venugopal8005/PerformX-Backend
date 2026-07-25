import mongoose from "mongoose";
import { REVIEW_LIMITS, REVIEW_PROVENANCE } from "../../domain/phase5Review.domain.js";

export const reviewActorSnapshotSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true, immutable: true },
  captured_at: { type: Date, required: true, immutable: true },
  display_name: { type: String, required: true, maxlength: REVIEW_LIMITS.name, immutable: true },
  workspace_role: { type: String, enum: ["owner", "member"], required: true, immutable: true },
  provenance: { type: String, enum: ["workspace_member"], required: true, immutable: true },
}, { _id: false, strict: "throw" });

const identity = (extra = {}) => new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
  name: { type: String, default: null, maxlength: REVIEW_LIMITS.name, immutable: true },
  provenance: { type: String, enum: REVIEW_PROVENANCE, required: true, immutable: true },
  ...extra,
}, { _id: false, strict: "throw" });

export const reviewContextSnapshotSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true, immutable: true },
  captured_at: { type: Date, required: true, immutable: true },
  client: { type: identity(), required: true, immutable: true },
  account: { type: identity({ external_id: { type: String, default: null, maxlength: REVIEW_LIMITS.name, immutable: true } }), required: true, immutable: true },
  campaign: { type: identity({ id: { type: String, default: null, maxlength: REVIEW_LIMITS.campaignId, immutable: true } }), required: true, immutable: true },
  issue: { type: identity({ title: { type: String, default: null, maxlength: REVIEW_LIMITS.title, immutable: true } }), required: true, immutable: true },
  report: { type: identity(), default: null, immutable: true },
  source_title: { type: String, default: null, maxlength: REVIEW_LIMITS.title, immutable: true },
  source_summary: { type: String, default: null, maxlength: REVIEW_LIMITS.summary, immutable: true },
  provenance: { type: String, enum: REVIEW_PROVENANCE, required: true, immutable: true },
}, { _id: false, strict: "throw" });

export const reviewActionSourceSnapshotSchema = new mongoose.Schema({
  version: { type: Number, enum: [1], required: true, immutable: true },
  captured_at: { type: Date, required: true, immutable: true },
  item_type: { type: String, enum: ["issue_review", "evaluation_review"], required: true, immutable: true },
  item_generation: { type: Number, min: 1, required: true, immutable: true },
  source_revision: { type: Number, min: 0, required: true, immutable: true },
  title: { type: String, default: null, maxlength: REVIEW_LIMITS.title, immutable: true },
  summary: { type: String, default: null, maxlength: REVIEW_LIMITS.summary, immutable: true },
  provenance: { type: String, enum: REVIEW_PROVENANCE, required: true, immutable: true },
}, { _id: false, strict: "throw" });

