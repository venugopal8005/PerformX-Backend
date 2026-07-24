import { DateTime } from "luxon";

import {
  EVALUATION_BASELINE_FRESHNESS_DAYS,
  EVALUATION_CADENCE_DAYS,
  EVALUATION_FOLLOW_UP_TIMEOUT_DAYS,
  EVALUATION_CONFIDENCE_VERSION,
  EVALUATION_LIMITS,
  EVALUATION_METRIC_RULES,
  EVALUATION_NORMALIZATION_VERSION,
  EVALUATION_NEUTRAL_METRICS,
  EVALUATION_PRIMARY_METRICS,
  hashEvaluationEvidence,
} from "../domain/phase4Evaluation.domain.js";

const round = (value) => Number.isFinite(value) ? Number(value.toFixed(6)) : null;
const asDate = (value, timezone) => DateTime.fromISO(String(value || ""), { zone: timezone }).startOf("day");
const dateText = (value) => value.toISODate();
const sameArray = (left = [], right = []) => left.length === right.length && left.every((item, index) => item === right[index]);
const validCurrency = (value) => /^[A-Z]{3}$/.test(String(value || ""));
const validAttributionWindows = (value) =>
  Array.isArray(value) &&
  value.length <= EVALUATION_LIMITS.attributionWindows &&
  value.every((item) => typeof item === "string" && item.length > 0 && item.length <= EVALUATION_LIMITS.attributionWindow);
const validCampaignSnapshot = (snapshot) => {
  if (!snapshot || !["ad", "campaign"].includes(snapshot.source_level)) return false;
  if (!Number.isSafeInteger(Number(snapshot.row_count)) || Number(snapshot.row_count) < 0) return false;
  for (const field of ["spend", "impressions", "clicks", "conversions"]) {
    if (!Number.isFinite(Number(snapshot[field])) || Number(snapshot[field]) < 0) return false;
  }
  for (const field of ["conversion_value", "ctr", "cpc", "cpm", "cpa", "roas", "conversion_rate"]) {
    if (snapshot[field] != null && (!Number.isFinite(Number(snapshot[field])) || Number(snapshot[field]) < 0)) return false;
  }
  return true;
};

export const localActionDate = (performedAt, timezone) => {
  const date = DateTime.fromJSDate(new Date(performedAt), { zone: timezone });
  return date.isValid ? date.toISODate() : null;
};

export const canonicalFollowUpWindow = ({ performedAt, timezone, cadence }) => {
  const days = EVALUATION_CADENCE_DAYS[cadence];
  const actionDate = localActionDate(performedAt, timezone);
  if (!days || !actionDate) return null;
  const start = asDate(actionDate, timezone).plus({ days: 1 });
  return { start: dateText(start), end: dateText(start.plus({ days: days - 1 })) };
};

export const overlapWindowDateBounds = ({ followUpWindow, timezone }) => {
  const start = asDate(followUpWindow?.start, timezone);
  const end = asDate(followUpWindow?.end, timezone);
  if (!start.isValid || !end.isValid || end < start) return null;
  return {
    start: start.toUTC().toJSDate(),
    endExclusive: end.plus({ days: 1 }).toUTC().toJSDate(),
  };
};

export const windowDurationDays = (window, timezone) => {
  const start = asDate(window?.start, timezone);
  const end = asDate(window?.end, timezone);
  if (!start.isValid || !end.isValid || end < start) return null;
  return Math.round(end.diff(start, "days").days) + 1;
};

