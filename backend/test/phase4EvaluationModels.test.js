import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { Evaluation } from "../src/models/Evaluation.js";
import { EvaluationSeries } from "../src/models/EvaluationSeries.js";
import { Intervention } from "../src/models/Intervention.js";
import { ReportRun } from "../src/models/ReportRun.js";
import { serializeEvaluationDetail } from "../src/utils/evaluationSerializers.js";

const id = () => new mongoose.Types.ObjectId();
const values = { spend: 100, impressions: 1000, clicks: 100, conversions: 10, conversion_value: 200, ctr: 10, cpc: 1, cpm: 100, cpa: 10, roas: 2, conversion_rate: 10 };
const snapshot = () => ({ report_run_id: id(), window: { start: "2026-01-01", end: "2026-01-01", timezone: "UTC", cadence: "daily" }, campaign_id: "c1", campaign_name: "One", currency: "USD", attribution_windows: ["7d_click"], meta_binding_revision: 1, provenance: "scheduled_window", values, row_count: 1, source_level: "campaign", completeness: "complete" });
const valid = () => {
  const interventionId = id();
  return { agency_id: id(), client_id: id(), issue_id: id(), intervention_id: interventionId, meta_ad_account_id: id(), campaign_id: "c1", report_id_at_action: id(), action_type: "replace_creative", sequence: 1, schema_version: 1, rule_version: 1, evidence_version: 1, normalization_version: 1, trigger_type: "report_run", source_report_run_id: id(), status: "ready", intent: { mode: "auto_resolved", primary_metric: "ctr", watched_metrics: ["ctr"], resolution_source: "issue_metric_family", rule_version: 1 }, primary_metric: "ctr", watched_metrics: ["ctr"], baseline: snapshot(), follow_up: snapshot(), metric_results: [{ metric: "ctr", directionality: "higher_is_better", unit: "percent", baseline_value: 2, follow_up_value: 3, absolute_delta: 1, relative_delta: 0.5, minimum_evidence_met: true, material: true, classification: "improved", reason_codes: [] }], observed_result: "improved", interpretability: "directional", reason_codes: [], overlap_intervention_ids: [], evidence_completeness: "complete", summary: "CTR improved across the bounded windows. This is an observed association, not causal attribution.", evidence_hash: "a".repeat(64), idempotency_key: "phase4:test:123456789", supersedes_evaluation_id: null, invalidation_context: null, calculated_at: new Date() };
};

test("Evaluation strict schema validates bounded immutable evidence without Mixed paths", async () => {
  const document = new Evaluation(valid());
  await document.validate();
  assert.equal(Evaluation.schema.path("agency_id").options.immutable, true);
  assert.equal(Evaluation.schema.path("metric_results").instance, "Array");
  assert.equal(Evaluation.schema.options.strict, "throw");
  assert.equal(Evaluation.schema.options.autoIndex, false);
  assert.equal(Evaluation.schema.options.autoCreate, false);
});
test("Evaluation rejects persisted pending and superseded statuses", async () => {
  for (const status of ["pending", "superseded"]) await assert.rejects(new Evaluation({ ...valid(), status }).validate(), /status/);
});
test("Evaluation arrays reject evidence beyond domain bounds", async () => {
  const tooManyWatched = valid();
  tooManyWatched.watched_metrics = ["ctr", "cpc", "cpm", "cpa", "roas", "conversions", "clicks"];
  await assert.rejects(new Evaluation(tooManyWatched).validate(), /watched metrics exceed/);

  const tooManyAttributionWindows = valid();
  tooManyAttributionWindows.baseline.attribution_windows = Array.from({ length: 9 }, (_, index) => `${index}d_click`);
  await assert.rejects(new Evaluation(tooManyAttributionWindows).validate(), /attribution windows exceed/);
});
test("ordinary Evaluation query mutation is rejected before database access", async () => {
  await assert.rejects(Evaluation.updateOne({ _id: id() }, { $set: { status: "invalidated" } }).exec(), (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED");
  await assert.rejects(Evaluation.deleteMany({}).exec(), (error) => error.code === "EVALUATION_QUERY_MUTATION_REJECTED");
});
test("EvaluationSeries is strict, index-disabled, and rejects unapproved mutation", async () => {
  assert.equal(EvaluationSeries.schema.options.strict, "throw");
  assert.equal(EvaluationSeries.schema.options.autoIndex, false);
  assert.equal(EvaluationSeries.schema.options.autoCreate, false);
  await assert.rejects(EvaluationSeries.updateOne({ _id: id() }, { $inc: { revision: 1 } }).exec(), (error) => error.code === "EVALUATION_SERIES_QUERY_MUTATION_REJECTED");
});
test("Intervention intent remains optional for legacy records and strict for future records", async () => {
  assert.equal(Intervention.schema.path("evaluation_intent").options.immutable, true);
  const intent = Intervention.schema.path("evaluation_intent").schema;
  assert.equal(intent.options.strict, "throw");
});
test("ReportRun evidence remains optional and uses strict nested schemas", () => {
  const path = ReportRun.schema.path("evaluation_evidence");
  assert.ok(path.schema);
  assert.equal(path.schema.options.strict, "throw");
  const campaignValidators = path.schema.path("campaign_snapshots").validators;
  const attributionValidators = path.schema.path("attribution_windows").validators;
  assert.equal(campaignValidators.some(({ validator }) => validator(Array(101).fill({})) === false), true);
  assert.equal(attributionValidators.some(({ validator }) => validator(Array(9).fill("7d_click")) === false), true);
  assert.equal(new ReportRun().evaluation_evidence, undefined);
});
test("serializer derives display status and excludes hashes, keys, leases, and private delivery data", () => {
  const raw = { ...valid(), _id: id(), request_hash: "secret", processing_lock: { token: "secret" }, email_html: "secret" };
  const successorId = id();
  const output = serializeEvaluationDetail(raw, { superseded: true, supersededByEvaluationId: successorId, canRefresh: true });
  assert.equal(output.effectiveStatus, "superseded");
  assert.equal(output.supersededByEvaluationId, String(successorId));
  assert.equal(output.canRefresh, true);
  for (const key of ["request_hash", "evidence_hash", "idempotency_key", "processing_lock", "email_html"]) assert.equal(key in output, false);
});
test("models declare exactly the twelve approved Phase 4 index names", () => {
  const names = [...Evaluation.schema.indexes(), ...EvaluationSeries.schema.indexes()].map(([, options]) => options.name).filter((name) => name?.startsWith("phase4_"));
  assert.equal(names.length, 12);
  assert.equal(new Set(names).size, 12);
});
