import mongoose from "mongoose";

const lifecycleLockSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
    },
    operation: {
      type: String,
      enum: [
        "archive",
        "report_create",
        "report_reparent",
        "meta_assignment",
        "intervention_write",
        "evaluation_write",
      ],
      required: true,
    },
    acquired_at: {
      type: Date,
      required: true,
    },
    expires_at: {
      type: Date,
      required: true,
    },
  },
  { _id: false }
);

const clientSchema = new mongoose.Schema(
  {
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    industry: {
      type: String,
      trim: true,
      default: null,
    },
    status: {
      type: String,
      enum: ["stable", "moderate", "critical"],
      default: "stable",
      required: true,
    },
    notes: {
      type: String,
      trim: true,
      default: null,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    is_archived: {
      type: Boolean,
      default: false,
      required: true,
      index: true,
    },
    archived_at: {
      type: Date,
      default: null,
    },
    archived_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lifecycle_lock: {
      type: lifecycleLockSchema,
      default: undefined,
      select: false,
    },
  },
  {
    timestamps: true,
    collection: "clients",
  }
);

clientSchema.index({ agency_id: 1, status: 1 });
clientSchema.index({ agency_id: 1, name: 1 });
clientSchema.index({ agency_id: 1, is_archived: 1, createdAt: -1 });
clientSchema.index({ agency_id: 1, is_archived: 1, archived_at: -1, _id: -1 });
clientSchema.index({ agency_id: 1, "lifecycle_lock.expires_at": 1 });
clientSchema.index({ created_by: 1 });

export const Client =
  mongoose.models.Client || mongoose.model("Client", clientSchema);

export default Client;
