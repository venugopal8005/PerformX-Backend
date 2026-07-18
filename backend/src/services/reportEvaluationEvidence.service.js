import { DateTime } from "luxon";

import {
  EVALUATION_CADENCE_DAYS,
  EVALUATION_EVIDENCE_VERSION,
  EVALUATION_LIMITS,
  EVALUATION_NORMALIZATION_VERSION,
} from "../domain/phase4Evaluation.domain.js";

const PURCHASE_ACTIONS = new Set([
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
]);
const CONVERSION_ACTIONS = new Set([
  ...PURCHASE_ACTIONS,
  "lead",
  "complete_registration",
  "submit_application",
  "schedule_total",
  "onsite_conversion.messaging_conversation_started_7d",
]);
const round = (value, decimals = 6) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
};
const parsedAmount = (value) => {
  if (value == null || value === "") return 0;
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) && number >= 0 ? number : null;
};
const amount = (value) => parsedAmount(value) ?? 0;
const divide = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const actionTotal = (items, types) =>
  Array.isArray(items)
    ? items.reduce((total, item) => types.has(item?.action_type) ? total + amount(item?.value) : total, 0)
    : 0;
const malformedActionValues = (items, types) => {
  if (items == null) return false;
  if (!Array.isArray(items)) return true;
  return items.some((item) => types.has(item?.action_type) && parsedAmount(item?.value) == null);
};
const hasMalformedMetrics = (row) =>
  [row?.spend, row?.impressions, row?.clicks].some((value) => parsedAmount(value) == null) ||
  malformedActionValues(row?.actions, CONVERSION_ACTIONS) ||
  malformedActionValues(row?.action_values, PURCHASE_ACTIONS);
