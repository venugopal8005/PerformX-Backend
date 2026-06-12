import mongoose from "mongoose";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const monitoredCampaignSchema = new mongoose.Schema(
  {
    campaign_id: {
      type: String,
      required: true,
      trim: true,
    },
    campaign_name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { _id: false }
);

const scheduleSchema = new mongoose.Schema(
  {
    timezone: {
      type: String,
      required: true,
      trim: true,
      default: "Asia/Kolkata",
      validate: {
        validator(value) {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: value }).format(
              new Date()
            );
            return true;
          } catch {
            return false;
          }
        },
        message: "schedule.timezone is invalid",
      },
    },
    time_of_day: {
      type: String,
      required: true,
      trim: true,
      match: TIME_OF_DAY_PATTERN,
    },
    day_of_week: {
      type: Number,
      min: 0,
      max: 6,
      default: null,
    },
    day_of_month: {
      type: Number,
      min: 1,
      max: 31,
      default: null,
    },
  },
  { _id: false }
);

const reportSchema = new mongoose.Schema(
  {
    agency_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agency",
      required: true,
      index: true,
    },
    client_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 140,
    },
    type: {
      type: String,
      enum: ["daily", "weekly", "monthly"],
      required: true,
      default: "daily",
    },
    status: {
      type: String,
      enum: ["active", "paused"],
      required: true,
      default: "paused",
    },
    severity: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
      default: "low",
    },
    recipients: {
      type: [
        {
          type: String,
          trim: true,
          lowercase: true,
          validate: {
            validator(value) {
              return EMAIL_PATTERN.test(value);
            },
            message: "recipient email is invalid",
          },
        },
      ],
      default: [],
    },
    monitored_campaigns: {
      type: [monitoredCampaignSchema],
      default: [],
    },
    last_summary: {
      type: String,
      trim: true,
      default: null,
    },
    last_signal_at: {
      type: Date,
      default: null,
    },
    next_run_at: {
      type: Date,
      default: null,
    },
    last_run_at: {
      type: Date,
      default: null,
    },
    schedule: {
      type: scheduleSchema,
      required: true,
    },
  },
  {
    timestamps: true,
    collection: "reports",
  }
);

reportSchema.index({ agency_id: 1, client_id: 1 });
reportSchema.index({ agency_id: 1, status: 1 });
reportSchema.index({ agency_id: 1, severity: 1 });
reportSchema.index({ agency_id: 1, next_run_at: 1 });
reportSchema.index({ client_id: 1, status: 1 });

reportSchema.pre("validate", function validateSchedule() {
  if (!this.schedule) {
    this.schedule = {};
  }

  if (this.type === "daily") {
    this.schedule.day_of_week = null;
    this.schedule.day_of_month = null;
    return;
  }

  if (this.type === "weekly") {
    this.schedule.day_of_month = null;

    if (!Number.isInteger(this.schedule.day_of_week)) {
      this.invalidate(
        "schedule.day_of_week",
        "weekly reports require schedule.day_of_week"
      );
    }
  }

  if (this.type === "monthly") {
    this.schedule.day_of_week = null;

    if (!Number.isInteger(this.schedule.day_of_month)) {
      this.invalidate(
        "schedule.day_of_month",
        "monthly reports require schedule.day_of_month"
      );
    }
  }
});

export const Report =
  mongoose.models.Report || mongoose.model("Report", reportSchema);

export default Report;
