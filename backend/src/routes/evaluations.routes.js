import { Router } from "express";
import { protect } from "auth-module";

import { getEvaluation, getEvaluations } from "../controllers/evaluations.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const router = Router();
router.get("/", protect, requireWorkspaceMember, getEvaluations);
router.get("/:evaluationId", protect, requireWorkspaceMember, getEvaluation);
export default router;

