import crypto from "crypto";
import { cookieOptions, generateToken } from "auth-module";

import {
  Agency,
  User,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceSettings,
} from "../models/index.js";
import { sendWorkspaceInviteEmail } from "../services/workspaceInviteEmail.service.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_DAYS = 7;

const normalizeEmail = (email = "") => String(email).trim().toLowerCase();
const isValidEmail = (email = "") => EMAIL_PATTERN.test(normalizeEmail(email));
const getUserId = (req) => req.user?.userId || req.user?.id || req.user?._id;
const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const generateRawToken = () => crypto.randomBytes(32).toString("base64url");
const getClientOrigin = () => process.env.CLIENT_ORIGIN || "http://localhost:5173";
const inviteExpiry = () => new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
const idsMatch = (left, right) =>
  left && right && left.toString() === right.toString();

const memberName = (user) => user?.full_name || user?.fullName || "Team member";

const authUser = (user, agency, role, workspaceSettings = null) => ({
  id: user._id,
  fullName: user.full_name || user.fullName || "",
  email: user.email,
  avatar: user.avatar_url || user.avatar || null,
  avatar_url: user.avatar_url || user.avatar || null,
  role,
  agencyId: agency._id,
  agency: {
    id: agency._id,
    name: agency.name,
    slug: agency.slug,
    logo_url: workspaceSettings?.logo_url || null,
    logoUrl: workspaceSettings?.logo_url || null,
  },
});

const serializeMember = (membership) => {
  const user = membership.user_id;

  return {
    id: membership._id,
    _id: membership._id,
    user_id: user?._id || membership.user_id,
    name: memberName(user),
    email: user?.email || "",
    avatar_url: user?.avatar_url || user?.avatar || null,
    role: membership.role,
    status: membership.status,
    joined_at: membership.joined_at,
    removed_at: membership.removed_at,
  };
};

const serializeInvite = (invite) => {
  const invitedBy = invite.invited_by_user_id;

  return {
    id: invite._id,
    _id: invite._id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    expires_at: invite.expires_at,
    last_sent_at: invite.last_sent_at,
    invited_by: invitedBy
      ? {
          id: invitedBy._id || invitedBy,
          name: invitedBy.full_name || invitedBy.fullName || null,
          email: invitedBy.email || null,
        }
      : null,
    accepted_at: invite.accepted_at,
    revoked_at: invite.revoked_at,
    createdAt: invite.createdAt,
  };
};

const expireOldInvites = (workspaceId) =>
  WorkspaceInvite.updateMany(
    {
      workspace_id: workspaceId,
      status: "pending",
      expires_at: { $lte: new Date() },
    },
    { $set: { status: "expired" } }
  );

const buildInviteUrl = (token) =>
  `${getClientOrigin()}/invite/${encodeURIComponent(token)}`;

const deliverInvite = async ({ invite, rawToken, workspace, inviter }) =>
  sendWorkspaceInviteEmail({
    to: invite.email,
    workspaceName: workspace.name,
    inviterName: memberName(inviter),
    inviteUrl: buildInviteUrl(rawToken),
    expiresAt: invite.expires_at,
  });

export const getTeamSettings = async (req, res) => {
  try {
    const workspaceId = req.user?.agencyId;
    await expireOldInvites(workspaceId);

    const [members, invites] = await Promise.all([
      WorkspaceMember.find({
        workspace_id: workspaceId,
        status: "active",
      })
        .populate("user_id", "full_name fullName email avatar_url avatar")
        .sort({ role: 1, joined_at: 1 }),
      WorkspaceInvite.find({
        workspace_id: workspaceId,
        status: { $in: ["pending", "expired"] },
      })
        .populate("invited_by_user_id", "full_name fullName email")
        .sort({ createdAt: -1 }),
    ]);

    return res.json({
      success: true,
      current_user_role: req.workspaceMembership?.role || "member",
      members: members.map(serializeMember),
      invites: invites.map(serializeInvite),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to load workspace team",
    });
  }
};

