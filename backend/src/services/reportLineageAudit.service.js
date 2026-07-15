import { Report, ReportRun, Signal } from "../models/index.js";

const defaultModels = { Report, ReportRun, Signal };

const historyAuditPipeline = (reportCollectionName) => [
  { $match: { report_id: { $ne: null } } },
  {
    $group: {
      _id: "$report_id",
      historical_client_ids: { $addToSet: "$client_id" },
    },
  },
  {
    $lookup: {
      from: reportCollectionName,
      localField: "_id",
      foreignField: "_id",
      as: "current_report",
    },
  },
  {
    $set: {
      current_report: { $arrayElemAt: ["$current_report", 0] },
    },
  },
  {
    $group: {
      _id: null,
      reports_with_history: { $sum: 1 },
      mixed_client_lineage: {
        $sum: {
          $cond: [{ $gt: [{ $size: "$historical_client_ids" }, 1] }, 1, 0],
        },
      },
      current_report_client_differs: {
        $sum: {
          $cond: [
            {
              $and: [
                {
                  $ne: [
                    { $type: "$current_report.client_id" },
                    "missing",
                  ],
                },
                {
                  $not: [
                    {
                      $in: [
                        "$current_report.client_id",
                        "$historical_client_ids",
                      ],
                    },
                  ],
                },
              ],
            },
            1,
            0,
          ],
        },
      },
    },
  },
];

const emptyHistoryResult = {
  reports_with_history: 0,
  mixed_client_lineage: 0,
  current_report_client_differs: 0,
};

const auditHistoryModel = async (Model, reportCollectionName) => {
  const [result] = await Model.aggregate(
    historyAuditPipeline(reportCollectionName)
  );
  return result || emptyHistoryResult;
};

export const auditReportClientLineage = async ({
  Models = defaultModels,
} = {}) => {
  const reportCollectionName = Models.Report.collection.name;
  const [reportsScanned, reportRuns, signals] = await Promise.all([
    Models.Report.countDocuments({}),
    auditHistoryModel(Models.ReportRun, reportCollectionName),
    auditHistoryModel(Models.Signal, reportCollectionName),
  ]);

  return {
    reports_scanned: reportsScanned,
    reports_with_report_run_history: reportRuns.reports_with_history,
    reports_with_signal_history: signals.reports_with_history,
    mixed_report_run_client_lineage: reportRuns.mixed_client_lineage,
    mixed_signal_client_lineage: signals.mixed_client_lineage,
    current_report_client_differs_from_run_history:
      reportRuns.current_report_client_differs,
    current_report_client_differs_from_signal_history:
      signals.current_report_client_differs,
  };
};
