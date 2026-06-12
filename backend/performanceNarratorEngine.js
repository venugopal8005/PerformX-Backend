
"use strict";

/**
 * Performance Narrator Engine
 *
 * Accepts Meta Ads daily insight rows, selects the latest two comparable days,
 * and returns one deterministic executive insight as JSON.
 *
 * Expected Meta input is usually an array from the Insights API with
 * time_increment=1:
 *
 * [
 *   {
 *     date_start: "2026-05-05",
 *     date_stop: "2026-05-05",
 *     campaign_id: "123",
 *     campaign_name: "Prospecting",
 *     spend: "501.66",
 *     impressions: "21306",
 *     clicks: "122",
 *     ctr: "0.57",
 *     cpc: "4.11",
 *     cpm: "23.5",
 *     reach: "18000",
 *     frequency: "1.8",
 *     actions: [{ action_type: "purchase", value: "12" }]
 *   }
 * ]
 */

const DEFAULT_OPTIONS = {
  currency: "INR",
  currencySymbol: "INR ",
  conversionActionTypes: [
    "purchase",
    "lead",
    "complete_registration",
    "submit_application",
    "schedule_total",
    "onsite_conversion.messaging_conversation_started_7d",
  ],
  excludeToday: false,
  today: null,
  timeZone: "Asia/Kolkata",
  minimumSpendForInsight: 1,
  minimumImpressionsForInsight: 100,
  minimumClicksForRateInsight: 20,
  minimumConversionsForConversionInsight: 3,
  minimumDailyRowsForBaseline: 4,
  baselineLookbackDays: 7,
  minimumSpendForStrongDecision: 500,
  minimumFinancialImpactAmount: 500,
  minimumFinancialImpactPercentOfSpend: 5,
  reportGoal: null,
};

const METRIC_DEFINITIONS = {
  spend: {
    label: "Spend",
    weight: 4,
    unit: "money",
    higherIsBad: null,
  },
  impressions: {
    label: "Impressions",
    weight: 3,
    unit: "number",
    higherIsBad: false,
  },
  reach: {
    label: "Reach",
    weight: 3,
    unit: "number",
    higherIsBad: false,
  },
  frequency: {
    label: "Frequency",
    weight: 6,
    unit: "number",
    higherIsBad: null,
  },
  clicks: {
    label: "Clicks",
    weight: 8,
    unit: "number",
    higherIsBad: false,
  },
  ctr: {
    label: "CTR",
    weight: 10,
    unit: "percent",
    higherIsBad: false,
  },
  cpc: {
    label: "CPC",
    weight: 9,
    unit: "money",
    higherIsBad: true,
  },
  cpm: {
    label: "CPM",
    weight: 7,
    unit: "money",
    higherIsBad: true,
  },
  conversions: {
    label: "Conversions",
    weight: 10,
    unit: "number",
    higherIsBad: false,
  },
  roas: {
    label: "ROAS",
    weight: 10,
    unit: "number",
    higherIsBad: false,
  },
  cpa: {
    label: "CPA",
    weight: 10,
    unit: "money",
    higherIsBad: true,
  },
  conversionRate: {
    label: "Conversion rate",
    weight: 9,
    unit: "percent",
    higherIsBad: false,
  },
};

const SNAPSHOT_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "conversions",
  "roas",
  "cpa",
  "frequency",
  "cpm",
];

const ARCHETYPES = [
  {
    id: "creative_fatigue",
    name: "Creative Fatigue",
    severityBias: 18,
    when: ({ d, current }) =>
      d.ctr <= -20 &&
      d.cpc >= 15 &&
      (d.frequency >= 10 || current.frequency >= 2.5 || d.clicks <= -15),
    confidence: ({ d, current }) =>
      confidenceFrom([
        d.ctr <= -35,
        d.cpc >= 25,
        d.frequency >= 15 || current.frequency >= 3,
        d.clicks <= -25,
      ]),
    cause:
      "Engagement efficiency fell while traffic became more expensive, which usually means the current creative is losing response quality.",
    action:
      "Pause the weakest creative set and launch 2-3 new variations against the same audience.",
    nextSignal:
      "CTR should recover first, followed by CPC normalization within 48-72 hours.",
  },
  {
    id: "audience_saturation",
    name: "Audience Saturation",
    severityBias: 15,
    when: ({ d, current }) =>
      (d.frequency >= 20 || current.frequency >= 3.5) &&
      d.reach <= 5 &&
      (d.ctr <= -15 || d.cpc >= 15 || d.cpm >= 15),
    confidence: ({ d, current }) =>
      confidenceFrom([
        current.frequency >= 3.5,
        d.frequency >= 25,
        d.reach <= 0,
        d.ctr <= -20 || d.cpc >= 20,
      ]),
    cause:
      "The campaign is repeatedly reaching a similar audience while response quality is weakening.",
    action:
      "Expand the audience, rotate exclusions, or reduce budget until fresh reach improves.",
    nextSignal:
      "Reach should increase and frequency growth should slow before efficiency recovers.",
  },
  {
    id: "engagement_quality_drop",
    name: "Engagement Quality Drop",
    severityBias: 17,
    when: ({ d }) =>
      d.ctr <= -25 &&
      d.clicks <= -15 &&
      (d.impressions >= 0 || d.reach >= 0) &&
      d.frequency < 10,
    confidence: ({ d }) =>
      confidenceFrom([
        d.ctr <= -35,
        d.clicks <= -25,
        d.impressions >= 10 || d.reach >= 10,
        d.cpc >= 10 || d.cpm <= 0,
      ]),
    cause:
      "Delivery reached enough people, but the audience clicked at a much lower rate, indicating weaker creative-message fit rather than a pure delivery problem.",
    action:
      "Refresh the hook, primary text, and visual angle before adding budget; keep the audience stable while testing the new creative.",
    nextSignal:
      "CTR and clicks should recover first while CPM can remain stable or lower.",
  },
  {
    id: "aggressive_scaling",
    name: "Aggressive Scaling",
    severityBias: 12,
    when: ({ d }) =>
      d.spend >= 25 &&
      (d.impressions >= 20 || d.reach >= 20) &&
      (d.cpa >= 20 || d.cpc >= 20 || d.ctr <= -15),
    confidence: ({ d }) =>
      confidenceFrom([
        d.spend >= 40,
        d.impressions >= 30 || d.reach >= 30,
        d.cpa >= 25 || d.cpc >= 25,
        d.conversions <= 10,
      ]),
    cause:
      "Spend and delivery expanded faster than efficiency, which indicates the budget increase is pushing into lower-quality inventory or audiences.",
    action:
      "Hold or step down the budget increase and scale again only after CPA or CPC stabilizes.",
    nextSignal:
      "CPA/CPC should flatten within the next comparison period if the scale pressure is reduced.",
  },
  {
    id: "conversion_funnel_breakdown",
    name: "Conversion Funnel Breakdown",
    severityBias: 22,
    when: ({ d }) =>
      d.clicks >= -10 &&
      d.ctr >= -15 &&
      (d.conversions <= -25 || d.conversionRate <= -25 || d.cpa >= 25),
    confidence: ({ d }) =>
      confidenceFrom([
        d.clicks >= 0,
        d.ctr >= -10,
        d.conversions <= -35 || d.conversionRate <= -35,
        d.cpa >= 35,
      ]),
    cause:
      "Traffic volume did not fall enough to explain the conversion loss, so the issue is likely after the click.",
    action:
      "Check landing page, offer, checkout, lead form, tracking, and recent site changes before increasing spend.",
    nextSignal:
      "Conversion rate should recover while CTR and CPC remain broadly stable.",
  },
  {
    id: "auction_pressure",
    name: "Auction Pressure",
    severityBias: 14,
    when: ({ d }) =>
      d.cpm >= 25 &&
      d.cpc >= 15 &&
      d.ctr > -20 &&
      d.impressions <= 15,
    confidence: ({ d }) =>
      confidenceFrom([
        d.cpm >= 40,
        d.cpc >= 25,
        d.ctr > -10,
        d.impressions <= 0 || d.reach <= 0,
      ]),
    cause:
      "Media costs increased while engagement did not collapse, pointing to more expensive auction conditions.",
    action:
      "Avoid scaling this campaign today; test lower-cost audiences or placements before adding budget.",
    nextSignal:
      "CPM should fall before CPC improves materially.",
  },
  {
    id: "delivery_instability",
    name: "Delivery Instability",
    severityBias: 10,
    when: ({ d }) =>
      Math.abs(d.spend) >= 30 &&
      Math.abs(d.impressions) >= 30 &&
      (d.clicks <= -25 || d.conversions <= -25 || d.ctr <= -20),
    confidence: ({ d }) =>
      confidenceFrom([
        Math.abs(d.spend) >= 50,
        Math.abs(d.impressions) >= 50,
        d.clicks <= -30 || d.conversions <= -30,
        d.cpm >= 20 || d.ctr <= -25,
      ]),
    cause:
      "Delivery shifted sharply enough to make performance unstable across the day-to-day comparison.",
    action:
      "Review budget edits, learning status, bid strategy changes, and approval issues before judging creative quality.",
    nextSignal:
      "Spend and impressions should stabilize before KPI movement becomes reliable.",
  },
  {
    id: "traffic_quality_drop",
    name: "Traffic Quality Drop",
    severityBias: 16,
    when: ({ d }) =>
      d.clicks >= 15 &&
      (d.conversions <= -15 || d.conversionRate <= -25 || d.cpa >= 25),
    confidence: ({ d }) =>
      confidenceFrom([
        d.clicks >= 25,
        d.conversions <= -25 || d.conversionRate <= -35,
        d.cpa >= 30,
        d.ctr >= 0,
      ]),
    cause:
      "The campaign attracted more clicks but those clicks converted worse than the previous day.",
    action:
      "Tighten targeting, review placements, and compare converting vs non-converting traffic segments.",
    nextSignal:
      "Conversion rate should improve before total conversions scale again.",
  },
  {
    id: "volume_loss",
    name: "Volume Loss",
    severityBias: 12,
    when: ({ d }) =>
      d.impressions <= -25 &&
      d.clicks <= -25 &&
      (d.spend <= -15 || d.cpm >= 20),
    confidence: ({ d }) =>
      confidenceFrom([
        d.impressions <= -40,
        d.clicks <= -40,
        d.spend <= -25 || d.cpm >= 30,
        d.conversions <= -20,
      ]),
    cause:
      "Delivery volume dropped enough to reduce traffic and conversion opportunity.",
    action:
      "Check budget caps, bid limits, audience size, ad approvals, and campaign learning constraints.",
    nextSignal:
      "Impressions and clicks should recover before downstream conversions improve.",
  },
  {
    id: "healthy_scaling",
    name: "Healthy Scaling",
    severityBias: 8,
    positive: true,
    when: ({ d }) =>
      d.spend >= 15 &&
      (d.conversions >= 10 || d.clicks >= 15) &&
      d.cpa <= 10 &&
      d.cpc <= 10 &&
      d.ctr >= -10,
    confidence: ({ d }) =>
      confidenceFrom([
        d.spend >= 25,
        d.conversions >= 20,
        d.cpa <= 0,
        d.ctr >= 0 || d.cpc <= 0,
      ]),
    cause:
      "Spend increased while efficiency held or improved, indicating the campaign absorbed more budget without quality loss.",
    action:
      "Continue scaling gradually while protecting CPA and CTR thresholds.",
    nextSignal:
      "Conversions should continue rising while CPA remains within target range.",
  },
];

function generatePerformanceNarrative(input, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const rows = extractRows(input);
  const context = extractContext(input);
  const prepared = selectComparisonDays(rows, config);

  if (!prepared.ok) {
    return insufficientData(prepared.reason, context);
  }

  const { currentRow, previousRow } = prepared;
  const current = normalizeMetaDailyRow(currentRow, config);
  const previous = normalizeMetaDailyRow(previousRow, config);
  const validation = validateComparableDays(current, previous, config);

  if (!validation.ok) {
    return insufficientData(validation.reason, {
      ...context,
      campaignId: current.campaignId || previous.campaignId || context.campaignId,
      campaignName:
        current.campaignName || previous.campaignName || context.campaignName,
    });
  }

  const deltas = calculateDeltas(current, previous);
  const dataQuality = assessDataQuality(rows, prepared, current, previous, config);
  const baselineComparison = buildBaselineComparison(
    prepared.dailyRows,
    current.date,
    current,
    config
  );
  const trustLayer = assessTrustLayer(
    rows,
    prepared,
    current,
    previous,
    deltas,
    baselineComparison,
    dataQuality,
    config
  );
  const anomalies = rankAnomalies(current, previous, deltas, trustLayer);
  const archetype = matchBestArchetype(current, previous, deltas, anomalies);
  const fallback = buildFallbackArchetype(anomalies, deltas);
  const trustedSelection = applyTrustToSelection(archetype || fallback, trustLayer);
  const segmentContributors = buildSegmentContributors(
    rows,
    current.date,
    previous.date,
    config
  );
  const adDiagnostics = buildAdDiagnostics(segmentContributors, trustedSelection, config);
  const reportGoal = extractReportGoal(input, context, config);
  const decisionType = buildDecisionType(trustedSelection, reportGoal);
  const topContributor = buildTopContributor(segmentContributors, adDiagnostics, trustedSelection, config);
  const trustGate = assessTrustGate({
    current,
    previous,
    trustLayer,
    dataQuality,
    baselineComparison,
    topContributor,
    selected: trustedSelection,
    decisionType,
    comparisonMode: "direct_daily",
    disclaimer: null,
    config,
  });
  const selected = applyTrustGateToSelection(
    trustedSelection,
    trustGate,
    decisionType,
    topContributor
  );
  const finalDecisionType = trustGate.decisionTypeOverride
    ? buildDecisionType({ id: trustGate.decisionTypeOverride }, reportGoal)
    : decisionType;
  const financialImpact = estimateFinancialImpact(
    current,
    previous,
    deltas,
    selected,
    config
  );
  const displayMetrics = buildDisplayMetrics(current, previous, deltas, config);
  const reportGoalAssessment = buildReportGoalAssessment(reportGoal, current, previous, displayMetrics, config);
  const followUp = buildFollowUp(
    extractPreviousNarrative(input, context),
    current,
    previous,
    deltas,
    displayMetrics
  );

  return {
    status: "ok",
    engineVersion: "1.0.0",
    analysisType: "daily_comparison",
    guidanceCoverage: {
      mode: "archetype_and_metric_specific_playbooks",
      supportedMetrics: Object.keys(METRIC_DEFINITIONS),
    },
    executiveSummary: buildExecutiveSummary(
      current,
      previous,
      deltas,
      selected,
      financialImpact,
      config
    ),
    userInsight: buildUserInsight(
      current,
      previous,
      deltas,
      anomalies,
      selected,
      financialImpact,
      adDiagnostics,
      trustLayer,
      trustGate,
      finalDecisionType,
      topContributor,
      reportGoalAssessment,
      config
    ),
    campaign: {
      id: current.campaignId || previous.campaignId || context.campaignId || null,
      name:
        current.campaignName ||
        previous.campaignName ||
        context.campaignName ||
        null,
    },
    period: {
      current: current.date,
      previous: previous.date,
    },
    dataQuality,
    trustLayer,
    trustGate,
    baselineComparison,
    decisionType: finalDecisionType,
    topContributor,
    followUp,
    displayMetrics,
    reportGoalAssessment,
    snapshot: buildSnapshot(current, previous, deltas, config),
    keyDelta: buildKeyDelta(anomalies, selected),
    likelyCause: {
      id: selected.id,
      archetype: selected.name,
      confidence: selected.confidence,
      summary: selected.cause,
      evidence: selected.evidence,
    },
    financialImpact,
    decision: selected.action,
    recommendations: buildRecommendations(selected, anomalies, deltas),
    diagnosticChecks: buildDiagnosticChecks(selected, deltas),
    monitoringPlan: buildMonitoringPlan(selected, anomalies),
    guardrails: buildGuardrails(current, previous, deltas, selected, config),
    nextSignal: selected.nextSignal,
    severity: {
      level: severityLevel(selected.score),
      score: round(selected.score, 1),
    },
    metrics: {
      current,
      previous,
      deltas,
    },
    rankedAnomalies: anomalies.slice(0, 5),
    segmentContributors: segmentContributors.slice(0, 5),
    adDiagnostics,
  };
}

function generateOperationalInsight(input = {}, options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const context = input.context || {};
  const period = input.period || {};
  const currentPeriodLabel = formatPeriodLabel(period.current);
  const previousPeriodLabel = formatPeriodLabel(period.previous);
  const current = normalizeOperationalMetrics(
    input.currentPeriodMetrics || input.current || {},
    currentPeriodLabel === "Unknown period" ? "current" : currentPeriodLabel,
    context,
    config
  );
  const previous = normalizeOperationalMetrics(
    input.previousPeriodMetrics || input.previous || {},
    previousPeriodLabel === "Unknown period" ? "previous" : previousPeriodLabel,
    context,
    config
  );
  const deltas = input.deltas || calculateDeltas(current, previous);
  const validation = validateComparableDays(current, previous, config);

  if (!validation.ok) {
    return insufficientData(validation.reason, context);
  }

  const dataQuality = buildOperationalDataQuality(input, current, previous, config);
  const baselineComparison = buildOperationalBaselineComparison(input);
  const prepared = {
    inputRowCount: Array.isArray(input.rawRows) ? input.rawRows.length : 0,
    dailyRowCount: input.periodRowCount || 2,
  };
  const trustLayer = assessTrustLayer(
    input.rawRows || [],
    prepared,
    current,
    previous,
    deltas,
    baselineComparison,
    dataQuality,
    config
  );
  const anomalies = rankAnomalies(current, previous, deltas, trustLayer);
  const archetype = matchBestArchetype(current, previous, deltas, anomalies);
  const fallback = buildFallbackArchetype(anomalies, deltas);
  const trustedSelection = applyTrustToSelection(archetype || fallback, trustLayer);
  const segmentContributors = normalizeOperationalSegmentContributors(
    input.segmentContributors || input.segments || []
  );
  const adDiagnostics = buildAdDiagnostics(segmentContributors, trustedSelection, config);
  const reportGoal = extractReportGoal(input, context, config);
  const decisionType = buildDecisionType(trustedSelection, reportGoal);
  const topContributor = buildTopContributor(segmentContributors, adDiagnostics, trustedSelection, config);
  const trustGate = assessTrustGate({
    current,
    previous,
    trustLayer,
    dataQuality,
    baselineComparison,
    topContributor,
    selected: trustedSelection,
    decisionType,
    comparisonMode: input.mode || period.source || "scheduled_window",
    disclaimer: input.disclaimer || null,
    config,
  });
  const selected = applyTrustGateToSelection(
    trustedSelection,
    trustGate,
    decisionType,
    topContributor
  );
  const finalDecisionType = trustGate.decisionTypeOverride
    ? buildDecisionType({ id: trustGate.decisionTypeOverride }, reportGoal)
    : decisionType;
  const financialImpact = estimateFinancialImpact(
    current,
    previous,
    deltas,
    selected,
    config
  );
  const displayMetrics = buildDisplayMetrics(current, previous, deltas, config);
  const reportGoalAssessment = buildReportGoalAssessment(reportGoal, current, previous, displayMetrics, config);
  const followUp = buildFollowUp(
    extractPreviousNarrative(input, context),
    current,
    previous,
    deltas,
    displayMetrics
  );

  return {
    status: "ok",
    engineVersion: "1.1.0",
    analysisType: input.analysisType || "period_comparison",
    guidanceCoverage: {
      mode: "period_agnostic_archetype_and_metric_playbooks",
      supportedMetrics: Object.keys(METRIC_DEFINITIONS),
    },
    executiveSummary: buildExecutiveSummary(
      current,
      previous,
      deltas,
      selected,
      financialImpact,
      config
    ),
    userInsight: buildUserInsight(
      current,
      previous,
      deltas,
      anomalies,
      selected,
      financialImpact,
      adDiagnostics,
      trustLayer,
      trustGate,
      finalDecisionType,
      topContributor,
      reportGoalAssessment,
      config
    ),
    campaign: {
      id: context.campaignId || current.campaignId || previous.campaignId || null,
      name:
        context.campaignName ||
        current.campaignName ||
        previous.campaignName ||
        null,
    },
    period: {
      current: period.current || current.date,
      previous: period.previous || previous.date,
    },
    dataQuality,
    trustLayer,
    trustGate,
    baselineComparison,
    decisionType: finalDecisionType,
    topContributor,
    followUp,
    displayMetrics,
    reportGoalAssessment,
    snapshot: buildSnapshot(current, previous, deltas, config),
    keyDelta: buildKeyDelta(anomalies, selected),
    likelyCause: {
      id: selected.id,
      archetype: selected.name,
      confidence: selected.confidence,
      summary: selected.cause,
      evidence: selected.evidence,
    },
    financialImpact,
    decision: selected.action,
    recommendations: buildRecommendations(selected, anomalies, deltas),
    diagnosticChecks: buildDiagnosticChecks(selected, deltas),
    monitoringPlan: buildMonitoringPlan(selected, anomalies),
    guardrails: buildGuardrails(current, previous, deltas, selected, config),
    nextSignal: selected.nextSignal,
    severity: {
      level: severityLevel(selected.score),
      score: round(selected.score, 1),
    },
    metrics: {
      current,
      previous,
      deltas,
    },
    rankedAnomalies: anomalies.slice(0, 5),
    segmentContributors: segmentContributors.slice(0, 5),
    adDiagnostics,
  };
}

