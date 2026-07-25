import { Router } from "express";
import { protect } from "auth-module";

import {
  getIssue,
  getIssues,
  getIssueSignals,
  getIssueTimeline,
} from "../controllers/issues.controller.js";
import {
  createIssueIntervention,
  getIssueInterventions,
} from "../controllers/interventions.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const issueRouter = Router();

issueRouter.get("/", protect, requireWorkspaceMember, getIssues);
issueRouter.post("/:issueId/interventions", protect, requireWorkspaceMember, createIssueIntervention);
issueRouter.get("/:issueId/interventions", protect, requireWorkspaceMember, getIssueInterventions);
issueRouter.get("/:issueId/signals", protect, requireWorkspaceMember, getIssueSignals);
issueRouter.get("/:issueId/timeline", protect, requireWorkspaceMember, getIssueTimeline);
issueRouter.get("/:issueId", protect, requireWorkspaceMember, getIssue);

export default issueRouter;
