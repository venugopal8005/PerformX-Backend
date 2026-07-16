import crypto from "node:crypto";

import {
  Client,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
} from "../models/index.js";
import {
  ISSUE_CLAIM_LEASE_MS,
  ISSUE_MATCHING_VERSION,
  ISSUE_REASON,
  issueProcessingKey,
} from "../domain/phase2Issue.domain.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";
import { assertPhase2IssueIntegrityReady } from "./phase2IssueIndexes.service.js";
import { buildCanonicalSignalIssueScope } from "./signalIssueScope.service.js";
import {
  buildIssueFingerprint,
  issueScopesEqual,
} from "./signalFingerprint.service.js";
import {
  processNegativeSignalTransaction,
  validatePersistedIssueParents,
} from "./issueMatching.service.js";

const defaultModels = {
  Client,
  Issue,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
};

const unlinkedSignalScope = {
  $or: [{ issue_id: null }, { issue_id: { $exists: false } }],
};

const key = (value) => String(value || "");

const inspectCandidates = async ({ Models }) => {
  const [signals, linked] = await Promise.all([
    Models.Signal.find(unlinkedSignalScope).sort({ detected_at: 1, _id: 1 }).lean(),
    Models.Signal.countDocuments({ issue_id: { $type: "objectId" } }),
  ]);
  const reportRunIds = [...new Set(signals.map((signal) => key(signal.report_run_id)).filter(Boolean))];
  const reportRuns = reportRunIds.length
    ? await Models.ReportRun.find({ _id: { $in: reportRunIds } }).lean()
    : [];
  const runById = new Map(reportRuns.map((run) => [key(run._id), run]));
  const groups = new Map();
  const legacy = [];
  const terminalSkipped = [];
  const parentStateByRun = new Map();

  for (const signal of signals) {
    if (["ineligible", "failed"].includes(signal.issue_matching_status)) {
      terminalSkipped.push(signal);
      continue;
    }
    if (signal.issue_matching_status === "legacy_ungrouped") {
      legacy.push({ signal, reason: ISSUE_REASON.LEGACY_UNGROUPED });
      continue;
    }
    const reportRun = runById.get(key(signal.report_run_id));
    if (!reportRun) {
      legacy.push({ signal, reason: ISSUE_REASON.REPORT_RUN_MISSING });
      continue;
    }
    const scopeResult = buildCanonicalSignalIssueScope({ signal, reportRun });
    if (!scopeResult.eligible) {
      legacy.push({ signal, reportRun, reason: scopeResult.reason });
      continue;
    }
    let parentState = parentStateByRun.get(key(reportRun._id));
    if (!parentState) {
      parentState = await validatePersistedIssueParents({
        reportRun,
        Models,
        session: null,
      });
      parentStateByRun.set(key(reportRun._id), parentState);
    }
    if (
      parentState.archived ||
      !parentState.reportOperational ||
      !parentState.operationalAuthority
    ) {
      legacy.push({
        signal,
        reportRun,
        reason: parentState.archived
          ? ISSUE_REASON.PARENT_ARCHIVED
          : !parentState.reportOperational
            ? ISSUE_REASON.PARENT_NOT_OPERATIONAL
            : parentState.operationalAuthorityReason,
      });
      continue;
    }
    const fingerprint = buildIssueFingerprint(scopeResult.scope).fingerprint;
    const groupKey = `${key(signal.agency_id)}:${key(signal.client_id)}:${fingerprint}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push({ signal, reportRun, fingerprint, scopeResult });
  }

  return { signals, linked, groups, legacy, terminalSkipped };
};

export const inspectPhase2IssueMigration = async ({ Models = defaultModels } = {}) => {
  const inventory = await inspectCandidates({ Models });
  const eligible = [...inventory.groups.values()].reduce((count, items) => count + items.length, 0);
  return {
    mode: "dry_run",
    counts: {
      unlinkedSignals: inventory.signals.length,
      alreadyLinked: inventory.linked,
      eligible,
      issueGroups: inventory.groups.size,
      legacyUngrouped: inventory.legacy.length,
      terminalSkipped: inventory.terminalSkipped.length,
    },
    reasons: Object.fromEntries(
      [...new Set(inventory.legacy.map((item) => item.reason))]
        .sort()
        .map((reason) => [reason, inventory.legacy.filter((item) => item.reason === reason).length])
    ),
    inventory,
  };
};

const assertExpectedCounts = ({ actual, expected }) => {
  const mismatches = [
    ["eligible", actual.eligible, expected.eligible],
    ["issueGroups", actual.issueGroups, expected.issueGroups],
    ["legacyUngrouped", actual.legacyUngrouped, expected.legacyUngrouped],
  ].filter(([, value, expectedValue]) => value !== expectedValue);
  if (!mismatches.length) return;
  const error = new Error("Phase 2 migration expected counts do not match persisted evidence.");
  error.code = "PHASE2_ISSUE_MIGRATION_COUNT_MISMATCH";
  error.status = 409;
  error.mismatches = mismatches.map(([field, actualValue, expectedValue]) => ({
    field,
    actual: actualValue,
    expected: expectedValue,
  }));
  throw error;
};

const migrationVerificationError = (message, check) => {
  const error = new Error(message);
  error.code = "PHASE2_ISSUE_MIGRATION_POST_VERIFY_FAILED";
  error.status = 409;
  error.check = check;
  return error;
};

const sameId = (left, right) => String(left) === String(right);
const sameDate = (left, right) => {
  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  return Number.isFinite(leftTime) && leftTime === rightTime;
};
const orderedSignalDocuments = (signals = []) =>
  [...signals].sort((left, right) => {
    const timeDifference =
      new Date(left.detected_at || left.createdAt).getTime() -
      new Date(right.detected_at || right.createdAt).getTime();
    return timeDifference || String(left._id).localeCompare(String(right._id));
  });
const exactIdSet = (actual = [], expected = []) => {
  const left = [...new Set(actual.map(String))].sort();
  const right = [...new Set(expected.map(String))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

export const verifyPhase2IssueMigrationApply = async ({
  inspection,
  expected,
  Models = defaultModels,
} = {}) => {
  const eligibleItems = [...inspection.inventory.groups.values()].flat();
  const eligibleIds = eligibleItems.map((item) => item.signal._id);
  const legacyItems = inspection.inventory.legacy;
  const legacyIds = legacyItems.map((item) => item.signal._id);
  const ineligibleIds = [
    ...legacyIds,
    ...inspection.inventory.terminalSkipped.map((signal) => signal._id),
  ];

  const [eligibleSignals, legacySignals, incorrectlyLinked, remaining] = await Promise.all([
    eligibleIds.length
      ? Models.Signal.find({ _id: { $in: eligibleIds } }).lean()
      : [],
    legacyIds.length
      ? Models.Signal.find({ _id: { $in: legacyIds } }).lean()
      : [],
    ineligibleIds.length
      ? Models.Signal.countDocuments({
          _id: { $in: ineligibleIds },
          issue_id: { $type: "objectId" },
        })
      : 0,
    inspectPhase2IssueMigration({ Models }),
  ]);

  const linkedEligible = eligibleSignals.filter(
    (signal) => signal.issue_id && signal.issue_matching_status === "matched"
  );
  if (
    eligibleSignals.length !== expected.eligible ||
    linkedEligible.length !== expected.eligible ||
    remaining.counts.eligible !== 0
  ) {
    throw migrationVerificationError(
      "Phase 2 migration did not link every expected eligible Signal.",
      "eligible_signal_linkage"
    );
  }
  if (incorrectlyLinked !== 0) {
    throw migrationVerificationError(
      "Phase 2 migration linked a Signal without deterministic historical identity.",
      "ineligible_signal_linkage"
    );
  }
  if (
    legacySignals.length !== expected.legacyUngrouped ||
    legacySignals.some(
      (signal) =>
        signal.issue_id ||
        signal.issue_matching_status !== "legacy_ungrouped" ||
        signal.issue_matching_reason !== ISSUE_REASON.LEGACY_UNGROUPED ||
        signal.matching_version !== ISSUE_MATCHING_VERSION
    )
  ) {
    throw migrationVerificationError(
      "Phase 2 migration did not persist every expected legacy classification.",
      "legacy_classification"
    );
  }

  const eligibleById = new Map(eligibleSignals.map((signal) => [key(signal._id), signal]));
  const migratedIssueIds = new Set();
  for (const items of inspection.inventory.groups.values()) {
    const groupSignals = items.map((item) => eligibleById.get(key(item.signal._id)));
    const groupIssueIds = new Set(groupSignals.map((signal) => key(signal?.issue_id)));
    if (groupSignals.some((signal) => !signal) || groupIssueIds.size !== 1 || groupIssueIds.has("")) {
      throw migrationVerificationError(
        "Phase 2 migration split one canonical group across multiple Issues.",
        "issue_grouping"
      );
    }
    const issueId = [...groupIssueIds][0];
    migratedIssueIds.add(issueId);
    const issue = await Models.Issue.findById(issueId).lean();
    if (!issue) {
      throw migrationVerificationError(
        "Phase 2 migration linked Signals to a missing Issue.",
        "issue_missing"
      );
    }
    const expectedFingerprint = items[0].fingerprint;
    if (
      issue.fingerprint !== expectedFingerprint ||
      !issueScopesEqual(issue.scope, items[0].scopeResult.scope) ||
      items.some(
        (item) =>
          !sameId(issue.agency_id, item.signal.agency_id) ||
          !sameId(issue.client_id, item.signal.client_id) ||
          !sameId(issue.meta_ad_account_id, item.scopeResult.lineage.metaAccountId)
      )
    ) {
      throw migrationVerificationError(
        "Phase 2 migration persisted an Issue with conflicting canonical ownership.",
        "issue_scope"
      );
    }

    const allIssueSignals = orderedSignalDocuments(
      await Models.Signal.find({ issue_id: issue._id }).lean()
    );
    const occurrenceNumbers = allIssueSignals.map(
      (signal) => signal.issue_occurrence_number
    );
    if (
      issue.occurrence_count !== allIssueSignals.length ||
      occurrenceNumbers.some(
        (number, index) => !Number.isSafeInteger(number) || number !== index + 1
      ) ||
      new Set(occurrenceNumbers).size !== occurrenceNumbers.length ||
      allIssueSignals.some(
        (signal) => signal.issue_fingerprint_snapshot !== issue.fingerprint
      )
    ) {
      throw migrationVerificationError(
        "Phase 2 migration persisted inconsistent occurrence lineage.",
        "occurrence_lineage"
      );
    }

    const firstSignal = allIssueSignals[0];
    const latestSignal = allIssueSignals.at(-1);
    const reportIds = allIssueSignals.map((signal) => signal.report_id);
    if (
      !sameId(issue.first_signal_id, firstSignal?._id) ||
      !sameId(issue.latest_signal_id, latestSignal?._id) ||
      !sameDate(issue.opened_at, firstSignal?.detected_at || firstSignal?.createdAt) ||
      !sameDate(issue.last_seen_at, latestSignal?.detected_at || latestSignal?.createdAt) ||
      !exactIdSet(issue.report_ids, reportIds)
    ) {
      throw migrationVerificationError(
        "Phase 2 migration persisted inconsistent Issue chronology.",
        "issue_chronology"
      );
    }

    const reportRuns = await Models.ReportRun.find({
      _id: { $in: groupSignals.map((signal) => signal.report_run_id) },
    }).lean();
    if (
      reportRuns.length !== groupSignals.length ||
      reportRuns.some(
        (reportRun) =>
          reportRun.issue_processing?.status !== "completed" ||
          !sameId(reportRun.issue_processing?.issue_id, issue._id)
      )
    ) {
      throw migrationVerificationError(
        "Phase 2 migration left ReportRun Issue processing inconsistent.",
        "report_run_processing"
      );
    }
  }

  if (migratedIssueIds.size !== expected.issueGroups) {
    throw migrationVerificationError(
      "Phase 2 migration produced an unexpected number of Issue groups.",
      "issue_group_count"
    );
  }
  return {
    linkedEligible: linkedEligible.length,
    issueGroups: migratedIssueIds.size,
    legacyUngrouped: legacySignals.length,
    remaining: remaining.counts,
  };
};

const claimForMigration = async ({ reportRun, session, Models }) => {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const claimed = await Models.ReportRun.findOneAndUpdate(
    {
      _id: reportRun._id,
      $or: [
        { issue_processing: { $exists: false } },
        { issue_processing: null },
        { "issue_processing.status": { $in: ["pending", "failed_retryable"] } },
      ],
    },
    {
      $set: {
        "issue_processing.processing_key": issueProcessingKey(reportRun._id),
        "issue_processing.version": ISSUE_MATCHING_VERSION,
        "issue_processing.status": "processing",
        "issue_processing.claim_token": token,
        "issue_processing.claimed_at": now,
        "issue_processing.claim_expires_at": new Date(now.getTime() + ISSUE_CLAIM_LEASE_MS),
        "issue_processing.completed_at": null,
        "issue_processing.failure_code": null,
        "issue_processing.failure_message": null,
        "issue_processing.result_classification": null,
        "issue_processing.issue_id": null,
      },
      $inc: { "issue_processing.attempts": 1 },
    },
    { new: true, session }
  ).select("+issue_processing.claim_token");
  if (claimed) return { reportRun: claimed, token, now };
  const error = new Error("ReportRun cannot be claimed for historical Issue migration.");
  error.code = "PHASE2_ISSUE_MIGRATION_RUN_NOT_CLAIMABLE";
  error.status = 409;
  throw error;
};

const applyGroup = async ({ items, Models, transactionRunner }) =>
  transactionRunner({
    unavailableCode: "PHASE2_ISSUE_MIGRATION_TRANSACTION_REQUIRED",
    unavailableMessage: "Phase 2 Issue migration requires a transaction-capable database deployment.",
    work: async (session) => {
      const results = [];
      for (const item of items) {
        const signal = await Models.Signal.findOne({
          _id: item.signal._id,
          ...unlinkedSignalScope,
        }).session(session);
        if (!signal) {
          results.push({ classification: "already_linked" });
          continue;
        }
        const persistedRun = await Models.ReportRun.findById(item.reportRun._id).session(session);
        const parentState = await validatePersistedIssueParents({
          reportRun: persistedRun,
          Models,
          session,
        });
        if (
          parentState.archived ||
          !parentState.reportOperational ||
          !parentState.operationalAuthority
        ) {
          const error = new Error(
            "Meta authority changed after Phase 2 migration inspection."
          );
          error.code = "PHASE2_ISSUE_MIGRATION_AUTHORITY_CHANGED";
          error.status = 409;
          error.reason = parentState.archived
            ? ISSUE_REASON.PARENT_ARCHIVED
            : !parentState.reportOperational
              ? ISSUE_REASON.PARENT_NOT_OPERATIONAL
              : parentState.operationalAuthorityReason;
          throw error;
        }
        const claim = await claimForMigration({ reportRun: persistedRun, session, Models });
        results.push(
          await processNegativeSignalTransaction({
            reportRun: claim.reportRun,
            signal,
            token: claim.token,
            parentState,
            Models,
            session,
            now: signal.detected_at || claim.now,
          })
        );
      }
      return results;
    },
  });

export const applyPhase2IssueMigration = async ({
  expected,
  Models = defaultModels,
  transactionRunner = runRequiredTransaction,
} = {}) => {
  assertPhase2IssueIntegrityReady();
  const inspection = await inspectPhase2IssueMigration({ Models });
  assertExpectedCounts({ actual: inspection.counts, expected });
  let processedGroups = 0;
  let processedSignals = 0;
  for (const items of inspection.inventory.groups.values()) {
    const results = await applyGroup({ items, Models, transactionRunner });
    processedGroups += 1;
    processedSignals += results.filter((result) => result.classification !== "already_linked").length;
  }
  if (inspection.inventory.legacy.length) {
    await Models.Signal.updateMany(
      {
        _id: { $in: inspection.inventory.legacy.map((item) => item.signal._id) },
        $and: [
          unlinkedSignalScope,
          {
            $or: [
              { issue_matching_status: null },
              { issue_matching_status: { $exists: false } },
            ],
          },
        ],
      },
      {
        $set: {
          issue_matching_status: "legacy_ungrouped",
          issue_matching_reason: ISSUE_REASON.LEGACY_UNGROUPED,
          matching_version: ISSUE_MATCHING_VERSION,
        },
      },
      { overwriteImmutable: true }
    );
  }
  const postApply = await verifyPhase2IssueMigrationApply({
    inspection,
    expected,
    Models,
  });
  return {
    mode: "apply",
    expected: { ...expected },
    processedGroups,
    processedSignals,
    legacyUngrouped: inspection.counts.legacyUngrouped,
    postApply,
  };
};

export const runPhase2IssueMigration = async ({ apply = false, expected, ...options } = {}) => {
  if (!apply) {
    const result = await inspectPhase2IssueMigration(options);
    const { inventory, ...safeResult } = result;
    return safeResult;
  }
  return applyPhase2IssueMigration({ expected, ...options });
};
