import { Router } from "express";
import { protect } from "auth-module";

import {
  acceptWorkspaceInvite,
  verifyWorkspaceInvite,
} from "../controllers/team.controller.js";

const invitesRouter = Router();

invitesRouter.get("/:token", verifyWorkspaceInvite);
invitesRouter.post("/:token/accept", protect, acceptWorkspaceInvite);

export default invitesRouter;
