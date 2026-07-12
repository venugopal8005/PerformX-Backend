import { Router } from "express";
import { protect } from "auth-module";

import {
  approveAndSendClientReport,
  cancelClientReport,
  getReportRunQuickLook,
} from "../controllers/reportRuns.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";

const reportRunsRouter = Router();

reportRunsRouter.get(
  "/:reportRunId/quick-look",
  protect,
  requireWorkspaceMember,
  getReportRunQuickLook
);

reportRunsRouter.post(
  "/:reportRunId/client-report/approve-send",
  protect,
  requireWorkspaceMember,
  approveAndSendClientReport
);

reportRunsRouter.post(
  "/:reportRunId/client-report/cancel",
  protect,
  requireWorkspaceMember,
  cancelClientReport
);

export default reportRunsRouter;
