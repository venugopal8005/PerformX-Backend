import test from "node:test";
import assert from "node:assert/strict";

import {
  EVALUATION_METRIC_RULES,
  EVALUATION_STATUSES,
  normalizeEvaluationIntent,
  resolveEvaluationIntent,
  hashEvaluationEvidence,
} from "../src/domain/phase4Evaluation.domain.js";
import {
  canonicalFollowUpWindow,
  buildEvaluationThresholdSnapshots,
  calculateEvaluationConfidence,
  classifyOverallResult,
  compareEvaluationMetric,
  detectOverlap,
  localActionDate,
  selectBaseline,
  selectFollowUp,
  windowDurationDays,
} from "../src/services/phase4EvaluationEngine.service.js";

const objectId = (suffix) => `0000000000000000000000${suffix}`;
const intervention = {
  _id: objectId("01"), agency_id: objectId("02"), client_id: objectId("03"),
  meta_ad_account_id: objectId("04"), report_id_at_action: objectId("05"),
  campaign_id: "campaign-1", performed_at: new Date("2026-03-08T06:30:00.000Z"),
};
const evidence = (start, end, overrides = {}) => ({
  version: 1, normalization_version: 1, comparison_mode: "scheduled_window", completeness: "complete", cadence: "daily",
  timezone: "America/New_York", currency: "USD", attribution_windows: ["7d_click"],
  meta_binding_revision: 2, current_window: { start, end }, previous_window: { start, end },
  campaign_snapshots: [{ campaign_id: "campaign-1", campaign_name: "Campaign", provenance: "scheduled_window", spend: 20, impressions: 1000, clicks: 50, conversions: 6, conversion_value: 100, ctr: 5, cpc: 0.4, cpm: 20, cpa: 3.333333, roas: 5, conversion_rate: 12, row_count: 1, source_level: "campaign", completeness: "complete", warnings: [] }],
  ...overrides,
});
const run = (id, start, end, overrides = {}) => ({
  _id: objectId(id), agency_id: intervention.agency_id, client_id: intervention.client_id,
  report_id: intervention.report_id_at_action, meta_ad_account_id: intervention.meta_ad_account_id,
  meta_binding_revision_snapshot: 2, evaluation_evidence: evidence(start, end, overrides),
});
const snapshot = (values = {}, overrides = {}) => ({
  currency: "USD", attribution_windows: ["7d_click"], values: { spend: 100, impressions: 1000, clicks: 100, conversions: 10, conversion_value: 200, ctr: 10, cpc: 1, cpm: 100, cpa: 10, roas: 2, conversion_rate: 10, ...values }, ...overrides,
});

