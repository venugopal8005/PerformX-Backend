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


const reportRouter = Router();

reportRouter.post("/create", protect, createReport);
reportRouter.post("/start-report", protect, startReport);
reportRouter.get("/run-report", runReport);
reportRouter.post("/manual-send", protect, manualSendReport);
reportRouter.get("/run-all",runAllReports);
reportRouter.get("/get-reports",protect,getReports);
reportRouter.get("/:reportId/history", protect, getReportHistory);
reportRouter.get("/:reportId", protect, getReport);
reportRouter.patch("/update-report", protect, updateReport);
reportRouter.delete("/delete-report", protect, deleteReport);
reportRouter.delete("/delete-report/:reportId", protect, deleteReport);
export default reportRouter;
