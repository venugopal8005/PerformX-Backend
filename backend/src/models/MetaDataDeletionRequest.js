import mongoose from "mongoose";

const metaDataDeletionRequestSchema = new mongoose.Schema(
  {
    meta_user_hash: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
      select: false,
    },
    confirmation_code: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["processing", "completed", "failed"],
      default: "processing",
      required: true,
      index: true,
    },
    requested_at: {
      type: Date,
      required: true,
      default: Date.now,
    },
    completed_at: {
      type: Date,
      default: null,
    },
    failed_at: {
      type: Date,
      default: null,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    failure_reason: {
      type: String,
      enum: ["cleanup_failed"],
      default: null,
    },
  },
  {
    collection: "meta_data_deletion_requests",
    versionKey: false,
  }
);

metaDataDeletionRequestSchema.index(
  { expires_at: 1 },
  { expireAfterSeconds: 0, name: "meta_data_deletion_request_expiry" }
);

export const MetaDataDeletionRequest =
  mongoose.models.MetaDataDeletionRequest ||
  mongoose.model("MetaDataDeletionRequest", metaDataDeletionRequestSchema);

export default MetaDataDeletionRequest;
