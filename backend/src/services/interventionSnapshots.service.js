import {
  INTERVENTION_LIMITS,
  INTERVENTION_PERFORMER_MODES,
  createInterventionError,
  INTERVENTION_ERROR,
  normalizeBoundedText,
  normalizeEmail,
} from "../domain/phase3Intervention.domain.js";

const plain = (value) => value?.toObject?.({ depopulate: true }) || value || null;
const sameId = (left, right) => Boolean(left && right && String(left) === String(right));
const bounded = (value, maximum) => {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result ? result.slice(0, maximum) : null;
};

export const buildWorkspaceActorSnapshot = ({ user, membership, capturedAt }) => {
  const actor = plain(user);
  const member = plain(membership);
  if (!actor || !member || member.status !== "active" || !sameId(actor._id, member.user_id)) {
    throw createInterventionError(
      INTERVENTION_ERROR.PERMISSION,
      "The selected workspace actor is unavailable.",
      403
    );
  }
  return {
    version: 1,
    captured_at: new Date(capturedAt),
    display_name: normalizeBoundedText(actor.full_name, {
      field: "actor display name",
      maximum: INTERVENTION_LIMITS.displayName,
      required: true,
    }),
    email: normalizeEmail(actor.email),
    workspace_role: member.role,
    provenance: "workspace_member",
  };
};

export const buildManualActorSnapshot = ({ displayName, email, capturedAt }) => ({
  version: 1,
  captured_at: new Date(capturedAt),
  display_name: normalizeBoundedText(displayName, {
    field: "performedBy.displayName",
    maximum: INTERVENTION_LIMITS.displayName,
    required: true,
  }),
  email: normalizeEmail(email),
  workspace_role: null,
  provenance: "manual",
});

export const normalizePerformerRequest = (value) => {
  if (value === undefined || value === null) return { mode: "self" };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw createInterventionError(
      INTERVENTION_ERROR.VALIDATION,
      "performedBy is invalid.",
      400
    );
  }
  const mode = value.mode || "self";
  if (!INTERVENTION_PERFORMER_MODES.includes(mode)) {
    throw createInterventionError(
      INTERVENTION_ERROR.VALIDATION,
      "performedBy.mode is invalid.",
      400
    );
  }
  const allowed = new Set(
    mode === "self"
      ? ["mode"]
      : mode === "workspace_member"
        ? ["mode", "userId"]
        : ["mode", "displayName", "email"]
  );
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw createInterventionError(
        INTERVENTION_ERROR.VALIDATION,
        `performedBy.${key} is not allowed.`,
        400
      );
    }
  }
  if (mode === "workspace_member" && !value.userId) {
    throw createInterventionError(
      INTERVENTION_ERROR.VALIDATION,
      "performedBy.userId is required.",
      400
    );
  }
  return {
    mode,
    ...(value.userId ? { userId: String(value.userId) } : {}),
    ...(mode === "manual"
      ? {
          displayName: normalizeBoundedText(value.displayName, {
            field: "performedBy.displayName",
            maximum: INTERVENTION_LIMITS.displayName,
            required: true,
          }),
          email: normalizeEmail(value.email),
        }
      : {}),
  };
};

const chooseIdentity = (...candidates) => {
  for (const candidate of candidates) {
    const value = bounded(candidate?.value, candidate?.maximum || INTERVENTION_LIMITS.title);
    if (value) return { value, provenance: candidate.provenance };
  }
  return { value: null, provenance: "unknown" };
};

const campaignFrom = (items, campaignId) =>
  (items || []).find((item) => sameId(item?.campaign_id, campaignId)) || null;

