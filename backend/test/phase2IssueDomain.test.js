import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import mongoose from "mongoose";

import {
  ISSUE_FINGERPRINT_VERSION,
  ISSUE_SUPPORTED_CADENCES,
  issueProcessingKey,
  trendForSeverity,
} from "../src/domain/phase2Issue.domain.js";
import { Issue, Report, ReportRun, Signal } from "../src/models/index.js";
import {
  buildCanonicalIssueObservationScope,
  buildCanonicalSignalIssueScope,
  canonicalizeIssueTimezone,
  resolveIssueArchetype,
  resolveIssueCampaignId,
} from "../src/services/signalIssueScope.service.js";
import {
  assertIssueFingerprintScopeMatch,
  buildCanonicalFingerprintInput,
  buildIssueFingerprint,
} from "../src/services/signalFingerprint.service.js";
import {
  buildIssueObservationKey,
  classifyIssueObservationOrder,
  readIssueComparisonWindow,
} from "../src/services/issueObservation.service.js";
import {
  PHASE2_ISSUE_INDEXES,
  classifyPhase2IssueIndex,
  hasExactPhase2IndexKey,
  hasExactPhase2IndexOptions,
} from "../src/services/phase2IssueIndexes.service.js";
import { parsePhase2IssueIndexMode } from "../src/scripts/applyPhase2IssueIndexes.js";
import { parsePhase2IssueMigrationArgs } from "../src/scripts/migratePhase2Issues.js";
import { serializeIssueListItem } from "../src/utils/issueSerializers.js";

const id = () => new mongoose.Types.ObjectId();

test("Issue list serialization exposes only persisted recurrence counts", () => {
  const baseIssue = {
    _id: id(),
    reopen_count: 0,
    claim_token: "private-claim",
    lifecycle_revision: 9,
    predecessor_issue_id: id(),
  };

  const initial = serializeIssueListItem(baseIssue);
  const reopened = serializeIssueListItem({ ...baseIssue, reopen_count: 2 });

  assert.equal(initial.reopenCount, 0);
  assert.equal(reopened.reopenCount, 2);
  assert.equal("claim_token" in reopened, false);
  assert.equal("lifecycleRevision" in reopened, false);
  assert.equal("predecessorIssueId" in reopened, false);
});

const fixture = ({ campaigns = ["campaign-1"], type = "daily", timezone = "Asia/Kolkata" } = {}) => {
  const agencyId = id();
  const clientId = id();
  const reportId = id();
  const reportRunId = id();
  const accountId = id();
  const reportRun = {
    _id: reportRunId,
    agency_id: agencyId,
    client_id: clientId,
    report_id: reportId,
    meta_ad_account_id: accountId,
    monitored_campaigns: campaigns.map((campaign_id) => ({ campaign_id })),
    context_snapshot: {
      report: { configuration: { type, schedule: { timezone } } },
    },
  };
  const signal = {
    _id: id(),
    agency_id: agencyId,
    client_id: clientId,
    report_id: reportId,
    report_run_id: reportRunId,
    campaign_id: campaigns[0] || null,
    type: "creative_fatigue",
    severity: "critical",
    metadata: { archetype_id: "creative_fatigue" },
  };
  return { signal, reportRun };
};

test("Phase 2 cadence vocabulary is derived from the persisted Report schema", () => {
  assert.deepEqual(ISSUE_SUPPORTED_CADENCES, ["daily", "weekly", "monthly"]);
  assert.deepEqual(Report.schema.path("type").enumValues, ISSUE_SUPPORTED_CADENCES);
});

test("campaign scope accepts an affected campaign inside a multi-campaign run", () => {
  const input = fixture({ campaigns: ["one", "two"] });
  input.signal.campaign_id = "two";
  assert.equal(buildCanonicalSignalIssueScope(input).scope.entity.campaign_id, "two");
});

test("campaign scope rejects absent ambiguous, conflicting, and missing identity", () => {
  const multi = fixture({ campaigns: ["one", "two"] });
  multi.signal.campaign_id = null;
  assert.equal(resolveIssueCampaignId(multi).reason, "campaign_ambiguous");
  multi.signal.campaign_id = "three";
  assert.equal(resolveIssueCampaignId(multi).reason, "campaign_conflict");
  const empty = fixture({ campaigns: [] });
  empty.signal.campaign_id = null;
  assert.equal(resolveIssueCampaignId(empty).reason, "campaign_missing");
});

