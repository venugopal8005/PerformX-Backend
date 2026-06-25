import mongoose from "mongoose";

const metaConnectionSchema = new mongoose.Schema(
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
    meta_user_id: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    meta_user_name: {
      type: String,
      trim: true,
      default: null,
    },
    business_id: {
      type: String,
      trim: true,
      default: null,
    },
    ad_account_id: {
      type: String,
      trim: true,
      default: null,
      index: true,
    },
    ad_account_name: {
      type: String,
      trim: true,
      default: null,
    },
    access_token: {
      type: String,
      select: false,
    },
    access_token_encrypted: {
      type: String,
      select: false,
      default: null,
    },
    token_expires_at: {
      type: Date,
      default: null,
    },
    permissions: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ["active", "expiring_soon", "expired", "permission_error", "revoked"],
      default: "active",
      required: true,
      index: true,
    },
    last_synced_at: {
      type: Date,
      default: null,
    },
    last_error: {
      type: String,
      trim: true,
      default: null,
    },
    is_active: {
      type: Boolean,
      default: true,
      required: true,
    },
    connected_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "meta_connections",
  }
);

metaConnectionSchema.index({ agency_id: 1, client_id: 1 });
metaConnectionSchema.index({ agency_id: 1, meta_user_id: 1 });
metaConnectionSchema.index(
  { client_id: 1, ad_account_id: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ad_account_id: { $type: "string" },
    },
  }
);
metaConnectionSchema.index({ connected_by: 1 });

metaConnectionSchema.virtual("workspace_id").get(function () {
  return this.agency_id;
});

metaConnectionSchema.virtual("workspace_id").set(function (value) {
  this.agency_id = value;
});

metaConnectionSchema.virtual("connected_by_user_id").get(function () {
  return this.connected_by;
});

metaConnectionSchema.virtual("connected_by_user_id").set(function (value) {
  this.connected_by = value;
});

export const MetaConnection =
  mongoose.models.MetaConnection ||
  mongoose.model("MetaConnection", metaConnectionSchema);

export default MetaConnection;
