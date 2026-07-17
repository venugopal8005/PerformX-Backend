import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";

import {
  INTERVENTION_ACTION_TYPES,
  buildInterventionRequestHash,
  normalizeInterventionAction,
  normalizeInterventionIdempotencyKey,
  normalizePerformedAt,
} from "../src/domain/phase3Intervention.domain.js";
import { Intervention, Issue } from "../src/models/index.js";
import {
  buildInterventionEvidenceSnapshots,
  buildManualActorSnapshot,
  buildWorkspaceActorSnapshot,
  normalizePerformerRequest,
} from "../src/services/interventionSnapshots.service.js";
import {
  serializeInterventionDetail,
  serializeInterventionListItem,
} from "../src/utils/interventionSerializers.js";
import { serializeHistoricalActivity } from "../src/utils/historicalSerializers.js";

const id = () => new mongoose.Types.ObjectId();

test("Phase 3 exposes the exact bounded V1 action taxonomy", () => {
  assert.deepEqual(INTERVENTION_ACTION_TYPES, [
    "pause_campaign", "resume_campaign", "increase_budget", "decrease_budget",
    "replace_creative", "add_creative", "remove_creative", "change_targeting",
    "add_exclusion", "change_bid_strategy", "fix_tracking", "landing_page_change",
    "monitor_only", "no_action", "internal_note", "other",
  ]);
});

test("action validation normalizes strict structured payloads", () => {
  assert.deepEqual(
    normalizeInterventionAction({
      actionType: "increase_budget",
      actionPayload: { mode: "absolute", amount: 2500, currency: "inr" },
      reason: " More qualified traffic ",
    }),
    {
      actionType: "increase_budget",
      actionVersion: 1,
      actionPayload: { budget_mode: "absolute", budget_amount: 2500, currency: "INR" },
      reason: "More qualified traffic",
      note: null,
    }
  );
  assert.deepEqual(
    normalizeInterventionAction({
      actionType: "change_targeting",
      actionPayload: { dimension: "audience", summary: "Exclude recent purchasers" },
      reason: "Reduce overlap",
    }).actionPayload,
    { targeting_dimension: "audience", change_summary: "Exclude recent purchasers" }
  );
});

test("unknown action types, versions, payload keys, and malformed budgets fail closed", () => {
  const invalid = [
    { actionType: "delete_everything", reason: "x" },
    { actionType: "pause_campaign", actionVersion: 2, reason: "x" },
    { actionType: "pause_campaign", actionPayload: { secret: true }, reason: "x" },
    { actionType: "increase_budget", actionPayload: { mode: "percent", amount: 101 }, reason: "x" },
    { actionType: "increase_budget", actionPayload: { mode: "absolute", amount: 10 }, reason: "x" },
  ];
  for (const input of invalid) {
    assert.throws(
      () => normalizeInterventionAction(input),
      (error) => error.code === "INTERVENTION_VALIDATION_FAILED"
    );
  }
});

test("budget amounts reject coercible and non-finite values without silent conversion", () => {
  const invalidAmounts = [
    "20",
    " 20 ",
    true,
    false,
    null,
    [],
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const amount of invalidAmounts) {
    assert.throws(
      () =>
        normalizeInterventionAction({
          actionType: "increase_budget",
          actionPayload: { mode: "percent", amount },
          reason: "Strict numeric evidence",
        }),
      (error) => error.code === "INTERVENTION_VALIDATION_FAILED"
    );
  }
  assert.equal(
    normalizeInterventionAction({
      actionType: "increase_budget",
      actionPayload: { mode: "percent", amount: 20 },
      reason: "Valid numeric evidence",
    }).actionPayload.budget_amount,
    20
  );
});

test("internal notes require a note while other actions require a reason", () => {
  assert.equal(
    normalizeInterventionAction({ actionType: "internal_note", note: "Watch for two days" }).note,
    "Watch for two days"
  );
  assert.throws(() => normalizeInterventionAction({ actionType: "internal_note" }));
  assert.throws(() => normalizeInterventionAction({ actionType: "pause_campaign" }));
});

test("idempotency keys and performed times are bounded", () => {
  assert.equal(normalizeInterventionIdempotencyKey("request-123456789"), "request-123456789");
  assert.throws(() => normalizeInterventionIdempotencyKey("short"));
  const openedAt = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(
    normalizePerformedAt("2026-01-02T00:00:00.000Z", {
      openedAt,
      now: new Date("2026-01-03T00:00:00.000Z"),
    }).toISOString(),
    "2026-01-02T00:00:00.000Z"
  );
  assert.throws(() => normalizePerformedAt("2025-12-31", { openedAt, now: new Date("2026-01-03") }));
});

test("semantic hashes include operation and target but not idempotency keys", () => {
  const base = { operation: "create", agencyId: id(), targetId: id(), payload: { action: "pause" } };
  const first = buildInterventionRequestHash({ ...base, payload: { ...base.payload, idempotencyKey: undefined } });
  const second = buildInterventionRequestHash({ ...base, payload: { idempotencyKey: undefined, action: "pause" } });
  assert.equal(first, second);
  assert.notEqual(first, buildInterventionRequestHash({ ...base, operation: "cancel" }));
});

