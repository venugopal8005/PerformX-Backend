import { Router } from "express";
import { createTask, getTasks } from "../controllers/task.controller.js";
import { protect } from "../../../auth-module/src/middlewares/auth.middleware.js";
import { updateTask,toggleSubtask } from "../controllers/task.controller.js";

const taskRouter = Router();

taskRouter.post("/", protect, createTask);
taskRouter.get("/", protect, getTasks);
taskRouter.post("/update-task", protect, updateTask);
taskRouter.patch("/:taskId/subtasks/:subtaskId", toggleSubtask);

export default taskRouter;