function extractRows(input) {
  if (Array.isArray(input)) {
    if (input.some(hasDailyDate)) return input;

    const nestedRows = input.flatMap((item) => {
      if (item && item.json) return extractRows(item.json);
      return extractRows(item);
    });

    return nestedRows.length ? nestedRows : input;
  }

  if (input && input.json) return extractRows(input.json);
  if (input && input.body) return extractRows(input.body);
  if (input && input.response) return extractRows(input.response);
  if (input && input.data && Array.isArray(input.data.data)) return input.data.data;
  if (input && Array.isArray(input.data)) return input.data;
  if (input && input.insights && Array.isArray(input.insights.data)) {
    return input.insights.data;
  }
  if (input && Array.isArray(input.rows)) return input.rows;
  return [];
}

function hasDailyDate(row) {
  return Boolean(row && (row.date_start || row.date || row.dateStop));
}

function extractContext(input) {
  if (!input || Array.isArray(input)) return {};
  return input.context || {};
}

function todayInTimeZone(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function selectComparisonDays(rows, config) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return {
      ok: false,
      reason:
        "At least two daily Meta insight rows are required. Request Meta Insights with time_increment=1.",
    };
  }

  const today = config.today || todayInTimeZone(config.timeZone);
  const filteredRows = rows
    .filter((row) => row && (row.date_start || row.date || row.dateStop))
    .filter((row) => {
      const date = row.date_start || row.date || row.dateStop;
      return !config.excludeToday || date < today;
    });
  const dailyRows = aggregateRowsByDate(filteredRows, config).sort((a, b) => {
    const aDate = a.date_start || a.date || a.dateStop || "";
    const bDate = b.date_start || b.date || b.dateStop || "";
    return aDate.localeCompare(bDate);
  });

  if (dailyRows.length < 2) {
    return {
      ok: false,
      reason:
        "Not enough completed daily rows after filtering. Provide at least two days of campaign insights.",
    };
  }

  return {
    ok: true,
    previousRow: dailyRows[dailyRows.length - 2],
    currentRow: dailyRows[dailyRows.length - 1],
    dailyRows,
    dailyRowCount: dailyRows.length,
    inputRowCount: filteredRows.length,
  };
}

function aggregateRowsByDate(rows, config) {
  const groups = new Map();

  for (const row of rows) {
    const date = row.date_start || row.date || row.dateStop;
    const normalized = normalizeMetaDailyRow(row, config);

    if (!groups.has(date)) {
      groups.set(date, {
        date_start: date,
        campaign_id: row.campaign_id || row.campaignId || null,
        campaign_name: row.campaign_name || row.campaignName || null,
        spend: 0,
        impressions: 0,
        reach: 0,
        clicks: 0,
        conversions: 0,
        roasTotal: 0,
        roasCount: 0,
      });
    }

    const group = groups.get(date);
    group.spend += normalized.spend;
    group.impressions += normalized.impressions;
    group.reach += normalized.reach;
    group.clicks += normalized.clicks;
    group.conversions += normalized.conversions;
    if (normalized.roas > 0) {
      group.roasTotal += normalized.roas;
      group.roasCount += 1;
    }

    if (group.campaign_id && normalized.campaignId && group.campaign_id !== normalized.campaignId) {
      group.campaign_id = null;
      group.campaign_name = "Multiple campaigns";
    }
  }

  return Array.from(groups.values()).map((row) => ({
    ...row,
    spend: round(row.spend, 2),
    impressions: round(row.impressions, 0),
    reach: round(row.reach, 0),
    clicks: round(row.clicks, 0),
    conversions: round(row.conversions, 2),
    roas: round(row.roasCount ? row.roasTotal / row.roasCount : 0, 2),
    frequency: round(safeDivide(row.impressions, row.reach), 2),
    ctr: round(safeDivide(row.clicks * 100, row.impressions), 2),
    cpc: round(safeDivide(row.spend, row.clicks), 2),
    cpm: round(safeDivide(row.spend * 1000, row.impressions), 2),
    cpa: round(safeDivide(row.spend, row.conversions), 2),
    conversionRate: round(safeDivide(row.conversions * 100, row.clicks), 2),
  }));
}

function normalizeMetaDailyRow(row, config) {
  const spend = number(row.spend);
  const impressions = number(row.impressions);
  const clicks = number(row.clicks);
  const reach = number(row.reach);
  const frequency =
    number(row.frequency) || safeDivide(impressions, reach) || number(row.freq);
  const cpm = number(row.cpm) || safeDivide(spend * 1000, impressions);
  const ctr = number(row.ctr) || safeDivide(clicks * 100, impressions);
  const cpc = number(row.cpc) || safeDivide(spend, clicks);
  const conversions = extractConversions(row, config);
  const roas = extractRoas(row);
  const cpa =
    number(row.cpa) ||
    number(row.cost_per_conversion) ||
    extractCostPerAction(row, config) ||
    safeDivide(spend, conversions);
  const conversionRate = safeDivide(conversions * 100, clicks);

  return {
    date: row.date_start || row.date || row.dateStop || null,
    campaignId: row.campaign_id || row.campaignId || null,
    campaignName: row.campaign_name || row.campaignName || null,
    spend: round(spend, 2),
    impressions: round(impressions, 0),
    reach: round(reach, 0),
    frequency: round(frequency, 2),
    clicks: round(clicks, 0),
    ctr: round(ctr, 2),
    cpc: round(cpc, 2),
    cpm: round(cpm, 2),
    conversions: round(conversions, 2),
    roas: round(roas, 2),
    cpa: round(cpa, 2),
    conversionRate: round(conversionRate, 2),
  };
}

function normalizeOperationalMetrics(metrics, date, context, config) {
  const spend = number(metrics.spend);
  const impressions = number(metrics.impressions);
  const clicks = number(metrics.clicks);
  const reach = number(metrics.reach);
  const conversions = number(metrics.conversions);
  const frequency =
    number(metrics.frequency) || safeDivide(impressions, reach) || number(metrics.freq);
  const ctr = number(metrics.ctr) || safeDivide(clicks * 100, impressions);
  const cpc = number(metrics.cpc) || safeDivide(spend, clicks);
  const cpm = number(metrics.cpm) || safeDivide(spend * 1000, impressions);
  const cpa =
    number(metrics.cpa) ||
    number(metrics.cost_per_conversion) ||
    safeDivide(spend, conversions);
  const conversionRate =
    number(metrics.conversionRate) ||
    number(metrics.conversion_rate) ||
    safeDivide(conversions * 100, clicks);

  return {
    date,
    campaignId: metrics.campaignId || metrics.campaign_id || context.campaignId || null,
    campaignName:
      metrics.campaignName || metrics.campaign_name || context.campaignName || null,
    spend: round(spend, 2),
    impressions: round(impressions, 0),
    reach: round(reach, 0),
    frequency: round(frequency, 2),
    clicks: round(clicks, 0),
    ctr: round(ctr, 2),
    cpc: round(cpc, 2),
    cpm: round(cpm, 2),
    conversions: round(conversions, 2),
    roas: round(number(metrics.roas) || number(metrics.purchase_roas), 2),
    cpa: round(cpa, 2),
    conversionRate: round(conversionRate, 2),
  };
}

function extractConversions(row, config) {
  const direct =
    number(row.conversions) ||
    number(row.results) ||
    number(row.purchases) ||
    number(row.leads);

  if (direct) return direct;

  return sumActionValues(row.actions, config.conversionActionTypes);
}

function extractRoas(row) {
  const direct = number(row.roas);
  if (direct) return direct;

  if (typeof row.purchase_roas === "number" || typeof row.purchase_roas === "string") {
    return number(row.purchase_roas);
  }

  if (Array.isArray(row.purchase_roas)) {
    const purchaseRoas =
      row.purchase_roas.find((item) =>
        ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"].includes(
          item?.action_type
        )
      ) || row.purchase_roas[0];

    return number(purchaseRoas?.value);
  }

  return 0;
}

function extractCostPerAction(row, config) {
  return firstActionValue(row.cost_per_action_type, config.conversionActionTypes);
}

function sumActionValues(actions, actionTypes) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, action) => {
    if (!action || !actionTypes.includes(action.action_type)) return sum;
    return sum + number(action.value);
  }, 0);
}

function firstActionValue(actions, actionTypes) {
  if (!Array.isArray(actions)) return 0;
  const action = actions.find((item) => item && actionTypes.includes(item.action_type));
  return action ? number(action.value) : 0;
}

function validateComparableDays(current, previous, config) {
  if (!current.date || !previous.date) {
    return { ok: false, reason: "Both rows must include a daily date." };
  }

  if (
    current.spend < config.minimumSpendForInsight &&
    previous.spend < config.minimumSpendForInsight
  ) {
    return {
      ok: false,
      reason: "Spend is too low to generate a reliable performance insight.",
    };
  }

  if (
    current.impressions < config.minimumImpressionsForInsight &&
    previous.impressions < config.minimumImpressionsForInsight
  ) {
    return {
      ok: false,
      reason: "Impressions are too low to generate a reliable performance insight.",
    };
  }

  return { ok: true };
}

function calculateDeltas(current, previous) {
  return Object.keys(METRIC_DEFINITIONS).reduce((acc, metric) => {
    acc[metric] = percentChange(current[metric], previous[metric]);
    return acc;
  }, {});
}

function rankAnomalies(current, previous, deltas, trustLayer = null) {
  const metricReliability = trustLayer?.metricReliability || {};

  return Object.entries(METRIC_DEFINITIONS)
    .map(([metric, definition]) => {
      const delta = deltas[metric];
      const direction = classifyDirection(metric, delta, deltas);
      const magnitude = Math.min(Math.abs(delta), 150);
      const directionMultiplier =
        direction === "bad" ? 1.3 : direction === "good" ? 0.65 : 0.9;
      const reliability = metricReliability[metric] || {
        level: "medium",
        usable: true,
        scoreMultiplier: 0.8,
        reasons: [],
      };
      const score =
        (magnitude / 10) *
        definition.weight *
        directionMultiplier *
        reliability.scoreMultiplier;

      return {
        metric,
        label: definition.label,
        current: current[metric],
        previous: previous[metric],
        delta: round(delta, 1),
        direction,
        reliability: reliability.level,
        reliabilityReasons: reliability.reasons,
        usable: reliability.usable,
        score: round(score, 1),
      };
    })
    .filter((item) => item.usable && Number.isFinite(item.delta) && Math.abs(item.delta) >= 5)
    .sort((a, b) => b.score - a.score);
}

function classifyDirection(metric, delta, deltas) {
  const definition = METRIC_DEFINITIONS[metric];

  if (!definition || delta === 0) return "neutral";
  if (definition.higherIsBad === true) return delta > 0 ? "bad" : "good";
  if (definition.higherIsBad === false) return delta < 0 ? "bad" : "good";

  if (metric === "spend") {
    if (
      delta > 0 &&
      (deltas.cpa > 10 || deltas.cpc > 10 || deltas.ctr < -10)
    ) {
      return "bad";
    }
    if (delta > 0 && (deltas.conversions > 0 || deltas.clicks > 0)) return "good";
    if (delta < 0 && (deltas.conversions < -10 || deltas.clicks < -10)) {
      return "bad";
    }
    return "neutral";
  }

  if (metric === "frequency") {
    if (delta > 0 && (deltas.ctr < -10 || deltas.cpc > 10)) return "bad";
    if (delta < 0 && deltas.reach > 0) return "good";
    return "neutral";
  }

  return "neutral";
}

function matchBestArchetype(current, previous, deltas, anomalies) {
  const candidates = ARCHETYPES.map((archetype) => {
    const ctx = { current, previous, d: deltas, anomalies };
    if (!archetype.when(ctx)) return null;

    const confidence = archetype.confidence(ctx);
    const evidence = buildEvidence(archetype, current, previous, deltas);
    const anomalyScore = anomalies
      .filter((item) => item.direction === (archetype.positive ? "good" : "bad"))
      .slice(0, 3)
      .reduce((sum, item) => sum + item.score, 0);

    return {
      id: archetype.id,
      name: archetype.name,
      confidence,
      cause: archetype.cause,
      action: archetype.action,
      nextSignal: archetype.nextSignal,
      evidence,
      score: anomalyScore + archetype.severityBias + confidence.score,
      positive: Boolean(archetype.positive),
    };
  }).filter(Boolean);

  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.score - a.score)[0];
}

function buildFallbackArchetype(anomalies) {
  const top =
    anomalies.find((item) => item.direction === "bad") ||
    anomalies.find((item) => item.direction === "good") ||
    anomalies[0];

  if (!top) {
    return {
      id: "stable_performance",
      name: "Stable Performance",
      confidence: { level: "Medium", score: 12 },
      cause:
        "No material daily anomaly crossed the engine threshold in the selected campaign data.",
      action:
        "Keep the campaign running and watch for a stronger signal in the next daily comparison.",
      nextSignal:
        "CTR, CPC, CPA, and conversions should remain within normal day-to-day variance.",
      evidence: [],
      score: 12,
      positive: true,
    };
  }

  const positive = top.direction === "good";
  const neutral = top.direction === "neutral";
  const playbook = metricDecisionPlaybook(top.metric, top.direction);
  const confidence = confidenceFrom([
    Math.abs(top.delta) >= 15,
    Math.abs(top.delta) >= 30,
    top.score >= 25,
    top.direction !== "neutral",
  ]);

  return {
    id: `metric_${top.metric}_${positive ? "improvement" : neutral ? "movement" : "issue"}`,
    name: playbook.archetypeName,
    confidence,
    cause: playbook.plainReason,
    action: playbook.primaryAction,
    nextSignal: playbook.expectedResult,
    evidence: [`${top.label} ${formatSignedPercent(top.delta)}`],
    score: top.score + (positive ? 10 : 14) + confidence.score,
    positive,
    neutral,
    metric: top.metric,
    playbook,
    watchMetrics: playbook.watchMetrics,
  };
}

function buildEvidence(archetype, current, previous, deltas) {
  const evidenceMetrics = {
    creative_fatigue: ["ctr", "cpc", "frequency", "clicks"],
    audience_saturation: ["frequency", "reach", "ctr", "cpc"],
    engagement_quality_drop: ["ctr", "clicks", "impressions", "cpc"],
    aggressive_scaling: ["spend", "impressions", "cpa", "cpc"],
    conversion_funnel_breakdown: ["clicks", "ctr", "conversions", "conversionRate", "cpa"],
    auction_pressure: ["cpm", "cpc", "ctr", "impressions"],
    delivery_instability: ["spend", "impressions", "clicks", "conversions"],
    traffic_quality_drop: ["clicks", "conversions", "conversionRate", "cpa"],
    volume_loss: ["impressions", "clicks", "spend", "cpm"],
    healthy_scaling: ["spend", "conversions", "cpa", "ctr"],
  }[archetype.id] || [];

  return evidenceMetrics
    .filter((metric) => Number.isFinite(deltas[metric]))
    .map((metric) => {
      const label = METRIC_DEFINITIONS[metric].label;
      return `${label} ${formatSignedPercent(deltas[metric])} (${formatMetric(
        current[metric],
        metric,
        { currencySymbol: "" }
      )} vs ${formatMetric(previous[metric], metric, { currencySymbol: "" })})`;
    });
}

function buildSnapshot(current, previous, deltas, config) {
  return SNAPSHOT_METRICS.reduce((acc, metric) => {
    const display = buildDisplayMetrics(current, previous, deltas, config)[metric];
    acc[metric] = display.available
      ? `${display.value}${display.delta ? ` (${display.delta})` : ""}`
      : {
          value: "N/A",
          available: false,
          reason: display.reason,
        };
    return acc;
  }, {});
}

function buildKeyDelta(anomalies, selected) {
  const top = anomalies.find((item) =>
    selected.positive ? item.direction === "good" : item.direction === "bad"
  ) || anomalies[0];

  if (!top) return "No material daily anomaly detected";

  const severity = top.direction === "bad" ? severityAdjective(top.score) : "Positive";
  return `${severity} ${top.label.toLowerCase()} ${
    top.direction === "bad" ? "movement" : "improvement"
  } (${top.label} ${formatSignedPercent(top.delta)})`;
}

