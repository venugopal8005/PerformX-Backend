import { Router, urlencoded } from "express";
import { meta } from "../controllers/meta.controller.js";
import { protect } from "../../../auth-module/src/middlewares/auth.middleware.js";
import { metaCallback } from "../controllers/meta.controller.js";
import { getAdAccounts } from "../controllers/getAdAccounts.controller.js";
import { selectAdAccount } from "../controllers/selectAdAccount.controller.js";
import { getCampaigns } from "../controllers/getCampaigns.controller.js";
import { getInsights } from "../controllers/getInsights.controller.js";
import { ConnectionStatus } from "../controllers/meta.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";
import {
  deauthorize,
  getDataDeletionStatus,
  requestDataDeletion,
} from "../controllers/metaCompliance.controller.js";
const metaRouter = Router();

const callbackFormParser = urlencoded({
  extended: false,
  limit: "10kb",
  parameterLimit: 5,
});

export const requireMetaCallbackForm = (req, res, next) => {
  if (!req.is("application/x-www-form-urlencoded")) {
    return res.status(415).json({
      success: false,
      code: "META_CALLBACK_CONTENT_TYPE_UNSUPPORTED",
      message: "Meta compliance callbacks require form-encoded data.",
    });
  }

  return callbackFormParser(req, res, (error) => {
    if (!error) return next();
    const tooLarge = error.type === "entity.too.large";
    return res.status(tooLarge ? 413 : 400).json({
      success: false,
      code: tooLarge ? "META_CALLBACK_BODY_TOO_LARGE" : "META_CALLBACK_BODY_INVALID",
      message: tooLarge
        ? "Meta compliance callback body is too large."
        : "Meta compliance callback body is invalid.",
    });
  });
};

metaRouter.post("/deauthorize", requireMetaCallbackForm, deauthorize);
metaRouter.post("/data-deletion", requireMetaCallbackForm, requestDataDeletion);
metaRouter.get("/data-deletion/status/:confirmationCode", getDataDeletionStatus);

metaRouter.get("/connect", protect, requireWorkspaceMember, meta);
metaRouter.get("/callback",protect,metaCallback);
metaRouter.get("/status", protect, requireWorkspaceMember, ConnectionStatus);
metaRouter.get("/ad-accounts", protect, requireWorkspaceMember, getAdAccounts);
metaRouter.post("/select-account", protect, requireWorkspaceMember, selectAdAccount);
metaRouter.get("/campaigns", protect, requireWorkspaceMember, getCampaigns);
metaRouter.get("/insights", protect, requireWorkspaceMember, getInsights);

export default metaRouter;