export const validateEvidenceCandidate = ({ run, intervention, cadence, timezone }) => {
  const evidence = run?.evaluation_evidence;
  const matchingSnapshots = evidence?.campaign_snapshots?.filter(
    (item) => String(item?.campaign_id) === String(intervention?.campaign_id)
  ) || [];
  const snapshot = matchingSnapshots[0];
  const reasons = [];
  if (!evidence || evidence.version !== 1) reasons.push("source_evidence_unvalidated");
  if (evidence?.normalization_version !== EVALUATION_NORMALIZATION_VERSION) reasons.push("source_evidence_unvalidated");
  if (evidence?.comparison_mode !== "scheduled_window" || evidence?.completeness !== "complete") reasons.push("historical_fallback_evidence");
  if (!snapshot) reasons.push("campaign_evidence_missing");
  if (!Array.isArray(evidence?.campaign_snapshots) || evidence.campaign_snapshots.length > EVALUATION_LIMITS.campaignSnapshots || matchingSnapshots.length > 1) reasons.push("campaign_mismatch");
  if (snapshot && !validCampaignSnapshot(snapshot)) reasons.push("malformed_evidence");
  if (evidence?.cadence !== cadence) reasons.push("cadence_mismatch");
  if (evidence?.timezone !== timezone) reasons.push("timezone_mismatch");
  if (!validCurrency(evidence?.currency) || !validAttributionWindows(evidence?.attribution_windows)) reasons.push("malformed_evidence");
  if (windowDurationDays(evidence?.current_window, timezone) !== EVALUATION_CADENCE_DAYS[cadence]) reasons.push("window_duration_mismatch");
  if (windowDurationDays(evidence?.previous_window, timezone) !== EVALUATION_CADENCE_DAYS[cadence]) reasons.push("window_duration_mismatch");
  if (snapshot && !["complete", "zero_delivery"].includes(snapshot.completeness)) reasons.push("malformed_evidence");
  if (snapshot && !["scheduled_window", "scheduled_manual_window"].includes(snapshot.provenance)) reasons.push("historical_fallback_evidence");
  if (run?.trigger_type === "manual" && snapshot?.provenance !== "scheduled_manual_window") reasons.push("malformed_evidence");
  if (run?.trigger_type !== "manual" && snapshot?.provenance === "scheduled_manual_window") reasons.push("malformed_evidence");
  if (String(run?.agency_id) !== String(intervention?.agency_id) ||
      String(run?.client_id) !== String(intervention?.client_id) ||
      String(run?.meta_ad_account_id) !== String(intervention?.meta_ad_account_id) ||
      String(run?.report_id) !== String(intervention?.report_id_at_action)) reasons.push("ownership_mismatch");
  if (Number(evidence?.meta_binding_revision) !== Number(run?.meta_binding_revision_snapshot)) reasons.push("account_binding_changed");
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)], evidence, snapshot };
};

export const selectBaseline = ({ runs = [], intervention, cadence, timezone }) => {
  const actionDate = localActionDate(intervention?.performed_at, timezone);
  const candidates = runs.map((run) => ({ run, validation: validateEvidenceCandidate({ run, intervention, cadence, timezone }) }))
    .filter(({ validation }) => validation.evidence?.current_window?.end < actionDate)
    .sort((left, right) =>
      right.validation.evidence.current_window.end.localeCompare(left.validation.evidence.current_window.end) ||
      String(right.run?._id).localeCompare(String(left.run?._id))
    );
  const selected = candidates.find(({ validation }) => validation.eligible) || null;
  if (!selected) return { selected: null, reason: candidates[0]?.validation?.reasons?.[0] || "baseline_evidence_missing" };
  const freshness = asDate(actionDate, timezone).diff(asDate(selected.validation.evidence.current_window.end, timezone), "days").days;
  if (freshness > EVALUATION_BASELINE_FRESHNESS_DAYS[cadence]) return { selected: null, reason: "baseline_stale" };
  return { selected, ...selected };
};