export const createWorkspaceInvite = async (req, res) => {
  const workspaceId = req.params.workspaceId || req.user?.agencyId;
  const userId = getUserId(req);
  const email = normalizeEmail(req.body.email);

  try {
    const ownerMembership = await WorkspaceMember.findOne({
      workspace_id: workspaceId,
      user_id: userId,
      role: "owner",
      status: "active",
    });

    if (!ownerMembership) {
      return res.status(403).json({
        success: false,
        message: "Only workspace owners can send invitations.",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address.",
      });
    }

    await expireOldInvites(workspaceId);

    const existingUser = await User.findOne({ email }).select("_id email");
    if (existingUser) {
      const existingMember = await WorkspaceMember.findOne({
        workspace_id: workspaceId,
        user_id: existingUser._id,
        status: "active",
      });

      if (existingMember) {
        return res.status(409).json({
          success: false,
          message: "That email is already an active workspace member.",
        });
      }
    }

    const duplicateInvite = await WorkspaceInvite.findOne({
      workspace_id: workspaceId,
      email,
      status: { $in: ["pending", "expired"] },
    });

    if (duplicateInvite) {
      return res.status(409).json({
        success: false,
        message:
          duplicateInvite.status === "expired"
            ? "This invite already exists but expired. Use Resend to send a fresh link."
            : "A pending invite already exists for this email.",
      });
    }

    const [workspace, inviter] = await Promise.all([
      Agency.findById(workspaceId),
      User.findById(userId),
    ]);

    if (!workspace || !inviter) {
      return res.status(404).json({
        success: false,
        message: "Workspace or inviter not found.",
      });
    }

    const rawToken = generateRawToken();
    const now = new Date();
    const invite = await WorkspaceInvite.create({
      workspace_id: workspaceId,
      email,
      role: "member",
      token_hash: hashToken(rawToken),
      status: "pending",
      invited_by_user_id: userId,
      expires_at: inviteExpiry(),
      last_sent_at: now,
    });

    try {
      await deliverInvite({ invite, rawToken, workspace, inviter });
    } catch (err) {
      await WorkspaceInvite.deleteOne({ _id: invite._id }).catch(() => null);
      throw err;
    }

    await invite.populate("invited_by_user_id", "full_name fullName email");

    return res.status(201).json({
      success: true,
      message: `Invitation sent to ${email}.`,
      invite: serializeInvite(invite),
      inviteLink: buildInviteUrl(rawToken),
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to send invitation.",
    });
  }
};

export const resendWorkspaceInvite = async (req, res) => {
  try {
    const workspaceId = req.user?.agencyId;
    const userId = getUserId(req);
    await expireOldInvites(workspaceId);

    const invite = await WorkspaceInvite.findOne({
      _id: req.params.inviteId,
      workspace_id: workspaceId,
      status: { $in: ["pending", "expired"] },
    });

    if (!invite) {
      return res.status(404).json({
        success: false,
        message: "Pending invitation not found.",
      });
    }

    const [workspace, inviter] = await Promise.all([
      Agency.findById(workspaceId),
      User.findById(userId),
    ]);
    const rawToken = generateRawToken();

    invite.token_hash = hashToken(rawToken);
    invite.status = "pending";
    invite.expires_at = inviteExpiry();
    invite.last_sent_at = new Date();
    invite.revoked_at = null;
    await invite.save();

    await deliverInvite({ invite, rawToken, workspace, inviter });
    await invite.populate("invited_by_user_id", "full_name fullName email");

    return res.json({
      success: true,
      message: `Invitation resent to ${invite.email}.`,
      invite: serializeInvite(invite),
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Failed to resend invitation.",
    });
  }
};

export const revokeWorkspaceInvite = async (req, res) => {
  try {
    const invite = await WorkspaceInvite.findOne({
      _id: req.params.inviteId,
      workspace_id: req.user?.agencyId,
      status: "pending",
    });

    if (!invite) {
      return res.status(404).json({
        success: false,
        message: "Pending invitation not found.",
      });
    }

    invite.status = "revoked";
    invite.revoked_at = new Date();
    await invite.save();

    return res.json({
      success: true,
      message: "Invitation revoked.",
      invite: serializeInvite(invite),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to revoke invitation.",
    });
  }
};

export const verifyWorkspaceInvite = async (req, res) => {
  try {
    const token = String(req.params.token || req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Invite token is required.",
      });
    }

    const invite = await WorkspaceInvite.findOne({ token_hash: hashToken(token) })
      .populate("workspace_id", "name slug")
      .populate("invited_by_user_id", "full_name fullName email");

    if (!invite) {
      return res.status(404).json({
        success: false,
        valid: false,
        message: "Invitation link is invalid.",
      });
    }

    if (invite.status === "pending" && invite.expires_at <= new Date()) {
      invite.status = "expired";
      await invite.save();
    }

    return res.json({
      success: true,
      valid: invite.status === "pending",
      invite: {
        email: invite.email,
        role: invite.role,
        status: invite.status,
        expires_at: invite.expires_at,
        workspace: {
          id: invite.workspace_id?._id || invite.workspace_id,
          name: invite.workspace_id?.name || "Narrative workspace",
          slug: invite.workspace_id?.slug || "",
        },
        invited_by: invite.invited_by_user_id
          ? {
              name:
                invite.invited_by_user_id.full_name ||
                invite.invited_by_user_id.fullName ||
                null,
              email: invite.invited_by_user_id.email || null,
            }
          : null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to verify invitation.",
    });
  }
};