function estimateFinancialImpact(current, previous, deltas, selected, config) {
  const symbol = config.currencySymbol;
  const totalSpend = current.spend + previous.spend;
  const noConversions = current.conversions === 0 && previous.conversions === 0;
  const caveats = [];

  const finishImpact = (impact) => {
    const amount = Number(impact.amount || 0);
    const percentOfSpend = totalSpend > 0 ? (amount / totalSpend) * 100 : 0;
    const shouldDisplayAmount =
      amount >= config.minimumFinancialImpactAmount ||
      percentOfSpend >= config.minimumFinancialImpactPercentOfSpend;
    const displayAmount = shouldDisplayAmount
      ? `${symbol}${formatNumber(amount)}`
      : "N/A";
    const summary = shouldDisplayAmount
      ? impact.summary
      : impact.type === "unavailable"
        ? impact.summary
        : impact.type === "positive"
          ? "Opportunity detected, but monetary impact is not large enough to quantify reliably yet."
          : "Efficiency risk detected, but monetary impact is limited from available data.";

    return {
      ...impact,
      amount: round(amount, 2),
      displayAmount,
      shouldDisplayAmount,
      percentOfSpend: round(percentOfSpend, 1),
      summary,
      caveats: uniqueList([...(impact.caveats || []), ...caveats]),
    };
  };

  if (noConversions) {
    return finishImpact({
      type: "unavailable",
      amount: 0,
      currency: config.currency,
      summary: "Conversion impact cannot be confirmed because no conversions were recorded.",
      method: "No estimate because conversion denominators were unavailable.",
      caveats: ["No conversions were recorded in either compared period."],
    });
  }

  const conversionLoss = previous.conversions - current.conversions;
  const lostConversionValue =
    !noConversions && conversionLoss > 0 && previous.cpa > 0 ? conversionLoss * previous.cpa : 0;
  const extraCpaCost =
    current.cpa > previous.cpa && current.conversions > 0
      ? (current.cpa - previous.cpa) * current.conversions
      : 0;
  const extraClickCost =
    current.cpc > previous.cpc && current.clicks > 0
      ? (current.cpc - previous.cpc) * current.clicks
      : 0;
  const estimatedLoss = Math.max(lostConversionValue, extraCpaCost, extraClickCost);

  if (selected.positive) {
    const savedCpaCost =
      previous.cpa > current.cpa && current.conversions > 0
        ? (previous.cpa - current.cpa) * current.conversions
        : 0;
    const gainedConversionValue =
      current.conversions > previous.conversions && previous.cpa > 0
        ? (current.conversions - previous.conversions) * previous.cpa
        : 0;
    const gain = Math.max(savedCpaCost, gainedConversionValue);

    return finishImpact({
      type: "positive",
      amount: round(gain, 2),
      currency: config.currency,
      summary:
        gain > 0
          ? `Estimated positive efficiency impact of ${symbol}${formatNumber(gain)}.`
          : "Positive movement detected, but financial impact is not large enough to quantify reliably.",
      method:
        gain > 0
          ? "max(CPA savings on current conversions, value of incremental conversions at previous CPA)"
          : "No reliable monetary estimate from available conversion and cost data.",
    });
  }

  if (estimatedLoss > 0) {
    return finishImpact({
      type: "negative",
      amount: round(estimatedLoss, 2),
      currency: config.currency,
      summary: `Estimated efficiency loss of ${symbol}${formatNumber(
        estimatedLoss
      )} from reduced conversion output or higher traffic cost.`,
      method:
        "max(lost conversions at previous CPA, extra CPA cost on current conversions, extra CPC cost on current clicks)",
    });
  }

  const spendDelta = current.spend - previous.spend;
  return finishImpact({
    type: spendDelta > 0 && (deltas.ctr < 0 || deltas.cpc > 0) ? "negative" : "neutral",
    amount: round(Math.abs(spendDelta), 2),
    currency: config.currency,
    summary:
      spendDelta !== 0
        ? `Spend moved by ${symbol}${formatNumber(Math.abs(spendDelta))}; conversion impact cannot be reliably estimated from the available data.`
        : "No material financial impact can be estimated from the available data.",
    method:
      "Spend delta fallback because conversion and unit-cost impact were not reliable enough.",
  });
}

function buildBaselineComparison(dailyRows, currentDate, current, config) {
  const rows = Array.isArray(dailyRows)
    ? dailyRows
        .filter((row) => {
          const date = row.date_start || row.date || row.dateStop;
          return date && currentDate && date < currentDate;
        })
        .slice(-config.baselineLookbackDays)
    : [];
  const normalizedRows = rows.map((row) => normalizeMetaDailyRow(row, config));
  const baseline = buildBaselineMetrics(normalizedRows);
  const deltas = baseline
    ? Object.keys(METRIC_DEFINITIONS).reduce((acc, metric) => {
        acc[metric] = percentChange(current[metric], baseline[metric]);
        return acc;
      }, {})
    : {};
  const findings = baseline
    ? Object.entries(METRIC_DEFINITIONS)
        .map(([metric, definition]) => ({
          metric,
          label: definition.label,
          current: current[metric],
          baseline: baseline[metric],
          delta: round(deltas[metric], 1),
          direction: classifyDirection(metric, deltas[metric], deltas),
        }))
        .filter((item) => Number.isFinite(item.delta) && Math.abs(item.delta) >= 5)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 5)
    : [];
  const available = rows.length >= config.minimumDailyRowsForBaseline && Boolean(baseline);

  return {
    available,
    level: available ? "strong" : rows.length >= 2 ? "limited" : "missing",
    comparedDays: rows.length,
    requiredDays: config.minimumDailyRowsForBaseline,
    lookbackDays: config.baselineLookbackDays,
    baseline,
    deltas,
    findings,
    summary: available
      ? `Compared against a ${rows.length}-day baseline before ${currentDate}.`
      : rows.length
        ? `Only ${rows.length} baseline day${rows.length === 1 ? "" : "s"} available; use trend claims carefully.`
        : "No historical baseline is available before the current comparison day.",
  };
}

function buildBaselineMetrics(rows) {
  if (!rows.length) return null;

  const totals = rows.reduce(
    (acc, row) => {
      acc.spend += row.spend;
      acc.impressions += row.impressions;
      acc.reach += row.reach;
      acc.clicks += row.clicks;
      acc.conversions += row.conversions;
      return acc;
    },
    {
      spend: 0,
      impressions: 0,
      reach: 0,
      clicks: 0,
      conversions: 0,
      roasTotal: 0,
      roasCount: 0,
    }
  );
  for (const row of rows) {
    if (row.roas > 0) {
      totals.roasTotal += row.roas;
      totals.roasCount += 1;
    }
  }
  const days = rows.length;

  return {
    spend: round(totals.spend / days, 2),
    impressions: round(totals.impressions / days, 0),
    reach: round(totals.reach / days, 0),
    clicks: round(totals.clicks / days, 0),
    conversions: round(totals.conversions / days, 2),
    roas: round(totals.roasCount ? totals.roasTotal / totals.roasCount : 0, 2),
    frequency: round(safeDivide(totals.impressions, totals.reach), 2),
    ctr: round(safeDivide(totals.clicks * 100, totals.impressions), 2),
    cpc: round(safeDivide(totals.spend, totals.clicks), 2),
    cpm: round(safeDivide(totals.spend * 1000, totals.impressions), 2),
    cpa: round(safeDivide(totals.spend, totals.conversions), 2),
    conversionRate: round(safeDivide(totals.conversions * 100, totals.clicks), 2),
  };
}

function assessTrustLayer(
  rows,
  prepared,
  current,
  previous,
  deltas,
  baselineComparison,
  dataQuality,
  config
) {
  const metricReliability = buildMetricReliability(current, previous, config);
  const minimumThresholds = buildMinimumThresholds(current, previous, config);
  const reasons = [];
  const warnings = [];
  const reliabilityFilters = Object.entries(metricReliability)
    .filter(([, value]) => !value.usable || value.level === "low")
    .map(([metric, value]) => ({
      metric,
      label: METRIC_DEFINITIONS[metric]?.label || metric,
      level: value.level,
      usable: value.usable,
      reasons: value.reasons,
    }));
  const topDelta = Object.values(deltas).reduce(
    (max, value) => Math.max(max, Math.abs(Number(value) || 0)),
    0
  );
  let score = 100;

  if (dataQuality.level === "limited") {
    score -= 22;
    warnings.push("Data quality is limited.");
  } else if (dataQuality.level === "usable") {
    score -= 10;
    warnings.push("Data quality is usable but not perfect.");
  }

  if (!baselineComparison.available) {
    score -= baselineComparison.level === "limited" ? 10 : 18;
    warnings.push(baselineComparison.summary);
  } else {
    reasons.push(baselineComparison.summary);
  }

  if (!minimumThresholds.spend.passed) score -= 18;
  if (!minimumThresholds.impressions.passed) score -= 18;
  if (!minimumThresholds.clicks.passed) score -= 8;
  if (!minimumThresholds.conversions.passed) score -= 10;

  score -= Math.min(reliabilityFilters.length * 3, 18);

  if (topDelta >= 30) {
    score += 5;
    reasons.push("The movement is large enough to treat as a meaningful signal.");
  } else if (topDelta < 10) {
    score -= 8;
    warnings.push("The detected movement is small, so the recommendation should be treated as lighter guidance.");
  }

  const boundedScore = Math.max(0, Math.min(100, round(score, 0)));
  const level = boundedScore >= 80 ? "high" : boundedScore >= 55 ? "medium" : "low";

  if (level === "high") {
    reasons.unshift("The recommendation is supported by enough delivery volume and usable metric data.");
  } else if (level === "medium") {
    reasons.unshift("The recommendation is usable, but should be checked against the listed caveats.");
  } else {
    reasons.unshift("Treat this as a cautionary signal, not a final optimization decision.");
  }

  return {
    level,
    score: boundedScore,
    reasons,
    warnings,
    minimumThresholds,
    metricReliability,
    reliabilityFilters,
    baseline: {
      level: baselineComparison.level,
      available: baselineComparison.available,
      comparedDays: baselineComparison.comparedDays,
      requiredDays: baselineComparison.requiredDays,
      summary: baselineComparison.summary,
    },
    rowCoverage: {
      inputRows: Array.isArray(rows) ? rows.length : 0,
      filteredRows: prepared.inputRowCount,
      aggregatedDailyRows: prepared.dailyRowCount,
    },
  };
}

function buildMinimumThresholds(current, previous, config) {
  const spend = current.spend + previous.spend;
  const impressions = current.impressions + previous.impressions;
  const clicks = current.clicks + previous.clicks;
  const conversions = current.conversions + previous.conversions;

  return {
    spend: {
      passed: current.spend >= config.minimumSpendForInsight || previous.spend >= config.minimumSpendForInsight,
      current: current.spend,
      previous: previous.spend,
      required: config.minimumSpendForInsight,
    },
    impressions: {
      passed:
        current.impressions >= config.minimumImpressionsForInsight ||
        previous.impressions >= config.minimumImpressionsForInsight,
      current: current.impressions,
      previous: previous.impressions,
      required: config.minimumImpressionsForInsight,
    },
    clicks: {
      passed: clicks >= config.minimumClicksForRateInsight,
      total: clicks,
      required: config.minimumClicksForRateInsight,
    },
    conversions: {
      passed: conversions >= config.minimumConversionsForConversionInsight,
      total: conversions,
      required: config.minimumConversionsForConversionInsight,
    },
    totalSpend: round(spend, 2),
    totalImpressions: impressions,
  };
}

function buildMetricReliability(current, previous, config) {
  return Object.keys(METRIC_DEFINITIONS).reduce((acc, metric) => {
    acc[metric] = metricReliability(metric, current, previous, config);
    return acc;
  }, {});
}

function metricReliability(metric, current, previous, config) {
  const reasons = [];
  const clicks = current.clicks + previous.clicks;
  const impressions = current.impressions + previous.impressions;
  const conversions = current.conversions + previous.conversions;
  const spend = current.spend + previous.spend;
  let level = "high";
  let usable = true;
  let scoreMultiplier = 1;

  if (current[metric] === 0 && previous[metric] === 0) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("No usable value was present for this metric in either compared period.");
  }

  if (["ctr", "cpc", "clicks"].includes(metric) && clicks < config.minimumClicksForRateInsight) {
    level = downgradeReliability(level);
    scoreMultiplier = Math.min(scoreMultiplier, 0.55);
    reasons.push(`Click volume is below ${config.minimumClicksForRateInsight}, so traffic-rate signals are weaker.`);
  }

  if (metric === "cpc" && (current.clicks === 0 || previous.clicks === 0)) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("CPC cannot be compared reliably because one period had zero clicks.");
  }

  if (metric === "ctr" && (current.impressions === 0 || previous.impressions === 0)) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("CTR cannot be compared reliably because one period had zero impressions.");
  }

  if (["cpm", "ctr", "impressions", "reach", "frequency"].includes(metric) && impressions < config.minimumImpressionsForInsight * 2) {
    level = downgradeReliability(level);
    scoreMultiplier = Math.min(scoreMultiplier, 0.65);
    reasons.push(`Impression volume is below ${config.minimumImpressionsForInsight * 2}, so delivery signals are weaker.`);
  }

  if (metric === "cpm" && (current.impressions === 0 || previous.impressions === 0)) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("CPM cannot be compared reliably because one period had zero impressions.");
  }

  if (metric === "frequency" && (current.reach === 0 || previous.reach === 0)) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("Frequency cannot be compared reliably because one period had zero reach.");
  }

  if (["conversions", "cpa", "conversionRate", "roas"].includes(metric) && conversions < config.minimumConversionsForConversionInsight) {
    level = downgradeReliability(level);
    scoreMultiplier = Math.min(scoreMultiplier, 0.45);
    reasons.push(`Conversion volume is below ${config.minimumConversionsForConversionInsight}, so conversion signals are weaker.`);
  }

  if (metric === "roas" && current.roas === 0 && previous.roas === 0) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("ROAS cannot be compared because purchase value or ROAS data was not available.");
  }

  if (metric === "cpa" && (current.conversions === 0 || previous.conversions === 0)) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("CPA cannot be compared reliably because one period had zero conversions.");
  }

  if (metric === "conversionRate" && (current.clicks === 0 || previous.clicks === 0)) {
    usable = false;
    level = "unusable";
    scoreMultiplier = 0;
    reasons.push("Conversion rate cannot be compared reliably because one period had zero clicks.");
  }

  if (["spend", "cpc", "cpm", "cpa"].includes(metric) && spend < config.minimumSpendForInsight * 2) {
    level = downgradeReliability(level);
    scoreMultiplier = Math.min(scoreMultiplier, 0.65);
    reasons.push(`Spend is below ${config.minimumSpendForInsight * 2}, so cost signals are weaker.`);
  }

  if (level === "high" && reasons.length) level = "medium";
  if (level === "unusable") usable = false;

  return {
    level,
    usable,
    scoreMultiplier,
    reasons,
  };
}

function downgradeReliability(level) {
  if (level === "unusable") return "unusable";
  if (level === "low") return "low";
  if (level === "medium") return "low";
  return "medium";
}

function applyTrustToSelection(selected, trustLayer) {
  const confidenceCap =
    trustLayer.level === "high" ? 24 : trustLayer.level === "medium" ? 16 : 8;
  const confidenceScore = Math.min(selected.confidence.score, confidenceCap);
  const confidence =
    confidenceScore >= 20
      ? { level: "High", score: confidenceScore }
      : confidenceScore >= 12
        ? { level: "Medium", score: confidenceScore }
        : { level: "Low", score: confidenceScore };
  const scoreMultiplier =
    trustLayer.level === "high" ? 1 : trustLayer.level === "medium" ? 0.9 : 0.72;

  return {
    ...selected,
    confidence,
    originalConfidence: selected.confidence,
    score: round(selected.score * scoreMultiplier, 1),
    trustLevel: trustLayer.level,
  };
}

function formatPeriodLabel(periodValue) {
  if (periodValue === null || periodValue === undefined || periodValue === "") {
    return "Unknown period";
  }

  if (typeof periodValue === "string" || typeof periodValue === "number") {
    return String(periodValue);
  }

  if (periodValue instanceof Date) {
    return periodValue.toISOString().slice(0, 10);
  }

  if (typeof periodValue === "object") {
    if (periodValue.label) return String(periodValue.label);

    const start = periodValue.start || periodValue.date_start || periodValue.dateStart;
    const end = periodValue.end || periodValue.date_stop || periodValue.dateStop;

    if (start && end && start !== end) return `${start} to ${end}`;
    if (start || end) return String(start || end);
  }

  return "Unknown period";
}

function extractReportGoal(input, context, config) {
  const reportGoal =
    input?.reportGoal ||
    input?.context?.reportGoal ||
    context?.reportGoal ||
    config.reportGoal ||
    null;

  if (!reportGoal || typeof reportGoal !== "object") return null;

  return {
    objective: reportGoal.objective || null,
    primaryKpi: reportGoal.primaryKpi || reportGoal.primary_kpi || null,
    targetValue:
      reportGoal.targetValue === null || reportGoal.targetValue === undefined
        ? null
        : number(reportGoal.targetValue),
    targetDirection: reportGoal.targetDirection || reportGoal.target_direction || null,
    currency: reportGoal.currency || config.currency,
  };
}

function extractPreviousNarrative(input, context) {
  return input?.previousNarrative || input?.context?.previousNarrative || context?.previousNarrative || null;
}

function buildDecisionType(selected, reportGoal = null) {
  const directMap = {
    creative_fatigue: "creative_action",
    engagement_quality_drop: "creative_action",
    audience_saturation: "audience_action",
    aggressive_scaling: "budget_action",
    conversion_funnel_breakdown: "funnel_or_tracking_action",
    auction_pressure: "budget_action",
    delivery_instability: "delivery_issue",
    volume_loss: "delivery_issue",
    healthy_scaling: "opportunity",
    stable_performance: "monitor_only",
    data_issue: "data_issue",
  };
  let id = directMap[selected.id] || null;

  if (!id && selected.id === "traffic_quality_drop") {
    const objective = String(reportGoal?.objective || "").toLowerCase();
    id = ["leads", "purchases"].includes(objective)
      ? "funnel_or_tracking_action"
      : "audience_action";
  }

  if (!id && selected.positive) id = "opportunity";
  if (!id && selected.metric) {
    if (["ctr", "cpc"].includes(selected.metric)) id = "creative_action";
    else if (["cpa", "conversionRate", "conversions", "roas"].includes(selected.metric)) {
      id = "funnel_or_tracking_action";
    } else if (["impressions", "reach", "frequency", "cpm"].includes(selected.metric)) {
      id = "delivery_issue";
    } else id = "monitor_only";
  }
  if (!id) id = "monitor_only";

  const definitions = {
    creative_action: {
      label: "Creative Action",
      description: "The recommendation is to improve ad message or creative before changing budget.",
    },
    audience_action: {
      label: "Audience Action",
      description: "The recommendation is to review audience freshness, overlap, or targeting quality.",
    },
    budget_action: {
      label: "Budget Action",
      description: "The recommendation is to control budget pressure until efficiency stabilizes.",
    },
    funnel_or_tracking_action: {
      label: "Funnel or Tracking Action",
      description: "The recommendation is to verify post-click performance, offer, landing page, or tracking.",
    },
    delivery_issue: {
      label: "Delivery Issue",
      description: "The recommendation is to verify delivery, pacing, bids, approvals, or account constraints.",
    },
    monitor_only: {
      label: "Monitor Only",
      description: "The data does not support a strong optimization change yet.",
    },
    opportunity: {
      label: "Opportunity",
      description: "Performance improved enough to protect or scale carefully.",
    },
    data_issue: {
      label: "Data Issue",
      description: "The data is not reliable enough for campaign optimization decisions.",
    },
  };

  return {
    id,
    ...definitions[id],
  };
}

