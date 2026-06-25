import mongoose from "mongoose";

const workspaceMemberSchema = new mongoose.Schema(
  {
    workspace_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      index: true,
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: ["owner", "member"],
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "removed"],
      default: "active",
      required: true,
      index: true,
    },
    joined_at: {
      type: Date,
      default: Date.now,
    },
    removed_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "workspace_members",
  }
);

workspaceMemberSchema.index(
  { workspace_id: 1, user_id: 1 },
  { unique: true }
);

export const WorkspaceMember =
  mongoose.models.WorkspaceMember ||
  mongoose.model("WorkspaceMember", workspaceMemberSchema);

export default WorkspaceMember;