const bounded = (value, limit) => {
  const text = String(value || "").trim();
  return text ? text.slice(0, limit) : null;
};
const campaignId = (value) => {
  const text = String(value || "").trim();
  return text && text.length <= EVALUATION_LIMITS.campaignId ? text : null;
};
const normalizedCurrency = (value) => {
  const currency = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
};
const normalizedWindow = (value) => {
  const start = String(value?.start || "");
  const end = String(value?.end || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startDate = DateTime.fromISO(start, { zone: "UTC" });
  const endDate = DateTime.fromISO(end, { zone: "UTC" });
  return !startDate.isValid || !endDate.isValid || startDate.toISODate() !== start || endDate.toISODate() !== end || endDate < startDate
    ? null
    : { start, end };
};
const windowDays = (window) => window
  ? Math.round(DateTime.fromISO(window.end, { zone: "UTC" }).diff(DateTime.fromISO(window.start, { zone: "UTC" }), "days").days) + 1
  : null;
const normalizedTimezone = (value) => {
  const timezone = bounded(value, EVALUATION_LIMITS.timezone);
  return timezone && String(value).trim().length <= EVALUATION_LIMITS.timezone && DateTime.now().setZone(timezone).isValid
    ? timezone
    : null;
};
const normalizedAttributionWindows = (values) => {
  const malformed = values.length > EVALUATION_LIMITS.attributionWindows || values.some((item) =>
    typeof item !== "string" || !item.trim() || item.trim().length > EVALUATION_LIMITS.attributionWindow
  );
  return {
    malformed,
    values: malformed ? [] : [...new Set(values.map((item) => item.trim().toLowerCase()))].sort(),
  };
};

const attributionFromRows = (rows) => {
  const observed = rows.map((row) => {
    const raw = row?.action_attribution_windows ?? row?.attribution_windows;
    if (raw == null) return null;
    if (!Array.isArray(raw)) return { malformed: true, values: [] };
    return normalizedAttributionWindows(raw);
  });
  const supplied = observed.filter(Boolean);
  if (!supplied.length) return { malformed: false, comparable: false, values: [] };
  if (supplied.some((item) => item.malformed) || supplied.length !== rows.length) {
    return { malformed: true, comparable: false, values: [] };
  }
  const signatures = new Set(supplied.map((item) => JSON.stringify(item.values)));
  return signatures.size === 1
    ? { malformed: false, comparable: true, values: supplied[0].values }
    : { malformed: true, comparable: false, values: [] };
};

const resolveAttribution = ({ rows, attributionContext, attributionWindows }) => {
  if (attributionContext != null) {
    if (!attributionContext || typeof attributionContext !== "object" || Array.isArray(attributionContext)) {
      return { malformed: true, comparable: false, values: [] };
    }
    const normalized = normalizedAttributionWindows(
      Array.isArray(attributionContext.windows) ? attributionContext.windows : []
    );
    const comparable = attributionContext.comparable === true && normalized.values.length > 0;
    return { malformed: normalized.malformed || (attributionContext.comparable === true && !comparable), comparable, values: comparable ? normalized.values : [] };
  }
  if (attributionWindows != null) {
    if (!Array.isArray(attributionWindows)) return { malformed: true, comparable: false, values: [] };
    const normalized = normalizedAttributionWindows(attributionWindows);
    return { ...normalized, comparable: !normalized.malformed && normalized.values.length > 0 };
  }
  return attributionFromRows(rows);
};

const aggregateCampaign = ({ rows, campaignId, campaignName, provenance }) => {
  const totals = rows.reduce((result, row) => {
    result.spend += amount(row.spend);
    result.impressions += amount(row.impressions);
    result.clicks += amount(row.clicks);
    result.conversions += actionTotal(row.actions, CONVERSION_ACTIONS);
    result.conversionValue += actionTotal(row.action_values, PURCHASE_ACTIONS);
    result.hasConversionValue ||= Array.isArray(row.action_values) && row.action_values.length > 0;
    return result;
  }, { spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, hasConversionValue: false });
  const spend = round(totals.spend, 2);
  const impressions = round(totals.impressions, 0);
  const clicks = round(totals.clicks, 0);
  const conversions = round(totals.conversions, 2);
  const conversionValue = totals.hasConversionValue ? round(totals.conversionValue, 2) : null;
  return {
    campaign_id: campaignId,
    campaign_name: bounded(campaignName, EVALUATION_LIMITS.campaignName),
    provenance,
    spend,
    impressions,
    clicks,
    conversions,
    conversion_value: conversionValue,
    ctr: divide(clicks * 100, impressions) == null ? null : round(divide(clicks * 100, impressions), 6),
    cpc: divide(spend, clicks) == null ? null : round(divide(spend, clicks), 6),
    cpm: divide(spend * 1000, impressions) == null ? null : round(divide(spend * 1000, impressions), 6),
    cpa: divide(spend, conversions) == null ? null : round(divide(spend, conversions), 6),
    roas: conversionValue == null || divide(conversionValue, spend) == null ? null : round(divide(conversionValue, spend), 6),
    conversion_rate: divide(conversions * 100, clicks) == null ? null : round(divide(conversions * 100, clicks), 6),
    row_count: rows.length,
    source_level: rows.some((row) => row?.ad_id) ? "ad" : "campaign",
    completeness: rows.length ? "complete" : "zero_delivery",
    warnings: [],
  };
};

const campaignRows = (rows, campaignId) => rows.filter((row) => String(row?.campaign_id || "").trim() === campaignId);

export const buildReportRunEvaluationEvidence = ({
  currentRows = [],
  monitoredCampaigns = [],
  period,
  timezone,
  currency,
  attributionWindows = null,
  attributionContext = null,
  metaBindingRevision,
  comparisonMode,
  cadence,
  triggerType,
  capturedAt = new Date(),
} = {}) => {
  const campaignInputs = Array.isArray(monitoredCampaigns) ? monitoredCampaigns : [];
  const rows = Array.isArray(currentRows) ? currentRows : [];
  const attribution = resolveAttribution({ rows, attributionContext, attributionWindows });
  const normalizedCampaigns = campaignInputs.slice(0, EVALUATION_LIMITS.campaignSnapshots).map((campaign) => ({
    id: campaignId(campaign?.campaign_id || campaign?.campaignId),
    name: bounded(campaign?.campaign_name || campaign?.campaignName, EVALUATION_LIMITS.campaignName),
  }));
  const requestedIds = new Set(normalizedCampaigns.map((campaign) => campaign.id).filter(Boolean));
  const malformed = !normalizedCampaigns.length || campaignInputs.length > EVALUATION_LIMITS.campaignSnapshots || requestedIds.size !== normalizedCampaigns.length || normalizedCampaigns.some((campaign) => !campaign.id) ||
    rows.some((row) => !campaignId(row?.campaign_id));
  const unexpectedCampaign = rows.some((row) => !requestedIds.has(String(row?.campaign_id || "").trim()));
  const rowCurrencies = [...new Set(rows.map((row) => normalizedCurrency(row?.account_currency || row?.currency)).filter(Boolean))];
  const canonicalCurrency = normalizedCurrency(currency);
  const canonicalTimezone = normalizedTimezone(timezone || period?.timezone);
  const canonicalCadence = ["daily", "weekly", "monthly"].includes(cadence) ? cadence : null;
  const currentWindow = normalizedWindow(period?.current);
  const previousWindow = normalizedWindow(period?.previous);
  const exactWindowDuration = Boolean(canonicalCadence && currentWindow && previousWindow) &&
    windowDays(currentWindow) === EVALUATION_CADENCE_DAYS[canonicalCadence] &&
    windowDays(previousWindow) === EVALUATION_CADENCE_DAYS[canonicalCadence];
  const inconsistentCurrency = rowCurrencies.length > 1 || (rowCurrencies.length === 1 && canonicalCurrency && rowCurrencies[0] !== canonicalCurrency);
  const invalidRowCurrency = rows.some((row) => {
    const value = row?.account_currency ?? row?.currency;
    return value != null && String(value).trim() !== "" && !normalizedCurrency(value);
  });
  const malformedMetrics = rows.some(hasMalformedMetrics);
  const canonicalMode = comparisonMode === "scheduled_window";
  const manual = triggerType === "manual";
  const provenance = canonicalMode
    ? (manual ? "scheduled_manual_window" : "scheduled_window")
    : "historical_fallback";
  const warnings = [];
  if (!canonicalMode) warnings.push("historical_fallback_evidence");
  if (malformed) warnings.push("malformed_campaign_identity");
  if (unexpectedCampaign) warnings.push("unexpected_campaign_evidence");
  if (inconsistentCurrency || invalidRowCurrency || !canonicalCurrency) warnings.push("currency_unavailable_or_inconsistent");
  if (malformedMetrics) warnings.push("malformed_metric_evidence");
  if (attribution.malformed) warnings.push("attribution_context_inconsistent");
  else if (!attribution.comparable) warnings.push("attribution_context_unavailable");
  if (!canonicalTimezone || !canonicalCadence || !currentWindow || !previousWindow || !exactWindowDuration) warnings.push("window_context_unavailable");
  const campaignSnapshots = malformed ? [] : normalizedCampaigns.map((campaign) =>
    aggregateCampaign({
      rows: campaignRows(rows, campaign.id),
      campaignId: campaign.id,
      campaignName: campaign.name || campaignRows(rows, campaign.id)[0]?.campaign_name,
      provenance,
    })
  );
  const complete = canonicalMode && !malformed && !unexpectedCampaign && !inconsistentCurrency && !invalidRowCurrency && !malformedMetrics && Boolean(canonicalCurrency) &&
    Boolean(canonicalTimezone && canonicalCadence && currentWindow && previousWindow && exactWindowDuration) &&
    Number.isSafeInteger(Number(metaBindingRevision)) && Number(metaBindingRevision) >= 0;
  return {
    version: EVALUATION_EVIDENCE_VERSION,
    captured_at: capturedAt,
    normalization_version: EVALUATION_NORMALIZATION_VERSION,
    timezone: canonicalTimezone,
    currency: canonicalCurrency,
    attribution_windows: attribution.values,
    meta_binding_revision: Number.isSafeInteger(Number(metaBindingRevision)) ? Number(metaBindingRevision) : null,
    comparison_mode: comparisonMode || null,
    cadence: canonicalCadence,
    current_window: currentWindow,
    previous_window: previousWindow,
    campaign_snapshots: campaignSnapshots,
    completeness: complete ? "complete" : "ineligible",
    warnings: warnings.slice(0, EVALUATION_LIMITS.warnings),
  };
};
