import express from "express";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import cors from "cors";
import { initAuth } from "auth-module";
import "dotenv/config";

import metaRouter from "./routes/meta.routes.js";
import reportRouter from "./routes/reports.routes.js";
import activityRouter from "./routes/activities.routes.js";
import clientRouter from "./routes/clients.routes.js";
import signalRouter from "./routes/signals.routes.js";
import settingsRouter from "./routes/settings.routes.js";
import invitesRouter from "./routes/invites.routes.js";
import workspacesRouter from "./routes/workspaces.routes.js";
import reportRunsRouter from "./routes/reportRuns.routes.js";
import { startN8NScheduler } from "./jobs/n8nScheduler.js";
import {
  Activity,
  ReportRun,
  Signal,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceSettings,
} from "./models/index.js";
import { initializeExecutionIntegrity } from "./services/executionIntegrityIndexes.service.js";
import { connectMongooseWithIndexManagementDisabled } from "./services/mongooseConnection.service.js";
import { logAction, logError } from "./utils/controllerLogger.js";

const app = express();

//middleware
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

app.use("/api/meta", metaRouter);
app.use("/api/reports", reportRouter);
app.use("/api/clients", clientRouter);
app.use("/api/signals", signalRouter);
app.use("/api/activities", activityRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/invites", invitesRouter);
app.use("/api/workspaces", workspacesRouter);
app.use("/api/report-runs", reportRunsRouter);

// db
try {
  await connectMongooseWithIndexManagementDisabled({
    mongooseInstance: mongoose,
    uri: process.env.MONGO_URI,
  });
  console.log("Database connected successfully");
} catch (error) {
  console.error("Database connection failed:", error);
  process.exit(1);
}

const executionIntegrity = await initializeExecutionIntegrity({
  models: { ReportRun, Signal, Activity },
  startScheduler: startN8NScheduler,
});

if (executionIntegrity.ready) {
  logAction(
    "ExecutionIntegrity",
    "STARTUP_VERIFIED",
    {
      indexes: executionIntegrity.results.map((result) => ({
        modelName: result.modelName,
        field: result.field,
        status: result.status,
      })),
    },
    "green"
  );
} else {
  logError(
    "ExecutionIntegrity",
    "STARTUP_VERIFICATION_FAILED",
    executionIntegrity.error
  );
}

// auth module
initAuth({
  app,
  db: mongoose,
  options: {
    models: {
      WorkspaceInvite,
      WorkspaceMember,
      WorkspaceSettings,
    },
  },
});

// health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok yeah but new" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
