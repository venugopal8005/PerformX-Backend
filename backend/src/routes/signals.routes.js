import { Router } from "express";
import { protect } from "auth-module";
import { getSignals } from "../controllers/signals.controller.js";

const signalRouter = Router();

signalRouter.get("/", protect, getSignals);

export default signalRouter;
