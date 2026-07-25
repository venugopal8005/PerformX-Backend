import { isDeepStrictEqual } from "node:util";

import { Issue, ReportRun, Signal } from "../models/index.js";
import { ISSUE_RECENT_REPORT_IDS_LIMIT } from "../domain/phase2Issue.domain.js";
import { buildSignalObservationKey } from "./signalGenerator.service.js";

export const PHASE3_SIGNAL_IDENTITY_INDEX = Object.freeze({
  name: "execution_integrity_report_run_signal_identity_unique",
  key: Object.freeze({ agency_id: 1, report_run_id: 1, observation_key: 1 }),
  options: Object.freeze({
    unique: true,
    partialFilterExpression: Object.freeze({
      report_run_id: Object.freeze({ $type: "objectId" }),
      observation_key: Object.freeze({ $type: "string" }),
    }),
  }),
});

export const PHASE3_SUPPORTING_SIGNAL_INDEXES = Object.freeze([
  Object.freeze({
    name: "phase3_signals_report_run_chronology",
    key: Object.freeze({ report_run_id: 1, detected_at: 1, _id: 1 }),
  }),
  Object.freeze({
    name: "phase3_signals_report_issue_lookup",
    key: Object.freeze({ agency_id: 1, report_id: 1, issue_id: 1 }),
  }),
]);

const defaultModels = { Issue, ReportRun, Signal };
const indexKey = (value) => Object.entries(value || {});
const isLegacySingleSignalIndex = (index) =>
  index?.unique === true &&
  isDeepStrictEqual(indexKey(index.key), [["report_run_id", 1]]);
const isExactIdentityIndex = (index) =>
  index?.unique === true &&
  isDeepStrictEqual(indexKey(index.key), indexKey(PHASE3_SIGNAL_IDENTITY_INDEX.key)) &&
  isDeepStrictEqual(
    index.partialFilterExpression || null,
    PHASE3_SIGNAL_IDENTITY_INDEX.options.partialFilterExpression
  );

