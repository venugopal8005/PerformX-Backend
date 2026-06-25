import { Router } from "express";
import { protect } from "auth-module";
import {
  assignMetaAdAccount,
  changePassword,
  getBilling,
  getEmailSettings,
  getMetaAdAccounts,
  getMetaConnections,
  getMetaOverview,
  getNotifications,
  getProfile,
  getReportDefaults,
  getSecurity,
  getWorkspace,
  metaSettingsCallback,
  refreshMetaAdAccountCampaigns,
  removeMetaAdAccount,
  removeMetaConnection,
  reconnectMetaConnection,
  startMetaConnection,
  syncAllMetaConnections,
  syncMetaConnection,
  updateNotifications,
  sendTestEmail,
  updateEmailSettings,
  updateProfile,
  updateReportDefaults,
  updateWorkspace,
} from "../controllers/settings.controller.js";
import {
  acceptWorkspaceInvite,
  createWorkspaceInvite,
  getTeamSettings,
  removeWorkspaceMember,
  resendWorkspaceInvite,
  revokeWorkspaceInvite,
  verifyWorkspaceInvite,
} from "../controllers/team.controller.js";
import {
  requireWorkspaceMember,
  requireWorkspaceOwner,
} from "../middlewares/workspaceAccess.js";

const settingsRouter = Router();

settingsRouter.get("/team/invites/verify", verifyWorkspaceInvite);
settingsRouter.post("/team/invites/accept", protect, acceptWorkspaceInvite);
settingsRouter.get("/team", protect, requireWorkspaceMember, getTeamSettings);
settingsRouter.post("/team/invites", protect, requireWorkspaceOwner, createWorkspaceInvite);
settingsRouter.post(
  "/team/invites/:inviteId/resend",
  protect,
  requireWorkspaceOwner,
  resendWorkspaceInvite
);
settingsRouter.post(
  "/team/invites/:inviteId/revoke",
  protect,
  requireWorkspaceOwner,
  revokeWorkspaceInvite
);
settingsRouter.delete(
  "/team/members/:memberId",
  protect,
  requireWorkspaceOwner,
  removeWorkspaceMember
);

settingsRouter.get("/profile", protect, requireWorkspaceMember, getProfile);
settingsRouter.patch("/profile", protect, requireWorkspaceMember, updateProfile);

settingsRouter.get("/workspace", protect, requireWorkspaceMember, getWorkspace);
settingsRouter.patch("/workspace", protect, requireWorkspaceOwner, updateWorkspace);

settingsRouter.get("/email", protect, requireWorkspaceMember, getEmailSettings);
settingsRouter.patch("/email", protect, requireWorkspaceMember, updateEmailSettings);
settingsRouter.post("/email/test", protect, requireWorkspaceMember, sendTestEmail);

settingsRouter.get("/meta/overview", protect, requireWorkspaceMember, getMetaOverview);
settingsRouter.get("/meta/connect/start", protect, requireWorkspaceMember, startMetaConnection);
settingsRouter.post("/meta/connect/start", protect, requireWorkspaceMember, startMetaConnection);
settingsRouter.get("/meta/callback", metaSettingsCallback);
settingsRouter.get("/meta/connections", protect, requireWorkspaceMember, getMetaConnections);
settingsRouter.post(
  "/meta/connections/:connectionId/reconnect",
  protect,
  requireWorkspaceMember,
  reconnectMetaConnection
);
settingsRouter.post("/meta/connections/:connectionId/sync", protect, requireWorkspaceMember, syncMetaConnection);
settingsRouter.post("/meta/sync-all", protect, requireWorkspaceMember, syncAllMetaConnections);
settingsRouter.delete("/meta/connections/:connectionId", protect, requireWorkspaceMember, removeMetaConnection);

settingsRouter.get("/meta/ad-accounts", protect, requireWorkspaceMember, getMetaAdAccounts);
settingsRouter.patch(
  "/meta/ad-accounts/:adAccountId/assign-client",
  protect,
  requireWorkspaceMember,
  assignMetaAdAccount
);
settingsRouter.post(
  "/meta/ad-accounts/:adAccountId/refresh-campaigns",
  protect,
  requireWorkspaceMember,
  refreshMetaAdAccountCampaigns
);
settingsRouter.delete("/meta/ad-accounts/:adAccountId", protect, requireWorkspaceMember, removeMetaAdAccount);

settingsRouter.get("/report-defaults", protect, requireWorkspaceMember, getReportDefaults);
settingsRouter.patch("/report-defaults", protect, requireWorkspaceMember, updateReportDefaults);

settingsRouter.get("/notifications", protect, requireWorkspaceMember, getNotifications);
settingsRouter.patch("/notifications", protect, requireWorkspaceMember, updateNotifications);

settingsRouter.get("/billing", protect, requireWorkspaceMember, getBilling);

settingsRouter.get("/security", protect, requireWorkspaceMember, getSecurity);
settingsRouter.post("/security/change-password", protect, requireWorkspaceMember, changePassword);

export default settingsRouter;
