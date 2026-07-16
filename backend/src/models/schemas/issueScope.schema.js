import mongoose from "mongoose";

import {
  ISSUE_ENTITY_LEVELS,
  ISSUE_FINGERPRINT_VERSION,
  ISSUE_SUPPORTED_CADENCES,
} from "../../domain/phase2Issue.domain.js";

const entitySchema = new mongoose.Schema(
  {
    level: { type: String, enum: ISSUE_ENTITY_LEVELS, required: true },
    id: { type: String, trim: true, required: true, maxlength: 256 },
    campaign_id: { type: String, trim: true, required: true, maxlength: 256 },
    adset_id: { type: String, trim: true, default: null, maxlength: 256 },
    ad_id: { type: String, trim: true, default: null, maxlength: 256 },
  },
  { _id: false }
);

const classificationSchema = new mongoose.Schema(
  {
    archetype: { type: String, trim: true, required: true, maxlength: 128 },
    metric_family: { type: String, trim: true, required: true, maxlength: 128 },
  },
  { _id: false }
);

const comparisonSchema = new mongoose.Schema(
  {
    cadence: { type: String, enum: ISSUE_SUPPORTED_CADENCES, required: true },
    timezone: { type: String, trim: true, required: true, maxlength: 128 },
  },
  { _id: false }
);

export const issueScopeSchema = new mongoose.Schema(
  {
    version: {
      type: Number,
      enum: [ISSUE_FINGERPRINT_VERSION],
      required: true,
    },
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
    },
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    meta_ad_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MetaAdAccount",
      required: true,
    },
    entity: { type: entitySchema, required: true },
    classification: { type: classificationSchema, required: true },
    comparison: { type: comparisonSchema, required: true },
  },
  { _id: false }
);