test("persisted statuses exclude processing and superseded states", () => {
  assert.deepEqual(EVALUATION_STATUSES, ["awaiting_follow_up", "ready", "insufficient_data", "not_evaluable", "invalidated"]);
});
test("explicit intent is strict, bounded, deduplicated, and primary-linked", () => {
  assert.deepEqual(normalizeEvaluationIntent({ mode: "explicit", primaryMetric: "ctr", watchedMetrics: ["ctr", "ctr", "spend"] }), { mode: "explicit", primary_metric: "ctr", watched_metrics: ["ctr", "spend"], resolution_source: "request", rule_version: 1 });
  assert.throws(() => normalizeEvaluationIntent({ mode: "explicit", primaryMetric: "ctr", watchedMetrics: ["cpc"] }), /must be watched/);
  assert.throws(() => normalizeEvaluationIntent({ mode: "explicit", watchedMetrics: ["reach"] }), /invalid/);
});
test("intent resolution follows action and exact metric policy", () => {
  assert.equal(resolveEvaluationIntent({ actionType: "replace_creative", issue: { metric_family: "cpc" }, signal: { metadata: { primary_anomaly: { metric: "ctr" } } } }).primary_metric, "ctr");
  assert.equal(resolveEvaluationIntent({ actionType: "monitor_only", issue: { metric_family: "cpc" } }).mode, "observational");
  assert.equal(resolveEvaluationIntent({ actionType: "internal_note" }).mode, "not_applicable");
  assert.equal(resolveEvaluationIntent({ actionType: "fix_tracking" }).resolution_source, "tracking_comparability");
  assert.equal(resolveEvaluationIntent({ actionType: "other", issue: { metric_family: "cpc" } }).mode, "unresolved");
  assert.equal(resolveEvaluationIntent({ actionType: "other", issue: { metric_family: "frequency" } }).mode, "unresolved");
});
test("threshold table is version-centralized and exact for core metrics", () => {
  assert.deepEqual(EVALUATION_METRIC_RULES.ctr, { directionality: "higher_is_better", relative: 0.1, absolute: 0.2, unit: "percent", minimum: { impressions: 100 } });
  assert.equal(EVALUATION_METRIC_RULES.cpc.directionality, "lower_is_better");
  assert.equal(EVALUATION_METRIC_RULES.spend.directionality, "context_only");
});
test("local action date and follow-up remain DST-safe", () => {
  assert.equal(localActionDate(intervention.performed_at, "America/New_York"), "2026-03-08");
  assert.deepEqual(canonicalFollowUpWindow({ performedAt: intervention.performed_at, timezone: "America/New_York", cadence: "weekly" }), { start: "2026-03-09", end: "2026-03-15" });
  assert.equal(windowDurationDays({ start: "2026-03-09", end: "2026-03-15" }, "America/New_York"), 7);
});
test("baseline selection uses latest complete pre-action canonical window", () => {
  const selected = selectBaseline({ runs: [run("10", "2026-03-06", "2026-03-06"), run("11", "2026-03-07", "2026-03-07"), run("12", "2026-03-08", "2026-03-08")], intervention, cadence: "daily", timezone: "America/New_York" });
  assert.equal(String(selected.run._id), objectId("11"));
});
test("stale baseline is rejected", () => {
  const selected = selectBaseline({ runs: [run("10", "2026-02-20", "2026-02-20")], intervention, cadence: "daily", timezone: "America/New_York" });
  assert.equal(selected.reason, "baseline_stale");
});
test("canonical follow-up excludes action date and rejects drifting windows", () => {
  const selected = selectFollowUp({ runs: [run("12", "2026-03-08", "2026-03-08"), run("13", "2026-03-09", "2026-03-09")], intervention, cadence: "daily", timezone: "America/New_York", now: new Date("2026-03-09T20:00:00Z") });
  assert.equal(String(selected.run._id), objectId("13"));
});
test("missing follow-up awaits before timeout and closes after timeout", () => {
  assert.equal(selectFollowUp({ runs: [], intervention, cadence: "daily", timezone: "America/New_York", now: new Date("2026-03-10T12:00:00Z") }).reason, "awaiting_follow_up");
  assert.equal(selectFollowUp({ runs: [], intervention, cadence: "daily", timezone: "America/New_York", now: new Date("2026-03-20T12:00:00Z") }).reason, "follow_up_timeout");
});
test("historical fallback and wrong cadence evidence are ineligible", () => {
  assert.equal(selectBaseline({ runs: [run("10", "2026-03-07", "2026-03-07", { comparison_mode: "historical_fallback" })], intervention, cadence: "daily", timezone: "America/New_York" }).reason, "historical_fallback_evidence");
  assert.equal(selectBaseline({ runs: [run("10", "2026-03-07", "2026-03-07", { cadence: "weekly" })], intervention, cadence: "daily", timezone: "America/New_York" }).reason, "cadence_mismatch");
});
test("higher-is-better metric classifies material improvement", () => {
  const result = compareEvaluationMetric({ metric: "ctr", baseline: snapshot({ ctr: 2 }), followUp: snapshot({ ctr: 2.5 }) });
  assert.equal(result.classification, "improved");
  assert.equal(result.material, true);
});
test("lower-is-better metric classifies material improvement", () => {
  assert.equal(compareEvaluationMetric({ metric: "cpc", baseline: snapshot({ cpc: 2 }), followUp: snapshot({ cpc: 1.5 }) }).classification, "improved");
});
test("minimum evidence runs before directional classification", () => {
  const result = compareEvaluationMetric({ metric: "ctr", baseline: snapshot({ impressions: 50, ctr: 2 }), followUp: snapshot({ impressions: 50, ctr: 5 }) });
  assert.equal(result.classification, "insufficient_data");
});
test("zero denominator is controlled and zero baseline can use absolute movement", () => {
  assert.equal(compareEvaluationMetric({ metric: "cpc", baseline: snapshot({ cpc: null }), followUp: snapshot({ cpc: 1 }) }).classification, "insufficient_data");
  const clicks = compareEvaluationMetric({ metric: "clicks", baseline: snapshot({ clicks: 0 }), followUp: snapshot({ clicks: 20 }) });
  assert.equal(clicks.classification, "improved");
  assert.equal(clicks.relative_delta, null);
  assert.deepEqual(clicks.reason_codes, ["zero_baseline"]);
  const unchanged = compareEvaluationMetric({ metric: "clicks", baseline: snapshot({ clicks: 0 }), followUp: snapshot({ clicks: 0 }) });
  assert.equal(unchanged.classification, "no_material_change");
  assert.equal(unchanged.relative_delta, null);
});
test("conversion metrics require exact attribution windows", () => {
  const result = compareEvaluationMetric({ metric: "cpa", baseline: snapshot(), followUp: snapshot({}, { attribution_windows: ["1d_click"] }) });
  assert.equal(result.classification, "not_evaluable");
  assert.deepEqual(result.reason_codes, ["attribution_not_comparable"]);
});