export const buildInterventionEvidenceSnapshots = ({
  issue: issueInput,
  client: clientInput,
  account: accountInput,
  signal: signalInput,
  reportRun: runInput,
  report: reportInput,
  capturedAt,
}) => {
  const issue = plain(issueInput);
  const client = plain(clientInput);
  const account = plain(accountInput);
  const signal = plain(signalInput);
  const reportRun = plain(runInput);
  const report = plain(reportInput);
  const campaignId = String(issue?.scope?.entity?.campaign_id || "").trim();
  const signalContext = plain(signal?.context_snapshot) || {};
  const runContext = plain(reportRun?.context_snapshot) || {};
  const signalCampaign = campaignFrom(signalContext.campaigns, campaignId);
  const runCampaign = campaignFrom(reportRun?.monitored_campaigns, campaignId);
  const reportCampaign = campaignFrom(report?.monitored_campaigns, campaignId);

  const clientName = chooseIdentity(
    { value: signalContext?.client?.name, provenance: "signal_snapshot" },
    { value: runContext?.client?.name, provenance: "report_run_snapshot" },
    { value: client?.name, provenance: "current_parent" }
  );
  const reportName = chooseIdentity(
    { value: signalContext?.report?.name, provenance: "signal_snapshot" },
    { value: runContext?.report?.name, provenance: "report_run_snapshot" },
    { value: report?.name, provenance: "current_parent" }
  );
  const accountName = chooseIdentity(
    { value: signalContext?.meta_account?.name, provenance: "signal_snapshot" },
    { value: reportRun?.meta_account_name_snapshot, provenance: "report_run_snapshot" },
    { value: account?.name, provenance: "current_parent" }
  );
  const externalAccount = chooseIdentity(
    { value: signalContext?.meta_account?.external_account_id, provenance: "signal_snapshot", maximum: 256 },
    { value: reportRun?.meta_account_external_id_snapshot, provenance: "report_run_snapshot", maximum: 256 },
    { value: account?.ad_account_id, provenance: "current_parent", maximum: 256 }
  );
  const campaignName = chooseIdentity(
    { value: signalCampaign?.campaign_name, provenance: "signal_snapshot" },
    { value: runCampaign?.campaign_name, provenance: "report_run_snapshot" },
    { value: reportCampaign?.campaign_name, provenance: "current_parent" }
  );
  const now = new Date(capturedAt);

  return {
    issueSnapshot: {
      version: 1,
      captured_at: now,
      provenance: "persisted_issue",
      title: bounded(issue.title, INTERVENTION_LIMITS.title),
      summary: bounded(issue.summary, INTERVENTION_LIMITS.text),
      archetype: bounded(issue.archetype, 128),
      metric_family: bounded(issue.metric_family, 128),
      status: issue.status,
      severity: issue.current_severity,
      trend: issue.trend,
      fingerprint: issue.fingerprint,
      fingerprint_version: issue.fingerprint_version,
      opened_at: issue.opened_at,
      last_seen_at: issue.last_seen_at,
      resolved_at: issue.resolved_at || null,
      occurrence_count: issue.occurrence_count,
      reopen_count: issue.reopen_count || 0,
      latest_signal_id: issue.latest_signal_id,
      latest_report_run_id: issue.latest_report_run_id,
      lifecycle_revision: issue.lifecycle_revision || 0,
    },
    scopeSnapshot: {
      version: 1,
      captured_at: now,
      client: { id: issue.client_id, name: clientName.value, provenance: clientName.provenance },
      meta_account: {
        id: issue.meta_ad_account_id,
        external_account_id: externalAccount.value,
        name: accountName.value,
        provenance: accountName.value ? accountName.provenance : externalAccount.provenance,
      },
      campaign: { id: campaignId, name: campaignName.value, provenance: campaignName.provenance },
      report: { id: issue.latest_report_id, name: reportName.value, provenance: reportName.provenance },
    },
    latestSignalSnapshot: {
      version: 1,
      captured_at: now,
      provenance: "persisted_signal",
      id: signal._id,
      report_id: signal.report_id,
      report_run_id: signal.report_run_id,
      type: bounded(signal.type, 128),
      severity: signal.severity,
      title: bounded(signal.title, INTERVENTION_LIMITS.title),
      description: bounded(signal.description, INTERVENTION_LIMITS.text),
      recommendation: bounded(signal.recommendation, INTERVENTION_LIMITS.text),
      detected_at: signal.detected_at || signal.createdAt,
      matched_at: signal.matched_at || null,
    },
  };
};
