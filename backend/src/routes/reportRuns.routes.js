import { Router } from "express";
import { protect } from "auth-module";

import {
  approveAndSendClientReport,
  cancelClientReport,
  getHistoricalArtifact,
  getHistoricalReportRun,
  getHistoricalReportRuns,
  getReportRunQuickLook,
} from "../controllers/reportRuns.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";
import { requireReportExecutionIntegrity } from "../middlewares/reportExecutionIntegrity.js";

const reportRunsRouter = Router();

reportRunsRouter.get(
  "/",
  protect,
  requireWorkspaceMember,
  getHistoricalReportRuns
);

reportRunsRouter.get(
  "/:reportRunId/artifacts/:audience",
  protect,
  requireWorkspaceMember,
  getHistoricalArtifact
);

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
  requireReportExecutionIntegrity,
  approveAndSendClientReport
);

reportRunsRouter.get(
  "/:reportRunId",
  protect,
  requireWorkspaceMember,
  getHistoricalReportRun
);

reportRunsRouter.post(
  "/:reportRunId/client-report/cancel",
  protect,
  requireWorkspaceMember,
  cancelClientReport
);

export default reportRunsRouter;
