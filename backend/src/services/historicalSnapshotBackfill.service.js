import {
  Agency,
  Client,
  Report,
  ReportRun,
  Signal,
  User,
} from "../models/index.js";
import {
  buildReportRunContextSnapshot,
  buildSignalContextSnapshotFromReportRun,
  buildSignalCurrentReferenceSnapshot,
} from "./historicalContextSnapshot.service.js";

const missingSnapshotQuery = {
  $or: [
    { context_snapshot: { $exists: false } },
    { context_snapshot: null },
  ],
};

const key = (value) => value?.toString?.() || String(value || "");
const uniqueIds = (documents, field) => [
  ...new Map(
    documents
      .map((document) => document[field])
      .filter(Boolean)
      .map((value) => [key(value), value])
  ).values(),
];
const byId = (documents) =>
  new Map(documents.map((document) => [key(document._id), document]));

const findByIds = async (Model, ids, fields = null) => {
  if (!ids.length) return [];
  let query = Model.find({ _id: { $in: ids } });
  if (fields) query = query.select(fields);
  return query.lean();
};

const loadReportRunReferences = async (runs, Models) => {
  const [agencies, clients, reports, users] = await Promise.all([
    findByIds(Models.Agency, uniqueIds(runs, "agency_id"), "name"),
    findByIds(Models.Client, uniqueIds(runs, "client_id"), "name"),
    findByIds(
      Models.Report,
      uniqueIds(runs, "report_id"),
      "name type schedule client_delivery_mode generate_client_report generate_internal_report"
    ),
    findByIds(Models.User, uniqueIds(runs, "triggered_by"), "full_name"),
  ]);

  return {
    agencies: byId(agencies),
    clients: byId(clients),
    reports: byId(reports),
    users: byId(users),
  };
};

const buildBackfilledRunSnapshot = (run, references) =>
  buildReportRunContextSnapshot({
    agency: references.agencies.get(key(run.agency_id)) || null,
    client: references.clients.get(key(run.client_id)) || null,
    report: references.reports.get(key(run.report_id)) || null,
    actor: references.users.get(key(run.triggered_by)) || null,
    capturedAt: run.started_at || run.ran_at || run.createdAt || new Date(),
    source: "backfill_current_reference",
  });

const isPartialRunSnapshot = (run, snapshot) =>
  !snapshot.workspace.name ||
  !snapshot.client.name ||
  !snapshot.report.name ||
  !snapshot.report.configuration ||
  (run.triggered_by && !snapshot.actor.name);

const nextBatch = async (Model, cursor, batchSize) => {
  const scope = cursor
    ? { $and: [missingSnapshotQuery, { _id: { $gt: cursor } }] }
    : missingSnapshotQuery;
  return Model.find(scope).sort({ _id: 1 }).limit(batchSize).lean();
};

const defaultModels = {
  Agency,
  Client,
  Report,
  ReportRun,
  Signal,
  User,
};

export const backfillReportRunSnapshots = async ({
  apply = false,
  batchSize = 200,
  Models = defaultModels,
} = {}) => {
  const missing = await Models.ReportRun.countDocuments(missingSnapshotQuery);
  const total = await Models.ReportRun.countDocuments({});
  const result = {
    missing,
    resolvable: 0,
    partially_resolvable: 0,
    updated: 0,
    skipped_existing: Math.max(0, total - missing),
  };
  let cursor = null;

  while (true) {
    const runs = await nextBatch(Models.ReportRun, cursor, batchSize);
    if (!runs.length) break;
    const references = await loadReportRunReferences(runs, Models);

    for (const run of runs) {
      const snapshot = buildBackfilledRunSnapshot(run, references);
      if (isPartialRunSnapshot(run, snapshot)) result.partially_resolvable += 1;
      else result.resolvable += 1;

      if (apply) {
        const update =
          typeof Models.ReportRun.backfillMissingContextSnapshot === "function"
            ? await Models.ReportRun.backfillMissingContextSnapshot({
                reportRunId: run._id,
                snapshot,
              })
            : await Models.ReportRun.updateOne(
                { _id: run._id, ...missingSnapshotQuery },
                { $set: { context_snapshot: snapshot } }
              );
        result.updated += update.modifiedCount || 0;
      }
    }

    cursor = runs.at(-1)._id;
    if (runs.length < batchSize) break;
  }

  return result;
};

