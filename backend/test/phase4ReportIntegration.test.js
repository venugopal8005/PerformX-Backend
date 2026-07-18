import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReportRunEvaluationEvidenceFromInsights,
  processReportRunIssuesBeforeDelivery,
} from "../src/services/reportRunner.service.js";
import { fetchMetaInsights } from "../src/services/metaInsights.service.js";

test("Report integration runs Issue processing before isolated Evaluation and delivery", async () => {
  const order = [];
  const result = await processReportRunIssuesBeforeDelivery({ reportRunId: "run-1", metadata: {}, issueProcessor: async () => order.push("issues"), evaluationProcessor: async () => order.push("evaluations"), beforeDelivery: async () => order.push("before_delivery"), deliveryProcessor: async () => { order.push("delivery"); return { reportRun: { _id: "run-1" } }; } });
  assert.deepEqual(order, ["issues", "evaluations", "before_delivery", "delivery"]);
  assert.equal(result.reportRun._id, "run-1");
});
test("Evaluation failure cannot prevent delivery or alter its response", async () => {
  const expected = { reportRun: { _id: "run-2" }, hasSafeFailure: false, hasUncertain: false };
  const result = await processReportRunIssuesBeforeDelivery({ reportRunId: "run-2", metadata: {}, issueProcessor: async () => {}, evaluationProcessor: async () => { throw new Error("evaluation exploded"); }, deliveryProcessor: async () => expected });
  assert.equal(result, expected);
});
test("Report integration supplies only a persisted ReportRun identifier to Evaluation", async () => {
  let received;
  await processReportRunIssuesBeforeDelivery({ reportRunId: "run-3", metadata: { secret: true }, issueProcessor: async () => {}, evaluationProcessor: async (input) => { received = input; }, deliveryProcessor: async () => ({}) });
  assert.deepEqual(received, { reportRunId: "run-3" });
});

test("Meta Insights result preserves exact row attribution authority", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl;
  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return ({
    ok: true,
    async json() {
      return { data: [{ campaign_id: "c1", spend: "1", impressions: "100", clicks: "10", action_attribution_windows: ["7D_CLICK", "1d_view"] }] };
    },
    });
  };
  try {
    const result = await fetchMetaInsights({ accessToken: "test", adAccountId: "act_1", dateRange: { start: "2026-01-02", end: "2026-01-02" } });
    assert.match(new URL(requestUrl).searchParams.get("fields"), /action_attribution_windows/);
    assert.deepEqual(result.attributionContext, { windows: ["1d_view", "7d_click"], source: "response_rows", comparable: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ReportRunner evidence boundary persists Insights attribution and no raw rows", () => {
  const evidence = buildReportRunEvaluationEvidenceFromInsights({
    currentInsights: {
      rows: [{ campaign_id: "c1", spend: "10", impressions: "1000", clicks: "50", actions: [], action_values: [] }],
      attributionContext: { windows: ["7d_click", "1d_view"], source: "request", comparable: true },
    },
    report: { type: "daily", schedule: { timezone: "UTC" }, monitored_campaigns: [{ campaign_id: "c1", campaign_name: "Campaign" }] },
    period: { current: { start: "2026-01-02", end: "2026-01-02" }, previous: { start: "2026-01-01", end: "2026-01-01" } },
    metaAdAccount: { currency: "USD" },
    metaBindingRevision: 2,
    comparisonMode: "scheduled_window",
    source: "scheduled",
    capturedAt: new Date("2026-01-03T00:00:00Z"),
  });
  assert.deepEqual(evidence.attribution_windows, ["1d_view", "7d_click"]);
  assert.equal(evidence.campaign_snapshots[0].conversion_value, null);
  assert.equal("rows" in evidence, false);
  assert.equal("actions" in evidence.campaign_snapshots[0], false);
});

for (const failure of [
  "indexes unavailable",
  "transaction unavailable",
  "validation failed",
  "approved duplicate conflict",
  "unexpected internal error",
]) {
  test(`Report delivery remains isolated when Evaluation reports ${failure}`, async () => {
    const delivery = { reportRun: { _id: `run-${failure}` }, payload: { unchanged: true } };
    let deliveries = 0;
    const result = await processReportRunIssuesBeforeDelivery({
      reportRunId: delivery.reportRun._id,
      metadata: { persisted: true },
      issueProcessor: async () => ({ committed: true }),
      evaluationProcessor: async () => { throw Object.assign(new Error(failure), { code: "CONTROLLED_TEST_FAILURE" }); },
      deliveryProcessor: async () => { deliveries += 1; return delivery; },
    });
    assert.equal(result, delivery);
    assert.equal(deliveries, 1);
  });
}