test("confidence remains separate from improved and worsened results", () => {
  const thresholdSnapshots = buildEvaluationThresholdSnapshots({ metrics: ["ctr"] });
  const candidate = (observedResult, cadence, impressions, rowCount) => ({
    status: "ready",
    observed_result: observedResult,
    reason_codes: [],
    threshold_snapshots: thresholdSnapshots,
    baseline: { window: { cadence }, values: { impressions }, row_count: rowCount, completeness: "complete" },
    follow_up: { window: { cadence }, values: { impressions }, row_count: rowCount, completeness: "complete" },
  });
  const lowImproved = calculateEvaluationConfidence(candidate("improved", "daily", 100, 1));
  const lowWorsened = calculateEvaluationConfidence(candidate("worsened", "daily", 100, 1));
  const highWorsened = calculateEvaluationConfidence(candidate("worsened", "weekly", 1000, 10));
  assert.equal(lowImproved.level, "low");
  assert.equal(lowWorsened.level, "low");
  assert.equal(highWorsened.level, "high");
});

test("threshold snapshots are detached from later rule changes", () => {
  const rules = { ctr: { ...EVALUATION_METRIC_RULES.ctr, minimum: { impressions: 100 } } };
  const snapshots = buildEvaluationThresholdSnapshots({ metrics: ["ctr"], rules });
  rules.ctr.relative = 0.5;
  rules.ctr.minimum.impressions = 999;
  assert.equal(snapshots[0].noise_boundary.relative, 0.1);
  assert.equal(snapshots[0].minimum_evidence.impressions, 100);
});

for (const [metric, rule] of Object.entries(EVALUATION_METRIC_RULES)) {
  test(`${metric} threshold equality is material and both sides are bounded`, () => {
    const relativeBaseline = metric === "impressions" ? 1000 : 100;
    const relativeDelta = relativeBaseline * rule.relative;
    const relativeResult = (delta) => compareEvaluationMetric({
      metric,
      baseline: snapshot({ [metric]: relativeBaseline }),
      followUp: snapshot({ [metric]: relativeBaseline + delta }),
    });
    assert.equal(relativeResult(relativeDelta - 0.0001).material, false);
    assert.equal(relativeResult(relativeDelta).material, true);
    assert.equal(relativeResult(relativeDelta + 0.0001).material, true);

    const absoluteBaseline = rule.absolute / (rule.relative * 2);
    const absoluteResult = (delta) => compareEvaluationMetric({
      metric,
      baseline: snapshot({ [metric]: absoluteBaseline }),
      followUp: snapshot({ [metric]: absoluteBaseline + delta }),
    });
    assert.equal(absoluteResult(rule.absolute - 0.000001).material, false);
    assert.equal(absoluteResult(rule.absolute).material, true);
    assert.equal(absoluteResult(rule.absolute + 0.000001).material, true);
    for (const result of [relativeResult(relativeDelta), absoluteResult(rule.absolute)]) {
      assert.equal(result.relative_delta == null || Number.isFinite(result.relative_delta), true);
      assert.equal(result.absolute_delta == null || Number.isFinite(result.absolute_delta), true);
    }
  });
}
test("currency mismatch rejects monetary comparability", () => {
  assert.equal(compareEvaluationMetric({ metric: "cpc", baseline: snapshot(), followUp: snapshot({}, { currency: "EUR" }) }).classification, "not_evaluable");
});
test("neutral metrics remain context only", () => {
  assert.equal(compareEvaluationMetric({ metric: "spend", baseline: snapshot({ spend: 100 }), followUp: snapshot({ spend: 200 }) }).classification, "context_only");
});
test("mixed requires conflicting material directional watched metrics", () => {
  const results = [
    { metric: "ctr", minimum_evidence_met: true, classification: "improved" },
    { metric: "cpc", minimum_evidence_met: true, classification: "worsened" },
    { metric: "spend", minimum_evidence_met: true, classification: "context_only" },
  ];
  assert.equal(classifyOverallResult({ primaryMetric: "ctr", watchedMetrics: ["ctr", "cpc", "spend"], metricResults: results }), "mixed");
  assert.equal(classifyOverallResult({ primaryMetric: "ctr", watchedMetrics: ["ctr", "spend"], metricResults: results }), "improved");
});
test("overlap excludes own chain, cancelled, and observational actions", () => {
  const items = [
    { _id: objectId("01"), status: "superseded", action_type: "replace_creative", performed_at: "2026-03-09T12:00:00Z" },
    { _id: objectId("06"), status: "active", action_type: "replace_creative", performed_at: "2026-03-09T12:00:00Z" },
    { _id: objectId("07"), status: "active", action_type: "monitor_only", performed_at: "2026-03-09T12:00:00Z" },
    { _id: objectId("08"), status: "cancelled", action_type: "change_targeting", performed_at: "2026-03-09T12:00:00Z" },
  ];
  assert.deepEqual(detectOverlap({ interventions: items, subjectChainIds: [objectId("01")], followUpWindow: { start: "2026-03-09", end: "2026-03-09" }, timezone: "America/New_York" }).map((item) => item._id), [objectId("06")]);
});
test("evidence hashing is stable across key order and numeric precision", () => {
  assert.equal(hashEvaluationEvidence({ b: 2, a: 1.0000000001 }), hashEvaluationEvidence({ a: 1, b: 2 }));
});