const loadSignalFallbackReferences = async (signals, Models) => {
  const [agencies, clients, reports] = await Promise.all([
    findByIds(Models.Agency, uniqueIds(signals, "agency_id"), "name"),
    findByIds(Models.Client, uniqueIds(signals, "client_id"), "name"),
    findByIds(Models.Report, uniqueIds(signals, "report_id"), "name"),
  ]);
  return {
    agencies: byId(agencies),
    clients: byId(clients),
    reports: byId(reports),
  };
};

export const backfillSignalSnapshots = async ({
  apply = false,
  batchSize = 200,
  Models = defaultModels,
} = {}) => {
  const missing = await Models.Signal.countDocuments(missingSnapshotQuery);
  const total = await Models.Signal.countDocuments({});
  const result = {
    missing,
    resolvable_from_report_run: 0,
    current_reference_fallback: 0,
    unresolved_historical_meta_scope: 0,
    partially_populated: 0,
    updated: 0,
    skipped_existing: Math.max(0, total - missing),
  };
  let cursor = null;

  while (true) {
    const signals = await nextBatch(Models.Signal, cursor, batchSize);
    if (!signals.length) break;
    const reportRunIds = uniqueIds(signals, "report_run_id");
    const reportRuns = await findByIds(Models.ReportRun, reportRunIds);
    const reportRunMap = byId(reportRuns);
    const runsMissingContext = reportRuns.filter(
      (run) => !run.context_snapshot
    );
    const runReferences = runsMissingContext.length
      ? await loadReportRunReferences(runsMissingContext, Models)
      : null;
    const fallbackSignals = signals.filter(
      (signal) => !reportRunMap.has(key(signal.report_run_id))
    );
    const fallbackReferences = fallbackSignals.length
      ? await loadSignalFallbackReferences(fallbackSignals, Models)
      : null;

    for (const signal of signals) {
      const sourceRun = reportRunMap.get(key(signal.report_run_id));
      let snapshot;

      if (sourceRun) {
        const historicalRun = sourceRun.context_snapshot
          ? sourceRun
          : {
              ...sourceRun,
              context_snapshot: buildBackfilledRunSnapshot(sourceRun, runReferences),
            };
        snapshot = buildSignalContextSnapshotFromReportRun({
          reportRun: historicalRun,
          campaignId: signal.campaign_id,
          capturedAt:
            historicalRun.context_snapshot?.captured_at ||
            signal.detected_at ||
            signal.createdAt,
        });
        result.resolvable_from_report_run += 1;
      } else {
        snapshot = buildSignalCurrentReferenceSnapshot({
          agency: fallbackReferences?.agencies.get(key(signal.agency_id)) || null,
          client: fallbackReferences?.clients.get(key(signal.client_id)) || null,
          report: fallbackReferences?.reports.get(key(signal.report_id)) || null,
          campaignId: signal.campaign_id,
          capturedAt: signal.detected_at || signal.createdAt || new Date(),
        });
        result.current_reference_fallback += 1;
      }

      if (
        !snapshot.meta_account.meta_ad_account_id &&
        !snapshot.meta_account.external_account_id &&
        !snapshot.meta_account.name
      ) {
        result.unresolved_historical_meta_scope += 1;
      }
      if (
        !snapshot.workspace.name ||
        !snapshot.client.name ||
        !snapshot.report.name
      ) {
        result.partially_populated += 1;
      }

      if (apply) {
        const update = await Models.Signal.updateOne(
          { _id: signal._id, ...missingSnapshotQuery },
          { $set: { context_snapshot: snapshot } }
        );
        result.updated += update.modifiedCount || 0;
      }
    }

    cursor = signals.at(-1)._id;
    if (signals.length < batchSize) break;
  }

  return result;
};

export const runHistoricalSnapshotBackfill = async ({
  apply = false,
  batchSize = 200,
  Models = defaultModels,
} = {}) => ({
  mode: apply ? "apply" : "dry_run",
  report_runs: await backfillReportRunSnapshots({ apply, batchSize, Models }),
  signals: await backfillSignalSnapshots({ apply, batchSize, Models }),
});

export { missingSnapshotQuery };
