import { Agency, User, WorkspaceMember } from "../models/index.js";

const idsMatch = (left, right) =>
  left && right && left.toString() === right.toString();

const getUserId = (req) => req.user?.userId || req.user?.id || req.user?._id;

const getUserAgencyId = (user) => user?.agencyId || user?.agency_id;

export const ensureWorkspaceMembership = async (req, res, next) => {
  try {
    const workspaceId = req.user?.agencyId;
    const userId = getUserId(req);

    if (!workspaceId || !userId) {
      return res.status(401).json({
        success: false,
        message: "Workspace context missing from auth token",
      });
    }

    let membership = await WorkspaceMember.findOne({
      workspace_id: workspaceId,
      user_id: userId,
      status: "active",
    });

    if (!membership) {
      const activeMemberCount = await WorkspaceMember.countDocuments({
        workspace_id: workspaceId,
        status: "active",
      });

      // Dev-safe migration path: old workspaces predate WorkspaceMember.
      // If the current user owns that legacy workspace, create the owner row.
      if (activeMemberCount === 0) {
        const [agency, user] = await Promise.all([
          Agency.findById(workspaceId),
          User.findById(userId),
        ]);
        const userBelongsToWorkspace = idsMatch(getUserAgencyId(user), workspaceId);
        const userLooksLikeOwner =
          user?.role === "owner" || idsMatch(agency?.created_by, userId);

        if (agency && user && userBelongsToWorkspace && userLooksLikeOwner) {
          membership = await WorkspaceMember.findOneAndUpdate(
            {
              workspace_id: workspaceId,
              user_id: userId,
            },
            {
              $set: {
                role: "owner",
                status: "active",
                removed_at: null,
              },
              $setOnInsert: {
                workspace_id: workspaceId,
                user_id: userId,
                joined_at: user.createdAt || agency.createdAt || new Date(),
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
        }
      }
    }

    if (!membership) {
      return res.status(403).json({
        success: false,
        message: "You no longer have access to this workspace.",
      });
    }

    req.workspaceId = workspaceId;
    req.workspaceMembership = membership;
    req.user.workspaceRole = membership.role;
    return next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Workspace access check failed",
    });
  }
};

export const requireWorkspaceMember = ensureWorkspaceMembership;

export const requireWorkspaceOwner = async (req, res, next) => {
  await ensureWorkspaceMembership(req, res, () => {
    if (req.workspaceMembership?.role !== "owner") {
      return res.status(403).json({
        success: false,
        message: "Only workspace owners can do this.",
      });
    }

    return next();
  });
};