export const acceptWorkspaceInvite = async (req, res) => {
  try {
    const token = String(req.params.token || req.body.token || "").trim();
    if (!token) {
      return res.status(400).json({
        success: false,
        message: "Invite token is required.",
      });
    }

    const invite = await WorkspaceInvite.findOne({
      token_hash: hashToken(token),
    });

    if (!invite) {
      return res.status(400).json({
        success: false,
        message: "This invitation is no longer available.",
      });
    }

    const user = await User.findById(getUserId(req));
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Sign in before accepting this invitation.",
      });
    }

    if (normalizeEmail(user.email) !== invite.email) {
      return res.status(403).json({
        success: false,
        invite_email: invite.email,
        message: "This invite was sent to another email.",
      });
    }

    if (invite.status === "pending" && invite.expires_at <= new Date()) {
      invite.status = "expired";
      await invite.save();

      return res.status(400).json({
        success: false,
        message: "This invitation has expired. Ask the owner to resend it.",
      });
    }

    if (invite.status === "revoked") {
      return res.status(400).json({
        success: false,
        message: "This invitation was revoked. Ask the owner for a new invite.",
      });
    }

    if (invite.status === "expired") {
      return res.status(400).json({
        success: false,
        message: "This invitation has expired. Ask the owner to resend it.",
      });
    }

    if (invite.status === "accepted") {
      const existingMembership = await WorkspaceMember.findOne({
        workspace_id: invite.workspace_id,
        user_id: user._id,
        status: "active",
      });

      if (
        existingMembership &&
        (!invite.accepted_by_user_id || idsMatch(invite.accepted_by_user_id, user._id))
      ) {
        const [agency, workspaceSettings] = await Promise.all([
          Agency.findById(invite.workspace_id),
          WorkspaceSettings.findOne({ agency_id: invite.workspace_id }).select("logo_url"),
        ]);
        const tokenValue = generateToken({
          userId: user._id.toString(),
          agencyId: agency._id.toString(),
          role: existingMembership.role,
        });

        res.cookie("token", tokenValue, cookieOptions);

        return res.json({
          success: true,
          message: "Invitation already accepted.",
          user: authUser(user, agency, existingMembership.role, workspaceSettings),
        });
      }

      return res.status(409).json({
        success: false,
        message: "This invite has already been accepted.",
      });
    }

    const membership = await WorkspaceMember.findOneAndUpdate(
      {
        workspace_id: invite.workspace_id,
        user_id: user._id,
      },
      {
        $set: {
          role: invite.role,
          status: "active",
          removed_at: null,
        },
        $setOnInsert: {
          workspace_id: invite.workspace_id,
          user_id: user._id,
          joined_at: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    invite.status = "accepted";
    invite.accepted_by_user_id = user._id;
    invite.accepted_at = new Date();
    await invite.save();

    const [agency, workspaceSettings] = await Promise.all([
      Agency.findById(invite.workspace_id),
      WorkspaceSettings.findOne({ agency_id: invite.workspace_id }).select("logo_url"),
    ]);
    const authPayload = {
      userId: user._id.toString(),
      agencyId: agency._id.toString(),
      role: membership.role,
    };
    const tokenValue = generateToken(authPayload);

    res.cookie("token", tokenValue, cookieOptions);

    return res.json({
      success: true,
      message: "Invitation accepted.",
      user: authUser(user, agency, membership.role, workspaceSettings),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to accept invitation.",
    });
  }
};

export const removeWorkspaceMember = async (req, res) => {
  try {
    const workspaceId = req.user?.agencyId;
    const membership = await WorkspaceMember.findOne({
      _id: req.params.memberId,
      workspace_id: workspaceId,
      status: "active",
    });

    if (!membership) {
      return res.status(404).json({
        success: false,
        message: "Workspace member not found.",
      });
    }

    if (membership.role === "owner") {
      return res.status(400).json({
        success: false,
        message: "Workspace owner cannot be removed.",
      });
    }

    membership.status = "removed";
    membership.removed_at = new Date();
    await membership.save();

    return res.json({
      success: true,
      message: "Member removed from workspace.",
      member: serializeMember(membership),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to remove member.",
    });
  }
};