test("actor snapshots support self/workspace and manual provenance", () => {
  const userId = id();
  const capturedAt = new Date();
  const workspace = buildWorkspaceActorSnapshot({
    user: { _id: userId, full_name: "  Jane Doe ", email: "JANE@EXAMPLE.COM" },
    membership: { user_id: userId, role: "member", status: "active" },
    capturedAt,
  });
  assert.equal(workspace.display_name, "Jane Doe");
  assert.equal(workspace.email, "jane@example.com");
  assert.equal(workspace.provenance, "workspace_member");
  const manual = buildManualActorSnapshot({ displayName: "Agency Contractor", email: null, capturedAt });
  assert.equal(manual.workspace_role, null);
  assert.equal(manual.provenance, "manual");
  assert.deepEqual(normalizePerformerRequest(), { mode: "self" });
});

test("evidence snapshots use persisted name precedence and preserve unknown identities", () => {
  const agencyId = id();
  const clientId = id();
  const accountId = id();
  const reportId = id();
  const runId = id();
  const signalId = id();
  const capturedAt = new Date("2026-07-17T12:00:00.000Z");
  const snapshots = buildInterventionEvidenceSnapshots({
    issue: {
      client_id: clientId,
      meta_ad_account_id: accountId,
      latest_report_id: reportId,
      latest_report_run_id: runId,
      latest_signal_id: signalId,
      scope: { entity: { campaign_id: "campaign-1" } },
      title: "Persisted Issue",
      summary: "Persisted summary",
      archetype: "ctr_decline",
      metric_family: "ctr",
      status: "open",
      current_severity: "critical",
      trend: "escalating",
      fingerprint: "a".repeat(64),
      fingerprint_version: 1,
      opened_at: capturedAt,
      last_seen_at: capturedAt,
      occurrence_count: 1,
      lifecycle_revision: 4,
    },
    client: { _id: clientId, agency_id: agencyId, name: "Mutable Client" },
    account: { _id: accountId, name: "Mutable Account", ad_account_id: "act_mutable" },
    signal: {
      _id: signalId,
      report_id: reportId,
      report_run_id: runId,
      type: "ctr_decline",
      severity: "critical",
      title: "Persisted Signal",
      detected_at: capturedAt,
      context_snapshot: {
        client: { name: "Signal Client" },
        report: { name: "Signal Report" },
        meta_account: { name: "Signal Account", external_account_id: "act_signal" },
        campaigns: [],
      },
    },
    reportRun: {
      _id: runId,
      meta_account_name_snapshot: "Run Account",
      meta_account_external_id_snapshot: "act_run",
      monitored_campaigns: [],
      context_snapshot: { client: { name: "Run Client" }, report: { name: "Run Report" } },
    },
    report: { _id: reportId, name: "Mutable Report", monitored_campaigns: [] },
    capturedAt,
  });
  assert.deepEqual(snapshots.scopeSnapshot.client, {
    id: clientId,
    name: "Signal Client",
    provenance: "signal_snapshot",
  });
  assert.equal(snapshots.scopeSnapshot.meta_account.name, "Signal Account");
  assert.equal(snapshots.scopeSnapshot.report.name, "Signal Report");
  assert.equal(snapshots.scopeSnapshot.campaign.name, null);
  assert.equal(snapshots.scopeSnapshot.campaign.provenance, "unknown");
  assert.equal(snapshots.issueSnapshot.title, "Persisted Issue");
  assert.equal(snapshots.latestSignalSnapshot.title, "Persisted Signal");
});

const validIntervention = () => {
  const agencyId = id();
  const clientId = id();
  const issueId = id();
  const accountId = id();
  const reportId = id();
  const runId = id();
  const signalId = id();
  const actorId = id();
  const now = new Date();
  const actor = {
    version: 1, captured_at: now, display_name: "Jane", email: "jane@example.com",
    workspace_role: "member", provenance: "workspace_member",
  };
  return {
    agency_id: agencyId, client_id: clientId, issue_id: issueId,
    meta_ad_account_id: accountId, campaign_id: "campaign-1",
    report_id_at_action: reportId, report_run_id_at_action: runId,
    performed_by_user_id: actorId, performed_by_snapshot: actor,
    recorded_by_user_id: actorId, recorded_by_snapshot: actor,
    action_type: "pause_campaign", action_version: 1, action_payload: {},
    reason: "Stop inefficient spend", note: null, performed_at: now, recorded_at: now,
    issue_snapshot: {
      version: 1, captured_at: now, provenance: "persisted_issue", title: "CTR decline",
      summary: null, archetype: "ctr_decline", metric_family: "ctr", status: "open",
      severity: "critical", trend: "escalating", fingerprint: "a".repeat(64),
      fingerprint_version: 1, opened_at: now, last_seen_at: now, resolved_at: null,
      occurrence_count: 1, reopen_count: 0, latest_signal_id: signalId,
      latest_report_run_id: runId, lifecycle_revision: 2,
    },
    scope_snapshot: {
      version: 1, captured_at: now,
      client: { id: clientId, name: "Acme", provenance: "current_parent" },
      meta_account: { id: accountId, external_account_id: "act_1", name: "Acme Ads", provenance: "current_parent" },
      campaign: { id: "campaign-1", name: "Campaign One", provenance: "signal_snapshot" },
      report: { id: reportId, name: "Daily", provenance: "report_run_snapshot" },
    },
    latest_signal_snapshot: {
      version: 1, captured_at: now, provenance: "persisted_signal", id: signalId,
      report_id: reportId, report_run_id: runId, type: "ctr_decline", severity: "critical",
      title: "CTR declined", description: null, recommendation: null,
      detected_at: now, matched_at: now,
    },
    issue_fingerprint_snapshot: "a".repeat(64), status: "active",
    idempotency_key: "request-123456789", request_hash: "b".repeat(64), revision: 0,
  };
};

