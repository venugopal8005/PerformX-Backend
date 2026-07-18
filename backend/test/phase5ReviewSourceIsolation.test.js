import assert from "node:assert/strict";
import test from "node:test";

import { Report } from "../src/models/index.js";
import { markExecutionIntegrityReady } from "../src/services/executionIntegrityIndexes.service.js";
import { projectSourceSafely } from "../src/services/reviewProjection.service.js";
import { runDueReports } from "../src/services/reportRunner.service.js";

test("post-commit Review projection converts readiness failure into a deferred result", async () => {
  const result = await projectSourceSafely(async () => {
    throw Object.assign(new Error("not ready"), { code: "REVIEW_INDEXES_NOT_READY" });
  }, { sourceId: "source-1" });

  assert.deepEqual(result, { deferred: true });
});

test("post-commit Review projection isolates unexpected failures", async () => {
  const result = await projectSourceSafely(async () => {
    throw Object.assign(new Error("unexpected"), { code: "REVIEW_TEST_FAILURE" });
  }, { sourceId: "source-2" }, { operation: "test_projection" });

  assert.deepEqual(result, { deferred: true });
});

for (const [failureName, errorCode] of [
  ["transaction failure", "REVIEW_TRANSACTION_REQUIRED"],
  ["validation failure", "REVIEW_VALIDATION_FAILED"],
  ["duplicate integrity conflict", "REVIEW_IDEMPOTENCY_CONFLICT"],
]) {
  test(`post-commit Review projection isolates ${failureName}`, async () => {
    const result = await projectSourceSafely(async () => {
      throw Object.assign(new Error(failureName), { code: errorCode });
    }, { sourceId: `source-${errorCode}` }, { operation: "test_projection" });

    assert.deepEqual(result, { deferred: true });
  });
}

test("scheduler Review maintenance failure is isolated after Evaluation maintenance", async () => {
  const originalFind = Report.find;
  const originalFetch = globalThis.fetch;
  const calls = [];
  let externalCalls = 0;
  markExecutionIntegrityReady([]);
  Report.find = () => ({ sort: async () => [] });
  globalThis.fetch = async () => {
    externalCalls += 1;
    throw new Error("No external request is allowed in this test.");
  };

  try {
    const result = await runDueReports({
      agencyId: "agency-1",
      now: new Date("2026-07-18T12:00:00.000Z"),
      evaluationMaintenanceProcessor: async () => { calls.push("evaluation"); },
      reviewMaintenanceProcessor: async () => {
        calls.push("review");
        throw Object.assign(new Error("isolated Review maintenance failure"), { code: "REVIEW_TEST_FAILURE" });
      },
    });

    assert.deepEqual(calls, ["evaluation", "review"]);
    assert.deepEqual(result, { ranCount: 0, checkedCount: 0, results: [] });
    assert.equal(externalCalls, 0);
  } finally {
    Report.find = originalFind;
    globalThis.fetch = originalFetch;
  }
});