test("single persisted campaign safely supplies missing Signal campaign identity", () => {
  const input = fixture();
  input.signal.campaign_id = null;
  assert.equal(resolveIssueCampaignId(input).campaignId, "campaign-1");
});

test("scope rejects malformed cadence and persisted timezone without fallback", () => {
  assert.equal(buildCanonicalSignalIssueScope(fixture({ type: "hourly" })).reason, "cadence_unsupported");
  assert.equal(buildCanonicalSignalIssueScope(fixture({ timezone: "" })).reason, "timezone_missing");
  assert.equal(buildCanonicalSignalIssueScope(fixture({ timezone: "Mars/Olympus" })).reason, "timezone_invalid");
  assert.equal(canonicalizeIssueTimezone("Asia/Calcutta"), "Asia/Calcutta");
});

test("observation scope rejects ambiguous clean windows", () => {
  const { reportRun } = fixture({ campaigns: ["one", "two"] });
  assert.equal(buildCanonicalIssueObservationScope({ reportRun }).reason, "campaign_ambiguous");
});

test("scope throws a controlled integrity error for contradictory lineage", () => {
  const input = fixture();
  input.signal.client_id = id();
  assert.throws(
    () => buildCanonicalSignalIssueScope(input),
    (error) => error.code === "ISSUE_SCOPE_OWNERSHIP_CONFLICT"
  );
});

test("positive archetypes are not applicable and metric anomalies require a mapped metric", () => {
  assert.equal(resolveIssueArchetype({ type: "stable_performance" }).notApplicable, true);
  assert.equal(resolveIssueArchetype({ type: "metric_anomaly", metadata: { primary_anomaly: { metric: "CTR" } } }).metricFamily, "ctr");
  assert.equal(resolveIssueArchetype({ type: "metric_anomaly", metadata: { primary_anomaly: { metric: "mystery" } } }).reason, "metric_family_missing");
});

test("fingerprint output is deterministic and independent of supplied property order", () => {
  const scope = buildCanonicalSignalIssueScope(fixture()).scope;
  const reversed = Object.fromEntries(Object.entries(scope).reverse());
  const first = buildIssueFingerprint(scope);
  const second = buildIssueFingerprint(reversed);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
});

test("fingerprint canonicalizes ObjectIds, enums, nullable hierarchy, and trims Meta IDs", () => {
  const scope = buildCanonicalSignalIssueScope(fixture()).scope;
  scope.entity.id = " campaign-1 ";
  scope.classification.archetype = "Creative Fatigue";
  const value = buildCanonicalFingerprintInput(scope);
  assert.equal(value.agency_id, String(scope.agency_id).toLowerCase());
  assert.equal(value.entity_id, "campaign-1");
  assert.equal(value.archetype, "creative_fatigue");
  assert.equal(value.adset_id, null);
  assert.equal(value.ad_id, null);
});

test("transient fields, Report ID, severity, and timestamps do not affect fingerprints", () => {
  const scope = buildCanonicalSignalIssueScope(fixture()).scope;
  const baseline = buildIssueFingerprint(scope).fingerprint;
  const noisy = { ...scope, report_id: id(), severity: "critical", detected_at: new Date(), random: "ignored" };
  assert.equal(buildIssueFingerprint(noisy).fingerprint, baseline);
});

test("fingerprint version is bounded and malformed input cannot hash", () => {
  const scope = buildCanonicalSignalIssueScope(fixture()).scope;
  assert.throws(() => buildIssueFingerprint(scope, { version: 2 }), /version is invalid/);
  assert.throws(
    () => buildIssueFingerprint({}),
    (error) => error.code === "ISSUE_FINGERPRINT_INPUT_INVALID"
  );
});

test("fingerprint has a fixed canonical SHA-256 vector", () => {
  const scope = {
    version: 1,
    agency_id: "64b000000000000000000001",
    client_id: "64b000000000000000000002",
    meta_ad_account_id: "64b000000000000000000003",
    entity: {
      level: "campaign",
      id: "cmp_Alpha",
      campaign_id: "cmp_Alpha",
      adset_id: null,
      ad_id: null,
    },
    classification: {
      archetype: "creative_fatigue",
      metric_family: "creative_engagement",
    },
    comparison: { cadence: "daily", timezone: "UTC" },
  };
  assert.equal(
    buildIssueFingerprint(scope).fingerprint,
    "4c7494b786df0414d1336a3367b5093e41db519ddc4d514e3a752087f2846a3b"
  );
});

