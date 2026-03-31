import { Task } from "../models/tasks/task.model.js";

export const updateTask = async (req, res) => {
  try {
    console.log(req.body);
    console.log("Task reached for update");
    const { _id, subtasks, ...rest } = req.body;
    const normalizedSubtasks = (subtasks || []).map((s) =>
      typeof s === "string" ? { title: s } : s,
    );
    const task = await Task.findOneAndUpdate(
      { _id  },
      { $set: { ...rest, subtasks: normalizedSubtasks } },
      { new: true, runValidators: true },
    );

    if (!task) {
      console.log("Task not Found");
      return res.status(404).json({ message: "Task not found" });
    }
    console.log("Task updated Successfully");
    return res.status(200).json({
      message: "Task updated successfully",
      task,
    });
  } catch (error) {
    console.error("Task failed to update", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const createTask = async (req, res) => {
  console.log("task initilised");

  try {
    const { title, priority, dueDate, subtasks } = req.body;
    // console.log("task initilised");
    console.log(req.body);

    // 1. Validate required fields
    if (!title || title.trim() === "") {
      return res.status(400).json({ message: "Task title is required" });
    }
    const normalizedSubtasks = (subtasks || []).map((s) =>
      typeof s === "string" ? { title: s } : s,
    );
    // 2. Create task with OWNER FROM AUTH
    const task = await Task.create({
      title: title.trim(),
      priority,
      dueDate,
      subtasks: normalizedSubtasks,
      owner: req.user.id, // 🔒 comes from token, not client
    });
    console.log("Task created - " + task.title);
    res.status(201).json({
      task,
    });
  } catch (err) {
    console.log("Failed to create task");
    res.status(500).json({
      message: "Failed to create task",
      error: err.message,
    });
  }
};
export const getTasks = async (req, res) => {
  try {
    const userId = req.user.id; // set by protect middleware

    const tasks = await Task.find({ owner: userId }).sort({ createdAt: -1 }); // newest first (optional)
    console.log("getting tasks in to the dashbaord");
    res.status(200).json({
      tasks,
    });
  } catch (err) {
    console.log("fetching tasks failed!!");
    res.status(500).json({
      message: "Failed to fetch tasks",
      error: err.message,
    });
  }
};
export const toggleSubtask = async (req, res) => {
  console.log("Toggle subtask initiated!!");
  try {
    const { taskId, subtaskId } = req.params;
    const { done } = req.body;

    const task = await Task.findOneAndUpdate(
      { _id: taskId, "subtasks._id": subtaskId },
      { $set: { "subtasks.$.done": done } },
      { new: true },
    );

    if (!task) {
      console.log("Task or subtask not found");
      return res.status(404).json({
        message: "Task or subtask not found",
      });
    }
    console.log("Subtask updated");
    return res.status(200).json({
      message: "Subtask updated",
      task,
    });
  } catch (error) {
    console.error("Failed to toggle subtask", error);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};
