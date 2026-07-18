import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";

import { resolveReviewEffectiveState } from "../src/services/reviewAuthority.service.js";

const oid = () => new mongoose.Types.ObjectId();
const fixture = (overrides = {}) => {
  const ids = { agency: oid(), client: oid(), account: oid(), issue: oid(), series: oid(), evaluation: oid() };
  const reviewItem = {
    _id: oid(), agency_id: ids.agency, client_id: ids.client, meta_ad_account_id: ids.account,
    meta_binding_revision_snapshot: 3, issue_id: ids.issue, type: "issue_review", state: "open",
    priority: "high", source_revision: 4, snoozed_until: null,
  };
  const base = {
    reviewItem,
    client: { _id: ids.client, agency_id: ids.agency, is_archived: false },
    metaAccount: { _id: ids.account, agency_id: ids.agency, client_id: ids.client, is_active: true, is_accessible: true, binding_revision: 3 },
    issue: { _id: ids.issue, agency_id: ids.agency, client_id: ids.client, status: "open", current_severity: "moderate", lifecycle_revision: 4 },
    evaluationSeries: null,
    currentEvaluation: null,
    now: new Date("2026-07-18T12:00:00.000Z"),
  };
  return { ...base, ...overrides, reviewItem: { ...reviewItem, ...(overrides.reviewItem || {}) } };
};

test("current synchronized Issue review is actionable with exact permissions", () => {
  const result = resolveReviewEffectiveState(fixture());
  assert.equal(result.effectiveState, "open");
  assert.equal(result.actionable, true);
  assert.equal(result.isSourceCurrent, true);
  assert.equal(result.sourceRevisionSynchronized, true);
  assert.deepEqual(result.mutationPermissions, { canAcknowledge: true, canSnooze: true, canReview: false, canRecordIntervention: true });
});

test("missing and foreign Client authority closes without disclosure", () => {
  assert.equal(resolveReviewEffectiveState(fixture({ client: null })).effectiveCloseReason, "source_invalidated");
  assert.equal(resolveReviewEffectiveState(fixture({ client: { _id: oid(), agency_id: oid(), is_archived: false } })).effectiveCloseReason, "source_invalidated");
});

test("archived Client takes precedence over lower authority checks", () => {
  const input = fixture(); input.client.is_archived = true; input.metaAccount = null; input.issue = null;
  const result = resolveReviewEffectiveState(input);
  assert.equal(result.effectiveState, "closed");
  assert.equal(result.effectiveCloseReason, "client_archived");
});

test("missing, inactive, inaccessible, and malformed accounts invalidate source", () => {
  assert.equal(resolveReviewEffectiveState(fixture({ metaAccount: null })).effectiveCloseReason, "source_invalidated");
  for (const patch of [{ is_active: false }, { is_accessible: false }, { binding_revision: "3" }]) {
    const input = fixture(); Object.assign(input.metaAccount, patch);
    assert.equal(resolveReviewEffectiveState(input).effectiveCloseReason, "source_invalidated");
  }
});

test("Client reassignment and binding revision drift close as account reassigned", () => {
  const reassigned = fixture(); reassigned.metaAccount.client_id = oid();
  assert.equal(resolveReviewEffectiveState(reassigned).effectiveCloseReason, "account_reassigned");
  const revised = fixture(); revised.metaAccount.binding_revision = 4;
  assert.equal(resolveReviewEffectiveState(revised).effectiveCloseReason, "account_reassigned");
});

test("missing and resolved Issues use exact close reasons", () => {
  assert.equal(resolveReviewEffectiveState(fixture({ issue: null })).effectiveCloseReason, "source_invalidated");
  const resolved = fixture(); resolved.issue.status = "resolved";
  assert.equal(resolveReviewEffectiveState(resolved).effectiveCloseReason, "source_resolved");
});