const duplicateIdentityCount = async (collection) => {
  const groups = await collection
    .aggregate([
      {
        $match: {
          report_run_id: { $type: "objectId" },
          observation_key: { $type: "string" },
        },
      },
      {
        $group: {
          _id: {
            agency_id: "$agency_id",
            report_run_id: "$report_run_id",
            observation_key: "$observation_key",
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $count: "count" },
    ])
    .toArray();
  return groups[0]?.count || 0;
};

export const inspectPhase3HistoricalIntegrityMigration = async ({
  Models = defaultModels,
} = {}) => {
  const indexes = await Models.Signal.collection.indexes();
  const [signalsNeedingIdentity, issuesNeedingRecentCache, duplicateIdentities] =
    await Promise.all([
      Models.Signal.countDocuments({
        report_run_id: { $type: "objectId" },
        $or: [
          { observation_key: { $exists: false } },
          { observation_key: null },
        ],
      }),
      Models.Issue.countDocuments({
        "report_ids.0": { $exists: true },
        $or: [
          { recent_report_ids: { $exists: false } },
          { recent_report_ids: { $size: 0 } },
        ],
      }),
      duplicateIdentityCount(Models.Signal.collection),
    ]);
  return {
    signalsNeedingIdentity,
    issuesNeedingRecentCache,
    duplicateIdentities,
    legacySingleSignalIndexNames: indexes
      .filter(isLegacySingleSignalIndex)
      .map((index) => index.name),
    identityIndexReady: indexes.some(isExactIdentityIndex),
    supportingIndexesReady: PHASE3_SUPPORTING_SIGNAL_INDEXES.every((required) =>
      indexes.some((index) => isDeepStrictEqual(indexKey(index.key), indexKey(required.key)))
    ),
  };
};

const assertExpected = (actual, expected) => {
  if (!expected || !isDeepStrictEqual(actual, expected)) {
    const error = new Error(
      "Phase 3 migration inventory changed after inspection; inspect again before applying."
    );
    error.code = "PHASE3_MIGRATION_EXPECTED_COUNTS_MISMATCH";
    throw error;
  }
};

const backfillSignalIdentities = async (Models) => {
  const signals = await Models.Signal.find({
    report_run_id: { $type: "objectId" },
    $or: [{ observation_key: { $exists: false } }, { observation_key: null }],
  }).sort({ _id: 1 });
  for (const signal of signals) {
    const reportRun = await Models.ReportRun.findById(signal.report_run_id).lean();
    if (!reportRun) {
      const error = new Error("A Signal references a missing ReportRun.");
      error.code = "PHASE3_SIGNAL_REPORT_RUN_MISSING";
      throw error;
    }
    const observationKey = buildSignalObservationKey({
      reportRunId: signal.report_run_id,
      signal,
      comparison: reportRun.comparison,
      narrative: reportRun.narrative || { period: reportRun.period },
    });
    const result = await Models.Signal.updateOne(
      {
        _id: signal._id,
        $or: [{ observation_key: { $exists: false } }, { observation_key: null }],
      },
      {
        $set: {
          observation_key: observationKey,
          observation_identity_version: 1,
        },
      },
      { overwriteImmutable: true }
    );
    if (result.modifiedCount !== 1) {
      const error = new Error("Signal identity changed during Phase 3 migration.");
      error.code = "PHASE3_SIGNAL_IDENTITY_WRITE_CONFLICT";
      throw error;
    }
  }
};

const backfillIssueRecentCaches = async (Models) => {
  const issues = await Models.Issue.find({
    "report_ids.0": { $exists: true },
    $or: [
      { recent_report_ids: { $exists: false } },
      { recent_report_ids: { $size: 0 } },
    ],
  })
    .select("_id report_ids")
    .sort({ _id: 1 });
  for (const issue of issues) {
    const recent = [...new Set((issue.report_ids || []).map(String))].slice(
      -ISSUE_RECENT_REPORT_IDS_LIMIT
    );
    await Models.Issue.updateOne(
      {
        _id: issue._id,
        $or: [
          { recent_report_ids: { $exists: false } },
          { recent_report_ids: { $size: 0 } },
        ],
      },
      { $set: { recent_report_ids: recent } }
    );
  }
};

export const applyPhase3HistoricalIntegrityMigration = async ({
  expected,
  Models = defaultModels,
} = {}) => {
  const before = await inspectPhase3HistoricalIntegrityMigration({ Models });
  assertExpected(before, expected);
  await backfillSignalIdentities(Models);
  await backfillIssueRecentCaches(Models);
  if ((await duplicateIdentityCount(Models.Signal.collection)) > 0) {
    const error = new Error("Duplicate Phase 3 Signal identities remain after backfill.");
    error.code = "PHASE3_SIGNAL_IDENTITY_DUPLICATES";
    throw error;
  }

  const indexes = await Models.Signal.collection.indexes();
  if (!indexes.some(isExactIdentityIndex)) {
    await Models.Signal.collection.createIndex(PHASE3_SIGNAL_IDENTITY_INDEX.key, {
      name: PHASE3_SIGNAL_IDENTITY_INDEX.name,
      ...PHASE3_SIGNAL_IDENTITY_INDEX.options,
    });
  }
  for (const required of PHASE3_SUPPORTING_SIGNAL_INDEXES) {
    const current = await Models.Signal.collection.indexes();
    if (!current.some((index) => isDeepStrictEqual(indexKey(index.key), indexKey(required.key)))) {
      await Models.Signal.collection.createIndex(required.key, { name: required.name });
    }
  }

  // The compound identity is established first, so removing the legacy index
  // never creates an interval without deterministic Signal uniqueness.
  const afterCreate = await Models.Signal.collection.indexes();
  for (const legacy of afterCreate.filter(isLegacySingleSignalIndex)) {
    await Models.Signal.collection.dropIndex(legacy.name);
  }
  return inspectPhase3HistoricalIntegrityMigration({ Models });
};

