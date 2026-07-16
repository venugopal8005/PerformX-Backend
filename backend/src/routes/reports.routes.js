import { Router } from "express";
import {
  createReport,
  deleteReport,
  getArchivedReports,
  getReport,
  getReportHistory,
  getReports,
  startReport,
  updateReport,
} from "../controllers/reports.controller.js";
import { runReport } from "../controllers/runReport.controller.js";
import { protect } from "../../../auth-module/index.js";
import { manualSendReport } from "../controllers/manualSend.controller.js";
import { runAllReports } from "../controllers/runAll.controller.js";
import { requireWorkspaceMember } from "../middlewares/workspaceAccess.js";
import { requireReportExecutionIntegrity } from "../middlewares/reportExecutionIntegrity.js";
import crypto from "crypto";


const reportRouter = Router();

const protectWorkspaceOrScheduler = (req, res, next) => {
  const expected = process.env.SCHEDULER_SECRET;
  const provided = req.get("x-scheduler-secret") || "";

  if (expected && provided) {
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (
      expectedBuffer.length === providedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      req.schedulerAuthorized = true;
      return next();
    }
  }

  return protect(req, res, () => requireWorkspaceMember(req, res, next));
};

reportRouter.post("/create", protect, requireWorkspaceMember, createReport);
reportRouter.post("/start-report", protect, requireWorkspaceMember, startReport);
reportRouter.get(
  "/run-report",
  protect,
  requireWorkspaceMember,
  requireReportExecutionIntegrity,
  runReport
);
reportRouter.post(
  "/manual-send",
  protect,
  requireWorkspaceMember,
  requireReportExecutionIntegrity,
  manualSendReport
);
reportRouter.get(
  "/run-all",
  protectWorkspaceOrScheduler,
  requireReportExecutionIntegrity,
  runAllReports
);
reportRouter.get("/get-reports", protect, requireWorkspaceMember, getReports);
reportRouter.get("/archived", protect, requireWorkspaceMember, getArchivedReports);
reportRouter.get("/:reportId/history", protect, requireWorkspaceMember, getReportHistory);
reportRouter.get("/:reportId", protect, requireWorkspaceMember, getReport);
reportRouter.patch("/update-report", protect, requireWorkspaceMember, updateReport);
reportRouter.delete("/delete-report", protect, requireWorkspaceMember, deleteReport);
reportRouter.delete("/delete-report/:reportId", protect, requireWorkspaceMember, deleteReport);
export default reportRouter;