function assessTrustGate({
  current,
  previous,
  trustLayer,
  dataQuality,
  baselineComparison,
  topContributor,
  selected,
  decisionType,
  comparisonMode,
  disclaimer,
  config,
}) {
  const totalSpend = current.spend + previous.spend;
  const totalClicks = current.clicks + previous.clicks;
  const totalConversions = current.conversions + previous.conversions;
  const reasons = [];
  const caveats = [];
  const flags = {
    dataWindowMismatch:
      comparisonMode === "historical_fallback" ||
      Boolean(disclaimer) ||
      dataQuality?.warnings?.some((warning) =>
        /scheduled|fallback|window|latest available|stale/i.test(String(warning))
      ),
    lowSpend: totalSpend < config.minimumSpendForStrongDecision,
    lowClicks: totalClicks < config.minimumClicksForRateInsight,
    noConversions: totalConversions === 0,
    noBaseline: !baselineComparison?.available,
    noAdLevelData: !topContributor?.available,
  };
  let level = trustLayer?.level || "medium";
  let actionability = userUrgency(selected.score, selected.positive);
  let blocked = false;
  let primaryActionOverride = null;
  let severityCap = null;
  let decisionTypeOverride = null;

  if (flags.dataWindowMismatch) {
    blocked = true;
    level = "low";
    actionability = "fix_data";
    severityCap = "medium";
    decisionTypeOverride = "data_issue";
    reasons.push("Data window mismatch: the scheduled report window did not contain usable delivery.");
    caveats.push("Latest available data may be stale relative to the scheduled report window.");
    primaryActionOverride = "Fix the Meta delivery date window, verify delivery, and rerun the report before optimizing campaigns.";
  }

  if (flags.lowSpend) {
    level = downgradeTrustGateLevel(level);
    if (!blocked) actionability = "monitor";
    severityCap = severityCap || "medium";
    reasons.push(`Spend is below ${config.currencySymbol}${formatNumber(config.minimumSpendForStrongDecision)}, so optimization confidence is limited.`);
    caveats.push("Spend is too low for a strong campaign-change recommendation.");
    primaryActionOverride = primaryActionOverride || "Monitor only until spend is high enough to support a reliable decision.";
  }

  if (flags.lowClicks) {
    level = downgradeTrustGateLevel(level);
    if (!blocked && ["creative_action", "audience_action", "budget_action"].includes(decisionType.id)) {
      actionability = "monitor";
    }
    reasons.push(`Click volume is below ${config.minimumClicksForRateInsight}, so CTR/CPC claims are weaker.`);
    caveats.push("CTR and CPC movement may be noisy because click volume is low.");
  }

  if (flags.noConversions) {
    if (["funnel_or_tracking_action", "budget_action"].includes(decisionType.id)) {
      level = downgradeTrustGateLevel(level);
    }
    reasons.push("No conversions were recorded in either period.");
    caveats.push("CPA, ROAS, and conversion impact cannot be confirmed from this report.");
  }

  if (flags.noBaseline) {
    if (level === "high") level = "medium";
    caveats.push("Historical baseline is missing or limited, so trend language should be treated as an early signal.");
  }

  if (flags.noAdLevelData && ["creative_action", "audience_action"].includes(decisionType.id)) {
    if (!blocked) actionability = actionability === "act_today" ? "review_today" : actionability;
    caveats.push("Ad-level data was not included, so the engine cannot identify a specific ad to pause or edit.");
    primaryActionOverride =
      primaryActionOverride ||
      "Break the campaign down by ad before making creative or audience changes.";
  }

  if (selected.positive && level === "low") {
    actionability = "monitor";
    caveats.push("Opportunity language is capped because reliability is low.");
  }

  return {
    level,
    actionability,
    blocked,
    reasons: uniqueList(reasons),
    caveats: uniqueList(caveats).slice(0, 5),
    flags,
    severityCap,
    decisionTypeOverride,
    primaryActionOverride,
  };
}

function downgradeTrustGateLevel(level) {
  if (level === "high") return "medium";
  return "low";
}

function applyTrustGateToSelection(selected, trustGate, decisionType, topContributor) {
  if (!trustGate) return selected;

  if (trustGate.decisionTypeOverride === "data_issue") {
    return {
      ...selected,
      id: "data_issue",
      name: "Data Window Mismatch",
      positive: false,
      confidence: { level: "Low", score: Math.min(selected.confidence?.score || 8, 8) },
      score: Math.min(selected.score || 20, 35),
      cause:
        "The scheduled report window did not contain usable delivery, so campaign optimization advice would be unreliable.",
      action: trustGate.primaryActionOverride,
      nextSignal: "The next report should show delivery in the expected scheduled period.",
      playbook: {
        decision: "fix_data_window",
        label: "Fix data window before optimizing",
        timeframe: "Before campaign changes",
        primaryAction: trustGate.primaryActionOverride,
        secondaryAction: "Check Meta date ranges, account delivery, permissions, and selected campaigns.",
        doNotDo: "Do not make campaign optimization decisions from stale or mismatched data.",
        plainReason: "The report used data outside the expected delivery window.",
        expectedResult: "The report uses the scheduled period with real delivery.",
        ifNoImprovement: "If the scheduled period still has no delivery, inspect campaign status, spend limits, and Meta permissions.",
        owner: "Developer or account owner",
        checklist: [
          "Verify the scheduled current and previous date windows.",
          "Confirm Meta returned delivery for those windows.",
          "Rerun the report after fixing the date window.",
        ],
      },
    };
  }

  if (trustGate.flags?.lowSpend) {
    return {
      ...selected,
      id: selected.id === "healthy_scaling" ? "stable_performance" : selected.id,
      name: selected.positive ? "Early Opportunity Signal" : selected.name,
      confidence: {
        level: selected.confidence?.level === "High" ? "Medium" : selected.confidence?.level || "Low",
        score: Math.min(selected.confidence?.score || 8, 12),
      },
      score: Math.min(selected.score || 30, selected.positive ? 35 : 45),
      action: trustGate.primaryActionOverride || selected.action,
      cause: `${selected.cause} Spend is still below the strong-decision threshold, so this should be treated as a monitor-only signal.`,
    };
  }

  if (trustGate.flags?.noAdLevelData && ["creative_action", "audience_action"].includes(decisionType.id)) {
    return {
      ...selected,
      action: trustGate.primaryActionOverride || selected.action,
      cause: `${selected.cause} Ad-level data was not included, so the exact responsible ad cannot be identified yet.`,
      nextSignal: topContributor?.recommendedAction || selected.nextSignal,
    };
  }

  return selected;
}

function buildTopContributor(segments, adDiagnostics, selected, config) {
  const candidate =
    adDiagnostics.fixFirst ||
    (selected.positive ? adDiagnostics.protect : null) ||
    adDiagnostics.all?.[0] ||
    null;
  const hasRealAd = candidate?.adName && candidate.adName !== "Unknown ad";

  if (!candidate || !hasRealAd) {
    return {
      available: false,
      level: null,
      name: null,
      contributionSummary:
        "Ad-level data was not included, so the engine can only diagnose campaign-level movement.",
      recommendedAction: "Break this campaign down by ad before making creative changes.",
      evidence: [],
    };
  }

  const level = candidate.adName ? "ad" : candidate.adsetName ? "adset" : "campaign";
  const name = candidate.adName || candidate.adsetName || candidate.campaignName;
  const evidence = (candidate.reasons || []).slice(0, 4);

  return {
    available: true,
    level,
    name,
    contributionSummary:
      evidence[0] || `${name} had the largest measurable contribution in the latest comparison.`,
    recommendedAction: candidate.action || actionForUnderperformingAd(selected),
    evidence,
    metrics: {
      current: candidate.current || {},
      previous: candidate.previous || {},
      deltas: candidate.deltas || {},
    },
  };
}

function isMetricAvailable(metric, current, previous = null) {
  const context = current || {};
  const compare = previous || {};

  if (metric === "cpa") {
    return context.conversions > 0 && Number.isFinite(context.cpa) && context.cpa > 0;
  }
  if (metric === "roas") {
    return Number.isFinite(context.roas) && context.roas > 0;
  }
  if (metric === "conversionRate") {
    return context.clicks > 0 && context.conversions > 0 && Number.isFinite(context.conversionRate);
  }
  if (metric === "cpc") {
    return context.clicks > 0 && Number.isFinite(context.cpc) && context.cpc > 0;
  }
  if (metric === "ctr") {
    return context.impressions > 0 && Number.isFinite(context.ctr);
  }
  if (metric === "cpm") {
    return context.impressions > 0 && Number.isFinite(context.cpm) && context.cpm > 0;
  }
  if (metric === "frequency") {
    return context.reach > 0 && context.impressions > 0 && Number.isFinite(context.frequency);
  }
  if (metric === "conversions") {
    return Number.isFinite(context.conversions);
  }

  return Number.isFinite(context[metric]) || Number.isFinite(compare[metric]);
}

function unavailableMetricReason(metric, context = {}) {
  if (metric === "cpa") return "No conversions recorded.";
  if (metric === "roas") return "No purchase value or ROAS was available.";
  if (metric === "conversionRate") {
    if (context.clicks === 0) return "No clicks recorded.";
    return "No conversions recorded.";
  }
  if (metric === "cpc") return "No clicks recorded.";
  if (metric === "ctr" || metric === "cpm") return "No impressions recorded.";
  if (metric === "frequency") return "Reach was unavailable or zero.";
  return "Metric was unavailable.";
}

function formatMetricSafe(value, metric, context, config) {
  if (!isMetricAvailable(metric, context)) {
    return {
      value: "N/A",
      available: false,
      reason: unavailableMetricReason(metric, context),
    };
  }

  return {
    value: formatMetric(value, metric, config),
    available: true,
    reason: null,
  };
}

function buildDisplayMetrics(current, previous, deltas, config) {
  return Object.keys(METRIC_DEFINITIONS).reduce((acc, metric) => {
    const currentSafe = formatMetricSafe(current[metric], metric, current, config);
    const previousSafe = formatMetricSafe(previous[metric], metric, previous, config);
    const deltaAvailable = currentSafe.available && previousSafe.available;

    acc[metric] = {
      label: METRIC_DEFINITIONS[metric].label,
      value: currentSafe.value,
      previousValue: previousSafe.value,
      delta: deltaAvailable ? formatSignedPercent(deltas[metric]) : null,
      deltaValue: deltaAvailable ? round(deltas[metric], 1) : null,
      available: currentSafe.available,
      reason: currentSafe.reason || (!previousSafe.available ? previousSafe.reason : null),
    };
    return acc;
  }, {});
}

function buildReportGoalAssessment(reportGoal, current, previous, displayMetrics, config) {
  if (!reportGoal) {
    return {
      available: false,
      objective: null,
      primaryKpi: null,
      targetSummary: null,
      assessment: "No report goal was provided, so the narrator used general Meta performance signals.",
    };
  }

  const primaryMetric = metricKeyFromKpi(reportGoal.primaryKpi);
  const metric = primaryMetric ? displayMetrics[primaryMetric] : null;
  const targetSummary =
    reportGoal.primaryKpi && reportGoal.targetValue !== null
      ? `${reportGoal.primaryKpi} target: ${reportGoal.targetDirection || "near"} ${formatMetric(reportGoal.targetValue, primaryMetric || "spend", {
          ...config,
          currencySymbol: `${reportGoal.currency || config.currency} `,
        })}`
      : null;
  let assessment = `Objective context: ${reportGoal.objective || "not specified"}.`;

  if (metric) {
    assessment = metric.available
      ? `${reportGoal.primaryKpi} is currently ${metric.value}${metric.delta ? ` (${metric.delta})` : ""}.`
      : `${reportGoal.primaryKpi} cannot be judged yet: ${metric.reason}`;
  }

  return {
    available: true,
    objective: reportGoal.objective || null,
    primaryKpi: reportGoal.primaryKpi || null,
    targetSummary,
    assessment,
  };
}

function metricKeyFromKpi(kpi = "") {
  const normalized = String(kpi || "").toLowerCase();
  const map = {
    cpa: "cpa",
    cpl: "cpa",
    roas: "roas",
    ctr: "ctr",
    cpc: "cpc",
    conversions: "conversions",
    clicks: "clicks",
  };
  return map[normalized] || null;
}

function buildFollowUp(previousNarrative, current, previous, deltas, displayMetrics) {
  if (!previousNarrative) {
    return {
      available: false,
      previousDecision: null,
      status: "inconclusive",
      summary: "",
      escalation: null,
    };
  }

  const previousDecision =
    previousNarrative.decision ||
    previousNarrative.userInsight?.decisionBrief?.primaryAction ||
    previousNarrative.userInsight?.decisionBrief?.decision ||
    null;
  const primaryMetric =
    metricKeyFromKpi(previousNarrative.primaryMetric) ||
    metricKeyFromKpi(previousNarrative.userInsight?.decisionBrief?.mainMetric?.label) ||
    Object.entries(displayMetrics)
      .filter(([, metric]) => metric.deltaValue !== null)
      .sort((a, b) => Math.abs(b[1].deltaValue) - Math.abs(a[1].deltaValue))[0]?.[0] ||
    null;

  if (!primaryMetric || !Number.isFinite(deltas[primaryMetric])) {
    return {
      available: true,
      previousDecision,
      status: "inconclusive",
      summary: "Previous recommendation could not be evaluated because the watched metric is unavailable.",
      escalation: null,
    };
  }

  const direction = classifyDirection(primaryMetric, deltas[primaryMetric], deltas);
  const status = direction === "good" ? "improved" : direction === "bad" ? "worsened" : "unchanged";
  const label = METRIC_DEFINITIONS[primaryMetric]?.label || primaryMetric;

  return {
    available: true,
    previousDecision,
    status,
    summary:
      status === "improved"
        ? `Previous signal improved. ${label} moved in the right direction.`
        : status === "worsened"
          ? `Previous recommendation has not worked yet. ${label} weakened again.`
          : `Previous signal is mostly unchanged. ${label} did not move enough to confirm improvement.`,
    escalation:
      status === "worsened"
        ? "Move from a light optimization to isolating the responsible segment before changing budget."
        : null,
  };
}

function assessDataQuality(rows, prepared, current, previous, config) {
  const allRows = Array.isArray(rows) ? rows : [];
  const datedRows = allRows.filter(hasDailyDate);
  const missingFields = ["spend", "impressions", "clicks"].filter(
    (field) => current[field] === 0 && previous[field] === 0
  );
  const warnings = [];

  if (prepared.dailyRowCount < 3) {
    warnings.push("Only two daily periods are available, so trend context is limited.");
  }

  if (missingFields.length) {
    warnings.push(`Missing or zero core metrics: ${missingFields.join(", ")}.`);
  }

  if (current.conversions === 0 && previous.conversions === 0) {
    warnings.push(
      "No conversion signal was found. CPA and conversion-rate recommendations are limited."
    );
  }

  if (config.excludeToday) {
    warnings.push(
      `Today was excluded in ${config.timeZone || "UTC"} to avoid partial-day reporting noise.`
    );
  }

  return {
    level: warnings.length >= 2 ? "limited" : warnings.length ? "usable" : "strong",
    inputRows: allRows.length,
    datedRows: datedRows.length,
    aggregatedDailyRows: prepared.dailyRowCount,
    comparedRows: 2,
    minimumSpendForInsight: config.minimumSpendForInsight,
    minimumImpressionsForInsight: config.minimumImpressionsForInsight,
    warnings,
  };
}

function buildOperationalDataQuality(input, current, previous, config) {
  const warnings = [];
  const rawRows = Array.isArray(input.rawRows) ? input.rawRows : [];
  const missingFields = ["spend", "impressions", "clicks"].filter(
    (field) => current[field] === 0 && previous[field] === 0
  );

  if (missingFields.length) {
    warnings.push(`Missing or zero core metrics: ${missingFields.join(", ")}.`);
  }

  if (current.conversions === 0 && previous.conversions === 0) {
    warnings.push(
      "No conversion signal was found. CPA, ROAS, and conversion-rate recommendations are limited."
    );
  }

  if (rawRows.length === 0) {
    warnings.push("The comparison used pre-aggregated period metrics.");
  }

  if (input.disclaimer) {
    warnings.push(input.disclaimer);
  }

  if (input.mode === "historical_fallback" || input.period?.source === "historical_fallback") {
    warnings.push("Latest data is stale relative to the scheduled report window.");
  }

  return {
    level: warnings.length >= 2 ? "limited" : warnings.length ? "usable" : "strong",
    inputRows: rawRows.length,
    datedRows: rawRows.filter(hasDailyDate).length,
    aggregatedDailyRows: input.periodRowCount || 2,
    comparedRows: 2,
    minimumSpendForInsight: config.minimumSpendForInsight,
    minimumImpressionsForInsight: config.minimumImpressionsForInsight,
    warnings,
  };
}

function buildOperationalBaselineComparison(input) {
  return {
    available: Boolean(input.baseline?.available),
    level: input.baseline?.level || "missing",
    comparedDays: input.baseline?.comparedDays || 0,
    requiredDays: input.baseline?.requiredDays || 0,
    lookbackDays: input.baseline?.lookbackDays || 0,
    baseline: input.baseline?.metrics || null,
    deltas: input.baseline?.deltas || {},
    findings: input.baseline?.findings || [],
    summary:
      input.baseline?.summary ||
      "No historical baseline was passed into this period comparison.",
  };
}

function buildExecutiveSummary(
  current,
  previous,
  deltas,
  selected,
  financialImpact,
  config
) {
  const movement = selected.positive ? "improved" : "weakened";
  const topSignals = [
    ["spend", "Spend"],
    ["ctr", "CTR"],
    ["cpc", "CPC"],
    ["conversions", "Conversions"],
    ["cpa", "CPA"],
  ]
    .filter(([metric]) => Number.isFinite(deltas[metric]) && Math.abs(deltas[metric]) >= 5)
    .map(([metric, label]) => `${label} ${formatSignedPercent(deltas[metric])}`)
    .slice(0, 3);

  const amount =
    financialImpact.shouldDisplayAmount && financialImpact.amount > 0
      ? ` Estimated impact: ${financialImpact.displayAmount}.`
      : "";

  return `${selected.name}: performance ${movement} versus ${previous.date}. ${
    topSignals.length ? topSignals.join(", ") : "Core metrics were mostly stable"
  }. ${selected.action}${amount}`;
}

function buildUserInsight(
  current,
  previous,
  deltas,
  anomalies,
  selected,
  financialImpact,
  adDiagnostics,
  trustLayer,
  trustGate,
  decisionType,
  topContributor,
  reportGoalAssessment,
  config
) {
  const topBad = anomalies.find((item) => item.direction === "bad");
  const topGood = anomalies.find((item) => item.direction === "good");
  const primary = selected.positive ? topGood || anomalies[0] : topBad || anomalies[0];
  const impactText = formatImpactForUser(financialImpact, config);
  const whatHappened = buildWhatHappened(deltas, primary, selected);
  const decisionBrief = buildDecisionBrief(
    current,
    previous,
    deltas,
    selected,
    primary,
    financialImpact,
    topContributor.available ? adDiagnostics.fixFirst : null,
    trustGate,
    decisionType,
    topContributor,
    config
  );

  return {
    headline: buildUserHeadline(selected, primary),
    plainSummary: buildPlainSummary(current, previous, deltas, selected, impactText),
    decisionBrief,
    trust: buildUserTrustSummary(trustLayer),
    trustGate,
    decisionType,
    topContributor,
    reportGoalAssessment,
    whatHappened,
    simpleDiagnosis: buildSimpleDiagnosis(selected, primary, whatHappened),
    plainEnglishEvidence: buildPlainEnglishEvidence(anomalies, selected),
    whyItMatters: buildWhyItMatters(selected, financialImpact, config),
    adToFixFirst: topContributor.available ? adDiagnostics.fixFirst : null,
    adToProtect: topContributor.available ? adDiagnostics.protect : null,
    adsToWatch: topContributor.available ? adDiagnostics.watch : [],
    whatToDoNext: buildUserNextSteps(selected, deltas, adDiagnostics.fixFirst),
    watchNext: buildWatchNext(selected, anomalies),
    confidence: selected.confidence.level,
    urgency: trustGate?.actionability || userUrgency(selected.score, selected.positive),
  };
}

