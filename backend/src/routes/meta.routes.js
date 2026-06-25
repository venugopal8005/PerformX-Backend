import { Router } from "express";
import { meta } from "../controllers/meta.controller.js";
import { protect } from "../../../auth-module/src/middlewares/auth.middleware.js";
import { metaCallback } from "../controllers/meta.controller.js";
import { getAdAccounts } from "../controllers/getAdAccounts.controller.js";
import { selectAdAccount } from "../controllers/selectAdAccount.controller.js";
import { getCampaigns } from "../controllers/getCampaigns.controller.js";
import { getInsights } from "../controllers/getInsights.controller.js";
import { ConnectionStatus } from "../controllers/meta.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";
const metaRouter = Router();

metaRouter.get("/connect", protect, requireWorkspaceMember, meta);
metaRouter.get("/callback",protect,metaCallback);
metaRouter.get("/status", protect, requireWorkspaceMember, ConnectionStatus);
metaRouter.get("/ad-accounts", protect, requireWorkspaceMember, getAdAccounts);
metaRouter.post("/select-account", protect, requireWorkspaceMember, selectAdAccount);
metaRouter.get("/campaigns", protect, requireWorkspaceMember, getCampaigns);
metaRouter.get("/insights", protect, requireWorkspaceMember, getInsights);

export default metaRouter;
