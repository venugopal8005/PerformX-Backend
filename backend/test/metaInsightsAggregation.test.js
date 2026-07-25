import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateMetaMetrics,
  normalizeMetaInsightRow,
} from "../src/services/metaInsights.service.js";

const purchaseValue = (value) => [{ action_type: "purchase", value }];
const purchases = (value) => [{ action_type: "purchase", value }];

test("aggregate ROAS is derived from total conversion value and total spend", () => {
  const metrics = aggregateMetaMetrics([
    {
      spend: "10",
      impressions: "100",
      clicks: "10",
      actions: purchases("1"),
      action_values: purchaseValue("10"),
      purchase_roas: [{ action_type: "purchase", value: "1" }],
    },
    {
      spend: "90",
      impressions: "900",
      clicks: "90",
      actions: purchases("9"),
      action_values: purchaseValue("270"),
      purchase_roas: [{ action_type: "purchase", value: "3" }],
    },
  ]);

  assert.equal(metrics.roas, 2.8);
  assert.equal(metrics.cpa, 10);
});

test("aggregate ROAS ignores row ratios and uses only raw attributed value", () => {
  const metrics = aggregateMetaMetrics([
    {
      spend: "25",
      action_values: purchaseValue("50"),
      purchase_roas: [{ action_type: "purchase", value: "999" }],
      roas: "999",
    },
    {
      spend: "75",
      action_values: purchaseValue("50"),
      purchase_roas: [{ action_type: "purchase", value: "0.01" }],
      roas: "0.01",
    },
  ]);

  assert.equal(metrics.roas, 1);
});

test("aggregate ratios use raw additive totals before final rounding", () => {
  const rows = Array.from({ length: 3 }, () => ({
    spend: "0.006",
    action_values: purchaseValue("0.006"),
  }));
  const metrics = aggregateMetaMetrics(rows);

  assert.equal(metrics.spend, 0.02);
  assert.equal(metrics.roas, 1);
});

test("zero, missing, and malformed aggregate inputs remain finite", () => {
  const cases = [
    [{ spend: "0", action_values: purchaseValue("100") }],
    [{ action_values: purchaseValue("100") }],
    [{ spend: "not-a-number", action_values: purchaseValue("also-bad") }],
    [{ spend: "Infinity", action_values: purchaseValue("-Infinity") }],
    [{ spend: "10" }, { spend: "20", action_values: purchaseValue("30") }],
  ];

  for (const rows of cases) {
    const metrics = aggregateMetaMetrics(rows);
    for (const value of Object.values(metrics)) {
      assert.equal(Number.isFinite(value), true);
    }
  }

  assert.equal(aggregateMetaMetrics(cases[0]).roas, 0);
  assert.equal(aggregateMetaMetrics(cases[4]).roas, 1);
});

test("normalized insight rows preserve normalized attribution authority", () => {
  const normalized = normalizeMetaInsightRow({
    action_attribution_windows: ["7D_CLICK", "1d_view", "7d_click"],
  });

  assert.deepEqual(normalized.action_attribution_windows, ["1d_view", "7d_click"]);
  assert.equal(
    normalizeMetaInsightRow({}).action_attribution_windows,
    null
  );
});
