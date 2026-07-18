import { safeHistoricalDate, safeHistoricalNumber, safeHistoricalObjectId, safeHistoricalString } from "./historicalValueSanitizer.js";

const plain = (value) => value?.toObject?.({ depopulate: true }) || value || {};
const id = safeHistoricalObjectId;
const text = (value, maximum = 500) => safeHistoricalString(value, maximum);
const date = safeHistoricalDate;
const number = safeHistoricalNumber;
const identity = (value = {}) => ({ id: id(value.id), name: text(value.name, 256), provenance: text(value.provenance, 32) });
const actor = (value) => value ? { displayName: text(value.display_name, 256), workspaceRole: text(value.workspace_role, 16), provenance: text(value.provenance, 32), capturedAt: date(value.captured_at) } : null;

export const serializeReviewItemList = (input, effective = {}) => {
  const value = plain(input); const context = plain(value.context_snapshot);
  return {
    id: id(value._id), type: text(value.type, 32), state: text(effective.effectiveState || value.state, 32),
    priority: text(effective.effectivePriority || value.priority, 16), reason: text(value.reason, 64), generation: number(value.generation),
    client: identity(context.client), account: { ...identity(context.account), externalId: text(context.account?.external_id, 256) },
    campaign: { id: text(context.campaign?.id, 256), name: text(context.campaign?.name, 256), provenance: text(context.campaign?.provenance, 32) },
    issue: { id: id(context.issue?.id || value.issue_id), title: text(context.issue?.title, 512), provenance: text(context.issue?.provenance, 32) },
    source: { title: text(context.source_title, 512), summary: text(context.source_summary, 1000), provenance: text(context.provenance, 32) },
    openedAt: date(value.opened_at), latestEvidenceAt: date(value.latest_evidence_at),
    acknowledgement: value.acknowledged_at ? { at: date(value.acknowledged_at), by: actor(value.acknowledged_by_snapshot) } : null,
    snooze: value.snoozed_at ? { at: date(value.snoozed_at), until: date(value.snoozed_until), note: text(value.snooze_note, 1000), by: actor(value.snoozed_by_snapshot) } : null,
    review: value.reviewed_at ? { at: date(value.reviewed_at), by: actor(value.reviewed_by_snapshot) } : null,
    permissions: { ...(effective.mutationPermissions || {}) },
    routes: { issueId: id(value.issue_id), reportId: id(value.report_id), reportRunId: id(value.report_run_id), interventionId: id(value.intervention_id), evaluationId: id(value.evaluation_id), previousReviewItemId: id(value.previous_review_item_id) },
  };
};

export const serializeReviewItemDetail = (input, effective = {}, { actions = [], linkedIntervention = null, linkedEvaluation = null } = {}) => {
  const value = plain(input); const context = plain(value.context_snapshot);
  return {
    ...serializeReviewItemList(value, effective), persistedState: text(value.state, 32), effectiveState: text(effective.effectiveState, 32),
    effectiveCloseReason: text(effective.effectiveCloseReason, 64), isSourceCurrent: effective.isSourceCurrent === true,
    sourceRevisionSynchronized: effective.sourceRevisionSynchronized === true, revision: number(value.revision),
    context: { version: number(context.version), capturedAt: date(context.captured_at), client: identity(context.client), account: { ...identity(context.account), externalId: text(context.account?.external_id, 256) }, campaign: { id: text(context.campaign?.id, 256), name: text(context.campaign?.name, 256), provenance: text(context.campaign?.provenance, 32) }, issue: { id: id(context.issue?.id), title: text(context.issue?.title, 512), provenance: text(context.issue?.provenance, 32) }, report: context.report ? identity(context.report) : null, sourceTitle: text(context.source_title, 512), sourceSummary: text(context.source_summary, 2000), provenance: text(context.provenance, 32) },
    linkedIntervention, linkedEvaluation, actions: actions.map(serializeReviewAction),
  };
};

export const serializeReviewAction = (input) => {
  const value = plain(input);
  return { id: id(value._id), reviewItemId: id(value.review_item_id), sequence: number(value.sequence), actionType: text(value.action_type, 64), actorType: text(value.actor_type, 16), decisionType: text(value.decision_type, 32), actor: actor(value.actor_snapshot), priorState: text(value.prior_state, 32), resultingState: text(value.resulting_state, 32), note: text(value.note, 2000), signalId: id(value.signal_id), interventionId: id(value.intervention_id), evaluationId: id(value.evaluation_id), occurredAt: date(value.occurred_at), recordedAt: date(value.recorded_at) };
};