function buildDecisionBrief(
  current,
  previous,
  deltas,
  selected,
  primary,
  financialImpact,
  fixFirstAd,
  trustGate,
  decisionType,
  topContributor,
  config
) {
  const playbook = decisionPlaybook(selected.id, selected);
  const focusName = fixFirstAd?.adName || null;
  const action = trustGate?.primaryActionOverride || (focusName
    ? `${playbook.primaryAction} Start with "${focusName}".`
    : playbook.primaryAction);
  const impact = formatDecisionImpact(financialImpact, config);

  return {
    decision: playbook.decision,
    label: playbook.label,
    decisionType,
    urgency: trustGate?.actionability || userUrgency(selected.score, selected.positive),
    timeframe: playbook.timeframe,
    primaryAction: action,
    secondaryAction: playbook.secondaryAction,
    doNotDo: buildDoNotDo(playbook, trustGate, decisionType),
    plainReason: playbook.plainReason,
    expectedResult: playbook.expectedResult,
    ifNoImprovement: playbook.ifNoImprovement,
    owner: playbook.owner,
    impact,
    confidence: selected.confidence.level,
    mainMetric: primary
      ? {
          label: primary.label,
          change: formatSignedPercent(primary.delta),
          plainChange: `${movementVerb(primary.metric, primary.delta)} by ${formatAbsolutePercent(primary.delta)}`,
        }
      : null,
    comparedWith: previous.date,
    currentDate: current.date,
    actionChecklist: buildActionChecklist(selected, deltas, fixFirstAd, trustGate, topContributor),
  };
}

function buildUserTrustSummary(trustLayer) {
  return {
    level: trustLayer.level,
    score: trustLayer.score,
    summary: trustLayer.reasons[0] || "Recommendation reliability was assessed from available data.",
    caveats: trustLayer.warnings.slice(0, 3),
    filteredSignals: trustLayer.reliabilityFilters.slice(0, 3).map((item) => ({
      metric: item.label,
      reason: item.reasons[0] || "Signal reliability is limited.",
    })),
    baseline: trustLayer.baseline,
  };
}

function decisionPlaybook(id, selected = {}) {
  if (selected.playbook) return selected.playbook;

  const playbooks = {
    creative_fatigue: {
      decision: "refresh_creative",
      label: "Refresh the weakest creative",
      timeframe: "Today",
      primaryAction: "Pause or reduce the weakest ad and launch 2-3 fresh creative variations.",
      secondaryAction: "Keep the audience and budget stable while the new creative gathers signal.",
      doNotDo: "Do not increase budget into the same tired creative.",
      plainReason: "People are responding less, and each click is becoming more expensive.",
      expectedResult: "CTR should improve first; CPC should start easing within 48-72 hours.",
      ifNoImprovement: "If CTR does not recover after 2-3 days, test a new audience angle as well.",
      owner: "Creative or campaign manager",
    },
    audience_saturation: {
      decision: "refresh_audience",
      label: "Give the campaign a fresher audience",
      timeframe: "Today",
      primaryAction: "Expand the audience or rotate exclusions so the ads reach fresh people.",
      secondaryAction: "Reduce budget pressure if frequency keeps climbing.",
      doNotDo: "Do not keep pushing more spend into the same small audience.",
      plainReason: "The same people are likely seeing the ads too often, so response quality is weakening.",
      expectedResult: "Reach should grow and frequency should slow before costs improve.",
      ifNoImprovement: "If reach stays flat, check audience size, exclusions, and delivery limits.",
      owner: "Media buyer",
    },
    engagement_quality_drop: {
      decision: "fix_message_fit",
      label: "Fix the ad message before changing budget",
      timeframe: "Today",
      primaryAction: "Rewrite the hook and refresh the visual angle on the ad with the weakest engagement.",
      secondaryAction: "Keep targeting stable so the creative test is clean.",
      doNotDo: "Do not solve this by increasing spend.",
      plainReason: "The ads are being shown, but fewer people care enough to click.",
      expectedResult: "CTR and clicks should recover while CPM can remain stable.",
      ifNoImprovement: "If CTR stays weak, test a stronger offer or a different audience promise.",
      owner: "Creative or marketing lead",
    },
    aggressive_scaling: {
      decision: "hold_scale",
      label: "Hold the scale-up",
      timeframe: "Today",
      primaryAction: "Stop additional budget increases and hold the campaign at the current or previous budget.",
      secondaryAction: "Only resume scaling after CPA or CPC stabilizes.",
      doNotDo: "Do not keep raising budget while efficiency is getting worse.",
      plainReason: "Spend grew faster than the campaign could absorb profitably.",
      expectedResult: "CPA or CPC should flatten in the next completed comparison period.",
      ifNoImprovement: "If costs keep rising tomorrow, step budget back to the last stable level.",
      owner: "Media buyer or founder",
    },
    conversion_funnel_breakdown: {
      decision: "check_post_click",
      label: "Check what happens after the click",
      timeframe: "Today",
      primaryAction: "Test the landing page, lead form, checkout, and tracking before changing ads.",
      secondaryAction: "Compare Meta clicks with website sessions and form starts.",
      doNotDo: "Do not pause all ads until you confirm the website or tracking is healthy.",
      plainReason: "People are still clicking, but fewer are becoming leads or purchases.",
      expectedResult: "Conversion rate should recover while CTR and CPC stay mostly stable.",
      ifNoImprovement: "If tracking is clean, inspect offer, pricing, page speed, and form friction.",
      owner: "Website, CRM, or growth owner",
    },
    auction_pressure: {
      decision: "avoid_expensive_auction",
      label: "Avoid scaling into expensive auctions",
      timeframe: "Today",
      primaryAction: "Hold budget and compare CPM by placement, audience, and geography.",
      secondaryAction: "Move small test budget toward lower-cost segments only if lead quality holds.",
      doNotDo: "Do not scale while auctions are more expensive.",
      plainReason: "Buying attention became more expensive even though engagement did not collapse.",
      expectedResult: "CPM should fall before CPC improves materially.",
      ifNoImprovement: "If CPM stays high, shift testing to cheaper placements or broader audiences.",
      owner: "Media buyer",
    },
    delivery_instability: {
      decision: "stabilize_delivery",
      label: "Stabilize delivery before judging performance",
      timeframe: "Next completed day",
      primaryAction: "Review recent edits, approvals, budget changes, bid strategy, and learning status.",
      secondaryAction: "Wait for one more completed day before making a large creative or budget decision.",
      doNotDo: "Do not overreact to one unstable delivery day.",
      plainReason: "The campaign changed too much operationally to make a clean performance call.",
      expectedResult: "Spend and impressions should stabilize before KPI movement becomes reliable.",
      ifNoImprovement: "If delivery stays unstable, look for account limits, rejected ads, or bid constraints.",
      owner: "Media buyer",
    },
    traffic_quality_drop: {
      decision: "cut_low_quality_traffic",
      label: "Cut the traffic that is not converting",
      timeframe: "Today",
      primaryAction: "Break down clicks by placement, device, geo, and audience, then reduce spend from weak segments.",
      secondaryAction: "Protect segments that still create qualified leads or purchases.",
      doNotDo: "Do not celebrate higher clicks if conversions are not following.",
      plainReason: "The campaign attracted more traffic, but that traffic was less likely to convert.",
      expectedResult: "Conversion rate should improve before total conversions scale again.",
      ifNoImprovement: "If conversion rate stays weak, check landing page fit and lead quality.",
      owner: "Media buyer or growth owner",
    },
    volume_loss: {
      decision: "restore_delivery",
      label: "Restore delivery first",
      timeframe: "Today",
      primaryAction: "Check budget caps, bid limits, audience size, rejected ads, and account spend limits.",
      secondaryAction: "Once impressions recover, judge CTR and CPA again.",
      doNotDo: "Do not rewrite strategy until delivery is fixed.",
      plainReason: "The campaign lost reach and clicks, so it had fewer chances to generate results.",
      expectedResult: "Impressions and clicks should recover before downstream conversions improve.",
      ifNoImprovement: "If delivery does not recover, inspect approvals, billing, bids, and audience constraints.",
      owner: "Media buyer or account owner",
    },
    healthy_scaling: {
      decision: "protect_and_scale",
      label: "Protect the winning setup",
      timeframe: "Next 48-72 hours",
      primaryAction: "Keep the current setup running and scale only in small controlled steps.",
      secondaryAction: "Use the previous CPA or CPC as your rollback line.",
      doNotDo: "Do not make major edits to the winning ad or audience today.",
      plainReason: "The campaign took more spend without showing a major quality loss.",
      expectedResult: "Conversions should keep rising while CPA stays near target.",
      ifNoImprovement: "If CPA rises, roll back to the last stable budget.",
      owner: "Media buyer or founder",
    },
    stable_performance: {
      decision: "monitor",
      label: "Keep monitoring",
      timeframe: "Next completed day",
      primaryAction: "Keep the campaign running and wait for a stronger signal.",
      secondaryAction: "Review again after the next completed daily report.",
      doNotDo: "Do not make a major change without a stronger reason.",
      plainReason: "The data does not show a meaningful problem or opportunity yet.",
      expectedResult: "Core metrics should stay within normal day-to-day movement.",
      ifNoImprovement: "If a metric breaks trend tomorrow, act on that stronger signal.",
      owner: "Campaign owner",
    },
  };

  return playbooks[id] || {
    decision: "investigate_primary_signal",
    label: "Investigate the primary signal",
    timeframe: "Today",
    primaryAction: "Review the top changed metric by campaign, ad set, ad, placement, device, and location.",
    secondaryAction: "Wait for one more completed day before making a large budget move.",
    doNotDo: "Do not scale until the movement is understood.",
    plainReason: "One metric moved enough to deserve attention, but the pattern is not yet definitive.",
    expectedResult: "The main metric should stabilize or reveal the responsible segment.",
    ifNoImprovement: "If the signal repeats tomorrow, act on the weakest segment first.",
    owner: "Campaign owner",
  };
}

