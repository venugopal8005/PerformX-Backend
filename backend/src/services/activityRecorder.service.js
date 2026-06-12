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
}) => {
  if (!agency_id) throw new Error("agency_id is required to record activity");
  if (!type) throw new Error("activity type is required");
  if (!title) throw new Error("activity title is required");

  return Activity.create({
    agency_id,
    client_id,
    report_id,
    user_id,
    type,
    title,
    description,
    severity,
    metadata,
  });
};

export const recordSignalActivities = async ({ signals = [], user_id = null }) => {
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
        metadata: {
          signal_id: signal._id,
          signal_type: signal.type,
          ...(signal.metadata || {}),
        },
      })
    )
  );
};
