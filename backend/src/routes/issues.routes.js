import { Router } from "express";
import { protect } from "auth-module";

import {
  getIssue,
  getIssues,
  getIssueSignals,
} from "../controllers/issues.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const issueRouter = Router();

issueRouter.get("/", protect, requireWorkspaceMember, getIssues);
issueRouter.get("/:issueId/signals", protect, requireWorkspaceMember, getIssueSignals);
issueRouter.get("/:issueId", protect, requireWorkspaceMember, getIssue);

export default issueRouter;
