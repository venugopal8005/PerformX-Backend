import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true,
    },
    ad_account_id: {
        type: String,
        required: true,
    },
    email: {
        type: String,
        required: true,
        trim: true,
    },
    frequency: {
        type: String,
        enum: ["15-min","hourly","daily", "weekly", "monthly"],
        required: true,
    },
    is_active: {
        type: Boolean,
        default: false,
    },
    last_run_at: {
        type: Date,
        default: null,
    },
    next_run_at: {
        type: Date,
        default: null,
    },
}, { timestamps: true });
export const Report = mongoose.model("Report", reportSchema);