export const selectFollowUp = ({ runs = [], intervention, cadence, timezone, now = new Date() }) => {
  const canonical = canonicalFollowUpWindow({ performedAt: intervention?.performed_at, timezone, cadence });
  if (!canonical) return { selected: null, reason: "window_mismatch", canonical };
  const candidates = runs.map((run) => ({ run, validation: validateEvidenceCandidate({ run, intervention, cadence, timezone }) }))
    .filter(({ validation }) =>
      validation.evidence?.current_window?.start === canonical.start &&
      validation.evidence?.current_window?.end === canonical.end)
    .sort((left, right) => String(right.run?._id).localeCompare(String(left.run?._id)));
  const selected = candidates.find(({ validation }) => validation.eligible);
  if (selected) return { selected, ...selected, canonical };
  if (candidates[0]) return { selected: null, reason: candidates[0].validation.reasons[0] || "follow_up_evidence_missing", canonical };
  const timeoutDate = asDate(canonical.end, timezone).plus({ days: EVALUATION_FOLLOW_UP_TIMEOUT_DAYS[cadence] });
  const current = DateTime.fromJSDate(new Date(now), { zone: timezone }).startOf("day");
  return { selected: null, reason: current > timeoutDate ? "follow_up_timeout" : "awaiting_follow_up", canonical };
};

