import test from "node:test";
import assert from "node:assert/strict";

import { buildEvaluationSummary } from "../src/services/phase4EvaluationEngine.service.js";
import { serializeEvaluationDetail } from "../src/utils/evaluationSerializers.js";

const forbiddenOutcomeLanguage = /\b(caused|fixed|resulted in|led to|successful|failed intervention|effective|ineffective|impact of|improved because|worsened because)\b/i;

test("deterministic Evaluation summaries and serialized output avoid causal outcome language", () => {
  const cases = [
    { status: "invalidated", primaryMetric: "ctr", observedResult: null, reasons: ["intervention_cancelled"] },
    { status: "awaiting_follow_up", primaryMetric: "ctr", observedResult: null, reasons: ["awaiting_follow_up"] },
    { status: "insufficient_data", primaryMetric: "ctr", observedResult: null, reasons: ["minimum_volume_not_met"] },
    { status: "not_evaluable", primaryMetric: "ctr", observedResult: null, reasons: ["overlapping_intervention"] },
    {
      status: "ready",
      primaryMetric: "ctr",
      observedResult: "improved",
      baseline: { values: { ctr: 1 } },
      followUp: { values: { ctr: 2 } },
      reasons: [],
    },
  ];
  for (const input of cases) {
    const summary = buildEvaluationSummary(input);
    const serialized = serializeEvaluationDetail({
      _id: "evaluation-1",
      status: input.status,
      summary,
      metric_results: [],
      watched_metrics: [],
      reason_codes: input.reasons,
      overlap_intervention_ids: [],
    });
    assert.doesNotMatch(summary, forbiddenOutcomeLanguage);
    assert.doesNotMatch(JSON.stringify(serialized), forbiddenOutcomeLanguage);
  }
});
