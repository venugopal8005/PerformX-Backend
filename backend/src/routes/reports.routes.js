import { Router } from "express";
import {
  createReport,
  deleteReport,
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


const reportRouter = Router();

reportRouter.post("/create", protect, requireWorkspaceMember, createReport);
reportRouter.post("/start-report", protect, requireWorkspaceMember, startReport);
reportRouter.get("/run-report", runReport);
reportRouter.post("/manual-send", protect, requireWorkspaceMember, manualSendReport);
reportRouter.get("/run-all",runAllReports);
reportRouter.get("/get-reports", protect, requireWorkspaceMember, getReports);
reportRouter.get("/:reportId/history", protect, requireWorkspaceMember, getReportHistory);
reportRouter.get("/:reportId", protect, requireWorkspaceMember, getReport);
reportRouter.patch("/update-report", protect, requireWorkspaceMember, updateReport);
reportRouter.delete("/delete-report", protect, requireWorkspaceMember, deleteReport);
reportRouter.delete("/delete-report/:reportId", protect, requireWorkspaceMember, deleteReport);
export default reportRouter;
