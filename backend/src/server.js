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
import { startN8NScheduler } from "./jobs/n8nScheduler.js";

startN8NScheduler();
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

// db
try {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Database connected successfully");
} catch (error) {
  console.error("Database connection failed:", error);
  process.exit(1);
}

// auth module
initAuth({ app, db: mongoose });

// health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok yeah but new" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
