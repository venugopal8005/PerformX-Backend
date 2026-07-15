import { Activity } from "../models/Activity.js";

export const recordActivity = async ({
  agency_id,
  client_id = null,
  report_id = null,
  user_id = null,
  type,
  title,
  description = null,
  severity = "stable",
  metadata = {},
  idempotency_key,
  session = null,
  ActivityModel = Activity,
}) => {
  if (!agency_id) throw new Error("agency_id is required to record activity");
  if (!type) throw new Error("activity type is required");
  if (!title) throw new Error("activity title is required");

  const document = {
    agency_id,
    client_id,
    report_id,
    user_id,
    ...(idempotency_key ? { idempotency_key } : {}),
    type,
    title,
    description,
    severity,
    metadata,
  };

  if (!idempotency_key) {
    if (!session) return ActivityModel.create(document);
    const [activity] = await ActivityModel.create([document], { session });
    return activity;
  }

  try {
    return await ActivityModel.findOneAndUpdate(
      { idempotency_key },
      { $setOnInsert: document },
      { upsert: true, new: true, setDefaultsOnInsert: true, ...(session ? { session } : {}) }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return ActivityModel.findOne({ idempotency_key });
  }
};

export const recordSignalActivities = async ({
  signals = [],
  user_id = null,
  report_run_id = null,
}) => {
  return Promise.all(
    signals.map((signal) =>
      recordActivity({
        agency_id: signal.agency_id,
        client_id: signal.client_id,
        report_id: signal.report_id,
        user_id,
        type: "signal_detected",
        title: `${signal.title}`,
        description: signal.description,
        severity: signal.severity,
        idempotency_key: report_run_id
          ? `report-run:${report_run_id}:signal-detected:${signal._id}`
          : undefined,
        metadata: {
          signal_id: signal._id,
          report_run_id,
          signal_type: signal.type,
          ...(signal.metadata || {}),
        },
      })
    )
  );
};