test("fingerprint builder independently rejects invalid enums, pairings, hierarchy, and IDs", () => {
  const valid = buildCanonicalSignalIssueScope(fixture()).scope;
  const invalidScopes = [
    { ...structuredClone(valid), entity: { ...valid.entity, level: "adset" } },
    { ...structuredClone(valid), classification: { ...valid.classification, archetype: "mystery" } },
    { ...structuredClone(valid), classification: { ...valid.classification, metric_family: "mystery" } },
    { ...structuredClone(valid), classification: { ...valid.classification, metric_family: "ctr" } },
    { ...structuredClone(valid), comparison: { ...valid.comparison, cadence: "hourly" } },
    { ...structuredClone(valid), entity: { ...valid.entity, id: "another-campaign" } },
    { ...structuredClone(valid), entity: { ...valid.entity, adset_id: "adset-1" } },
    { ...structuredClone(valid), agency_id: "not-an-object-id" },
  ];
  for (const scope of invalidScopes) {
    assert.throws(
      () => buildIssueFingerprint(scope),
      (error) => error.code === "ISSUE_FINGERPRINT_INPUT_INVALID"
    );
  }
});

test("observation windows use strict dates and exact keys for duplicate identity", () => {
  const reportRun = (start, end) => ({
    comparison: { period: { current: { start, end } } },
  });
  assert.ok(readIssueComparisonWindow(reportRun("2024-02-29", "2024-02-29")));
  for (const invalid of [
    "2026-02-29",
    "2026-02-30",
    "2026-02-31",
    "2026-04-31",
    "2026-00-10",
    "2026-13-10",
    "2026-01-00",
  ]) {
    assert.equal(readIssueComparisonWindow(reportRun(invalid, invalid)), null);
  }
  const first = buildIssueObservationKey({
    fingerprint: "a".repeat(64),
    reportRun: reportRun("2026-07-01", "2026-07-02"),
  });
  const same = buildIssueObservationKey({
    fingerprint: "a".repeat(64),
    reportRun: reportRun("2026-07-01", "2026-07-02"),
  });
  const sameEndDifferentStart = buildIssueObservationKey({
    fingerprint: "a".repeat(64),
    reportRun: reportRun("2026-07-02", "2026-07-02"),
  });
  const issue = {
    last_observation_key: first.key,
    last_observation_end: first.window.endDate,
  };
  assert.equal(classifyIssueObservationOrder({ issue, observation: same }), "duplicate");
  assert.equal(
    classifyIssueObservationOrder({ issue, observation: sameEndDifferentStart }),
    "newer"
  );
});

test("hash match with different full scope fails closed", () => {
  const scope = buildCanonicalSignalIssueScope(fixture()).scope;
  const changed = structuredClone(scope);
  changed.entity.id = "another";
  assert.throws(
    () => assertIssueFingerprintScopeMatch({ expectedScope: scope, actualScope: changed, fingerprint: "a".repeat(64) }),
    (error) => error.code === "ISSUE_FINGERPRINT_COLLISION"
  );
});

test("Issue validates active and resolved lifecycle invariants", async () => {
  const input = fixture();
  const scope = buildCanonicalSignalIssueScope(input).scope;
  const fingerprint = buildIssueFingerprint(scope).fingerprint;
  const base = {
    agency_id: scope.agency_id, client_id: scope.client_id, meta_ad_account_id: scope.meta_ad_account_id,
    fingerprint, fingerprint_version: ISSUE_FINGERPRINT_VERSION, active_fingerprint: fingerprint,
    scope, archetype: "creative_fatigue", metric_family: "creative_engagement",
    origin_report_id: input.signal.report_id, latest_report_id: input.signal.report_id, report_ids: [input.signal.report_id],
    status: "open", opened_at: new Date(), last_seen_at: new Date(), occurrence_count: 1,
    first_signal_id: input.signal._id, latest_signal_id: input.signal._id, latest_report_run_id: input.reportRun._id,
    current_severity: "critical", latest_evidence: { kind: "signal", signal_id: input.signal._id, report_run_id: input.reportRun._id, observed_at: new Date(), severity: "critical" },
    title: "Issue",
  };
  const valid = new Issue(base);
  await valid.validate();
  assert.equal(valid.status, "open");
  await assert.rejects(new Issue({ ...base, status: "resolved", resolved_at: null }).validate(), /resolved_at/);
  await assert.rejects(new Issue({ ...base, active_fingerprint: null }).validate(), /active_fingerprint/);
});