test("non-current Evaluation review is superseded", () => {
  const input = fixture();
  input.reviewItem.type = "evaluation_review";
  input.reviewItem.evaluation_series_id = input.evaluationSeries = { _id: oid(), agency_id: input.reviewItem.agency_id, current_evaluation_id: oid() };
  input.reviewItem.evaluation_series_id = input.evaluationSeries._id;
  input.reviewItem.evaluation_id = oid();
  input.currentEvaluation = { _id: input.evaluationSeries.current_evaluation_id, agency_id: input.reviewItem.agency_id, status: "ready", observed_result: "improved", sequence: 1 };
  const result = resolveReviewEffectiveState(input);
  assert.equal(result.effectiveState, "superseded");
  assert.equal(result.effectiveCloseReason, "evaluation_superseded");
});

test("invalidated or non-ready current Evaluation closes as source invalidated", () => {
  for (const evaluationPatch of [{ status: "invalidated" }, { status: "awaiting_evidence" }, { observed_result: null }]) {
    const input = fixture(); const evaluationId = oid(); const seriesId = oid();
    input.reviewItem = { ...input.reviewItem, type: "evaluation_review", evaluation_series_id: seriesId, evaluation_id: evaluationId, source_revision: 2 };
    input.evaluationSeries = { _id: seriesId, agency_id: input.reviewItem.agency_id, current_evaluation_id: evaluationId };
    input.currentEvaluation = { _id: evaluationId, agency_id: input.reviewItem.agency_id, status: "ready", observed_result: "mixed", sequence: 2, ...evaluationPatch };
    assert.equal(resolveReviewEffectiveState(input).effectiveCloseReason, "source_invalidated");
  }
});

test("current Evaluation uses Evaluation priority and sequence synchronization", () => {
  const input = fixture(); const evaluationId = oid(); const seriesId = oid();
  input.reviewItem = { ...input.reviewItem, type: "evaluation_review", evaluation_series_id: seriesId, evaluation_id: evaluationId, source_revision: 2 };
  input.evaluationSeries = { _id: seriesId, agency_id: input.reviewItem.agency_id, current_evaluation_id: evaluationId };
  input.currentEvaluation = { _id: evaluationId, agency_id: input.reviewItem.agency_id, status: "ready", observed_result: "worsened", sequence: 2 };
  const result = resolveReviewEffectiveState(input);
  assert.equal(result.effectivePriority, "high");
  assert.equal(result.sourceRevisionSynchronized, true);
  assert.equal(result.mutationPermissions.canReview, true);
});

test("persisted terminal state remains terminal when source authority is current", () => {
  for (const state of ["reviewed", "closed", "superseded"]) {
    const result = resolveReviewEffectiveState(fixture({ reviewItem: { state, close_reason: state === "closed" ? "source_invalidated" : null } }));
    assert.equal(result.effectiveState, state);
    assert.equal(result.actionable, false);
  }
});

test("unexpired snooze is active but not actionable", () => {
  const result = resolveReviewEffectiveState(fixture({ reviewItem: { state: "snoozed", snoozed_until: new Date("2026-07-19T00:00:00.000Z") } }));
  assert.equal(result.effectiveState, "snoozed");
  assert.equal(result.actionable, false);
  assert.equal(result.snoozedVisibility, "snoozed_only");
});

test("expired snooze is effectively open and actionable", () => {
  const result = resolveReviewEffectiveState(fixture({ reviewItem: { state: "snoozed", snoozed_until: new Date("2026-07-18T00:00:00.000Z") } }));
  assert.equal(result.persistedState, "snoozed");
  assert.equal(result.effectiveState, "open");
  assert.equal(result.actionable, true);
  assert.equal(result.snoozedVisibility, "expired_actionable");
});

test("newer source evidence remains visible but disables every mutation", () => {
  const input = fixture(); input.issue.lifecycle_revision = 5;
  const result = resolveReviewEffectiveState(input);
  assert.equal(result.isSourceCurrent, true);
  assert.equal(result.actionable, true);
  assert.equal(result.sourceRevisionSynchronized, false);
  assert.deepEqual(result.mutationPermissions, { canAcknowledge: false, canSnooze: false, canReview: false, canRecordIntervention: false });
});
