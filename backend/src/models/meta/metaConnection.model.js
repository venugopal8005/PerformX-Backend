import mongoose from "mongoose";

const metaConnectionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: "User",
    },
    access_token: {
      type: String,
      required: true,
    },
    ad_account_id: {
      type: String,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    is_active: {
      type: Boolean,
      default: true,
    }
  },
  { timestamps: true }
);

// prevent duplicate connections per user
metaConnectionSchema.index({ user_id: 1 }, { unique: true });

export const MetaConnection = mongoose.model(
  "MetaConnection",
  metaConnectionSchema
); 