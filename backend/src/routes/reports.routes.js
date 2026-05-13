import { Router } from "express";
import { createReport } from "../controllers/reports.controller.js";
import { startReport } from "../controllers/reports.controller.js";
import { runReport } from "../controllers/runReport.controller.js";
import { protect } from "../../../auth-module/index.js";
import { manualSendReport } from "../controllers/manualSend.controller.js";
import { runAllReports } from "../controllers/runAll.controller.js";
import { getReports } from "../controllers/reports.controller.js";


const reportRouter = Router();

reportRouter.post("/create", protect, createReport);
reportRouter.post("/start-report", protect, startReport);
reportRouter.get("/run-report", runReport);
reportRouter.post("/manual-send",manualSendReport);
reportRouter.get("/run-all",runAllReports);
reportRouter.get("/get-reports",protect,getReports);
export default reportRouter;
