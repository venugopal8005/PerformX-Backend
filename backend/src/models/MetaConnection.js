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
      required: true,
      index: true,
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
      required: true,
      select: false,
    },
    token_expires_at: {
      type: Date,
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

export const MetaConnection =
  mongoose.models.MetaConnection ||
  mongoose.model("MetaConnection", metaConnectionSchema);

export default MetaConnection;