test("Signal and ReportRun expose additive write-once lineage and bounded claim state", () => {
  assert.equal(Signal.schema.path("issue_id").options.immutable, true);
  assert.equal(Signal.schema.path("issue_fingerprint_snapshot").options.immutable, true);
  assert.equal(ReportRun.schema.path("issue_processing.processing_key").options.immutable, true);
  assert.equal(ReportRun.schema.path("issue_processing.failure_message").options.maxlength, 500);
  assert.equal(ReportRun.schema.path("issue_processing.claim_token").options.maxlength, 64);
  const runId = id();
  assert.equal(issueProcessingKey(runId), `report-run:${runId}:issues:v1`);
});

test("severity trend is deterministic", () => {
  assert.equal(trendForSeverity("moderate", "critical"), "escalating");
  assert.equal(trendForSeverity("critical", "moderate"), "improving");
  assert.equal(trendForSeverity("moderate", "moderate"), "unchanged");
});

test("Phase 2 declares exactly ten ordered indexes and strict semantics", () => {
  assert.equal(PHASE2_ISSUE_INDEXES.length, 10);
  const spec = PHASE2_ISSUE_INDEXES[0];
  assert.equal(hasExactPhase2IndexKey(spec.key, spec.key), true);
  assert.equal(hasExactPhase2IndexKey(new Map(Object.entries(spec.key)), spec.key), true);
  assert.equal(hasExactPhase2IndexKey(Object.entries(spec.key), spec.key), true);
  assert.equal(hasExactPhase2IndexKey(Object.fromEntries(Object.entries(spec.key).reverse()), spec.key), false);
  assert.equal(hasExactPhase2IndexOptions({ unique: true, partialFilterExpression: spec.partialFilterExpression }, spec), true);
  assert.equal(hasExactPhase2IndexOptions({ unique: false, partialFilterExpression: spec.partialFilterExpression }, spec), false);
  assert.equal(classifyPhase2IssueIndex(spec, [{ name: "other", key: spec.key, unique: true, partialFilterExpression: spec.partialFilterExpression }]).applicationRequired, false);
});

test("maintenance CLIs reject ambiguous modes before connection", () => {
  assert.equal(parsePhase2IssueIndexMode([]), "inspect");
  assert.throws(() => parsePhase2IssueIndexMode(["--apply", "--inspect"]));
  assert.deepEqual(parsePhase2IssueMigrationArgs([]), { apply: false, expected: null });
  assert.deepEqual(
    parsePhase2IssueMigrationArgs(["--apply", "--expected-eligible=2", "--expected-groups=1", "--expected-legacy-ungrouped=3"]),
    { apply: true, expected: { eligible: 2, issueGroups: 1, legacyUngrouped: 3 } }
  );
  assert.throws(() => parsePhase2IssueMigrationArgs(["--apply"]));
  assert.throws(() => parsePhase2IssueMigrationArgs(["--dry-run", "--expected-eligible=1"]));
});

test("execution integrates Issue processing after evidence and before delivery", () => {
  const source = readFileSync(new URL("../src/services/reportRunner.service.js", import.meta.url), "utf8");
  const events = source.indexOf("await persistRunEvents(");
  const pipeline = source.indexOf("await processReportRunIssuesBeforeDelivery(");
  const helper = source.indexOf("export const processReportRunIssuesBeforeDelivery");
  const issues = source.indexOf("await issueProcessor(", helper);
  const delivery = source.indexOf("return deliveryProcessor(", issues);
  assert.ok(events >= 0 && pipeline > events);
  assert.ok(helper >= 0 && issues > helper && delivery > issues);
});

test("Issue router is read-only and startup never applies Phase 2 indexes", () => {
  const routes = readFileSync(new URL("../src/routes/issues.routes.js", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.equal(routes.includes("issueRouter.post"), false);
  assert.equal(routes.includes("issueRouter.patch"), false);
  assert.equal(routes.includes("issueRouter.delete"), false);
  assert.equal(server.includes("initializePhase2IssueIntegrity"), true);
  assert.equal(server.includes("applyPhase2IssueIndexes"), false);
});
