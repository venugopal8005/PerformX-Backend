import { Router } from "express";
import { protect } from "auth-module";
import { getSignals } from "../controllers/signals.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const signalRouter = Router();

signalRouter.get("/", protect, requireWorkspaceMember, getSignals);

export default signalRouter;
