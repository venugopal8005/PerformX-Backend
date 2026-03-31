import mongoose from "mongoose";

const subtaskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    done: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true }
);

const taskSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ["todo", "doing", "done"],
      default: "todo",
    },

    priority: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },

    subtasks: [subtaskSchema],

    dueDate: {
      type: Date,
      default: null,
    },

    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  }
);

export const Task = mongoose.model("Task", taskSchema);
