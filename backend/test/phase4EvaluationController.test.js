import test from "node:test";
import assert from "node:assert/strict";

import evaluationRouter from "../src/routes/evaluations.routes.js";
import interventionRouter from "../src/routes/interventions.routes.js";
import { evaluationControllerInternals } from "../src/controllers/evaluations.controller.js";
import { serializeEvaluationDetail } from "../src/utils/evaluationSerializers.js";

test("workspace list requires an approved bounded filter", () => {
  assert.throws(() => evaluationControllerInternals.filtersFor({}), (error) => error.code === "EVALUATION_FILTER_REQUIRED");
  assert.deepEqual(evaluationControllerInternals.filtersFor({ status: "ready" }), { status: "ready" });
});
test("workspace filters reject unsupported statuses, metrics, results, and IDs", () => {
  for (const query of [{ status: "pending" }, { primaryMetric: "reach" }, { observedResult: "success" }, { clientId: "bad" }]) assert.throws(() => evaluationControllerInternals.filtersFor(query), (error) => error.code === "EVALUATION_VALIDATION_FAILED");
});
test("Intervention history cursor is deterministic and sequence-scoped", () => {
  const page = evaluationControllerInternals.finalizeSequencePage({
    documents: [{ sequence: 3 }, { sequence: 2 }, { sequence: 1 }],
    limit: 2,
  });
  assert.equal(page.page.hasMore, true);
  assert.equal(evaluationControllerInternals.decodeSequenceCursor(page.page.nextCursor), 2);
  assert.throws(
    () => evaluationControllerInternals.decodeSequenceCursor("not-a-cursor"),
    (error) => error.code === "INVALID_CURSOR"
  );
});
test("routes expose the four approved operations and no destructive route", () => {
  const evaluationPaths = evaluationRouter.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
  const interventionPaths = interventionRouter.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`);
  assert.ok(evaluationPaths.includes("get /"));
  assert.ok(evaluationPaths.includes("get /:evaluationId"));
  assert.ok(interventionPaths.includes("get /:interventionId/evaluations"));
  assert.ok(interventionPaths.includes("post /:interventionId/evaluations/refresh"));
  assert.equal([...evaluationPaths, ...interventionPaths].some((item) => /delete|patch|put/.test(item)), false);
});
test("detail serializer does not expose request, lease, actor email, token, raw rows, or HTML", () => {
  const output = serializeEvaluationDetail({ _id: "507f1f77bcf86cd799439011", status: "not_evaluable", reason_codes: [], watched_metrics: [], metric_results: [], request_hash: "secret", idempotency_key: "secret", processing_lock: { token: "secret" }, actor_email: "secret@example.com", rawRows: [{ secret: true }], html: "secret" });
  const serialized = JSON.stringify(output);
  for (const secret of ["request_hash", "idempotency_key", "processing_lock", "actor_email", "rawRows", "secret@example.com"]) assert.equal(serialized.includes(secret), false);
});
