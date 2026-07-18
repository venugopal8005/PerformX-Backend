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
import issuesRouter from "./routes/issues.routes.js";
import interventionsRouter from "./routes/interventions.routes.js";
import evaluationsRouter from "./routes/evaluations.routes.js";
import { startN8NScheduler } from "./jobs/n8nScheduler.js";
import {
  Activity,
  Intervention,
  Evaluation,
  EvaluationSeries,
  Issue,
  ReportRun,
  Signal,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceSettings,
} from "./models/index.js";
import { initializeExecutionIntegrity } from "./services/executionIntegrityIndexes.service.js";
import { initializePhase2IssueIntegrity } from "./services/phase2IssueIndexes.service.js";
import { initializePhase3InterventionIntegrity } from "./services/phase3InterventionIndexes.service.js";
import { initializePhase4EvaluationIntegrity } from "./services/phase4EvaluationIndexes.service.js";
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
app.use("/api/issues", issuesRouter);
app.use("/api/interventions", interventionsRouter);
app.use("/api/evaluations", evaluationsRouter);

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
});

let phase2IssueIntegrity;
try {
  phase2IssueIntegrity = await initializePhase2IssueIntegrity({
    collections: {
      issues: Issue.collection,
      signals: Signal.collection,
    },
  });
} catch (error) {
  phase2IssueIntegrity = { ready: false, error };
}

let phase3InterventionIntegrity;
try {
  phase3InterventionIntegrity = await initializePhase3InterventionIntegrity({
    collection: Intervention.collection,
  });
} catch (error) {
  phase3InterventionIntegrity = { ready: false, error };
}

let phase4EvaluationIntegrity;
try {
  phase4EvaluationIntegrity = await initializePhase4EvaluationIntegrity({
    collections: {
      evaluations: Evaluation.collection,
      evaluation_series: EvaluationSeries.collection,
    },
  });
} catch (error) {
  phase4EvaluationIntegrity = { ready: false, error };
}

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

if (phase2IssueIntegrity.ready) {
  logAction(
    "Phase2IssueIntegrity",
    "STARTUP_VERIFIED",
    {
      indexes: phase2IssueIntegrity.results.map((result) => ({
        collection: result.collection,
        name: result.expectedName,
        status: result.classification,
      })),
    },
    "green"
  );
} else {
  logError(
    "Phase2IssueIntegrity",
    "STARTUP_VERIFICATION_FAILED",
    phase2IssueIntegrity.error || new Error("Critical Phase 2 Issue indexes are absent.")
  );
}

if (phase3InterventionIntegrity.ready) {
  logAction(
    "Phase3InterventionIntegrity",
    "STARTUP_VERIFIED",
    {
      indexes: phase3InterventionIntegrity.results.map((result) => ({
        collection: result.collection,
        name: result.expectedName,
        status: result.classification,
      })),
    },
    "green"
  );
} else {
  logError(
    "Phase3InterventionIntegrity",
    "STARTUP_VERIFICATION_FAILED",
    phase3InterventionIntegrity.error || new Error("Required Phase 3 Intervention indexes are absent.")
  );
}

if (phase4EvaluationIntegrity.ready) {
  logAction("Phase4EvaluationIntegrity", "STARTUP_VERIFIED", {
    indexes: phase4EvaluationIntegrity.results.map((result) => ({ collection: result.collection, name: result.expectedName, status: result.classification })),
  }, "green");
} else {
  logError("Phase4EvaluationIntegrity", "STARTUP_VERIFICATION_FAILED", phase4EvaluationIntegrity.error || new Error("Required Phase 4 Evaluation indexes are absent."));
}

if (executionIntegrity.ready && phase2IssueIntegrity.ready) {
  await startN8NScheduler();
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