function metricDecisionPlaybook(metric, direction) {
  const positive = direction === "good";
  const neutral = direction === "neutral";
  const directionSuffix = positive ? "improved" : neutral ? "moved" : "needs attention";
  const fallback = {
    archetypeName: `${METRIC_DEFINITIONS[metric]?.label || "Metric"} ${directionSuffix}`,
    decision: `review_${metric || "metric"}`,
    label: `Review ${METRIC_DEFINITIONS[metric]?.label?.toLowerCase() || "the metric"}`,
    timeframe: "Today",
    primaryAction:
      "Break down the changed metric by campaign, ad set, ad, placement, device, location, and age/gender.",
    secondaryAction:
      "Wait for one more completed day before making a large budget change.",
    doNotDo: "Do not scale until the movement is understood.",
    plainReason:
      "One metric moved materially, but the surrounding metrics do not yet point to a stronger root cause.",
    expectedResult:
      "The metric should stabilize or reveal which segment is driving the movement.",
    ifNoImprovement:
      "If the signal repeats tomorrow, act on the weakest segment first.",
    owner: "Campaign owner",
    watchMetrics: [METRIC_DEFINITIONS[metric]?.label || "Primary metric", "Spend", "Conversions"],
    checklist: [
      "Break the metric down by ad, ad set, placement, device, and location.",
      "Compare it with spend, CTR, CPC, CPA, and conversions.",
      "Act only on the segment that caused the movement.",
    ],
  };

  const playbooks = {
    spend: {
      bad: {
        archetypeName: "Spend efficiency issue",
        decision: "control_spend",
        label: "Control wasted spend",
        timeframe: "Today",
        primaryAction:
          "Check whether the extra spend created extra qualified conversions; if not, return budget to the last stable level.",
        secondaryAction:
          "Break spend by ad set and ad to find where budget increased without result growth.",
        doNotDo: "Do not increase budget again until CPA or CPC stabilizes.",
        plainReason:
          "More budget was used, but the efficiency signal does not justify pushing spend higher.",
        expectedResult:
          "Spend should stop rising faster than conversions, and CPA or CPC should stabilize.",
        ifNoImprovement:
          "If costs keep rising tomorrow, reduce budget on the segment that absorbed spend without results.",
        owner: "Media buyer or founder",
        watchMetrics: ["Spend", "CPA", "CPC", "Conversions"],
        checklist: [
          "Find which campaign, ad set, or ad absorbed the extra spend.",
          "Compare extra spend with extra conversions or qualified leads.",
          "Reduce budget on segments where spend rose without result growth.",
        ],
      },
      good: {
        archetypeName: "Efficient spend growth",
        decision: "protect_efficient_spend",
        label: "Protect efficient spend",
        timeframe: "Next 48-72 hours",
        primaryAction:
          "Keep the current setup running and only increase budget in small controlled steps.",
        secondaryAction:
          "Use the previous CPA or CPC as the rollback line.",
        doNotDo: "Do not make major edits to the ad or audience while spend is scaling efficiently.",
        plainReason:
          "Budget increased while the campaign still showed useful output or stable efficiency.",
        expectedResult:
          "Conversions or clicks should keep growing without CPA or CPC breaking the previous benchmark.",
        ifNoImprovement:
          "If CPA or CPC rises, roll back to the last stable budget.",
        owner: "Media buyer",
        watchMetrics: ["Spend", "CPA", "Conversions", "CTR"],
        checklist: [
          "Leave the winning setup unchanged.",
          "Increase budget only in small steps.",
          "Roll back if CPA or CPC crosses the previous benchmark.",
        ],
      },
    },
    impressions: {
      bad: {
        archetypeName: "Delivery volume loss",
        decision: "restore_impressions",
        label: "Restore ad delivery",
        timeframe: "Today",
        primaryAction:
          "Check budget caps, bid limits, audience size, rejected ads, and learning or delivery restrictions.",
        secondaryAction:
          "Fix delivery before judging creative or funnel quality.",
        doNotDo: "Do not rewrite ads until impressions recover.",
        plainReason:
          "The ads were shown less often, so the campaign had fewer chances to get clicks or conversions.",
        expectedResult:
          "Impressions should recover first, then clicks and conversions can be judged again.",
        ifNoImprovement:
          "If impressions stay low, inspect approvals, billing, bid strategy, and audience constraints.",
        owner: "Media buyer",
        watchMetrics: ["Impressions", "Reach", "Spend", "Clicks"],
        checklist: [
          "Check delivery status, approvals, billing, bids, and budget caps.",
          "Confirm the audience is large enough to deliver.",
          "Review CTR and CPA only after impressions recover.",
        ],
      },
      good: {
        archetypeName: "Delivery volume growth",
        decision: "validate_delivery_quality",
        label: "Validate delivery quality",
        timeframe: "Today",
        primaryAction:
          "Check whether the extra impressions created extra clicks or conversions before increasing budget.",
        secondaryAction:
          "Break new delivery by placement, audience, and location.",
        doNotDo: "Do not assume more impressions are useful unless engagement or conversions follow.",
        plainReason:
          "The ads reached more auction opportunities, but volume only matters if quality holds.",
        expectedResult:
          "CTR should stay stable and clicks or conversions should rise with impressions.",
        ifNoImprovement:
          "If impressions rise while CTR falls, refresh creative or narrow weak placements.",
        owner: "Media buyer",
        watchMetrics: ["Impressions", "CTR", "Clicks", "Conversions"],
        checklist: [
          "Break new impressions by placement, audience, and location.",
          "Check whether CTR held steady.",
          "Keep only the segments where impressions created useful clicks or conversions.",
        ],
      },
    },
    reach: {
      bad: {
        archetypeName: "Reach contraction",
        decision: "restore_reach",
        label: "Restore fresh reach",
        timeframe: "Today",
        primaryAction:
          "Expand the audience, check exclusions, and confirm delivery is not trapped in a narrow pool.",
        secondaryAction:
          "Review frequency to see whether the same people are being hit repeatedly.",
        doNotDo: "Do not increase budget into a shrinking audience.",
        plainReason:
          "The campaign reached fewer people, which reduces fresh opportunity and can push frequency up.",
        expectedResult:
          "Reach should expand and frequency should stop climbing.",
        ifNoImprovement:
          "If reach remains low, inspect audience size, exclusions, placements, and account limits.",
        owner: "Media buyer",
        watchMetrics: ["Reach", "Frequency", "Impressions", "CTR"],
        checklist: [
          "Check audience size and exclusions.",
          "Compare reach against frequency.",
          "Expand or refresh the audience before adding budget.",
        ],
      },
      good: {
        archetypeName: "Fresh reach expansion",
        decision: "protect_reach_quality",
        label: "Protect fresh reach quality",
        timeframe: "Next completed day",
        primaryAction:
          "Keep the audience expansion if CTR and conversions stay healthy.",
        secondaryAction:
          "Watch whether new reach is coming from quality placements and locations.",
        doNotDo: "Do not scale aggressively until fresh reach proves it can convert.",
        plainReason:
          "The ads reached more people, which can create growth if engagement quality holds.",
        expectedResult:
          "Reach should stay higher while CTR, CPC, and CPA remain controlled.",
        ifNoImprovement:
          "If CTR or CPA worsens, narrow the weakest new segment.",
        owner: "Media buyer",
        watchMetrics: ["Reach", "CTR", "CPC", "CPA"],
        checklist: [
          "Check where the new reach came from.",
          "Keep segments where CTR and CPA hold.",
          "Reduce segments where reach grew but engagement weakened.",
        ],
      },
    },
    frequency: {
      bad: {
        archetypeName: "Frequency pressure",
        decision: "reduce_repetition",
        label: "Reduce ad repetition",
        timeframe: "Today",
        primaryAction:
          "Expand the audience or rotate creative so the same people are not seeing the same message too often.",
        secondaryAction:
          "Lower budget pressure if frequency keeps rising while CTR or CPC worsens.",
        doNotDo: "Do not keep pushing spend into the same narrow audience.",
        plainReason:
          "The same people likely saw the ads more often, which can create fatigue and higher costs.",
        expectedResult:
          "Frequency should slow while CTR stabilizes and CPC stops rising.",
        ifNoImprovement:
          "If frequency stays high, refresh exclusions, expand audiences, or reduce budget.",
        owner: "Media buyer",
        watchMetrics: ["Frequency", "Reach", "CTR", "CPC"],
        checklist: [
          "Check frequency by ad set.",
          "Expand the audience or rotate exclusions.",
          "Refresh creative if CTR is also falling.",
        ],
      },
      good: {
        archetypeName: "Healthier frequency",
        decision: "maintain_frequency_control",
        label: "Keep frequency controlled",
        timeframe: "Next completed day",
        primaryAction:
          "Keep the current delivery setup if reach is stable and efficiency is not worsening.",
        secondaryAction:
          "Watch CTR and CPA to confirm lower repetition is helping.",
        doNotDo: "Do not narrow the audience again unless quality drops.",
        plainReason:
          "The ads were repeated less often, which can reduce fatigue if reach remains healthy.",
        expectedResult:
          "CTR should hold or improve while CPC and CPA remain controlled.",
        ifNoImprovement:
          "If performance does not improve, check whether reach quality dropped.",
        owner: "Media buyer",
        watchMetrics: ["Frequency", "Reach", "CTR", "CPA"],
        checklist: [
          "Confirm reach did not collapse.",
          "Watch CTR and CPA after lower repetition.",
          "Keep the broader delivery setup if quality holds.",
        ],
      },
    },
    clicks: {
      bad: {
        archetypeName: "Traffic volume loss",
        decision: "recover_clicks",
        label: "Recover useful traffic",
        timeframe: "Today",
        primaryAction:
          "Check whether clicks fell because impressions dropped, CTR dropped, or CPC became too expensive.",
        secondaryAction:
          "Refresh creative if CTR fell; fix delivery if impressions fell.",
        doNotDo: "Do not increase budget until you know why traffic dropped.",
        plainReason:
          "The campaign sent less traffic, which reduces conversion opportunity.",
        expectedResult:
          "Clicks should recover with stable CTR and CPC.",
        ifNoImprovement:
          "If clicks stay low, inspect creative engagement and delivery restrictions.",
        owner: "Media buyer or creative lead",
        watchMetrics: ["Clicks", "CTR", "CPC", "Impressions"],
        checklist: [
          "Check whether impressions, CTR, or CPC caused the click drop.",
          "Refresh creative if CTR dropped.",
          "Fix delivery if impressions dropped.",
        ],
      },
      good: {
        archetypeName: "Traffic volume growth",
        decision: "validate_click_quality",
        label: "Validate click quality",
        timeframe: "Today",
        primaryAction:
          "Check whether the extra clicks turned into leads, purchases, or qualified website sessions.",
        secondaryAction:
          "Protect placements and ads where clicks convert.",
        doNotDo: "Do not celebrate more clicks if conversions or lead quality do not follow.",
        plainReason:
          "The campaign sent more traffic, but traffic only matters if it becomes business outcomes.",
        expectedResult:
          "Conversions or conversion rate should hold while clicks rise.",
        ifNoImprovement:
          "If clicks rise but conversions do not, cut low-quality placements or audiences.",
        owner: "Growth owner",
        watchMetrics: ["Clicks", "Conversions", "Conversion rate", "CPA"],
        checklist: [
          "Compare extra clicks with extra conversions.",
          "Break clicks by placement, device, geo, and audience.",
          "Reduce traffic sources that click but do not convert.",
        ],
      },
    },
    ctr: {
      bad: {
        archetypeName: "Engagement drop",
        decision: "fix_ctr",
        label: "Fix ad engagement",
        timeframe: "Today",
        primaryAction:
          "Refresh the hook, visual, and first line of the ad with the weakest CTR.",
        secondaryAction:
          "Keep targeting stable while testing the new message.",
        doNotDo: "Do not solve a CTR drop by adding budget.",
        plainReason:
          "Fewer people clicked after seeing the ad, which usually means the message or creative is less compelling.",
        expectedResult:
          "CTR should recover first, followed by cheaper CPC.",
        ifNoImprovement:
          "If CTR stays weak, test a different offer angle or audience promise.",
        owner: "Creative or marketing lead",
        watchMetrics: ["CTR", "Clicks", "CPC", "Frequency"],
        checklist: [
          "Find the ad with the largest CTR drop.",
          "Rewrite the hook and swap the visual angle.",
          "Keep targeting unchanged while testing the new message.",
        ],
      },
      good: {
        archetypeName: "Engagement improvement",
        decision: "protect_ctr",
        label: "Protect the winning message",
        timeframe: "Next 48-72 hours",
        primaryAction:
          "Keep the winning creative unchanged and check whether better CTR also improves CPC or conversions.",
        secondaryAction:
          "Use the winning hook as a template for new variations.",
        doNotDo: "Do not edit the winning ad while it is gaining engagement.",
        plainReason:
          "More people clicked after seeing the ad, which means the message is resonating better.",
        expectedResult:
          "CTR should stay elevated without CPA getting worse.",
        ifNoImprovement:
          "If CTR improves but conversions do not, inspect traffic quality and landing page fit.",
        owner: "Creative or media buyer",
        watchMetrics: ["CTR", "CPC", "Conversions", "CPA"],
        checklist: [
          "Leave the winning ad unchanged.",
          "Document the hook and creative angle that improved CTR.",
          "Check whether conversions or CPA also improved.",
        ],
      },
    },
    cpc: {
      bad: {
        archetypeName: "Click cost increase",
        decision: "lower_cpc",
        label: "Bring click cost down",
        timeframe: "Today",
        primaryAction:
          "Check whether CPC rose because CTR fell, CPM rose, or low-quality placements absorbed spend.",
        secondaryAction:
          "Refresh creative if CTR fell; test lower-cost placements if CPM rose.",
        doNotDo: "Do not scale while each click is getting more expensive.",
        plainReason:
          "Each website visit or click became more expensive, making the campaign harder to run efficiently.",
        expectedResult:
          "CPC should ease after CTR improves or expensive inventory is reduced.",
        ifNoImprovement:
          "If CPC stays high, reduce budget from the ad set or placement with the highest cost.",
        owner: "Media buyer",
        watchMetrics: ["CPC", "CTR", "CPM", "Clicks"],
        checklist: [
          "Check whether CTR dropped or CPM rose.",
          "Refresh creative if CTR is the problem.",
          "Shift spend away from expensive placements if CPM is the problem.",
        ],
      },
      good: {
        archetypeName: "Cheaper traffic",
        decision: "protect_low_cpc",
        label: "Protect cheaper clicks",
        timeframe: "Next completed day",
        primaryAction:
          "Keep the setup that lowered CPC, then confirm those cheaper clicks still convert.",
        secondaryAction:
          "Move budget carefully toward segments with low CPC and stable conversion quality.",
        doNotDo: "Do not chase cheap clicks if conversion rate drops.",
        plainReason:
          "Each click became cheaper, which can improve efficiency if traffic quality holds.",
        expectedResult:
          "CPC should stay lower while conversions or conversion rate remain stable.",
        ifNoImprovement:
          "If cheaper clicks do not convert, cut the low-quality segment.",
        owner: "Media buyer",
        watchMetrics: ["CPC", "Clicks", "Conversion rate", "CPA"],
        checklist: [
          "Find which segment produced cheaper clicks.",
          "Check whether those clicks converted.",
          "Shift budget only toward low-CPC segments with stable quality.",
        ],
      },
    },
    cpm: {
      bad: {
        archetypeName: "Reach cost increase",
        decision: "lower_cpm",
        label: "Avoid expensive reach",
        timeframe: "Today",
        primaryAction:
          "Compare CPM by placement, audience, location, and campaign objective; reduce spend from expensive segments.",
        secondaryAction:
          "Avoid scaling until reach cost cools down or quality offsets the higher CPM.",
        doNotDo: "Do not buy more volume in expensive inventory without proof it converts.",
        plainReason:
          "Reaching people became more expensive, which can raise downstream click and acquisition costs.",
        expectedResult:
          "CPM should fall before CPC or CPA improves materially.",
        ifNoImprovement:
          "If CPM stays high, test broader audiences or cheaper placements with small budget.",
        owner: "Media buyer",
        watchMetrics: ["CPM", "CPC", "CTR", "CPA"],
        checklist: [
          "Break CPM down by placement, audience, and location.",
          "Hold budget on the most expensive segments.",
          "Test cheaper inventory only if lead quality holds.",
        ],
      },
      good: {
        archetypeName: "Cheaper reach",
        decision: "validate_cheap_reach",
        label: "Validate cheaper reach",
        timeframe: "Next completed day",
        primaryAction:
          "Check whether cheaper reach also kept CTR and conversion quality stable.",
        secondaryAction:
          "Shift budget carefully toward low-CPM segments that still create outcomes.",
        doNotDo: "Do not optimize for cheap reach alone.",
        plainReason:
          "Reaching people became cheaper, which is useful only if the audience still responds.",
        expectedResult:
          "CPM should stay lower while CTR and conversions remain stable.",
        ifNoImprovement:
          "If cheap reach lowers quality, move budget back to higher-intent segments.",
        owner: "Media buyer",
        watchMetrics: ["CPM", "CTR", "Conversions", "CPA"],
        checklist: [
          "Find where CPM improved.",
          "Check CTR and conversions from that inventory.",
          "Scale only the cheaper segments that keep quality.",   
        ],
      },
    },
    conversions: {
      bad: {
        archetypeName: "Conversion volume loss",
        decision: "recover_conversions",
        label: "Recover conversions",
        timeframe: "Today",
        primaryAction:
          "Check whether conversions fell because traffic dropped, conversion rate dropped, or tracking broke.",
        secondaryAction:
          "Inspect landing page, lead form, checkout, CRM, and tracking events.",
        doNotDo: "Do not increase budget until conversion loss is explained.",
        plainReason:
          "The campaign produced fewer leads or purchases, which is the clearest business risk.",
        expectedResult:
          "Conversions should recover while CPA returns near the previous benchmark.",
        ifNoImprovement:
          "If conversions stay low, pause weak segments and verify post-click tracking.",
        owner: "Growth owner",
        watchMetrics: ["Conversions", "Conversion rate", "CPA", "Clicks"],
        checklist: [
          "Check whether clicks fell or conversion rate fell.",
          "Test the landing page, form, checkout, and tracking.",
          "Reduce spend from ads or placements with no conversions.",
        ],
      },
      good: {
        archetypeName: "Conversion volume growth",
        decision: "protect_conversion_growth",
        label: "Protect conversion growth",
        timeframe: "Next 48-72 hours",
        primaryAction:
          "Identify which ad, audience, or placement produced the extra conversions and protect it.",
        secondaryAction:
          "Scale slowly while keeping CPA near the previous benchmark.",
        doNotDo: "Do not edit the winning segment while conversion volume is improving.",
        plainReason:
          "The campaign produced more leads or purchases, which is the most useful growth signal.",
        expectedResult:
          "Conversions should continue rising without CPA breaking the target.",
        ifNoImprovement:
          "If CPA rises, roll budget back to the last efficient level.",
        owner: "Media buyer or founder",
        watchMetrics: ["Conversions", "CPA", "Spend", "CTR"],
        checklist: [
          "Find which segment created the extra conversions.",
          "Protect it from edits.",
          "Scale slowly while monitoring CPA.",
        ],
      },
    },
    cpa: {
      bad: {
        archetypeName: "Acquisition cost increase",
        decision: "lower_cpa",
        label: "Lower acquisition cost",
        timeframe: "Today",
        primaryAction:
          "Find whether CPA rose because spend increased, conversions fell, CPC rose, or conversion rate dropped.",
        secondaryAction:
          "Cut spend from ads or segments where cost rose without conversion growth.",
        doNotDo: "Do not scale while each lead or purchase is getting more expensive.",
        plainReason:
          "Each lead or purchase became more expensive, which directly hurts profitability.",
        expectedResult:
          "CPA should move back toward the previous benchmark.",
        ifNoImprovement:
          "If CPA stays high, reduce spend on the weakest segment and inspect the landing page.",
        owner: "Media buyer or founder",
        watchMetrics: ["CPA", "Conversions", "CPC", "Conversion rate"],
        checklist: [
          "Find which segment had the highest CPA increase.",
          "Check whether conversions fell or CPC rose.",
          "Reduce spend from high-CPA segments until efficiency recovers.",
        ],
      },
      good: {
        archetypeName: "Acquisition cost improvement",
        decision: "protect_low_cpa",
        label: "Protect lower CPA",
        timeframe: "Next 48-72 hours",
        primaryAction:
          "Protect the setup that lowered CPA and scale only in small steps.",
        secondaryAction:
          "Use the improved CPA as the benchmark for future budget increases.",
        doNotDo: "Do not make major edits to the winning ad, audience, or funnel today.",
        plainReason:
          "Each lead or purchase became cheaper, which is a strong efficiency signal.",
        expectedResult:
          "CPA should stay near the improved level while conversion volume holds.",
        ifNoImprovement:
          "If CPA rises after scaling, roll budget back to the last efficient level.",
        owner: "Media buyer or founder",
        watchMetrics: ["CPA", "Conversions", "Spend", "CTR"],
        checklist: [
          "Identify what lowered CPA.",
          "Leave that setup unchanged.",
          "Scale slowly and roll back if CPA rises.",
        ],
      },
    },
    conversionRate: {
      bad: {
        archetypeName: "Post-click conversion drop",
        decision: "fix_conversion_rate",
        label: "Fix post-click conversion",
        timeframe: "Today",
        primaryAction:
          "Check the landing page, offer, form, checkout, CRM handoff, and tracking events.",
        secondaryAction:
          "Compare Meta clicks with website sessions and form or checkout starts.",
        doNotDo: "Do not blame the ad creative until the post-click path is checked.",
        plainReason:
          "A lower share of clickers became leads or purchases, so the issue may be after the click.",
        expectedResult:
          "Conversion rate should recover while clicks remain stable.",
        ifNoImprovement:
          "If the funnel is healthy, cut low-quality traffic sources that click but do not convert.",
        owner: "Website, CRM, or growth owner",
        watchMetrics: ["Conversion rate", "Conversions", "CPA", "Clicks"],
        checklist: [
          "Test the landing page, form, checkout, and tracking yourself.",
          "Compare Meta clicks with website sessions.",
          "Cut placements or audiences with clicks but no conversions.",
        ],
      },
      good: {
        archetypeName: "Post-click conversion improvement",
        decision: "protect_conversion_rate",
        label: "Protect better conversion rate",
        timeframe: "Next 48-72 hours",
        primaryAction:
          "Identify which traffic source, offer, or page path improved conversion rate and protect it.",
        secondaryAction:
          "Scale only after CPA confirms the improvement is profitable.",
        doNotDo: "Do not change the landing page or offer while conversion rate is improving.",
        plainReason:
          "A higher share of clickers became leads or purchases, which usually means better traffic or funnel quality.",
        expectedResult:
          "Conversion rate should stay higher while CPA improves or remains stable.",
        ifNoImprovement:
          "If conversion rate drops again, compare traffic mix and recent website changes.",
        owner: "Growth owner",
        watchMetrics: ["Conversion rate", "CPA", "Conversions", "Clicks"],
        checklist: [
          "Find which traffic source or page path improved.",
          "Protect it from edits.",
          "Scale only if CPA stays healthy.",
        ],
      },
    },
  };

  const bucket = positive ? "good" : "bad";
  return playbooks[metric]?.[bucket] || fallback;
}

function formatDecisionImpact(financialImpact, config) {
  if (!financialImpact || financialImpact.type === "unavailable") {
    return financialImpact?.summary || "Conversion impact cannot be confirmed from available data.";
  }

  if (!financialImpact.shouldDisplayAmount || financialImpact.amount <= 0) {
    return "Impact is directionally important, but not reliably quantifiable yet.";
  }

  const amount = financialImpact.displayAmount || `${config.currencySymbol}${formatNumber(financialImpact.amount)}`;

  if (financialImpact.type === "positive") {
    return `${amount} estimated gain`;
  }

  if (financialImpact.type === "negative") {
    return `${amount} estimated risk`;
  }

  return `${amount} spend movement to review`;
}

function buildSimpleDiagnosis(selected, primary, whatHappened) {
  const metricText = primary
    ? `${primary.label} ${movementVerb(primary.metric, primary.delta)} by ${formatAbsolutePercent(primary.delta)}`
    : "No single metric moved enough to dominate the report";

  return {
    title: selected.name,
    inPlainEnglish: `${decisionPlaybook(selected.id, selected).plainReason} ${metricText}.`,
    evidence: whatHappened.slice(0, 3),
  };
}

function buildPlainEnglishEvidence(anomalies, selected) {
  const useful = anomalies
    .filter((item) => selected.positive ? item.direction === "good" : item.direction === "bad")
    .slice(0, 3);

  return useful.map((item) => ({
    metric: item.label,
    change: formatSignedPercent(item.delta),
    meaning: explainMetricMovement(item.metric, item.delta),
  }));
}

function explainMetricMovement(metric, delta) {
  const direction = delta > 0 ? "up" : "down";
  const explanations = {
    ctr: {
      up: "More people clicked after seeing the ad.",
      down: "Fewer people clicked after seeing the ad.",
    },
    cpc: {
      up: "Each website visit or click became more expensive.",
      down: "Each website visit or click became cheaper.",
    },
    cpa: {
      up: "Each lead or purchase became more expensive.",
      down: "Each lead or purchase became cheaper.",
    },
    roas: {
      up: "Revenue return improved for the spend used.",
      down: "Revenue return weakened for the spend used.",
    },
    cpm: {
      up: "Reaching people became more expensive.",
      down: "Reaching people became cheaper.",
    },
    conversions: {
      up: "The campaign produced more leads or purchases.",
      down: "The campaign produced fewer leads or purchases.",
    },
    clicks: {
      up: "The campaign sent more traffic.",
      down: "The campaign sent less traffic.",
    },
    impressions: {
      up: "The ads were shown more often.",
      down: "The ads were shown less often.",
    },
    reach: {
      up: "The ads reached more people.",
      down: "The ads reached fewer people.",
    },
    spend: {
      up: "More budget was used.",
      down: "Less budget was used.",
    },
    frequency: {
      up: "The same people likely saw the ads more often.",
      down: "The ads were repeated less often to the same people.",
    },
    conversionRate: {
      up: "A higher share of clickers became leads or purchases.",
      down: "A lower share of clickers became leads or purchases.",
    },
  };

  return explanations[metric]?.[direction] || "This metric moved materially.";
}

function buildDoNotDo(playbook, trustGate, decisionType) {
  if (trustGate?.blocked || trustGate?.level === "low") {
    return "Do not make optimization decisions from this report until data quality is fixed or verified.";
  }

  if (trustGate?.flags?.noConversions) {
    return "Do not judge CPA, ROAS, or conversion impact today because conversions were not recorded.";
  }

  if (trustGate?.flags?.noAdLevelData && decisionType?.id === "creative_action") {
    return "Do not pause a specific ad until ad-level data confirms which ad caused the movement.";
  }

  if (decisionType?.id === "budget_action") {
    return "Do not increase budget until the primary efficiency signal stabilizes.";
  }

  return playbook.doNotDo || "Do not make a major change without a stronger signal.";
}

