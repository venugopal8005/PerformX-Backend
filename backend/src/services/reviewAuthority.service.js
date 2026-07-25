import {
  REVIEW_ACTIVE_STATES, reviewPriorityForEvaluationResult, reviewPriorityForIssueSeverity,
} from "../domain/phase5Review.domain.js";

const same = (left, right) => Boolean(left && right && String(left) === String(right));
const value = (document) => document?.toObject ? document.toObject() : document;
const closed = (item, reason, state = "closed") => ({
  persistedState: item.state, effectiveState: state, effectiveCloseReason: reason,
  isSourceCurrent: false, sourceRevisionSynchronized: false,
  mutationPermissions: { canAcknowledge: false, canSnooze: false, canReview: false, canRecordIntervention: false },
  actionable: false, snoozedVisibility: "hidden", effectivePriority: item.priority,
});

export const resolveReviewEffectiveState = ({ reviewItem, client, metaAccount, issue, evaluationSeries = null, currentEvaluation = null, now = new Date() } = {}) => {
  const item = value(reviewItem);
  const parent = value(client);
  const account = value(metaAccount);
  const sourceIssue = value(issue);
  const series = value(evaluationSeries);
  const evaluation = value(currentEvaluation);
  if (!item) return closed({ state: "closed", priority: "normal" }, "source_invalidated");
  if (!parent || !same(parent._id, item.client_id) || !same(parent.agency_id, item.agency_id)) return closed(item, "source_invalidated");
  if (parent.is_archived === true) return closed(item, "client_archived");
  if (!account || !same(account._id, item.meta_ad_account_id) || !same(account.agency_id, item.agency_id)) return closed(item, "source_invalidated");
  if (account.is_active !== true || account.is_accessible !== true || !Number.isSafeInteger(account.binding_revision)) return closed(item, "source_invalidated");
  if (!same(account.client_id, item.client_id) || account.binding_revision !== item.meta_binding_revision_snapshot) return closed(item, "account_reassigned");
  if (!sourceIssue || !same(sourceIssue._id, item.issue_id) || !same(sourceIssue.agency_id, item.agency_id) || !same(sourceIssue.client_id, item.client_id)) return closed(item, "source_invalidated");
  if (sourceIssue.status === "resolved") return closed(item, "source_resolved");
  if (!["open", "monitoring"].includes(sourceIssue.status)) return closed(item, "source_invalidated");

  let sourceRevisionSynchronized = sourceIssue.lifecycle_revision === item.source_revision;
  let effectivePriority = item.priority;
  try { effectivePriority = reviewPriorityForIssueSeverity(sourceIssue.current_severity).priority; } catch { return closed(item, "source_invalidated"); }
  if (item.type === "evaluation_review") {
    if (!series || !evaluation || !same(series.agency_id, item.agency_id) || !same(series._id, item.evaluation_series_id)) return closed(item, "source_invalidated");
    if (!same(series.current_evaluation_id, item.evaluation_id) || !same(evaluation._id, item.evaluation_id)) return closed(item, "evaluation_superseded", "superseded");
    if (evaluation.status === "invalidated" || evaluation.invalidation_context) return closed(item, "source_invalidated");
    if (evaluation.status !== "ready" || !evaluation.observed_result) return closed(item, "source_invalidated");
    sourceRevisionSynchronized = evaluation.sequence === item.source_revision;
    try { effectivePriority = reviewPriorityForEvaluationResult(evaluation.observed_result).priority; } catch { return closed(item, "source_invalidated"); }
  }

  if (["reviewed", "closed", "superseded"].includes(item.state)) {
    return { ...closed(item, item.close_reason || null, item.state), isSourceCurrent: true, sourceRevisionSynchronized, effectivePriority };
  }
  if (!REVIEW_ACTIVE_STATES.includes(item.state)) return closed(item, "source_invalidated");
  const snoozed = item.state === "snoozed" && item.snoozed_until && new Date(item.snoozed_until) > now;
  const effectiveState = item.state === "snoozed" && !snoozed ? "open" : item.state;
  const mutable = sourceRevisionSynchronized;
  return {
    persistedState: item.state, effectiveState, effectiveCloseReason: null,
    isSourceCurrent: true, sourceRevisionSynchronized,
    mutationPermissions: {
      canAcknowledge: mutable && effectiveState === "open",
      canSnooze: mutable,
      canReview: mutable && item.type === "evaluation_review",
      canRecordIntervention: mutable,
    },
    actionable: !snoozed,
    snoozedVisibility: snoozed ? "snoozed_only" : item.state === "snoozed" ? "expired_actionable" : "visible",
    effectivePriority,
  };
};

export const loadReviewAuthorityBatch = async ({ agencyId, reviewItems, Models, session = null } = {}) => {
  const items = reviewItems.map(value);
  const ids = (field) => [...new Set(items.map((item) => item[field]).filter(Boolean).map(String))];
  const apply = (query) => session && typeof query?.session === "function" ? query.session(session) : query;
  const [clients, accounts, issues, series] = await Promise.all([
    apply(Models.Client.find({ _id: { $in: ids("client_id") }, agency_id: agencyId }).lean()),
    Models.MetaAdAccount.collection.find({ _id: { $in: ids("meta_ad_account_id").map((id) => Models.MetaAdAccount.schema.path("_id").cast(id)) }, agency_id: Models.MetaAdAccount.schema.path("agency_id").cast(agencyId) }, { session: session || undefined, projection: { agency_id: 1, client_id: 1, is_active: 1, is_accessible: 1, binding_revision: 1, name: 1, ad_account_id: 1 } }).toArray(),
    apply(Models.Issue.find({ _id: { $in: ids("issue_id") }, agency_id: agencyId }).lean()),
    apply(Models.EvaluationSeries.find({ _id: { $in: ids("evaluation_series_id") }, agency_id: agencyId }).lean()),
  ]);
  const currentIds = series.map((entry) => entry.current_evaluation_id).filter(Boolean);
  const evaluations = currentIds.length ? await apply(Models.Evaluation.find({ _id: { $in: currentIds }, agency_id: agencyId }).lean()) : [];
  const map = (entries) => new Map(entries.map((entry) => [String(entry._id), entry]));
  const maps = { clients: map(clients), accounts: map(accounts), issues: map(issues), series: map(series), evaluations: map(evaluations) };
  return items.map((item) => {
    const evaluationSeries = maps.series.get(String(item.evaluation_series_id)) || null;
    return {
    reviewItem: item,
    client: maps.clients.get(String(item.client_id)) || null,
    metaAccount: maps.accounts.get(String(item.meta_ad_account_id)) || null,
    issue: maps.issues.get(String(item.issue_id)) || null,
    evaluationSeries,
    currentEvaluation: evaluationSeries
      ? maps.evaluations.get(String(evaluationSeries.current_evaluation_id)) || null
      : null,
    };
  });
};
