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

const safetySettingsSchema = new mongoose.Schema(
  {
    hold_client_report_on_low_trust: {
      type: Boolean,
      default: true,
    },
    hold_client_report_on_missing_metrics: {
      type: Boolean,
      default: true,
    },
    hold_client_report_on_insufficient_data: {
      type: Boolean,
      default: true,
    },
    notify_team_when_held: {
      type: Boolean,
      default: true,
    },
  },
  { _id: false }
);

const executionLockSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      enum: ["manual", "scheduled", "api"],
      required: true,
    },
    acquired_at: {
      type: Date,
      required: true,
    },
    expires_at: {
      type: Date,
      required: true,
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
    meta_ad_account_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MetaAdAccount",
      default: null,
      index: true,
    },
    meta_account_external_id_snapshot: {
      type: String,
      trim: true,
      default: null,
    },
    meta_account_name_snapshot: {
      type: String,
      trim: true,
      default: null,
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
    internal_recipients: {
      type: [
        {
          type: String,
          trim: true,
          lowercase: true,
          validate: {
            validator(value) {
              return EMAIL_PATTERN.test(value);
            },
            message: "internal recipient email is invalid",
          },
        },
      ],
      default: [],
    },
    client_recipients: {
      type: [
        {
          type: String,
          trim: true,
          lowercase: true,
          validate: {
            validator(value) {
              return EMAIL_PATTERN.test(value);
            },
            message: "client recipient email is invalid",
          },
        },
      ],
      default: [],
    },
    generate_client_report: {
      type: Boolean,
      default: true,
      required: true,
    },
    generate_internal_report: {
      type: Boolean,
      default: true,
      required: true,
    },
    client_delivery_mode: {
      type: String,
      enum: ["generate_only", "auto_send", "approval_required"],
      default: "generate_only",
      required: true,
    },
    safety_settings: {
      type: safetySettingsSchema,
      default: () => ({}),
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
    execution_lock: {
      type: executionLockSchema,
      default: undefined,
      select: false,
    },
    is_archived: {
      type: Boolean,
      default: false,
      required: true,
      index: true,
    },
    archived_at: {
      type: Date,
      default: null,
    },
    archived_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
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
reportSchema.index({ agency_id: 1, meta_ad_account_id: 1 });
reportSchema.index({ agency_id: 1, status: 1 });
reportSchema.index({ agency_id: 1, severity: 1 });
reportSchema.index({ agency_id: 1, next_run_at: 1 });
reportSchema.index({ agency_id: 1, is_archived: 1, createdAt: -1 });
reportSchema.index({ agency_id: 1, is_archived: 1, archived_at: -1, _id: -1 });
reportSchema.index(
  { agency_id: 1, client_id: 1, is_archived: 1, archived_at: -1, _id: -1 },
  {
    name: "phase1e_reports_client_archived_cursor",
    unique: false,
    sparse: false,
  }
);
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
