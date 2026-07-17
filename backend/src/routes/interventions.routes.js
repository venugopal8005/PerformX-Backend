import { Router } from "express";
import { protect } from "auth-module";

import {
  cancelIntervention,
  correctIntervention,
  getIntervention,
  getInterventions,
} from "../controllers/interventions.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const interventionRouter = Router();

interventionRouter.get("/", protect, requireWorkspaceMember, getInterventions);
interventionRouter.get("/:interventionId", protect, requireWorkspaceMember, getIntervention);
interventionRouter.post("/:interventionId/cancel", protect, requireWorkspaceMember, cancelIntervention);
interventionRouter.post(
  "/:interventionId/corrections",
  protect,
  requireWorkspaceMember,
  correctIntervention
);

export default interventionRouter;