const finiteNumberOrNull = (value) => {
  if (value == null || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

export const buildEvidenceSnapshot = ({ run, validation, cadence, timezone }) => {
  const { evidence, snapshot } = validation;
  return {
    report_run_id: String(run._id),
    window: {
      start: String(evidence.current_window.start),
      end: String(evidence.current_window.end),
      timezone: String(timezone),
      cadence: String(cadence),
    },
    campaign_id: String(snapshot.campaign_id),
    campaign_name: snapshot.campaign_name == null ? null : String(snapshot.campaign_name),
    currency: String(evidence.currency),
    attribution_windows: [...(evidence.attribution_windows || [])].map(String),
    meta_binding_revision: Number(evidence.meta_binding_revision),
    provenance: String(snapshot.provenance),
    values: {
      spend: finiteNumberOrNull(snapshot.spend),
      impressions: finiteNumberOrNull(snapshot.impressions),
      clicks: finiteNumberOrNull(snapshot.clicks),
      conversions: finiteNumberOrNull(snapshot.conversions),
      conversion_value: finiteNumberOrNull(snapshot.conversion_value),
      ctr: finiteNumberOrNull(snapshot.ctr),
      cpc: finiteNumberOrNull(snapshot.cpc),
      cpm: finiteNumberOrNull(snapshot.cpm),
      cpa: finiteNumberOrNull(snapshot.cpa),
      roas: finiteNumberOrNull(snapshot.roas),
      conversion_rate: finiteNumberOrNull(snapshot.conversion_rate),
    },
    row_count: Number(snapshot.row_count),
    source_level: String(snapshot.source_level),
    completeness: String(snapshot.completeness),
  };
};

const minimumMet = (values, minimum) => Object.entries(minimum).every(([field, value]) => Number(values?.[field]) >= value);

const minimumFields = ["spend", "impressions", "clicks", "conversions"];

export const buildEvaluationThresholdSnapshots = ({
  metrics = [],
  rules = EVALUATION_METRIC_RULES,
} = {}) => metrics.flatMap((metric) => {
  const rule = rules?.[metric];
  if (!rule) return [];
  const minimum = Object.fromEntries(
    minimumFields.map((field) => [field, Number.isFinite(Number(rule.minimum?.[field])) ? Number(rule.minimum[field]) : null])
  );
  return [{
    metric,
    directionality: rule.directionality,
    unit: rule.unit,
    material_improvement: { relative: Number(rule.relative), absolute: Number(rule.absolute) },
    material_worsening: { relative: Number(rule.relative), absolute: Number(rule.absolute) },
    noise_boundary: { relative: Number(rule.relative), absolute: Number(rule.absolute), requires_both: true },
    minimum_evidence: minimum,
    requires_attribution: rule.requiresAttribution === true,
    requires_conversion_value: rule.requiresValue === true,
  }];
});

const ruleFromThreshold = (threshold) => threshold ? {
  directionality: threshold.directionality,
  unit: threshold.unit,
  relative: threshold.noise_boundary.relative,
  absolute: threshold.noise_boundary.absolute,
  minimum: Object.fromEntries(
    Object.entries(threshold.minimum_evidence || {}).filter(([, value]) => value != null)
  ),
  requiresAttribution: threshold.requires_attribution,
  requiresValue: threshold.requires_conversion_value,
} : null;

export const compareEvaluationMetric = ({ metric, baseline, followUp, threshold = null }) => {
  const rule = ruleFromThreshold(threshold) || EVALUATION_METRIC_RULES[metric];
  if (!rule) return { metric, classification: "not_evaluable", minimum_evidence_met: false, material: false, reason_codes: ["unsupported_metric"] };
  if (rule.requiresAttribution && (!baseline.attribution_windows.length || !sameArray(baseline.attribution_windows, followUp.attribution_windows))) {
    return { metric, directionality: rule.directionality, unit: rule.unit, baseline_value: null, follow_up_value: null, absolute_delta: null, relative_delta: null, minimum_evidence_met: false, material: false, classification: "not_evaluable", reason_codes: ["attribution_not_comparable"] };
  }
  if (baseline.currency !== followUp.currency) {
    return { metric, directionality: rule.directionality, unit: rule.unit, baseline_value: null, follow_up_value: null, absolute_delta: null, relative_delta: null, minimum_evidence_met: false, material: false, classification: "not_evaluable", reason_codes: ["currency_mismatch"] };
  }
  const baselineValue = baseline.values?.[metric];
  const followUpValue = followUp.values?.[metric];
  const hasValues = Number.isFinite(baselineValue) && Number.isFinite(followUpValue);
  const zeroBaselineMetrics = new Set(["conversions", "conversion_value", "clicks", "impressions", "spend"]);
  const zeroBaseline = baselineValue === 0 && followUpValue > 0 && zeroBaselineMetrics.has(metric);
  const baselineMinimum = zeroBaseline && Object.hasOwn(rule.minimum, metric)
    ? Object.fromEntries(Object.entries(rule.minimum).filter(([field]) => field !== metric))
    : rule.minimum;
  const enough = minimumMet(baseline.values, baselineMinimum) && minimumMet(followUp.values, rule.minimum);
  if (!hasValues || (rule.requiresValue && (baseline.values.conversion_value == null || followUp.values.conversion_value == null))) {
    return { metric, directionality: rule.directionality, unit: rule.unit, baseline_value: baselineValue ?? null, follow_up_value: followUpValue ?? null, absolute_delta: null, relative_delta: null, minimum_evidence_met: false, material: false, classification: "insufficient_data", reason_codes: ["zero_denominator"] };
  }
  const absolute = round(followUpValue - baselineValue);
  const relative = baselineValue === 0 ? null : round(absolute / Math.abs(baselineValue));
  if (!enough) {
    return { metric, directionality: rule.directionality, unit: rule.unit, baseline_value: baselineValue, follow_up_value: followUpValue, absolute_delta: absolute, relative_delta: relative, minimum_evidence_met: false, material: false, classification: "insufficient_data", reason_codes: ["minimum_volume_not_met"] };
  }
  const material = zeroBaseline
    ? Math.abs(absolute) >= rule.absolute
    : Math.abs(absolute) >= rule.absolute && Math.abs(relative ?? 0) >= rule.relative;
  let classification = "no_material_change";
  if (rule.directionality === "context_only") classification = "context_only";
  else if (material && absolute !== 0) {
    const positive = absolute > 0;
    classification = (positive === (rule.directionality === "higher_is_better")) ? "improved" : "worsened";
  }
  return { metric, directionality: rule.directionality, unit: rule.unit, baseline_value: baselineValue, follow_up_value: followUpValue, absolute_delta: absolute, relative_delta: relative, minimum_evidence_met: true, material, classification, reason_codes: zeroBaseline ? ["zero_baseline"] : [] };
};

const confidenceFactorForReason = (reason, candidate) => {
  if (reason === "overlapping_intervention" || reason === "overlap_completeness_unavailable") return "overlapping_intervention";
  if (["baseline_not_found", "baseline_evidence_missing", "baseline_stale"].includes(reason)) return "missing_baseline_report_run";
  if (["follow_up_not_found", "follow_up_evidence_missing", "follow_up_timeout", "awaiting_follow_up"].includes(reason)) return "missing_follow_up_report_run";
  if (["attribution_mismatch", "attribution_not_comparable"].includes(reason)) return "attribution_incompatible";
  if (["historical_fallback_evidence", "source_evidence_unvalidated", "malformed_evidence"].includes(reason)) return "data_quality_failure";
  if (["window_mismatch", "window_duration_mismatch", "cadence_mismatch", "timezone_mismatch", "currency_mismatch", "binding_revision_mismatch", "account_binding_changed"].includes(reason)) return "data_quality_failure";
  if (reason === "intervention_cancelled" || reason === "intervention_superseded") return "evaluation_invalidated";
  if (reason === "minimum_volume_not_met") {
    const minimums = candidate.threshold_snapshots?.flatMap((item) => Object.entries(item.minimum_evidence || {})) || [];
    const values = [candidate.baseline?.values, candidate.follow_up?.values].filter(Boolean);
    if (minimums.some(([field, value]) => field === "spend" && value != null && values.some((row) => Number(row.spend) < value))) return "insufficient_spend";
    if (minimums.some(([field, value]) => field === "conversions" && value != null && values.some((row) => Number(row.conversions) < value))) return "insufficient_conversions";
    return "insufficient_volume";
  }
  return null;
};

const evidenceMarginFactors = (candidate) => {
  const factors = new Set();
  for (const threshold of candidate.threshold_snapshots || []) {
    for (const [field, minimum] of Object.entries(threshold.minimum_evidence || {})) {
      if (minimum == null || minimum <= 0) continue;
      const values = [candidate.baseline?.values?.[field], candidate.follow_up?.values?.[field]];
      if (values.some((value) => Number(value) < minimum * 2)) {
        factors.add(field === "spend" ? "insufficient_spend" : field === "conversions" ? "insufficient_conversions" : "insufficient_volume");
      }
    }
  }
  return [...factors];
};

export const calculateEvaluationConfidence = (candidate) => {
  const factors = new Set(
    (candidate.reason_codes || []).map((reason) => confidenceFactorForReason(reason, candidate)).filter(Boolean)
  );
  if (candidate.status === "invalidated") factors.add("evaluation_invalidated");
  if (!candidate.baseline) factors.add("incomplete_baseline_evidence");
  if (!candidate.follow_up) factors.add("incomplete_follow_up_evidence");

  if (candidate.status === "insufficient_data") {
    return { level: "low", score: 20, factors: [...factors], version: EVALUATION_CONFIDENCE_VERSION };
  }
  if (candidate.status !== "ready") {
    return { level: "unavailable", score: null, factors: [...factors], version: EVALUATION_CONFIDENCE_VERSION };
  }

  let score = 100;
  const cadenceDays = EVALUATION_CADENCE_DAYS[candidate.baseline?.window?.cadence];
  if (cadenceDays != null && cadenceDays < 7) {
    factors.add("short_observation_window");
    score -= 20;
  }
  if ([candidate.baseline?.row_count, candidate.follow_up?.row_count].some((value) => Number(value) <= 1)) {
    factors.add("limited_observation_density");
    score -= 15;
  }
  for (const factor of evidenceMarginFactors(candidate)) {
    factors.add(factor);
    score -= 20;
  }
  if (candidate.observed_result === "mixed") {
    factors.add("unstable_metric_direction");
    score -= 15;
  }
  if ([candidate.baseline?.completeness, candidate.follow_up?.completeness].some((value) => value !== "complete")) {
    factors.add("data_quality_failure");
    score -= 30;
  }
  score = Math.max(0, Math.min(100, score));
  const level = score >= 75 ? "high" : score >= 50 ? "medium" : "low";
  return { level, score, factors: [...factors], version: EVALUATION_CONFIDENCE_VERSION };
};

export const classifyOverallResult = ({ primaryMetric, watchedMetrics = [], metricResults = [] }) => {
  const directional = metricResults.filter((result) =>
    watchedMetrics.includes(result.metric) &&
    !EVALUATION_NEUTRAL_METRICS.includes(result.metric) &&
    result.minimum_evidence_met &&
    ["improved", "worsened", "no_material_change"].includes(result.classification)
  );
  const material = directional.filter((result) => ["improved", "worsened"].includes(result.classification));
  if (directional.length >= 2 && new Set(material.map((result) => result.classification)).size > 1) return "mixed";
  return metricResults.find((result) => result.metric === primaryMetric)?.classification || null;
};

const displayMetric = (metric) => metric.replaceAll("_", " ").toUpperCase();
export const buildEvaluationSummary = ({ status, primaryMetric, observedResult, baseline, followUp, reasons = [] }) => {
  if (status === "invalidated") return `This Evaluation is invalidated after the recorded Intervention was corrected or cancelled.`;
  if (status === "awaiting_follow_up") return `Follow-up evidence is not available yet for the canonical post-action window.`;
  if (status === "insufficient_data") return `There is insufficient persisted evidence for this Evaluation: ${reasons[0] || "bounded evidence is unavailable"}.`;
  if (status !== "ready") return `This Intervention is not currently evaluable: ${reasons[0] || "bounded evidence is unavailable"}.`;
  const result = observedResult === "mixed" ? "showed mixed directional movement" : `was classified as ${String(observedResult).replaceAll("_", " ")}`;
  const baselineValue = baseline?.values?.[primaryMetric];
  const followUpValue = followUp?.values?.[primaryMetric];
  return `${displayMetric(primaryMetric)} ${result}, moving from ${baselineValue} to ${followUpValue} across the bounded windows. This is an observed association, not causal attribution.`;
};

export const detectOverlap = ({ interventions = [], subjectChainIds = [], followUpWindow, timezone }) => {
  const excluded = new Set(subjectChainIds.map(String));
  const ignored = new Set(["internal_note", "monitor_only", "no_action"]);
  return interventions.filter((item) => {
    if (!item || excluded.has(String(item._id)) || item.status !== "active" || ignored.has(item.action_type)) return false;
    const actionDate = localActionDate(item.performed_at, timezone);
    return actionDate >= followUpWindow.start && actionDate <= followUpWindow.end;
  });
};

export const evaluationCandidateHash = (candidate) => hashEvaluationEvidence({
  status: candidate.status,
  intent: candidate.intent,
  primary_metric: candidate.primary_metric,
  watched_metrics: candidate.watched_metrics,
  baseline: candidate.baseline,
  follow_up: candidate.follow_up,
  metric_results: candidate.metric_results,
  threshold_snapshots: candidate.threshold_snapshots,
  observed_result: candidate.observed_result,
  confidence_level: candidate.confidence_level,
  confidence_score: candidate.confidence_score,
  confidence_factors: candidate.confidence_factors,
  confidence_version: candidate.confidence_version,
  interpretability: candidate.interpretability,
  reason_codes: candidate.reason_codes,
  overlap_intervention_ids: candidate.overlap_intervention_ids,
  evidence_completeness: candidate.evidence_completeness,
  invalidation_context: candidate.invalidation_context,
});

export const phase4EvaluationEngineInternals = { minimumMet, sameArray, validCampaignSnapshot };