function buildActionChecklist(selected, deltas, fixFirstAd, trustGate = null, topContributor = null) {
  if (trustGate?.blocked || trustGate?.flags?.dataWindowMismatch) {
    return [
      "Verify the scheduled Meta delivery window and report date range.",
      "Confirm Meta returned spend, impressions, and clicks for the expected period.",
      "Run the report again after the data window is corrected.",
    ];
  }

  if (trustGate?.flags?.lowSpend) {
    return [
      "Keep the campaign running without a major change.",
      "Wait until spend crosses the reliability threshold.",
      "Review the next completed report before changing budget or creative.",
    ];
  }

  if (trustGate?.flags?.noAdLevelData && !topContributor?.available) {
    return [
      "Break the campaign down by ad and ad set before acting.",
      "Find which ad drove the largest CTR, CPC, CPA, or conversion movement.",
      "Only change the confirmed weak segment, not the whole campaign.",
    ];
  }

  const adName = fixFirstAd?.adName || "the weakest ad";
  const checklistByDecision = {
    refresh_creative: [
      `Open ${adName} in Meta Ads Manager.`,
      "Pause it or reduce its spend.",
      "Launch 2-3 new versions with a different hook, visual, and first line.",
    ],
    refresh_audience: [
      "Check the ad set frequency and audience size.",
      "Expand the audience or loosen narrow exclusions.",
      "Keep budget steady until reach improves.",
    ],
    fix_message_fit: [
      `Find which ad had the biggest CTR drop, starting with ${adName}.`,
      "Rewrite the hook and swap the visual angle.",
      "Keep targeting unchanged while testing the new message.",
    ],
    hold_scale: [
      "Stop any planned budget increase today.",
      "Compare current CPA/CPC against the last stable day.",
      "Roll budget back if costs rise again tomorrow.",
    ],
    check_post_click: [
      "Open the landing page and submit the form or checkout yourself.",
      "Compare Meta clicks with website sessions.",
      "Check tracking events, page speed, offer changes, and CRM delivery.",
    ],
    avoid_expensive_auction: [
      "Compare CPM by placement, audience, and location.",
      "Hold budget on expensive segments.",
      "Test cheaper segments with small budget only.",
    ],
    stabilize_delivery: [
      "Review edits, approvals, learning status, bids, and budget changes.",
      "Do not make a final creative call today.",
      "Wait for one more completed daily comparison.",
    ],
    cut_low_quality_traffic: [
      "Break down clicks by placement, device, geo, and audience.",
      "Reduce spend from segments with clicks but no conversions.",
      "Keep budget on segments with qualified outcomes.",
    ],
    restore_delivery: [
      "Check budget caps, billing, bid limits, rejected ads, and audience size.",
      "Fix the delivery blocker first.",
      "Review CTR/CPA again after impressions recover.",
    ],
    protect_and_scale: [
      "Leave the winning ad and audience unchanged.",
      "Increase budget only in small steps.",
      "Roll back if CPA or CPC crosses the previous benchmark.",
    ],
    monitor: [
      "Keep the campaign running.",
      "Check the next completed daily report.",
      "Avoid major edits until a stronger signal appears.",
    ],
  };
  const playbook = decisionPlaybook(selected.id, selected);
  const checklist = playbook.checklist || checklistByDecision[playbook.decision] || [
    playbook.primaryAction,
    playbook.secondaryAction,
    playbook.ifNoImprovement,
  ];

  if (!selected.positive && deltas.spend > 20 && !checklist.some((item) => item.includes("budget increase"))) {
    return ["Stop any planned budget increase today.", ...checklist].slice(0, 4);
  }

  return checklist.slice(0, 4);
}

function buildUserHeadline(selected, primary) {
  const byArchetype = {
    creative_fatigue: "Creative fatigue is likely making clicks more expensive.",
    audience_saturation: "The audience may be getting saturated.",
    engagement_quality_drop: "People are seeing the ads, but fewer are engaging.",
    aggressive_scaling: "The campaign may have scaled faster than performance could handle.",
    conversion_funnel_breakdown: "The problem is likely happening after the click.",
    auction_pressure: "Auction costs increased today.",
    delivery_instability: "Delivery shifted too much to judge performance cleanly.",
    traffic_quality_drop: "The campaign brought more traffic, but the traffic quality dropped.",
    volume_loss: "Delivery volume dropped and reduced opportunity.",
    healthy_scaling: "The campaign scaled well today.",
    stable_performance: "Performance looks stable today.",
  };

  if (byArchetype[selected.id]) return byArchetype[selected.id];

  if (selected.metric && primary) {
    if (selected.neutral) return `${primary.label} moved enough to review today.`;
    return selected.positive
      ? `${primary.label} improved; protect what caused it.`
      : `${primary.label} needs attention today.`;
  }

  if (!primary) {
    return selected.positive
      ? "Performance looks stable today."
      : "No clear performance issue was detected yet.";
  }

  if (selected.positive) {
    return `${primary.label} improved, and the campaign looks healthier today.`;
  }

  return `${primary.label} is the main issue to fix today.`;
}

function buildPlainSummary(current, previous, deltas, selected, impactText) {
  const direction = selected.neutral ? "different" : selected.positive ? "better" : "worse";
  const compared = `Compared with ${previous.date}, ${current.date} looks ${direction}.`;
  const signal = selected.cause;

  return `${compared} ${signal} ${impactText}`.trim();
}

function buildWhatHappened(deltas, primary, selected) {
  const points = [];

  if (primary) {
    points.push(
      `${primary.label} ${movementVerb(primary.metric, primary.delta)} by ${formatAbsolutePercent(
        primary.delta
      )}.`
    );
  }

  if (Math.abs(deltas.spend) >= 10) {
    points.push(`Spend ${deltas.spend > 0 ? "increased" : "decreased"} by ${formatAbsolutePercent(deltas.spend)}.`);
  }

  if (Math.abs(deltas.ctr) >= 10) {
    points.push(`CTR ${deltas.ctr > 0 ? "improved" : "dropped"} by ${formatAbsolutePercent(deltas.ctr)}.`);
  }

  if (Math.abs(deltas.cpc) >= 10) {
    points.push(`CPC ${deltas.cpc > 0 ? "became more expensive" : "became cheaper"} by ${formatAbsolutePercent(deltas.cpc)}.`);
  }

  if (Math.abs(deltas.conversions) >= 10) {
    points.push(`Conversions ${deltas.conversions > 0 ? "increased" : "fell"} by ${formatAbsolutePercent(deltas.conversions)}.`);
  }

  if (!points.length) {
    points.push(
      selected.positive
        ? "The campaign is mostly stable, with no major negative movement."
        : "There is movement in the data, but no single metric is strong enough to call a major issue."
    );
  }

  return uniqueList(points).slice(0, 4);
}

function buildWhyItMatters(selected, financialImpact, config) {
  if (selected.positive) {
    if (financialImpact.shouldDisplayAmount && financialImpact.amount > 0) {
      return `This is useful because the campaign may have created about ${financialImpact.displayAmount} in efficiency gain.`;
    }

    return "This is useful because the campaign improved without showing a clear cost problem.";
  }

  if (financialImpact.type === "unavailable") {
    return financialImpact.summary || "This matters because conversion impact cannot be confirmed from the available data.";
  }

  if (financialImpact.shouldDisplayAmount && financialImpact.amount > 0) {
    return `This matters because the issue may have cost about ${financialImpact.displayAmount} in wasted spend or lost efficiency.`;
  }

  return "This matters because the campaign is showing a quality or delivery issue that can become expensive if budget is increased.";
}

function buildUserNextSteps(selected, deltas, fixFirstAd = null) {
  const byArchetype = {
    creative_fatigue: [
      "Do not increase budget today.",
      "Pause or reduce spend on the weakest creative.",
      "Launch 2-3 fresh creative variations with a new hook, image/video, and primary text.",
    ],
    audience_saturation: [
      "Do not push more spend into the same audience.",
      "Expand the audience or refresh exclusions.",
      "Rotate creatives so repeated users see something new.",
    ],
    engagement_quality_drop: [
      "Keep the audience stable for now.",
      "Refresh the creative hook and message first.",
      "Compare CTR by ad to find which creative caused the drop.",
    ],
    aggressive_scaling: [
      "Hold the latest budget increase.",
      "Wait until CPA or CPC stabilizes before scaling again.",
      "If costs keep rising tomorrow, step budget back to the previous level.",
    ],
    conversion_funnel_breakdown: [
      "Check the landing page, form, checkout, and tracking before changing ads.",
      "Compare Meta clicks with website sessions.",
      "Look for recent site, offer, or payment changes.",
    ],
    auction_pressure: [
      "Avoid scaling today.",
      "Check CPM by placement and audience.",
      "Test lower-cost audiences or placements with a small budget only.",
    ],
    delivery_instability: [
      "Review recent edits, approvals, budget changes, and learning status.",
      "Do not judge the creative until delivery stabilizes.",
      "Wait for one more completed day before making large changes.",
    ],
    traffic_quality_drop: [
      "Check which placement, device, geo, or audience created the extra clicks.",
      "Reduce spend from segments that click but do not convert.",
      "Keep only traffic sources that produce qualified leads or purchases.",
    ],
    volume_loss: [
      "Check budget caps, account limits, bid limits, and rejected ads.",
      "Confirm the audience is still large enough to deliver.",
      "Fix delivery first before evaluating CTR or CPA.",
    ],
    healthy_scaling: [
      "Keep the current setup running.",
      "Scale slowly, not aggressively.",
      "Use the previous CPA or CPC as the point where you stop increasing budget.",
    ],
    stable_performance: [
      "Keep the campaign running.",
      "Check again after the next completed day.",
      "Avoid major changes until a stronger signal appears.",
    ],
  };

  const steps = byArchetype[selected.id] || [
    selected.action,
    "Break down the changed metric by campaign, ad set, ad, placement, device, and location.",
    "Wait for the next completed day before making a large budget move.",
  ];
  const adStep = fixFirstAd
    ? `${fixFirstAd.action} Focus on "${fixFirstAd.adName}" first.`
    : null;
  const finalSteps = adStep ? [adStep, ...steps] : steps;

  if (!selected.positive && deltas.spend > 20 && !finalSteps.includes("Do not increase budget today.")) {
    return ["Do not increase budget today.", ...finalSteps].slice(0, 4);
  }

  return finalSteps.slice(0, 4);
}

function buildWatchNext(selected, anomalies) {
  const preferredMetrics = {
    creative_fatigue: ["CTR", "CPC", "Frequency"],
    audience_saturation: ["Reach", "Frequency", "CTR"],
    engagement_quality_drop: ["CTR", "Clicks", "CPC"],
    aggressive_scaling: ["CPA", "CPC", "Conversions"],
    conversion_funnel_breakdown: ["Conversion rate", "Conversions", "CPA"],
    auction_pressure: ["CPM", "CPC", "CTR"],
    delivery_instability: ["Spend", "Impressions", "Clicks"],
    traffic_quality_drop: ["Conversion rate", "CPA", "Conversions"],
    volume_loss: ["Impressions", "Clicks", "Spend"],
    healthy_scaling: ["Conversions", "CPA", "CTR"],
  };

  const labels = preferredMetrics[selected.id] || selected.watchMetrics || anomalies
    .filter((item) => selected.positive ? item.direction === "good" : item.direction === "bad")
    .slice(0, 2)
    .map((item) => item.label);

  return {
    timeframe: "Next 48-72 hours",
    metrics: labels.length ? labels : ["CTR", "CPC", "CPA", "Conversions"],
    goodSign: selected.nextSignal,
    badSign: selected.positive
      ? "The improvement disappears while cost rises."
      : "The same issue gets worse in the next daily report.",
  };
}

function formatImpactForUser(financialImpact, config) {
  if (!financialImpact || financialImpact.amount <= 0 || financialImpact.type === "unavailable") {
    return financialImpact?.type === "unavailable" ? financialImpact.summary : "";
  }

  if (!financialImpact.shouldDisplayAmount) {
    return financialImpact.summary || "";
  }

  if (financialImpact.type === "positive") {
    return `Estimated positive impact is around ${financialImpact.displayAmount}.`;
  }

  if (financialImpact.type === "negative") {
    return `Estimated negative impact is around ${financialImpact.displayAmount}.`;
  }

  return "";
}

function userUrgency(score, positive) {
  if (positive) return score >= 75 ? "opportunity" : "monitor";
  if (score >= 75) return "act_today";
  if (score >= 40) return "review_today";
  return "monitor";
}

function buildRecommendations(selected, anomalies, deltas) {
  const urgency = selected.score >= 75 ? "high" : selected.score >= 40 ? "medium" : "low";
  const primaryAnomaly = anomalies.find((item) =>
    selected.positive ? item.direction === "good" : item.direction === "bad"
  );

  const recommendations = [
    {
      priority: "P1",
      urgency,
      title: selected.positive ? "Protect the winning setup" : "Act on the primary signal",
      action: selected.action,
      reason: selected.cause,
    },
  ];

  if (!selected.positive && primaryAnomaly) {
    recommendations.push({
      priority: "P2",
      urgency: "medium",
      title: `Validate ${primaryAnomaly.label.toLowerCase()}`,
      action: `Compare ${primaryAnomaly.label.toLowerCase()} by campaign, ad set, ad, placement, and age/gender split before making broad budget changes.`,
      reason: `${primaryAnomaly.label} moved ${formatSignedPercent(
        primaryAnomaly.delta
      )}, making it the strongest measurable signal.`,
    });
  }

  if (!selected.positive && (deltas.cpa >= 20 || deltas.conversionRate <= -20)) {
    recommendations.push({
      priority: "P3",
      urgency: "medium",
      title: "Check post-click health",
      action:
        "Review landing page speed, form completion, checkout errors, tracking events, and recent offer changes.",
      reason:
        "Conversion efficiency changed enough that the issue may be outside Meta delivery.",
    });
  }

  if (selected.positive) {
    recommendations.push({
      priority: "P2",
      urgency: "low",
      title: "Scale gradually",
      action:
        "Increase budget in controlled steps and keep the previous CPA/CPC as the rollback threshold.",
      reason:
        "Positive movement is useful only if efficiency holds after additional spend.",
    });
  }

  return recommendations;
}

function buildDiagnosticChecks(selected, deltas) {
  if (selected.playbook?.checklist?.length) {
    return selected.playbook.checklist;
  }

  const checksByArchetype = {
    creative_fatigue: [
      "Compare CTR and CPC by creative ID for the last 3-7 days.",
      "Check frequency and first-time impression ratio by ad set.",
      "Confirm no winning creative was paused or rejected.",
    ],
    audience_saturation: [
      "Review audience size, overlap, exclusions, and frequency by ad set.",
      "Compare fresh reach against total impressions.",
      "Check whether budget is concentrated in a narrow retargeting pool.",
    ],
    conversion_funnel_breakdown: [
      "Test landing page, lead form, checkout, and tracking events.",
      "Compare Meta clicks against site sessions for the same date.",
      "Review offer, price, stock, CRM, and recent website deployments.",
    ],
    auction_pressure: [
      "Compare CPM by placement and audience.",
      "Check competitor-heavy sale periods, holidays, or campaign launches.",
      "Shift test budget into lower-cost placements only if quality holds.",
    ],
    aggressive_scaling: [
      "Review budget edits and learning status in the previous 48 hours.",
      "Check whether spend moved faster than conversions or qualified leads.",
      "Hold budget until CPA/CPC stabilizes.",
    ],
    traffic_quality_drop: [
      "Break down clicks by placement, device, geo, and age/gender.",
      "Compare converting and non-converting traffic segments.",
      "Check whether low-intent placements absorbed the incremental traffic.",
    ],
    volume_loss: [
      "Check budget caps, bid limits, approvals, and audience size.",
      "Review delivery status and rejected or limited ads.",
      "Confirm account-level spend limits were not reached.",
    ],
    delivery_instability: [
      "Review campaign edits, bid strategy changes, learning resets, and approval issues.",
      "Compare spend pacing by hour if intraday data is available.",
      "Wait for delivery to stabilize before judging creative quality.",
    ],
  };

  const checks = checksByArchetype[selected.id] || [
    "Break down the top anomaly by campaign, ad set, ad, placement, device, and geo.",
    "Compare against the previous 7-day average before making irreversible changes.",
    "Confirm tracking and attribution settings did not change.",
  ];

  if (deltas.spend >= 25 && deltas.conversions <= 0) {
    return [...checks, "Inspect whether incremental spend produced incremental qualified outcomes."];
  }

  return checks;
}

function buildMonitoringPlan(selected, anomalies) {
  const topMetrics = anomalies
    .filter((item) => selected.positive ? item.direction === "good" : item.direction === "bad")
    .slice(0, 3)
    .map((item) => item.label);

  return {
    window: "next_48_to_72_hours",
    cadence: selected.score >= 75 ? "check_every_12_hours" : "daily",
    watchMetrics: topMetrics.length ? topMetrics : ["CTR", "CPC", "CPA", "Conversions"],
    successSignal: selected.nextSignal,
    rollbackSignal: selected.positive
      ? "CPA or CPC rises while CTR or conversions stop improving."
      : "The same anomaly worsens in the next completed daily comparison.",
  };
}

function buildGuardrails(current, previous, deltas, selected, config) {
  const guardrails = [];

  if (!selected.positive && current.spend > previous.spend) {
    guardrails.push({
      metric: "spend",
      rule: "Avoid increasing budget until the primary anomaly stabilizes.",
      current: formatMetric(current.spend, "spend", config),
      previous: formatMetric(previous.spend, "spend", config),
      delta: formatSignedPercent(deltas.spend),
    });
  }

  if (current.cpa > 0 || previous.cpa > 0) {
    guardrails.push({
      metric: "cpa",
      rule: "Use previous CPA as the first rollback benchmark.",
      current: formatMetric(current.cpa, "cpa", config),
      previous: formatMetric(previous.cpa, "cpa", config),
      delta: formatSignedPercent(deltas.cpa),
    });
  }

  if (current.ctr > 0 || previous.ctr > 0) {
    guardrails.push({
      metric: "ctr",
      rule: "Treat further CTR decline as evidence that creative or audience fit is weakening.",
      current: formatMetric(current.ctr, "ctr", config),
      previous: formatMetric(previous.ctr, "ctr", config),
      delta: formatSignedPercent(deltas.ctr),
    });
  }

  return guardrails;
}

function buildSegmentContributors(rows, currentDate, previousDate, config) {
  if (!Array.isArray(rows) || !currentDate || !previousDate) return [];

  const bySegment = new Map();

  for (const row of rows) {
    const date = row && (row.date_start || row.date || row.dateStop);
    if (date !== currentDate && date !== previousDate) continue;

    const key = segmentKey(row);
    const segment = bySegment.get(key) || {
      id: key,
      campaignId: row.campaign_id || row.campaignId || null,
      campaignName: row.campaign_name || row.campaignName || "Unknown campaign",
      adsetName: row.adset_name || row.adsetName || null,
      adName: row.ad_name || row.adName || null,
      current: emptySegmentMetrics(),
      previous: emptySegmentMetrics(),
    };

    const target = date === currentDate ? segment.current : segment.previous;
    const normalized = normalizeMetaDailyRow(row, config);
    target.spend += normalized.spend;
    target.impressions += normalized.impressions;
    target.clicks += normalized.clicks;
    target.conversions += normalized.conversions;

    bySegment.set(key, segment);
  }

  return Array.from(bySegment.values())
    .map((segment) => {
      const deltas = {
        spend: round(segment.current.spend - segment.previous.spend, 2),
        impressions: round(segment.current.impressions - segment.previous.impressions, 0),
        clicks: round(segment.current.clicks - segment.previous.clicks, 0),
        conversions: round(segment.current.conversions - segment.previous.conversions, 2),
      };
      const score =
        Math.abs(deltas.spend) +
        Math.abs(deltas.clicks * 3) +
        Math.abs(deltas.conversions * 20);

      return {
        ...segment,
        current: finalizeSegmentMetrics(segment.current),
        previous: finalizeSegmentMetrics(segment.previous),
        deltas,
        contributionScore: round(score, 1),
      };
    })
    .filter((segment) => segment.contributionScore > 0)
    .sort((a, b) => b.contributionScore - a.contributionScore);
}

