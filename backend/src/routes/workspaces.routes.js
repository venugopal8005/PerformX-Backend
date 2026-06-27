import { Router } from "express";
import { protect } from "auth-module";

import { createWorkspaceInvite } from "../controllers/team.controller.js";

const workspacesRouter = Router();

workspacesRouter.post("/:workspaceId/invites", protect, createWorkspaceInvite);

export default workspacesRouter;
