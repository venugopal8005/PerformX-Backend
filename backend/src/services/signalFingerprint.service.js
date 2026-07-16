import crypto from "node:crypto";
import mongoose from "mongoose";

import {
  ISSUE_APPROVED_ARCHETYPES,
  ISSUE_ARCHETYPE_METRIC_FAMILY,
  ISSUE_ENABLED_ENTITY_LEVELS,
  ISSUE_ERROR_CODE,
  ISSUE_FINGERPRINT_VERSION,
  ISSUE_PRIMARY_METRIC_FAMILIES,
  ISSUE_REASON,
  ISSUE_SUPPORTED_CADENCES,
} from "../domain/phase2Issue.domain.js";
import {
  canonicalizeIssueTimezone,
  normalizeIssueEnum,
} from "./signalIssueScope.service.js";

const normalizedObjectId = (value) => {
  if (!mongoose.isObjectIdOrHexString(value)) return null;
  return String(value).toLowerCase();
};

const normalizedExternalId = (value, { nullable = false } = {}) => {
  if (value === null || value === undefined || value === "") {
    return nullable ? null : "";
  }
  return String(value).trim();
};

export const createIssueFingerprintError = (message, reason) => {
  const error = new Error(message);
  error.code = "ISSUE_FINGERPRINT_INPUT_INVALID";
  error.status = 400;
  error.reason = reason;
  return error;
};

export const buildCanonicalFingerprintInput = (
  scope,
  { version = ISSUE_FINGERPRINT_VERSION } = {}
) => {
  if (version !== ISSUE_FINGERPRINT_VERSION || scope?.version !== version) {
    throw createIssueFingerprintError(
      "Issue fingerprint version is invalid.",
      ISSUE_REASON.SCOPE_MALFORMED
    );
  }

  const agencyId = normalizedObjectId(scope?.agency_id);
  const clientId = normalizedObjectId(scope?.client_id);
  const metaAdAccountId = normalizedObjectId(scope?.meta_ad_account_id);
  const entityLevel = normalizeIssueEnum(scope?.entity?.level);
  const entityId = normalizedExternalId(scope?.entity?.id);
  const campaignId = normalizedExternalId(scope?.entity?.campaign_id);
  const adsetId = normalizedExternalId(scope?.entity?.adset_id, { nullable: true });
  const adId = normalizedExternalId(scope?.entity?.ad_id, { nullable: true });
  const archetype = normalizeIssueEnum(scope?.classification?.archetype);
  const metricFamily = normalizeIssueEnum(scope?.classification?.metric_family);
  const cadence = normalizeIssueEnum(scope?.comparison?.cadence);
  const timezone = canonicalizeIssueTimezone(scope?.comparison?.timezone);
  const rawTimezone = String(scope?.comparison?.timezone || "").trim();

  if (
    !agencyId ||
    !clientId ||
    !metaAdAccountId ||
    !entityLevel ||
    !entityId ||
    !campaignId ||
    !archetype ||
    !metricFamily ||
    !cadence ||
    !timezone
  ) {
    throw createIssueFingerprintError(
      "Canonical Issue scope is incomplete.",
      ISSUE_REASON.SCOPE_MALFORMED
    );
  }

  const approvedMetricFamilies = new Set([
    ...Object.values(ISSUE_ARCHETYPE_METRIC_FAMILY),
    ...Object.values(ISSUE_PRIMARY_METRIC_FAMILIES),
  ]);
  const primaryMetricFamilies = new Set(
    Object.values(ISSUE_PRIMARY_METRIC_FAMILIES)
  );
  const expectedMetricFamily = ISSUE_ARCHETYPE_METRIC_FAMILY[archetype];
  const pairingValid =
    (archetype === "metric_anomaly" && primaryMetricFamilies.has(metricFamily)) ||
    expectedMetricFamily === metricFamily;
  if (
    !ISSUE_ENABLED_ENTITY_LEVELS.includes(entityLevel) ||
    entityLevel !== "campaign" ||
    entityId !== campaignId ||
    scope?.entity?.adset_id !== null ||
    scope?.entity?.ad_id !== null ||
    !ISSUE_APPROVED_ARCHETYPES.includes(archetype) ||
    !approvedMetricFamilies.has(metricFamily) ||
    !pairingValid ||
    !ISSUE_SUPPORTED_CADENCES.includes(cadence) ||
    rawTimezone !== timezone
  ) {
    throw createIssueFingerprintError(
      "Canonical Issue scope is invalid.",
      ISSUE_REASON.SCOPE_MALFORMED
    );
  }

  return {
    v: version,
    agency_id: agencyId,
    client_id: clientId,
    meta_ad_account_id: metaAdAccountId,
    entity_level: entityLevel,
    entity_id: entityId,
    campaign_id: campaignId,
    adset_id: adsetId,
    ad_id: adId,
    archetype,
    metric_family: metricFamily,
    cadence,
    timezone,
  };
};

export const serializeCanonicalFingerprintInput = (input) =>
  JSON.stringify({
    v: input.v,
    agency_id: input.agency_id,
    client_id: input.client_id,
    meta_ad_account_id: input.meta_ad_account_id,
    entity_level: input.entity_level,
    entity_id: input.entity_id,
    campaign_id: input.campaign_id,
    adset_id: input.adset_id,
    ad_id: input.ad_id,
    archetype: input.archetype,
    metric_family: input.metric_family,
    cadence: input.cadence,
    timezone: input.timezone,
  });

export const buildIssueFingerprint = (scope, options = {}) => {
  const canonicalInput = buildCanonicalFingerprintInput(scope, options);
  const canonicalJson = serializeCanonicalFingerprintInput(canonicalInput);
  return {
    fingerprint: crypto.createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
    fingerprintVersion: canonicalInput.v,
    canonicalInput,
    canonicalJson,
  };
};

export const issueScopesEqual = (left, right, options = {}) => {
  try {
    const leftInput = buildCanonicalFingerprintInput(left, options);
    const rightInput = buildCanonicalFingerprintInput(right, options);
    return (
      serializeCanonicalFingerprintInput(leftInput) ===
      serializeCanonicalFingerprintInput(rightInput)
    );
  } catch {
    return false;
  }
};

export const assertIssueFingerprintScopeMatch = ({
  expectedScope,
  actualScope,
  fingerprint,
  version = ISSUE_FINGERPRINT_VERSION,
}) => {
  if (issueScopesEqual(expectedScope, actualScope, { version })) return true;
  const error = new Error("Issue fingerprint matched a different canonical scope.");
  error.code = ISSUE_ERROR_CODE.FINGERPRINT_COLLISION;
  error.status = 409;
  error.reason = ISSUE_REASON.FINGERPRINT_COLLISION;
  error.fingerprint = fingerprint;
  throw error;
};
