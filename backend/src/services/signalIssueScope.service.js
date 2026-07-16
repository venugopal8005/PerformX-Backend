import mongoose from "mongoose";

import {
  ISSUE_ARCHETYPE_METRIC_FAMILY,
  ISSUE_ENABLED_ENTITY_LEVELS,
  ISSUE_ERROR_CODE,
  ISSUE_FINGERPRINT_VERSION,
  ISSUE_POSITIVE_ARCHETYPES,
  ISSUE_PRIMARY_METRIC_FAMILIES,
  ISSUE_REASON,
  ISSUE_SUPPORTED_CADENCES,
} from "../domain/phase2Issue.domain.js";

const normalizeEnum = (value) =>
  String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();

const objectId = (value) => {
  if (!mongoose.isObjectIdOrHexString(value)) return null;
  return new mongoose.Types.ObjectId(value);
};

const sameId = (left, right) => String(left) === String(right);

const ineligible = (reason, details = {}) => ({
  eligible: false,
  reason,
  ...details,
});

export const createIssueScopeIntegrityError = (reason, details = {}) => {
  const error = new Error("Signal and ReportRun ownership evidence conflicts.");
  error.code = ISSUE_ERROR_CODE.OWNERSHIP_CONFLICT;
  error.status = 409;
  error.reason = reason;
  error.details = details;
  return error;
};

export const canonicalizeIssueTimezone = (value) => {
  const timezone = String(value || "").trim();
  if (!timezone) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone })
      .resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
};

export const resolveIssueArchetype = (signal = {}) => {
  const metadataArchetype = normalizeEnum(signal?.metadata?.archetype_id);
  const signalType = normalizeEnum(signal?.type);
  const archetype = metadataArchetype || signalType;

  if (!archetype) return ineligible(ISSUE_REASON.ARCHETYPE_MISSING);
  if (ISSUE_POSITIVE_ARCHETYPES.includes(archetype)) {
    return ineligible(ISSUE_REASON.POSITIVE_ARCHETYPE, {
      notApplicable: true,
      archetype,
    });
  }

  let metricFamily = ISSUE_ARCHETYPE_METRIC_FAMILY[archetype] || null;
  if (archetype === "metric_anomaly") {
    const metric = normalizeEnum(signal?.metadata?.primary_anomaly?.metric);
    metricFamily = ISSUE_PRIMARY_METRIC_FAMILIES[metric] || null;
  }
  if (!metricFamily) {
    return ineligible(
      archetype === "metric_anomaly"
        ? ISSUE_REASON.METRIC_FAMILY_MISSING
        : ISSUE_REASON.ARCHETYPE_UNSUPPORTED,
      { archetype }
    );
  }

  return { eligible: true, archetype, metricFamily };
};

const persistedCampaigns = (reportRun = {}) =>
  (Array.isArray(reportRun.monitored_campaigns) ? reportRun.monitored_campaigns : [])
    .map((campaign) => String(campaign?.campaign_id || "").trim())
    .filter(Boolean);

export const resolveIssueCampaignId = ({ signal, reportRun }) => {
  const campaigns = [...new Set(persistedCampaigns(reportRun))];
  const signalCampaignId = String(signal?.campaign_id || "").trim();

  if (signalCampaignId) {
    if (!campaigns.includes(signalCampaignId)) {
      return ineligible(ISSUE_REASON.CAMPAIGN_CONFLICT);
    }
    return { eligible: true, campaignId: signalCampaignId };
  }
  if (campaigns.length === 1) {
    return { eligible: true, campaignId: campaigns[0] };
  }
  return ineligible(
    campaigns.length > 1
      ? ISSUE_REASON.CAMPAIGN_AMBIGUOUS
      : ISSUE_REASON.CAMPAIGN_MISSING
  );
};

const persistedCadence = (reportRun = {}) =>
  normalizeEnum(reportRun?.context_snapshot?.report?.configuration?.type);

const persistedTimezone = (reportRun = {}) =>
  reportRun?.context_snapshot?.report?.configuration?.schedule?.timezone;

