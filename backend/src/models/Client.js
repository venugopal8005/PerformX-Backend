import mongoose from "mongoose";

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
  },
  {
    timestamps: true,
    collection: "clients",
  }
);

clientSchema.index({ agency_id: 1, status: 1 });
clientSchema.index({ agency_id: 1, name: 1 });
clientSchema.index({ created_by: 1 });

export const Client =
  mongoose.models.Client || mongoose.model("Client", clientSchema);

export default Client;
