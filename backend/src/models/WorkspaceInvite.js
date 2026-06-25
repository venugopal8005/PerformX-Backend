import mongoose from "mongoose";

const workspaceInviteSchema = new mongoose.Schema(
  {
    workspace_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ["member"],
      default: "member",
      required: true,
    },
    token_hash: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "revoked", "expired"],
      default: "pending",
      required: true,
      index: true,
    },
    invited_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    expires_at: {
      type: Date,
      required: true,
      index: true,
    },
    accepted_by_user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    accepted_at: {
      type: Date,
      default: null,
    },
    revoked_at: {
      type: Date,
      default: null,
    },
    last_sent_at: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "workspace_invites",
  }
);

workspaceInviteSchema.index({ workspace_id: 1, email: 1 });

workspaceInviteSchema.pre("validate", function () {
  if (this.email) {
    this.email = this.email.toString().trim().toLowerCase();
  }
});

export const WorkspaceInvite =
  mongoose.models.WorkspaceInvite ||
  mongoose.model("WorkspaceInvite", workspaceInviteSchema);

export default WorkspaceInvite;
