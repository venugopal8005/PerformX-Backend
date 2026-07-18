import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createReviewItemIntervention, getReviewItems } from "../src/controllers/review.controller.js";
import { serializeReviewAction, serializeReviewItemDetail } from "../src/utils/reviewSerializers.js";

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

test("Review controllers reject missing workspace context without service access", async () => {
  const res = response();
  await getReviewItems({ user: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test("Review-to-Intervention rejects malformed IDs with a non-disclosing 404", async () => {
  const res = response();
  await createReviewItemIntervention({ user: { agencyId: "agency-1" }, params: { reviewItemId: "not-an-object-id" }, body: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "REVIEW_NOT_FOUND");
  assert.equal(res.body.message, "Review item not found.");
});

test("Review serializers exclude private hashes, keys, leases, email, and Review origin", () => {
  const value = {
    _id: "64b000000000000000000001",
    type: "issue_review",
    state: "open",
    priority: "high",
    reason: "issue_created",
    generation: 1,
    revision: 2,
    issue_id: "64b000000000000000000002",
    context_snapshot: { version: 1, client: {}, account: {}, campaign: {}, issue: {}, provenance: "snapshot" },
    request_hash: "secret-hash",
    idempotency_key: "secret-key-123456",
    processing_lock: { token: "secret-token" },
    review_origin: { version: 1 },
    actor_email: "private@example.com",
  };
  const action = serializeReviewAction({ ...value, review_item_id: value._id, sequence: 1, action_type: "acknowledged", actor_type: "human" });
  const output = JSON.stringify({ item: serializeReviewItemDetail(value, { effectiveState: "open", mutationPermissions: {} }), action });
  for (const secret of ["secret-hash", "secret-key", "secret-token", "review_origin", "private@example.com"]) assert.equal(output.includes(secret), false);
});

test("Phase 5 routes expose the exact bounded API surface behind membership middleware", async () => {
  const [reviewRoutes, clientRoutes, issueRoutes, server] = await Promise.all([
    readFile(new URL("../src/routes/review.routes.js", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/clients.routes.js", import.meta.url), "utf8"),
    readFile(new URL("../src/routes/issues.routes.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
  ]);
  for (const route of [
    'router.get("/summary", protect, requireWorkspaceMember, getReviewSummary)',
    'router.get("/", protect, requireWorkspaceMember, getReviewItems)',
    'router.get("/:reviewItemId/actions", protect, requireWorkspaceMember, getReviewActions)',
    'router.post("/:reviewItemId/acknowledge", protect, requireWorkspaceMember, acknowledgeReview)',
    'router.post("/:reviewItemId/snooze", protect, requireWorkspaceMember, snoozeReview)',
    'router.post("/:reviewItemId/review", protect, requireWorkspaceMember, interpretReview)',
    'router.post("/:reviewItemId/interventions", protect, requireWorkspaceMember, createReviewItemIntervention)',
    'router.get("/:reviewItemId", protect, requireWorkspaceMember, getReviewItem)',
  ]) assert.equal(reviewRoutes.includes(route), true, route);
  assert.match(clientRoutes, /\/:clientId\/review-items/);
  assert.match(clientRoutes, /\/:clientId\/review-summary/);
  assert.match(issueRoutes, /\/:issueId\/timeline/);
  assert.match(server, /app\.use\("\/api\/review-items", reviewRouter\)/);
});
