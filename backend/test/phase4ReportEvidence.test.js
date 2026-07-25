import test from "node:test";
import assert from "node:assert/strict";

import { buildReportRunEvaluationEvidence } from "../src/services/reportEvaluationEvidence.service.js";

const base = (overrides = {}) => ({
  currentRows: [{ campaign_id: "c1", campaign_name: "One", spend: "10", impressions: "1000", clicks: "50", actions: [{ action_type: "purchase", value: "5" }], action_values: [{ action_type: "purchase", value: "40" }] }],
  monitoredCampaigns: [{ campaign_id: "c1", campaign_name: "One" }],
  period: { timezone: "UTC", current: { start: "2026-01-02", end: "2026-01-02" }, previous: { start: "2026-01-01", end: "2026-01-01" } },
  timezone: "UTC", currency: "USD", attributionWindows: ["7d_click"], metaBindingRevision: 2,
  comparisonMode: "scheduled_window", cadence: "daily", triggerType: "scheduled", capturedAt: new Date("2026-01-03T00:00:00Z"), ...overrides,
});

test("evidence is bounded and derived rates are recalculated from additive totals", () => {
  const evidence = buildReportRunEvaluationEvidence(base());
  assert.equal(evidence.completeness, "complete");
  assert.deepEqual(evidence.campaign_snapshots[0], { campaign_id: "c1", campaign_name: "One", provenance: "scheduled_window", spend: 10, impressions: 1000, clicks: 50, conversions: 5, conversion_value: 40, ctr: 5, cpc: 0.2, cpm: 10, cpa: 2, roas: 4, conversion_rate: 10, row_count: 1, source_level: "campaign", completeness: "complete", warnings: [] });
});
test("row-level rates, reach, frequency, and raw action arrays are not copied", () => {
  const snapshot = buildReportRunEvaluationEvidence(base({ currentRows: [{ ...base().currentRows[0], ctr: "99", cpc: "99", reach: "900", frequency: "8" }] })).campaign_snapshots[0];
  assert.equal(snapshot.ctr, 5);
  assert.equal("reach" in snapshot, false);
  assert.equal("frequency" in snapshot, false);
  assert.equal("actions" in snapshot, false);
});
test("explicit monitored campaign with no returned rows produces zero delivery", () => {
  const snapshot = buildReportRunEvaluationEvidence(base({ currentRows: [] })).campaign_snapshots[0];
  assert.equal(snapshot.completeness, "zero_delivery");
  assert.equal(snapshot.spend, 0);
  assert.equal(snapshot.ctr, null);
});
test("historical fallback evidence is persisted as ineligible", () => {
  const evidence = buildReportRunEvaluationEvidence(base({ comparisonMode: "historical_fallback" }));
  assert.equal(evidence.completeness, "ineligible");
  assert.ok(evidence.warnings.includes("historical_fallback_evidence"));
});
test("missing timezone, invalid cadence, and malformed windows remain bounded and ineligible", () => {
  const evidence = buildReportRunEvaluationEvidence(base({
    timezone: null,
    period: { current: { start: "bad", end: "bad" }, previous: { start: "2026-01-01", end: "2026-01-01" } },
    cadence: "hourly",
  }));
  assert.equal(evidence.completeness, "ineligible");
  assert.equal(evidence.current_window, null);
  assert.ok(evidence.warnings.includes("window_context_unavailable"));
});
test("manual canonical evidence receives bounded manual provenance", () => {
  assert.equal(buildReportRunEvaluationEvidence(base({ triggerType: "manual" })).campaign_snapshots[0].provenance, "scheduled_manual_window");
});
test("malformed and duplicate campaign identities fail closed", () => {
  assert.equal(buildReportRunEvaluationEvidence(base({ monitoredCampaigns: [{ campaign_id: "" }] })).completeness, "ineligible");
  assert.equal(buildReportRunEvaluationEvidence(base({ monitoredCampaigns: [{ campaign_id: "c1" }, { campaign_id: "c1" }] })).completeness, "ineligible");
});
test("unexpected campaign rows fail closed instead of leaking into a snapshot", () => {
  const evidence = buildReportRunEvaluationEvidence(base({ currentRows: [...base().currentRows, { campaign_id: "foreign", spend: 100 }] }));
  assert.equal(evidence.completeness, "ineligible");
  assert.equal(evidence.campaign_snapshots.length, 1);
});
test("inconsistent row currency fails closed", () => {
  const evidence = buildReportRunEvaluationEvidence(base({ currentRows: [{ ...base().currentRows[0], account_currency: "EUR" }] }));
  assert.equal(evidence.completeness, "ineligible");
});
test("conversion value stays null when action value evidence is absent", () => {
  const evidence = buildReportRunEvaluationEvidence(base({ currentRows: [{ ...base().currentRows[0], action_values: undefined }] }));
  assert.equal(evidence.campaign_snapshots[0].conversion_value, null);
  assert.equal(evidence.campaign_snapshots[0].roas, null);
});
test("empty action value evidence remains null while explicit zero remains zero", () => {
  const empty = buildReportRunEvaluationEvidence(base({ currentRows: [{ ...base().currentRows[0], action_values: [] }] }));
  assert.equal(empty.campaign_snapshots[0].conversion_value, null);
  assert.equal(empty.campaign_snapshots[0].roas, null);
  const explicitZero = buildReportRunEvaluationEvidence(base({ currentRows: [{ ...base().currentRows[0], action_values: [{ action_type: "purchase", value: "0" }] }] }));
  assert.equal(explicitZero.campaign_snapshots[0].conversion_value, 0);
  assert.equal(explicitZero.campaign_snapshots[0].roas, 0);
});
test("malformed supplied additive metrics fail closed instead of becoming valid zero evidence", () => {
  for (const currentRows of [
    [{ ...base().currentRows[0], spend: "not-a-number" }],
    [{ ...base().currentRows[0], clicks: "-1" }],
    [{ ...base().currentRows[0], actions: [{ action_type: "purchase", value: "bad" }] }],
    [{ ...base().currentRows[0], action_values: { purchase: "40" } }],
  ]) {
    const evidence = buildReportRunEvaluationEvidence(base({ currentRows }));
    assert.equal(evidence.completeness, "ineligible");
    assert.ok(evidence.warnings.includes("malformed_metric_evidence"));
  }
});
test("invalid supplied row currency fails closed", () => {
  const evidence = buildReportRunEvaluationEvidence(base({
    currentRows: [{ ...base().currentRows[0], account_currency: "US" }],
  }));
  assert.equal(evidence.completeness, "ineligible");
  assert.ok(evidence.warnings.includes("currency_unavailable_or_inconsistent"));
});
test("overlong campaign identity is rejected rather than truncated", () => {
  const id = "c".repeat(257);
  const evidence = buildReportRunEvaluationEvidence(base({
    monitoredCampaigns: [{ campaign_id: id }],
    currentRows: [{ ...base().currentRows[0], campaign_id: id }],
  }));
  assert.equal(evidence.completeness, "ineligible");
  assert.equal(evidence.campaign_snapshots.length, 0);
  assert.ok(evidence.warnings.includes("malformed_campaign_identity"));
});
test("invalid timezone, calendar date, or cadence duration fails closed at evidence creation", () => {
  const cases = [
    { timezone: "Not/A_Timezone" },
    { period: { timezone: "UTC", current: { start: "2026-02-30", end: "2026-02-30" }, previous: { start: "2026-02-28", end: "2026-02-28" } } },
    { period: { timezone: "UTC", current: { start: "2026-01-02", end: "2026-01-03" }, previous: { start: "2025-12-31", end: "2026-01-01" } } },
  ];
  for (const overrides of cases) {
    const evidence = buildReportRunEvaluationEvidence(base(overrides));
    assert.equal(evidence.completeness, "ineligible");
    assert.ok(evidence.warnings.includes("window_context_unavailable"));
  }
});
test("oversized or malformed attribution metadata is rejected rather than truncated", () => {
  for (const attributionWindows of [Array.from({ length: 9 }, (_, index) => `${index}d_click`), ["7d_click", { value: "1d_view" }]]) {
    const evidence = buildReportRunEvaluationEvidence(base({ attributionWindows }));
    assert.equal(evidence.completeness, "complete");
    assert.deepEqual(evidence.attribution_windows, []);
    assert.ok(evidence.warnings.includes("attribution_context_inconsistent"));
  }
});
test("row attribution is normalized and conflicting rows fail conversion comparability only", () => {
  const matching = buildReportRunEvaluationEvidence(base({
    attributionWindows: null,
    currentRows: [
      { ...base().currentRows[0], action_attribution_windows: ["7D_CLICK", "1d_view"] },
      { ...base().currentRows[0], action_attribution_windows: ["1d_view", "7d_click"] },
    ],
  }));
  assert.deepEqual(matching.attribution_windows, ["1d_view", "7d_click"]);
  assert.equal(matching.completeness, "complete");
  const conflicting = buildReportRunEvaluationEvidence(base({
    attributionWindows: null,
    currentRows: [
      { ...base().currentRows[0], action_attribution_windows: ["7d_click"] },
      { ...base().currentRows[0], action_attribution_windows: ["1d_click"] },
    ],
  }));
  assert.deepEqual(conflicting.attribution_windows, []);
  assert.equal(conflicting.completeness, "complete");
  assert.ok(conflicting.warnings.includes("attribution_context_inconsistent"));
  assert.equal(conflicting.campaign_snapshots[0].ctr, 5);
});
test("missing row attribution is retained as non-comparable evidence", () => {
  const evidence = buildReportRunEvaluationEvidence(base({
    attributionWindows: null,
    currentRows: [{ ...base().currentRows[0], action_attribution_windows: undefined }],
  }));

  assert.deepEqual(evidence.attribution_windows, []);
  assert.ok(evidence.warnings.includes("attribution_context_unavailable"));
  assert.equal(evidence.campaign_snapshots[0].cpa, 2);
  assert.equal(evidence.campaign_snapshots[0].roas, 4);
});
