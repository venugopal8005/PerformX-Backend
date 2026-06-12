import { Router } from "express";
import { protect } from "auth-module";
import { getActivities } from "../controllers/activities.controller.js";

const activityRouter = Router();

activityRouter.get("/", protect, getActivities);

export default activityRouter;