export const buildCanonicalIssueObservationScope = ({ reportRun } = {}) => {
  if (!reportRun) return ineligible(ISSUE_REASON.REPORT_RUN_MISSING);
  const agencyId = objectId(reportRun.agency_id);
  const clientId = objectId(reportRun.client_id);
  const reportId = objectId(reportRun.report_id);
  const reportRunId = objectId(reportRun._id);
  const metaAccountId = objectId(reportRun.meta_ad_account_id);
  if (!agencyId) return ineligible(ISSUE_REASON.AGENCY_MISSING);
  if (!clientId) return ineligible(ISSUE_REASON.CLIENT_MISSING);
  if (!reportId) return ineligible(ISSUE_REASON.REPORT_MISSING);
  if (!reportRunId) return ineligible(ISSUE_REASON.REPORT_RUN_MISSING);
  if (!metaAccountId) return ineligible(ISSUE_REASON.META_ACCOUNT_MISSING);

  const campaigns = [...new Set(persistedCampaigns(reportRun))];
  if (campaigns.length !== 1) {
    return ineligible(
      campaigns.length > 1
        ? ISSUE_REASON.CAMPAIGN_AMBIGUOUS
        : ISSUE_REASON.CAMPAIGN_MISSING
    );
  }

  const cadence = persistedCadence(reportRun);
  if (!cadence) return ineligible(ISSUE_REASON.CADENCE_MISSING);
  if (!ISSUE_SUPPORTED_CADENCES.includes(cadence)) {
    return ineligible(ISSUE_REASON.CADENCE_UNSUPPORTED);
  }
  const rawTimezone = persistedTimezone(reportRun);
  if (!String(rawTimezone || "").trim()) {
    return ineligible(ISSUE_REASON.TIMEZONE_MISSING);
  }
  const timezone = canonicalizeIssueTimezone(rawTimezone);
  if (!timezone) return ineligible(ISSUE_REASON.TIMEZONE_INVALID);

  return {
    eligible: true,
    agencyId,
    clientId,
    reportId,
    reportRunId,
    metaAccountId,
    campaignId: campaigns[0],
    cadence,
    timezone,
  };
};

const validateLineage = ({ signal, reportRun }) => {
  const required = [
    ["agency_id", ISSUE_REASON.AGENCY_MISSING],
    ["client_id", ISSUE_REASON.CLIENT_MISSING],
    ["report_id", ISSUE_REASON.REPORT_MISSING],
  ];
  for (const [field, reason] of required) {
    if (!objectId(signal?.[field]) || !objectId(reportRun?.[field])) {
      return ineligible(reason);
    }
    if (!sameId(signal[field], reportRun[field])) {
      throw createIssueScopeIntegrityError(ISSUE_REASON.OWNERSHIP_CONFLICT, {
        field,
      });
    }
  }

  if (!objectId(reportRun?._id)) return ineligible(ISSUE_REASON.REPORT_RUN_MISSING);
  if (signal?.report_run_id && !sameId(signal.report_run_id, reportRun._id)) {
    throw createIssueScopeIntegrityError(ISSUE_REASON.OWNERSHIP_CONFLICT, {
      field: "report_run_id",
    });
  }

  const metaAccountId = objectId(reportRun?.meta_ad_account_id);
  if (!metaAccountId) return ineligible(ISSUE_REASON.META_ACCOUNT_MISSING);
  const signalMetaAccountId = signal?.context_snapshot?.meta_account?.meta_ad_account_id;
  if (signalMetaAccountId && !sameId(signalMetaAccountId, metaAccountId)) {
    throw createIssueScopeIntegrityError(ISSUE_REASON.OWNERSHIP_CONFLICT, {
      field: "meta_ad_account_id",
    });
  }

  return {
    eligible: true,
    agencyId: objectId(signal.agency_id),
    clientId: objectId(signal.client_id),
    reportId: objectId(signal.report_id),
    reportRunId: objectId(reportRun._id),
    metaAccountId,
  };
};

export const buildCanonicalSignalIssueScope = ({ signal, reportRun } = {}) => {
  if (!signal || !reportRun) {
    return ineligible(
      signal ? ISSUE_REASON.REPORT_RUN_MISSING : ISSUE_REASON.SCOPE_MALFORMED
    );
  }

  const lineage = validateLineage({ signal, reportRun });
  if (!lineage.eligible) return lineage;

  const campaign = resolveIssueCampaignId({ signal, reportRun });
  if (!campaign.eligible) return campaign;

  const classification = resolveIssueArchetype(signal);
  if (!classification.eligible) return classification;

  const cadence = persistedCadence(reportRun);
  if (!cadence) return ineligible(ISSUE_REASON.CADENCE_MISSING);
  if (!ISSUE_SUPPORTED_CADENCES.includes(cadence)) {
    return ineligible(ISSUE_REASON.CADENCE_UNSUPPORTED);
  }

  const rawTimezone = persistedTimezone(reportRun);
  if (!String(rawTimezone || "").trim()) {
    return ineligible(ISSUE_REASON.TIMEZONE_MISSING);
  }
  const timezone = canonicalizeIssueTimezone(rawTimezone);
  if (!timezone) return ineligible(ISSUE_REASON.TIMEZONE_INVALID);

  const entityLevel = "campaign";
  if (!ISSUE_ENABLED_ENTITY_LEVELS.includes(entityLevel)) {
    return ineligible(ISSUE_REASON.ENTITY_LEVEL_UNSUPPORTED);
  }

  return {
    eligible: true,
    lineage,
    scope: {
      version: ISSUE_FINGERPRINT_VERSION,
      agency_id: lineage.agencyId,
      client_id: lineage.clientId,
      meta_ad_account_id: lineage.metaAccountId,
      entity: {
        level: entityLevel,
        id: campaign.campaignId,
        campaign_id: campaign.campaignId,
        adset_id: null,
        ad_id: null,
      },
      classification: {
        archetype: classification.archetype,
        metric_family: classification.metricFamily,
      },
      comparison: {
        cadence,
        timezone,
      },
    },
  };
};

export const normalizeIssueEnum = normalizeEnum;
