import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { evaluationServiceInternals } from "../src/services/evaluation.service.js";

const id = () => new mongoose.Types.ObjectId();
const ids = { agency: id(), client: id(), issue: id(), account: id(), report: id(), intervention: id() };
const intervention = (overrides = {}) => ({ _id: ids.intervention, agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, meta_ad_account_id: ids.account, campaign_id: "c1", report_id_at_action: ids.report, action_type: "replace_creative", performed_at: new Date("2026-01-02T12:00:00Z"), status: "active", evaluation_intent: { mode: "auto_resolved", primary_metric: "ctr", watched_metrics: ["ctr"], resolution_source: "issue_metric_family", rule_version: 1 }, ...overrides });
const snapshot = (start, metrics = {}) => ({ version: 1, captured_at: new Date(), normalization_version: 1, timezone: "UTC", currency: "USD", attribution_windows: ["7d_click"], meta_binding_revision: 1, comparison_mode: "scheduled_window", cadence: "daily", current_window: { start, end: start }, previous_window: { start, end: start }, campaign_snapshots: [{ campaign_id: "c1", campaign_name: "One", provenance: "scheduled_window", spend: 100, impressions: 1000, clicks: 50, conversions: 5, conversion_value: 100, ctr: 5, cpc: 2, cpm: 100, cpa: 20, roas: 1, conversion_rate: 10, row_count: 1, source_level: "campaign", completeness: "complete", warnings: [], ...metrics }], completeness: "complete", warnings: [] });
const run = (start, metrics) => ({ _id: id(), agency_id: ids.agency, client_id: ids.client, report_id: ids.report, meta_ad_account_id: ids.account, meta_binding_revision_snapshot: 1, evaluation_evidence: snapshot(start, metrics) });
const report = { _id: ids.report, type: "daily", schedule: { timezone: "UTC" } };
const compute = ({ item = intervention(), runs = [run("2026-01-01", { ctr: 2 }), run("2026-01-03", { ctr: 3 })], related = null, now = new Date("2026-01-04T00:00:00Z"), triggerType = "report_run" } = {}) => evaluationServiceInternals.computeCandidate({ intervention: item, runs, relatedInterventions: related || [item], triggerType, sourceReportRunId: runs.at(-1)?._id, report, now });

test("service candidate becomes ready from exact baseline and follow-up evidence", () => {
  const candidate = compute();
  assert.equal(candidate.status, "ready");
  assert.equal(candidate.observed_result, "improved");
  assert.equal(candidate.evidence_completeness, "complete");
  assert.equal(candidate.confidence_level, "medium");
  assert.equal(candidate.threshold_snapshots[0].minimum_evidence.impressions, 100);
});
test("missing canonical follow-up persists awaiting state", () => {
  const candidate = compute({ runs: [run("2026-01-01", { ctr: 2 })], now: new Date("2026-01-04T00:00:00Z") });
  assert.equal(candidate.status, "awaiting_follow_up");
  assert.deepEqual(candidate.reason_codes, ["awaiting_follow_up"]);
});
test("expired canonical follow-up persists insufficient_data with precise timeout reason", () => {
  const candidate = compute({ runs: [run("2026-01-01", { ctr: 2 })], now: new Date("2026-01-20T00:00:00Z") });
  assert.equal(candidate.status, "insufficient_data");
  assert.equal(candidate.confidence_level, "low");
  assert.deepEqual(candidate.reason_codes, ["follow_up_timeout"]);
  assert.match(candidate.summary, /insufficient persisted evidence/i);
});
test("invalid persisted source evidence preserves its precise controlled reason", () => {
  const fallback = run("2026-01-01", { ctr: 2 });
  fallback.evaluation_evidence.comparison_mode = "historical_fallback";
  const candidate = compute({ runs: [fallback], now: new Date("2026-01-20T00:00:00Z") });
  assert.equal(candidate.status, "not_evaluable");
  assert.deepEqual(candidate.reason_codes, ["historical_fallback_evidence"]);
});
test("minimum-volume failure persists insufficient data", () => {
  const candidate = compute({ runs: [run("2026-01-01", { impressions: 20, clicks: 1, ctr: 5 }), run("2026-01-03", { impressions: 20, clicks: 2, ctr: 10 })] });
  assert.equal(candidate.status, "insufficient_data");
});
test("separate same-campaign action contaminates follow-up", () => {
  const separate = intervention({ _id: id(), performed_at: new Date("2026-01-03T14:00:00Z"), action_type: "change_targeting" });
  const candidate = compute({ related: [intervention(), separate] });
  assert.equal(candidate.status, "not_evaluable");
  assert.deepEqual(candidate.reason_codes, ["overlapping_intervention"]);
  assert.equal(candidate.confidence_level, "unavailable");
  assert.ok(candidate.confidence_factors.includes("overlapping_intervention"));
});
test("correction predecessor and successor collapse to one overlap chain", () => {
  const predecessor = intervention({ status: "superseded", superseded_by_intervention_id: id() });
  const successor = intervention({ _id: predecessor.superseded_by_intervention_id, supersedes_intervention_id: predecessor._id });
  const candidate = compute({ item: successor, related: [predecessor, successor] });
  assert.equal(candidate.status, "ready");
});
test("cancelled and superseded records append invalidated candidates", () => {
  for (const status of ["cancelled", "superseded"]) {
    const candidate = compute({ item: intervention({ status }), runs: [] });
    assert.equal(candidate.status, "invalidated");
    assert.ok(candidate.invalidation_context);
  }
});
test("legacy Intervention without intent remains readable but not evaluable", () => {
  const candidate = compute({ item: intervention({ evaluation_intent: undefined }) });
  assert.equal(candidate.status, "not_evaluable");
  assert.deepEqual(candidate.reason_codes, ["intent_unresolved"]);
});
test("not-applicable tracking intent remains controlled", () => {
  const candidate = compute({ item: intervention({ action_type: "fix_tracking", evaluation_intent: { mode: "not_applicable", primary_metric: null, watched_metrics: [], resolution_source: "tracking_comparability", rule_version: 1 } }) });
  assert.equal(candidate.status, "not_evaluable");
  assert.deepEqual(candidate.reason_codes, ["tracking_comparability_unavailable"]);
});
test("same evidence creates the same stable candidate hash", () => {
  const runs = [run("2026-01-01", { ctr: 2 }), run("2026-01-03", { ctr: 3 })];
  assert.equal(compute({ runs }).evidence_hash, compute({ runs }).evidence_hash);
});