function normalizeOperationalSegmentContributors(segments) {
  if (!Array.isArray(segments)) return [];

  return segments
    .map((segment) => {
      if (!segment) return null;

      return {
        id: segment.id || segment.key || segment.campaignId || segment.campaign_id || "segment",
        campaignId: segment.campaignId || segment.campaign_id || null,
        campaignName:
          segment.campaignName || segment.campaign_name || "Monitored campaigns",
        adsetName: segment.adsetName || segment.adset_name || null,
        adName: segment.adName || segment.ad_name || null,
        current: finalizeSegmentMetrics({
          spend: number(segment.current?.spend),
          impressions: number(segment.current?.impressions),
          clicks: number(segment.current?.clicks),
          conversions: number(segment.current?.conversions),
        }),
        previous: finalizeSegmentMetrics({
          spend: number(segment.previous?.spend),
          impressions: number(segment.previous?.impressions),
          clicks: number(segment.previous?.clicks),
          conversions: number(segment.previous?.conversions),
        }),
        deltas: segment.deltas || {},
        contributionScore: number(segment.contributionScore),
      };
    })
    .filter(Boolean);
}

function buildAdDiagnostics(segments, selected, config) {
  const diagnosed = (segments || [])
    .map((segment) => diagnoseSegment(segment, selected, config))
    .filter(Boolean);

  const fixCandidates = diagnosed
    .filter((item) => item.classification === "underperforming")
    .sort((a, b) => b.score - a.score);
  const protectCandidates = diagnosed
    .filter((item) => item.classification === "outperforming")
    .sort((a, b) => b.score - a.score);
  const watchCandidates = diagnosed
    .filter((item) => item.classification === "watch")
    .sort((a, b) => b.score - a.score);

  return {
    fixFirst: fixCandidates[0] || null,
    protect: protectCandidates[0] || null,
    watch: watchCandidates.slice(0, 3),
    all: diagnosed
      .sort((a, b) => b.score - a.score)
      .slice(0, 5),
  };
}

function diagnoseSegment(segment, selected, config) {
  if (!segment || !segment.current || !segment.previous) return null;

  const current = segment.current;
  const previous = segment.previous;
  const percentDeltas = {
    spend: percentChange(current.spend, previous.spend),
    impressions: percentChange(current.impressions, previous.impressions),
    clicks: percentChange(current.clicks, previous.clicks),
    conversions: percentChange(current.conversions, previous.conversions),
    ctr: percentChange(current.ctr, previous.ctr),
    cpc: percentChange(current.cpc, previous.cpc),
    cpa: percentChange(current.cpa, previous.cpa),
  };
  const reasons = buildSegmentReasons(percentDeltas, current, previous, config);
  const badScore = scoreBadSegment(percentDeltas, current, previous);
  const goodScore = scoreGoodSegment(percentDeltas, current, previous);

  if (badScore < 15 && goodScore < 15) {
    return {
      classification: "watch",
      score: round(Math.max(badScore, goodScore, segment.contributionScore || 0), 1),
      action: "Keep monitoring this ad until the next daily report.",
      reasons: reasons.length ? reasons.slice(0, 3) : ["No severe ad-level movement yet."],
      ...segmentSummary(segment, percentDeltas, config),
    };
  }

  const underperforming = badScore >= goodScore;

  return {
    classification: underperforming ? "underperforming" : "outperforming",
    score: round(underperforming ? badScore : goodScore, 1),
    action: underperforming
      ? actionForUnderperformingAd(selected)
      : "Keep this ad running and avoid editing it while it is improving.",
    reasons: reasonsForClassification(reasons, percentDeltas, underperforming, config),
    ...segmentSummary(segment, percentDeltas, config),
  };
}

function buildSegmentReasons(deltas, current, previous, config) {
  const reasons = [];

  if (deltas.ctr <= -15) reasons.push(`CTR dropped ${formatSignedPercent(deltas.ctr)}.`);
  if (deltas.cpc >= 15) reasons.push(`CPC increased ${formatSignedPercent(deltas.cpc)}.`);
  if (deltas.cpa >= 20 && (current.cpa > 0 || previous.cpa > 0)) {
    reasons.push(`CPA increased ${formatSignedPercent(deltas.cpa)}.`);
  }
  if (deltas.conversions <= -20) {
    reasons.push(`Conversions fell ${formatSignedPercent(deltas.conversions)}.`);
  }
  if (deltas.spend >= 15 && deltas.conversions <= 0) {
    reasons.push(
      `Spend increased ${formatSignedPercent(deltas.spend)} without conversion growth.`
    );
  }
  if (current.spend > 0 && current.conversions === 0) {
    reasons.push(`It spent ${formatMetric(current.spend, "spend", config)} with no conversions.`);
  }
  if (deltas.ctr >= 15) reasons.push(`CTR improved ${formatSignedPercent(deltas.ctr)}.`);
  if (deltas.cpc <= -15) reasons.push(`CPC improved ${formatSignedPercent(deltas.cpc)}.`);
  if (deltas.conversions >= 20) {
    reasons.push(`Conversions increased ${formatSignedPercent(deltas.conversions)}.`);
  }
  if (deltas.cpa <= -15 && current.cpa > 0) reasons.push(`CPA improved ${formatSignedPercent(deltas.cpa)}.`);

  return uniqueList(reasons);
}

function scoreBadSegment(deltas, current, previous) {
  let score = 0;

  if (current.spend >= 1 || previous.spend >= 1) score += Math.min(current.spend, 500) / 25;
  if (deltas.ctr <= -10) score += Math.min(Math.abs(deltas.ctr), 100) * 0.7;
  if (deltas.cpc >= 10) score += Math.min(deltas.cpc, 150) * 0.55;
  if (deltas.cpa >= 15) score += Math.min(deltas.cpa, 150) * 0.65;
  if (deltas.conversions <= -10) score += Math.min(Math.abs(deltas.conversions), 100) * 0.8;
  if (deltas.spend >= 15 && deltas.conversions <= 0) score += 25;
  if (current.spend > 0 && current.conversions === 0) score += 20;

  return score;
}

function scoreGoodSegment(deltas, current, previous) {
  let score = 0;

  if (current.spend <= 0 && current.clicks <= 0) return 0;
  if (deltas.ctr >= 10) score += Math.min(deltas.ctr, 100) * 0.6;
  if (deltas.cpc <= -10) score += Math.min(Math.abs(deltas.cpc), 100) * 0.45;
  if (deltas.cpa <= -10 && current.cpa > 0) score += Math.min(Math.abs(deltas.cpa), 100) * 0.55;
  if (deltas.conversions >= 10) score += Math.min(deltas.conversions, 100) * 0.75;
  if (deltas.spend >= 10 && deltas.conversions >= 10) score += 12;

  return score;
}

function actionForUnderperformingAd(selected) {
  const actions = {
    creative_fatigue: "Pause this ad or refresh its hook, visual, and primary text today.",
    audience_saturation: "Reduce spend on this ad set or move this ad into a fresher audience.",
    engagement_quality_drop: "Refresh this ad creative before adding more budget.",
    aggressive_scaling: "Hold budget on this ad until CPC or CPA stabilizes.",
    conversion_funnel_breakdown: "Do not judge the ad alone; check the landing page and tracking for this traffic first.",
    auction_pressure: "Avoid scaling this ad today; test lower-cost placements or audiences.",
    delivery_instability: "Do not make a final call yet; review recent edits and delivery status for this ad.",
    traffic_quality_drop: "Reduce spend from this ad if its clicks are not converting.",
    volume_loss: "Check delivery restrictions, approvals, and budget limits for this ad.",
  };

  return actions[selected.id] || "Review this ad first and avoid increasing its budget today.";
}

function reasonsForClassification(reasons, deltas, underperforming, config) {
  const selected = reasons.filter((reason) => {
    if (underperforming) {
      return (
        reason.includes("dropped") ||
        reason.includes("increased") ||
        reason.includes("fell") ||
        reason.includes("without conversion") ||
        reason.includes("no conversions")
      );
    }

    return reason.includes("improved") || reason.includes("increased");
  });

  if (selected.length) return selected.slice(0, 4);

  if (underperforming) {
    return [`This ad shows the weakest efficiency movement in the latest comparison.`];
  }

  return [`This ad shows the strongest positive movement in the latest comparison.`];
}

function segmentSummary(segment, percentDeltas, config) {
  return {
    id: segment.id,
    campaignId: segment.campaignId,
    campaignName: segment.campaignName,
    adsetName: segment.adsetName,
    adName: segment.adName || null,
    current: {
      spend: formatMetric(segment.current.spend, "spend", config),
      impressions: formatMetric(segment.current.impressions, "impressions", config),
      clicks: formatMetric(segment.current.clicks, "clicks", config),
      conversions: formatMetric(segment.current.conversions, "conversions", config),
      ctr: formatMetricSafe(segment.current.ctr, "ctr", segment.current, config).value,
      cpc: formatMetricSafe(segment.current.cpc, "cpc", segment.current, config).value,
      cpa: formatMetricSafe(segment.current.cpa, "cpa", segment.current, config).value,
    },
    previous: {
      spend: formatMetric(segment.previous.spend, "spend", config),
      impressions: formatMetric(segment.previous.impressions, "impressions", config),
      clicks: formatMetric(segment.previous.clicks, "clicks", config),
      conversions: formatMetric(segment.previous.conversions, "conversions", config),
      ctr: formatMetricSafe(segment.previous.ctr, "ctr", segment.previous, config).value,
      cpc: formatMetricSafe(segment.previous.cpc, "cpc", segment.previous, config).value,
      cpa: formatMetricSafe(segment.previous.cpa, "cpa", segment.previous, config).value,
    },
    deltas: {
      spend: formatSignedPercent(percentDeltas.spend),
      impressions: formatSignedPercent(percentDeltas.impressions),
      clicks: formatSignedPercent(percentDeltas.clicks),
      conversions: formatSignedPercent(percentDeltas.conversions),
      ctr: formatSignedPercent(percentDeltas.ctr),
      cpc: formatSignedPercent(percentDeltas.cpc),
      cpa: formatSignedPercent(percentDeltas.cpa),
    },
  };
}

function segmentKey(row) {
  return [
    row.campaign_id || row.campaignId || "campaign_unknown",
    row.adset_id || row.adsetId || row.adset_name || row.adsetName || "adset_unknown",
    row.ad_id || row.adId || row.ad_name || row.adName || "ad_unknown",
  ].join("|");
}

function emptySegmentMetrics() {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
  };
}

function finalizeSegmentMetrics(metrics) {
  return {
    spend: round(metrics.spend, 2),
    impressions: round(metrics.impressions, 0),
    clicks: round(metrics.clicks, 0),
    conversions: round(metrics.conversions, 2),
    ctr: round(safeDivide(metrics.clicks * 100, metrics.impressions), 2),
    cpc: round(safeDivide(metrics.spend, metrics.clicks), 2),
    cpa: round(safeDivide(metrics.spend, metrics.conversions), 2),
  };
}

function insufficientData(reason, context = {}) {
  return {
    status: "insufficient_data",
    engineVersion: "1.0.0",
    analysisType: "daily_comparison",
    guidanceCoverage: {
      mode: "archetype_and_metric_specific_playbooks",
      supportedMetrics: Object.keys(METRIC_DEFINITIONS),
    },
    executiveSummary: reason,
    userInsight: {
      headline: "There is not enough data to give a reliable recommendation.",
      plainSummary: reason,
      decisionBrief: {
        decision: "fix_data",
        label: "Fix the Meta data feed",
        urgency: "fix_data",
        timeframe: "Before sending recommendations",
        primaryAction:
          "Fetch Meta Insights with time_increment=1 and at least two completed daily rows.",
        secondaryAction:
          "Include spend, impressions, clicks, CTR, CPC, CPM, reach, frequency, actions, and cost_per_action_type.",
        doNotDo: "Do not send an optimization recommendation from incomplete data.",
        plainReason:
          "The narrator needs two comparable completed days before it can separate signal from noise.",
        expectedResult: "Two completed daily rows are available and the narrator can produce a clear next step.",
        ifNoImprovement:
          "If the Meta response still has one day or no dates, check the insight date preset and permissions.",
        owner: "Developer or account owner",
        impact: "No reliable impact estimate until daily data is available.",
        confidence: "Low",
        mainMetric: null,
        comparedWith: null,
        currentDate: null,
        actionChecklist: [
          "Request Meta Insights with time_increment=1.",
          "Exclude today's partial data from the comparison.",
          "Run the narrator again after two completed days are available.",
        ],
      },
      simpleDiagnosis: {
        title: "Insufficient Data",
        inPlainEnglish:
          "There are not enough completed daily rows to give a reliable recommendation.",
        evidence: [
          "The report needs at least two completed daily Meta insight rows.",
        ],
      },
      plainEnglishEvidence: [],
      whatHappened: [
        "The report needs at least two completed daily Meta insight rows.",
      ],
      whyItMatters:
        "Without two comparable days, any recommendation could point you in the wrong direction.",
      whatToDoNext: [
        "Fetch Meta Insights with time_increment=1.",
        "Include spend, impressions, clicks, CTR, CPC, CPM, reach, frequency, actions, and cost_per_action_type.",
        "Run the narrator again after two completed days are available.",
      ],
      watchNext: {
        timeframe: "After the next successful fetch",
        metrics: ["Spend", "Impressions", "Clicks", "CTR", "CPC", "Conversions"],
        goodSign: "Two completed daily rows are available.",
        badSign: "The Meta response still has only one day or no dated rows.",
      },
      confidence: "Low",
      urgency: "fix_data",
    },
    decisionType: {
      id: "data_issue",
      label: "Data Issue",
      description: "The data is not reliable enough for campaign optimization decisions.",
    },
    trustGate: {
      level: "low",
      actionability: "fix_data",
      blocked: true,
      reasons: [reason],
      caveats: ["No optimization recommendation should be made until data quality is fixed."],
      flags: {
        dataWindowMismatch: false,
        lowSpend: true,
        lowClicks: true,
        noConversions: true,
        noBaseline: true,
        noAdLevelData: true,
      },
    },
    topContributor: {
      available: false,
      level: null,
      name: null,
      contributionSummary:
        "Ad-level data was not included, so the engine can only diagnose campaign-level movement.",
      recommendedAction: "Break this campaign down by ad before making creative changes.",
      evidence: [],
    },
    followUp: {
      available: false,
      previousDecision: null,
      status: "inconclusive",
      summary: "",
      escalation: null,
    },
    displayMetrics: {},
    reportGoalAssessment: {
      available: false,
      objective: null,
      primaryKpi: null,
      targetSummary: null,
      assessment: "No reliable goal assessment is available until comparable Meta data exists.",
    },
    campaign: {
      id: context.campaignId || null,
      name: context.campaignName || null,
    },
    reason,
    dataQuality: {
      level: "insufficient",
      inputRows: 0,
      datedRows: 0,
      aggregatedDailyRows: 0,
      comparedRows: 0,
      warnings: [reason],
    },
    snapshot: {},
    keyDelta: "Insufficient daily data",
    likelyCause: {
      archetype: "Insufficient Data",
      confidence: { level: "Low", score: 0 },
      summary: reason,
      evidence: [],
    },
    financialImpact: {
      type: "unavailable",
      amount: 0,
      displayAmount: "N/A",
      shouldDisplayAmount: false,
      currency: context.currency || DEFAULT_OPTIONS.currency,
      summary: "Financial impact cannot be estimated without two comparable daily rows.",
      method: "No estimate.",
      caveats: [reason],
    },
    decision:
      "Pull campaign insights with daily breakdown enabled, then compare the latest two completed days.",
    recommendations: [
      {
        priority: "P1",
        urgency: "high",
        title: "Fetch daily Meta insights",
        action:
          "Request Meta Insights with time_increment=1 and include spend, impressions, clicks, reach, frequency, cpm, ctr, cpc, actions, and cost_per_action_type.",
        reason,
      },
    ],
    diagnosticChecks: [
      "Confirm the Meta request uses a daily breakdown.",
      "Confirm at least two completed days are returned.",
      "Confirm spend and impressions are not both below the configured minimums.",
    ],
    monitoringPlan: {
      window: "after_next_successful_fetch",
      cadence: "daily",
      watchMetrics: ["Spend", "Impressions", "Clicks", "CTR", "CPC", "Conversions"],
      successSignal: "Two comparable daily rows are available.",
      rollbackSignal: "No action recommended until data is available.",
    },
    guardrails: [],
    nextSignal: "The engine needs two daily rows before producing a decision.",
    segmentContributors: [],
  };
}

function confidenceFrom(checks) {
  const passed = checks.filter(Boolean).length;
  const ratio = passed / checks.length;

  if (ratio >= 0.75) return { level: "High", score: 24 };
  if (ratio >= 0.5) return { level: "Medium", score: 16 };
  return { level: "Low", score: 8 };
}

function severityLevel(score) {
  if (score >= 115) return "critical";
  if (score >= 75) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function severityAdjective(score) {
  if (score >= 80) return "Critical";
  if (score >= 45) return "Major";
  return "Material";
}

function percentChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return current > 0 ? 100 : -100;
  return round(((current - previous) / Math.abs(previous)) * 100, 2);
}

function safeDivide(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function number(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function formatSignedPercent(value) {
  const rounded = round(value, 1);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}%`;
}

function formatAbsolutePercent(value) {
  return `${Math.abs(round(value, 1))}%`;
}

function movementVerb(metric, delta) {
  if (metric === "ctr" || metric === "conversionRate") {
    return delta > 0 ? "improved" : "dropped";
  }

  if (metric === "cpc" || metric === "cpm" || metric === "cpa") {
    return delta > 0 ? "became more expensive" : "became cheaper";
  }

  if (metric === "conversions" || metric === "clicks" || metric === "impressions" || metric === "reach") {
    return delta > 0 ? "increased" : "fell";
  }

  if (metric === "roas") {
    return delta > 0 ? "improved" : "dropped";
  }

  if (metric === "spend" || metric === "frequency") {
    return delta > 0 ? "increased" : "decreased";
  }

  return delta > 0 ? "increased" : "decreased";
}

function formatMetric(value, metric, config) {
  const definition = METRIC_DEFINITIONS[metric];
  if (!definition) return String(value);

  if (definition.unit === "money") {
    return `${config.currencySymbol || ""}${formatNumber(value)}`;
  }

  if (definition.unit === "percent") {
    return `${round(value, 2)}%`;
  }

  return formatNumber(value);
}

function formatNumber(value) {
  const rounded = round(value, Math.abs(value) >= 100 ? 0 : 2);
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: Math.abs(rounded) >= 100 ? 0 : 2,
  }).format(rounded);
}

function uniqueList(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

export {
  generatePerformanceNarrative,
  generateOperationalInsight,
  normalizeMetaDailyRow,
  calculateDeltas,
  rankAnomalies,
  matchBestArchetype,
  ARCHETYPES,
  METRIC_DEFINITIONS,
};
