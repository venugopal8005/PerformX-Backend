import mongoose from "mongoose";

const metaAdAccountSchema = new mongoose.Schema(
  {
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      index: true,
    },
    meta_connection_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MetaConnection",
      required: true,
      index: true,
    },
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      default: null,
      index: true,
    },
    assignment_scope: {
      type: String,
      enum: ["v1"],
      default: null,
    },
    ad_account_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
      default: null,
    },
    currency: {
      type: String,
      trim: true,
      default: null,
    },
    timezone_name: {
      type: String,
      trim: true,
      default: null,
    },
    account_status: {
      type: String,
      trim: true,
      default: null,
    },
    last_synced_at: {
      type: Date,
      default: null,
    },
    last_seen_at: {
      type: Date,
      default: null,
    },
    is_accessible: {
      type: Boolean,
      default: true,
      required: true,
      index: true,
    },
    campaigns_last_synced_at: {
      type: Date,
      default: null,
    },
    is_active: {
      type: Boolean,
      default: true,
      required: true,
    },
    binding_revision: {
      type: Number,
      cast: false,
      min: 0,
      default: 0,
      required: true,
      validate: {
        validator: Number.isSafeInteger,
        message: "binding_revision must be a non-negative integer.",
      },
    },
    binding_fence_counter: {
      type: Number,
      cast: false,
      min: 0,
      default: 0,
      select: false,
      validate: {
        validator: Number.isSafeInteger,
        message: "binding_fence_counter must be a non-negative integer.",
      },
    },
  },
  {
    timestamps: true,
    collection: "meta_ad_accounts",
  }
);

metaAdAccountSchema.index(
  { agency_id: 1, ad_account_id: 1 },
  { unique: true }
);
metaAdAccountSchema.index({ agency_id: 1, client_id: 1 });
metaAdAccountSchema.index(
  { agency_id: 1, client_id: 1, assignment_scope: 1 },
  {
    unique: true,
    partialFilterExpression: { assignment_scope: "v1" },
  }
);
metaAdAccountSchema.index({ agency_id: 1, is_active: 1 });
metaAdAccountSchema.index({ agency_id: 1, is_accessible: 1 });

metaAdAccountSchema.virtual("workspace_id").get(function () {
  return this.agency_id;
});

metaAdAccountSchema.virtual("workspace_id").set(function (value) {
  this.agency_id = value;
});

export const MetaAdAccount =
  mongoose.models.MetaAdAccount ||
  mongoose.model("MetaAdAccount", metaAdAccountSchema);

export default MetaAdAccount;
