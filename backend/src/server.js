import express from "express";
import mongoose from "mongoose";
import cookieParser from "cookie-parser";
import cors from "cors";
import { initAuth } from "auth-module";
import "dotenv/config";
import taskRouter from "../src/routes/task.routes.js"

const app = express();

//middleware
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use("/api/tasks", taskRouter);


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