test("Intervention model enforces lifecycle invariants and strict immutable evidence", async () => {
  const active = new Intervention(validIntervention());
  await active.validate();
  const invalid = new Intervention({ ...validIntervention(), status: "cancelled" });
  await assert.rejects(
    invalid.validate(),
    (error) => /cancellation evidence/.test(error.errors.status.message)
  );
  assert.equal(Intervention.schema.path("agency_id").options.immutable, true);
  assert.equal(Intervention.schema.path("issue_snapshot").options.immutable, true);
  assert.notEqual(Intervention.schema.path("action_payload").instance, "Mixed");
});

test("Issue cache fields are additive and default safely", () => {
  const issue = new Issue();
  assert.equal(issue.intervention_count, 0);
  assert.equal(issue.intervention_revision, 0);
  assert.equal(issue.latest_intervention_id, null);
});

test("Intervention serializer allowlists evidence and excludes private helpers", () => {
  const raw = { ...validIntervention(), _id: id(), request_hash: "secret", __v: 9 };
  const serialized = serializeInterventionDetail(raw, { permissions: { canCancel: true } });
  assert.equal(serialized.actionType, "pause_campaign");
  assert.equal(serialized.permissions.canCancel, true);
  assert.equal("request_hash" in serialized, false);
  assert.equal("idempotency_key" in serialized, false);
  assert.equal("__v" in serialized, false);
  const containsEmailKey = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Object.hasOwn(value, "email")) return true;
    return Object.values(value).some(containsEmailKey);
  };
  assert.equal(containsEmailKey(serialized), false);
});

test("public serialization removes actor email from correction and cancellation evidence", () => {
  const cancellationRecord = validIntervention();
  const actor = cancellationRecord.recorded_by_snapshot;
  cancellationRecord.status = "cancelled";
  cancellationRecord.cancellation = {
    reason: "Recorded against the wrong Issue",
    cancelled_at: new Date("2026-07-17T12:30:00.000Z"),
    cancelled_by_user_id: cancellationRecord.recorded_by_user_id,
    cancelled_by_snapshot: actor,
  };

  const correctionRecord = validIntervention();
  correctionRecord.status = "superseded";
  correctionRecord.superseded_by_intervention_id = id();
  correctionRecord.corrected_at = new Date("2026-07-17T12:45:00.000Z");
  correctionRecord.corrected_by_user_id = correctionRecord.recorded_by_user_id;
  correctionRecord.corrected_by_snapshot = correctionRecord.recorded_by_snapshot;

  const containsEmailKey = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Object.hasOwn(value, "email")) return true;
    return Object.values(value).some(containsEmailKey);
  };
  for (const serialized of [
    serializeInterventionDetail(cancellationRecord),
    serializeInterventionListItem(cancellationRecord),
    serializeInterventionDetail(correctionRecord),
    serializeInterventionListItem(correctionRecord),
  ]) {
    assert.equal(containsEmailKey(serialized), false);
  }
});

test("historical Intervention Activity display excludes actor and metadata email", () => {
  const serialized = serializeHistoricalActivity(
    {
      _id: id(),
      agency_id: id(),
      client_id: id(),
      user_id: id(),
      type: "intervention_recorded",
      title: "Intervention recorded",
      description: "A human action was recorded.",
      severity: "stable",
      metadata: {
        intervention_id: id(),
        issue_id: id(),
        action_type: "pause_campaign",
        recorder_display_name_snapshot: "Workspace Owner",
        email: "metadata@example.com",
      },
    },
    { _id: id(), full_name: "Current Owner", email: "actor@example.com" },
    { actorSource: "workspace_member" }
  );
  const containsEmailKey = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Object.hasOwn(value, "email")) return true;
    return Object.values(value).some(containsEmailKey);
  };

  assert.equal(containsEmailKey(serialized), false);
  assert.equal(serialized.actor.displayName, "Workspace Owner");
  assert.equal(serialized.display.icon.name, "ClipboardCheck");
});
