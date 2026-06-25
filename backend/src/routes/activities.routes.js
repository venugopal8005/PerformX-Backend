import { Router } from "express";
import { protect } from "auth-module";
import { getActivities } from "../controllers/activities.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const activityRouter = Router();

activityRouter.get("/", protect, requireWorkspaceMember, getActivities);

export default activityRouter;
