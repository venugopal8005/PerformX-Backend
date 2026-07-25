import { getActivityDisplay } from "./activityDisplay.js";
import {
  asHistoricalRecord,
  hasHistoricalValue,
  safeHistoricalBoolean,
  safeHistoricalDate,
  safeHistoricalNumber,
  safeHistoricalObjectId,
  safeHistoricalString,
  safeHistoricalTextArray,
} from "./historicalValueSanitizer.js";

const METRIC_KEYS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "conversions",
  "conversionValue",
  "conversionRate",
  "cvr",
  "roas",
  "cpa",
];
const DELTA_KEYS = METRIC_KEYS.flatMap((key) => [key, `${key}_change_percent`]);
const TRUST_FLAG_KEYS = [
  "dataWindowMismatch",
  "lowSpend",
  "lowClicks",
  "noConversions",
  "noBaseline",
  "noAdLevelData",
];
const MAX_CAMPAIGNS = 50;
const MAX_RECOMMENDATIONS = 10;

const record = (value) => asHistoricalRecord(value) || {};
const idString = (value) => safeHistoricalObjectId(value);
const text = (value, maximum) => safeHistoricalString(value, maximum);
const number = (value) => safeHistoricalNumber(value);
const bool = (value) => safeHistoricalBoolean(value);

const safeIdentifier = (value) => idString(value) || text(value, 256);

const safeSchedule = (schedule) => {
  const value = asHistoricalRecord(schedule);
  if (!value) return null;
  return {
    timezone: text(value.timezone, 128),
    time_of_day: text(value.time_of_day, 32),
    day_of_week: Number.isInteger(value.day_of_week) ? value.day_of_week : null,
    day_of_month: Number.isInteger(value.day_of_month) ? value.day_of_month : null,
  };
};

const safePeriodPoint = (point) => {
  if (typeof point === "string") return text(point, 128);
  if (point instanceof Date) return safeHistoricalDate(point);
  const value = asHistoricalRecord(point);
  if (!value) return null;
  return {
    start: text(value.start, 128) || safeHistoricalDate(value.start),
    end: text(value.end, 128) || safeHistoricalDate(value.end),
    date: text(value.date, 128) || safeHistoricalDate(value.date),
    label: text(value.label, 256),
  };
};

const safePeriod = (period) => {
  const value = asHistoricalRecord(period);
  if (!value) return null;
  return {
    type: text(value.type, 64),
    current: safePeriodPoint(value.current),
    previous: safePeriodPoint(value.previous),
    latestActiveDate:
      text(value.latestActiveDate, 128) || safeHistoricalDate(value.latestActiveDate),
  };
};

const safeNumberMap = (source, allowedKeys) => {
  const value = asHistoricalRecord(source);
  if (!value) return {};
  return Object.fromEntries(
    allowedKeys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key] === null ? null : number(value[key])])
      .filter(([, item]) => item !== null || value !== undefined)
  );
};

const safeMetrics = (metrics) => safeNumberMap(metrics, METRIC_KEYS);
const safeDeltas = (deltas) => safeNumberMap(deltas, DELTA_KEYS);

const safeRowCounts = (rowCounts) => {
  const value = asHistoricalRecord(rowCounts);
  if (!value) return null;
  return {
    current: number(value.current),
    previous: number(value.previous),
    total: number(value.total),
  };
};

const safeFlags = (flags) => {
  const value = asHistoricalRecord(flags);
  if (!value) return null;
  return Object.fromEntries(
    TRUST_FLAG_KEYS.map((key) => [key, bool(value[key])]).filter(([, item]) => item !== null)
  );
};

const safeDataQuality = (dataQuality) => {
  const value = asHistoricalRecord(dataQuality);
  if (!value) return null;
  const rowCoverage = asHistoricalRecord(value.rowCoverage);
  return {
    level: text(value.level, 64),
    status: text(value.status, 64),
    score: number(value.score),
    summary: text(value.summary),
    reasons: safeHistoricalTextArray(value.reasons),
    warnings: safeHistoricalTextArray(value.warnings),
    missingFields: safeHistoricalTextArray(value.missingFields),
    flags: safeFlags(value.flags),
    rowCoverage: rowCoverage
      ? {
          inputRows: number(rowCoverage.inputRows),
          filteredRows: number(rowCoverage.filteredRows),
          aggregatedDailyRows: number(rowCoverage.aggregatedDailyRows),
        }
      : null,
  };
};

const safeTrustGate = (trustGate) => {
  const value = asHistoricalRecord(trustGate);
  if (!value) return null;
  return {
    level: text(value.level, 64),
    actionability: text(value.actionability, 64),
    blocked: bool(value.blocked),
    reasons: safeHistoricalTextArray(value.reasons),
    caveats: safeHistoricalTextArray(value.caveats),
    flags: safeFlags(value.flags),
    severityCap: text(value.severityCap, 64),
    decisionTypeOverride: text(value.decisionTypeOverride, 128),
    primaryActionOverride: text(value.primaryActionOverride),
  };
};

const safeDecisionType = (decisionType) => {
  const value = asHistoricalRecord(decisionType);
  if (!value) return null;
  return {
    id: text(value.id, 128),
    label: text(value.label, 256),
    description: text(value.description),
  };
};

const safeConfidence = (confidence) => {
  if (typeof confidence === "string") return text(confidence, 64);
  const value = asHistoricalRecord(confidence);
  if (!value) return null;
  return {
    level: text(value.level, 64),
    score: number(value.score),
    summary: text(value.summary),
  };
};

const safeEvidence = (items) =>
  Array.isArray(items)
    ? items.slice(0, 10).map((item) => {
        if (typeof item === "string") return text(item);
        const value = asHistoricalRecord(item);
        if (!value) return null;
        return {
          metric: text(value.metric, 128),
          change: text(value.change, 128),
          meaning: text(value.meaning),
          summary: text(value.summary),
        };
      }).filter(Boolean)
    : [];

const safeRecommendation = (recommendation) => {
  if (typeof recommendation === "string") return text(recommendation);
  const value = asHistoricalRecord(recommendation);
  if (!value) return null;
  return {
    priority: text(value.priority, 32),
    urgency: text(value.urgency, 64),
    title: text(value.title, 512),
    action: text(value.action),
    reason: text(value.reason),
  };
};

const safeRecommendations = (recommendations) =>
  Array.isArray(recommendations)
    ? recommendations.slice(0, MAX_RECOMMENDATIONS).map(safeRecommendation).filter(Boolean)
    : [];

const safeWatchNext = (watchNext) => {
  const value = asHistoricalRecord(watchNext);
  if (!value) return null;
  return {
    timeframe: text(value.timeframe, 256),
    metrics: safeHistoricalTextArray(value.metrics, { maximum: 10, textMaximum: 128 }),
    goodSign: text(value.goodSign),
    badSign: text(value.badSign),
  };
};

const safeDecisionBrief = (decisionBrief) => {
  const value = asHistoricalRecord(decisionBrief);
  if (!value) return null;
  const mainMetric = asHistoricalRecord(value.mainMetric);
  return {
    decision: text(value.decision, 128),
    label: text(value.label, 512),
    decisionType: safeDecisionType(value.decisionType),
    urgency: text(value.urgency, 64),
    timeframe: text(value.timeframe, 256),
    primaryAction: text(value.primaryAction),
    secondaryAction: text(value.secondaryAction),
    doNotDo: text(value.doNotDo),
    plainReason: text(value.plainReason),
    expectedResult: text(value.expectedResult),
    ifNoImprovement: text(value.ifNoImprovement),
    owner: text(value.owner, 256),
    impact: text(value.impact, 512),
    confidence: safeConfidence(value.confidence),
    mainMetric: mainMetric
      ? {
          label: text(mainMetric.label, 128),
          change: text(mainMetric.change, 128),
          plainChange: text(mainMetric.plainChange, 512),
        }
      : null,
    comparedWith: text(value.comparedWith, 128) || safeHistoricalDate(value.comparedWith),
    currentDate: text(value.currentDate, 128) || safeHistoricalDate(value.currentDate),
    actionChecklist: safeHistoricalTextArray(value.actionChecklist, { maximum: 10 }),
  };
};

const safeTrustSummary = (trust) => {
  const value = asHistoricalRecord(trust);
  if (!value) return null;
  const baseline = asHistoricalRecord(value.baseline);
  return {
    level: text(value.level, 64),
    score: number(value.score),
    summary: text(value.summary),
    caveats: safeHistoricalTextArray(value.caveats),
    baseline: baseline
      ? {
          level: text(baseline.level, 64),
          available: bool(baseline.available),
          comparedDays: number(baseline.comparedDays),
          requiredDays: number(baseline.requiredDays),
          summary: text(baseline.summary),
        }
      : null,
  };
};

const safeAdIdentity = (ad) => {
  const value = asHistoricalRecord(ad);
  if (!value) return null;
  return {
    id: safeIdentifier(value.id),
    campaignId: safeIdentifier(value.campaignId),
    campaignName: text(value.campaignName, 512),
    adsetName: text(value.adsetName, 512),
    adName: text(value.adName, 512),
    classification: text(value.classification, 64),
    score: number(value.score),
    action: text(value.action),
    reasons: safeHistoricalTextArray(value.reasons),
  };
};

const safeTopContributor = (topContributor) => {
  const value = asHistoricalRecord(topContributor);
  if (!value) return null;
  return {
    available: bool(value.available),
    level: text(value.level, 64),
    name: text(value.name, 512),
    contributionSummary: text(value.contributionSummary),
    recommendedAction: text(value.recommendedAction),
    evidence: safeHistoricalTextArray(value.evidence),
    metrics: asHistoricalRecord(value.metrics)
      ? {
          current: safeMetrics(value.metrics.current),
          previous: safeMetrics(value.metrics.previous),
          deltas: safeDeltas(value.metrics.deltas),
        }
      : null,
  };
};

const safeUserInsight = (userInsight) => {
  const value = asHistoricalRecord(userInsight);
  if (!value) return null;
  const diagnosis = asHistoricalRecord(value.simpleDiagnosis);
  const goal = asHistoricalRecord(value.reportGoalAssessment);
  return {
    headline: text(value.headline, 512),
    plainSummary: text(value.plainSummary),
    decisionBrief: safeDecisionBrief(value.decisionBrief),
    trust: safeTrustSummary(value.trust),
    trustGate: safeTrustGate(value.trustGate),
    decisionType: safeDecisionType(value.decisionType),
    topContributor: safeTopContributor(value.topContributor),
    reportGoalAssessment: goal
      ? {
          available: bool(goal.available),
          objective: text(goal.objective, 256),
          primaryKpi: text(goal.primaryKpi, 128),
          targetSummary: text(goal.targetSummary, 512),
          assessment: text(goal.assessment),
        }
      : null,
    whatHappened: safeHistoricalTextArray(value.whatHappened, { maximum: 10 }),
    simpleDiagnosis: diagnosis
      ? {
          title: text(diagnosis.title, 512),
          inPlainEnglish: text(diagnosis.inPlainEnglish),
          evidence: safeHistoricalTextArray(diagnosis.evidence, { maximum: 10 }),
        }
      : null,
    plainEnglishEvidence: safeEvidence(value.plainEnglishEvidence),
    whyItMatters: text(value.whyItMatters),
    adToFixFirst: safeAdIdentity(value.adToFixFirst),
    adToProtect: safeAdIdentity(value.adToProtect),
    adsToWatch: Array.isArray(value.adsToWatch)
      ? value.adsToWatch.slice(0, 5).map(safeAdIdentity).filter(Boolean)
      : [],
    whatToDoNext: safeHistoricalTextArray(value.whatToDoNext, { maximum: 10 }),
    watchNext: safeWatchNext(value.watchNext),
    confidence: safeConfidence(value.confidence),
    urgency: text(value.urgency, 64),
  };
};

const safeLikelyCause = (likelyCause) => {
  if (typeof likelyCause === "string") return text(likelyCause);
  const value = asHistoricalRecord(likelyCause);
  if (!value) return null;
  return {
    id: text(value.id, 128),
    archetype: text(value.archetype, 512),
    confidence: safeConfidence(value.confidence),
    summary: text(value.summary),
    evidence: safeEvidence(value.evidence),
  };
};

const safeNarrativeMetrics = (metrics) => {
  const value = asHistoricalRecord(metrics);
  if (!value) return null;
  return {
    current: safeMetrics(value.current),
    previous: safeMetrics(value.previous),
    deltas: safeDeltas(value.deltas),
  };
};

const safeNarrative = (narrative) => {
  const value = asHistoricalRecord(narrative);
  if (!value) return null;
  const campaign = asHistoricalRecord(value.campaign);
  const severity = asHistoricalRecord(value.severity);
  return {
    status: text(value.status, 64),
    reason: text(value.reason),
    engineVersion: text(value.engineVersion, 64),
    analysisType: text(value.analysisType, 128),
    executiveSummary: text(value.executiveSummary),
    keyDelta: text(value.keyDelta),
    decision: text(value.decision),
    nextSignal: text(value.nextSignal),
    disclaimer: text(value.disclaimer),
    comparisonMode: text(value.comparisonMode, 128),
    period: safePeriod(value.period),
    scheduledPeriod: safePeriod(value.scheduledPeriod),
    campaign: campaign
      ? { id: safeIdentifier(campaign.id), name: text(campaign.name, 512) }
      : null,
    severity: severity
      ? { level: text(severity.level, 64), score: number(severity.score) }
      : null,
    decisionType: safeDecisionType(value.decisionType),
    likelyCause: safeLikelyCause(value.likelyCause),
    recommendations: safeRecommendations(value.recommendations),
    diagnosticChecks: safeHistoricalTextArray(value.diagnosticChecks),
    dataQuality: safeDataQuality(value.dataQuality),
    trustGate: safeTrustGate(value.trustGate),
    userInsight: safeUserInsight(value.userInsight),
    metrics: safeNarrativeMetrics(value.metrics),
  };
};

const safeComparison = (comparison) => {
  const value = asHistoricalRecord(comparison);
  if (!value) return null;
  return {
    mode: text(value.mode, 128),
    period: safePeriod(value.period),
    scheduledPeriod: safePeriod(value.scheduledPeriod),
    currentPeriodMetrics: safeMetrics(value.currentPeriodMetrics),
    previousPeriodMetrics: safeMetrics(value.previousPeriodMetrics),
    deltas: safeDeltas(value.deltas),
    rowCounts: safeRowCounts(value.rowCounts),
    disclaimer: text(value.disclaimer),
  };
};

const safeContext = (snapshot) => {
  const value = asHistoricalRecord(snapshot);
  if (!value) return null;
  const workspace = record(value.workspace);
  const client = record(value.client);
  const report = record(value.report);
  const actor = record(value.actor);
  const configuration = asHistoricalRecord(report.configuration);
  return {
    version: number(value.version),
    capturedAt: safeHistoricalDate(value.captured_at),
    source: text(value.source, 128),
    workspace: { name: text(workspace.name, 512) },
    client: { name: text(client.name, 512) },
    report: {
      name: text(report.name, 512),
      configuration: configuration
        ? {
            type: text(configuration.type, 64),
            schedule: safeSchedule(configuration.schedule),
            clientDeliveryMode: text(configuration.client_delivery_mode, 64),
            generateClientReport: bool(configuration.generate_client_report),
            generateInternalReport: bool(configuration.generate_internal_report),
          }
        : null,
    },
    actor: { name: text(actor.name, 512) },
  };
};

const safeSignalContext = (snapshot) => {
  const value = asHistoricalRecord(snapshot);
  if (!value) return null;
  const workspace = record(value.workspace);
  const client = record(value.client);
  const report = record(value.report);
  const meta = record(value.meta_account);
  return {
    version: number(value.version),
    capturedAt: safeHistoricalDate(value.captured_at),
    source: text(value.source, 128),
    workspace: { name: text(workspace.name, 512) },
    client: { name: text(client.name, 512) },
    report: { name: text(report.name, 512) },
    metaAccount: {
      id: idString(meta.meta_ad_account_id),
      externalId: text(meta.external_account_id, 256),
      name: text(meta.name, 512),
    },
    campaigns: Array.isArray(value.campaigns)
      ? value.campaigns.slice(0, MAX_CAMPAIGNS).map((campaign) => ({
          id: safeIdentifier(campaign?.campaign_id),
          name: text(campaign?.campaign_name, 512),
        }))
      : [],
  };
};

const legacySignalContext = (context) =>
  context
    ? {
        version: context.version,
        captured_at: context.capturedAt,
        source: context.source,
        workspace: context.workspace,
        client: context.client,
        report: context.report,
        meta_account: {
          meta_ad_account_id: context.metaAccount.id,
          external_account_id: context.metaAccount.externalId,
          name: context.metaAccount.name,
        },
        campaigns: context.campaigns.map((campaign) => ({
          campaign_id: campaign.id,
          campaign_name: campaign.name,
        })),
      }
    : null;

const safeArtifactStatus = (artifact) => {
  const value = asHistoricalRecord(artifact);
  if (!value) return null;
  const safety = asHistoricalRecord(value.safety);
  return {
    status: text(value.status, 64),
    sent_at: safeHistoricalDate(value.sent_at),
    approved_at: safeHistoricalDate(value.approved_at),
    cancelled_at: safeHistoricalDate(value.cancelled_at),
    safety: safety
      ? {
          passed: bool(safety.passed),
          reasons: safeHistoricalTextArray(safety.reasons),
          warnings: safeHistoricalTextArray(safety.warnings),
        }
      : null,
  };
};

const safeSafetySettings = (settings) => {
  const value = asHistoricalRecord(settings);
  if (!value) return null;
  return {
    hold_client_report_on_low_trust: bool(value.hold_client_report_on_low_trust),
    hold_client_report_on_missing_metrics: bool(value.hold_client_report_on_missing_metrics),
    hold_client_report_on_insufficient_data: bool(
      value.hold_client_report_on_insufficient_data
    ),
    notify_team_when_held: bool(value.notify_team_when_held),
  };
};

const hasArtifact = (artifact) => {
  const value = asHistoricalRecord(artifact);
  return Boolean(
    value &&
      [
        value.status,
        value.subject,
        value.html,
        value.text,
        value.sent_at,
        value.approved_at,
        value.cancelled_at,
      ].some(hasHistoricalValue)
  );
};

const actorIdentity = (actor) => {
  const value = asHistoricalRecord(actor);
  const id = idString(value);
  if (!value || !id) return null;
  return { id, displayName: text(value.full_name || value.displayName, 512) };
};

const sourceFor = ({ snapshotValue, currentValue, persistedSnapshotValue }) => {
  if (hasHistoricalValue(snapshotValue) || hasHistoricalValue(persistedSnapshotValue)) {
    return "snapshot";
  }
  if (hasHistoricalValue(currentValue)) return "current_parent";
  return "unknown";
};

const resolveRunIdentity = (reportRun, fallback = {}) => {
  const run = record(reportRun);
  const snapshot = record(run.context_snapshot);
  const snapshotClient = record(snapshot.client);
  const snapshotReport = record(snapshot.report);
  const snapshotWorkspace = record(snapshot.workspace);
  const currentClient = record(fallback.client);
  const currentReport = record(fallback.report);
  const currentMeta = record(fallback.metaAccount);
  const snapshotClientName = text(snapshotClient.name, 512);
  const snapshotReportName = text(snapshotReport.name, 512);
  const persistedMetaName = text(run.meta_account_name_snapshot, 512);
  const persistedMetaExternalId = text(run.meta_account_external_id_snapshot, 256);
  const fallbackMetaSnapshotName = fallback.metaAccountIsSnapshot
    ? text(currentMeta.name, 512)
    : null;
  const fallbackMetaSnapshotExternalId = fallback.metaAccountIsSnapshot
    ? text(currentMeta.externalId, 256)
    : null;

  const sources = {
    agency: sourceFor({ snapshotValue: snapshotWorkspace.name }),
    client: sourceFor({
      snapshotValue: snapshotClientName,
      currentValue: currentClient.name,
    }),
    report: sourceFor({
      snapshotValue: snapshotReportName,
      currentValue: currentReport.name,
    }),
    metaAccount: sourceFor({
      persistedSnapshotValue:
        persistedMetaName ||
        persistedMetaExternalId ||
        fallbackMetaSnapshotName ||
        fallbackMetaSnapshotExternalId,
      currentValue: fallback.metaAccountIsSnapshot ? null : currentMeta.name,
    }),
  };

  return {
    client: {
      id: idString(run.client_id || currentClient._id || currentClient.id),
      name: snapshotClientName || text(currentClient.name, 512),
      isArchived: currentClient.is_archived === true,
    },
    report: {
      id: idString(run.report_id || currentReport._id || currentReport.id),
      name: snapshotReportName || text(currentReport.name, 512),
    },
    metaAccount: {
      id: idString(run.meta_ad_account_id || currentMeta._id || currentMeta.id),
      externalId:
        persistedMetaExternalId ||
        fallbackMetaSnapshotExternalId ||
        text(currentMeta.externalId, 256),
      name:
        persistedMetaName || fallbackMetaSnapshotName || text(currentMeta.name, 512),
    },
    sources,
  };
};

const identityCompleteness = ({ identity, sources, requireMeta = true }) => {
  const required = [
    { value: identity.report?.name, source: sources.report },
    { value: identity.client?.name, source: sources.client },
    ...(requireMeta
      ? [
          {
            value:
              identity.metaAccount?.id ||
              identity.metaAccount?.externalId ||
              identity.metaAccount?.name,
            source: sources.metaAccount,
          },
        ]
      : []),
  ];
  if (required.every((item) => hasHistoricalValue(item.value) && item.source === "snapshot")) {
    return "complete";
  }
  if (required.some((item) => hasHistoricalValue(item.value))) return "partial";
  return "legacy_unknown";
};

const safeSignalMetadata = (metadata) => {
  const value = asHistoricalRecord(metadata);
  if (!value) return {};
  return {
    ...(typeof value.narrator_status === "string"
      ? { narrator_status: text(value.narrator_status, 64) }
      : {}),
    ...(typeof value.reason === "string" ? { reason: text(value.reason) } : {}),
    ...(asHistoricalRecord(value.data_quality)
      ? { data_quality: safeDataQuality(value.data_quality) }
      : {}),
    ...(Array.isArray(value.action_checklist)
      ? { action_checklist: safeHistoricalTextArray(value.action_checklist, { maximum: 10 }) }
      : {}),
    ...(asHistoricalRecord(value.watch_next)
      ? { watch_next: safeWatchNext(value.watch_next) }
      : {}),
    ...(asHistoricalRecord(value.period) ? { period: safePeriod(value.period) } : {}),
    ...(typeof value.archetype_id === "string"
      ? { archetype_id: text(value.archetype_id, 128) }
      : {}),
    ...(typeof value.archetype === "string"
      ? { archetype: text(value.archetype, 512) }
      : {}),
    ...(typeof value.decision === "string" ? { decision: text(value.decision) } : {}),
    ...(typeof value.key_delta === "string" ? { key_delta: text(value.key_delta) } : {}),
    ...(asHistoricalRecord(value.primary_anomaly)
      ? {
          primary_anomaly: {
            metric: text(value.primary_anomaly.metric, 128),
            label: text(value.primary_anomaly.label, 256),
            delta: number(value.primary_anomaly.delta),
            direction: text(value.primary_anomaly.direction, 32),
          },
        }
      : {}),
    ...(asHistoricalRecord(value.deltas) ? { deltas: safeDeltas(value.deltas) } : {}),
    ...(asHistoricalRecord(value.current_metrics)
      ? { current_metrics: safeMetrics(value.current_metrics) }
      : {}),
    ...(asHistoricalRecord(value.previous_metrics)
      ? { previous_metrics: safeMetrics(value.previous_metrics) }
      : {}),
    ...(Array.isArray(value.recommendations)
      ? { recommendations: safeRecommendations(value.recommendations) }
      : {}),
  };
};

const safeActivityMetadata = (metadata) => {
  const value = asHistoricalRecord(metadata);
  if (!value) return {};
  const result = {};
  const idKeys = [
    "signal_id",
    "report_run_id",
    "report_id",
    "client_id",
    "connection_id",
    "meta_user_id",
    "meta_ad_account_id",
    "ad_account_id",
    "previous_client_id",
    "intervention_id",
    "issue_id",
  ];
  const textKeys = [
    "signal_type",
    "report_name",
    "client_name",
    "sync_status",
    "execution_source",
    "decision",
    "key_delta",
    "archetype",
    "report_type",
    "comparison_mode",
    "client_delivery_mode",
    "confidence",
    "failure_stage",
    "error_code",
    "action_type",
    "recorder_display_name_snapshot",
  ];
  const numberKeys = [
    "signal_count",
    "archived_report_count",
    "synced_count",
    "new_count",
    "failure_count",
    "campaign_count",
  ];

  for (const key of idKeys) {
    const item = safeIdentifier(value[key]);
    if (item) result[key] = item;
  }
  for (const key of textKeys) {
    const item = text(value[key]);
    if (item !== null) result[key] = item;
  }
  for (const key of numberKeys) {
    const item = number(value[key]);
    if (item !== null) result[key] = item;
  }
  if (typeof value.meta_identity_changed === "boolean") {
    result.meta_identity_changed = value.meta_identity_changed;
  }
  if (Array.isArray(value.updated_fields)) {
    result.updated_fields = safeHistoricalTextArray(value.updated_fields, {
      maximum: 30,
      textMaximum: 128,
    });
  }
  if (asHistoricalRecord(value.period)) result.period = safePeriod(value.period);
  if (asHistoricalRecord(value.scheduled_period)) {
    result.scheduled_period = safePeriod(value.scheduled_period);
  }
  if (asHistoricalRecord(value.row_counts)) result.row_counts = safeRowCounts(value.row_counts);
  const nextRunAt = safeHistoricalDate(value.next_run_at);
  if (nextRunAt) result.next_run_at = nextRunAt;
  if (typeof value.estimated_impact === "number") {
    result.estimated_impact = number(value.estimated_impact);
  } else if (typeof value.estimated_impact === "string") {
    result.estimated_impact = text(value.estimated_impact, 512);
  }
  return result;
};

export const serializeArchivedClientSummary = ({
  client,
  actor = null,
  counts = {},
  lastActivity = null,
}) => {
  const value = record(client);
  const hasIdentity = Boolean(text(value.name, 512));
  return {
    _id: value._id,
    id: idString(value),
    name: text(value.name, 512),
    status: text(value.status, 64),
    is_archived: value.is_archived === true,
    archived_at: value.archived_at || null,
    archived_by: actorIdentity(actor),
    reportCount: number(counts.reports) || 0,
    reportRunCount: number(counts.reportRuns) || 0,
    signalCount: number(counts.signals) || 0,
    lastActivity: lastActivity ? serializeHistoricalActivity(lastActivity) : null,
    identitySources: {
      agency: "unknown",
      client: hasIdentity ? "current_parent" : "unknown",
      report: "unknown",
      metaAccount: "unknown",
    },
    identityCompleteness: hasIdentity ? "partial" : "legacy_unknown",
  };
};

export const serializeClientHistorySummary = ({ client, actor = null }) => {
  const value = record(client);
  const hasIdentity = Boolean(text(value.name, 512));
  return {
    _id: value._id,
    id: idString(value),
    name: text(value.name, 512),
    industry: text(value.industry, 512),
    notes: text(value.notes),
    status: text(value.status, 64),
    is_archived: value.is_archived === true,
    archived_at: value.archived_at || null,
    archived_by: actorIdentity(actor),
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
    identitySources: {
      agency: "unknown",
      client: hasIdentity ? "current_parent" : "unknown",
      report: "unknown",
      metaAccount: "unknown",
    },
    identityCompleteness: hasIdentity ? "partial" : "legacy_unknown",
  };
};

export const serializeReportHistorySummary = ({
  report,
  actor = null,
  latestRun = null,
  client = null,
  metaAccount = null,
  counts = {},
}) => {
  const value = record(report);
  const run = record(latestRun);
  const hasReportMetaSnapshot = Boolean(
    text(value.meta_account_external_id_snapshot, 256) ||
      text(value.meta_account_name_snapshot, 512)
  );
  const identity = resolveRunIdentity(run, {
    report: value,
    client,
    metaAccount: hasReportMetaSnapshot
      ? {
          id: value.meta_ad_account_id,
          externalId: value.meta_account_external_id_snapshot,
          name: value.meta_account_name_snapshot,
        }
      : metaAccount,
    metaAccountIsSnapshot: hasReportMetaSnapshot,
  });

  return {
    _id: value._id,
    id: idString(value),
    agency_id: value.agency_id || null,
    client_id: identity.client.id
      ? {
          _id: identity.client.id,
          name: identity.client.name,
          status: text(client?.status, 64),
          is_archived: client?.is_archived === true,
        }
      : null,
    client_ref_id: idString(value.client_id),
    meta_ad_account_id: identity.metaAccount.id
      ? {
          _id: identity.metaAccount.id,
          name: identity.metaAccount.name,
          ad_account_id: identity.metaAccount.externalId,
        }
      : null,
    meta_ad_account_ref_id: idString(value.meta_ad_account_id),
    meta_account_external_id_snapshot: text(value.meta_account_external_id_snapshot, 256),
    meta_account_name_snapshot: text(value.meta_account_name_snapshot, 512),
    name: identity.report.name,
    type: text(value.type, 64),
    reportType: text(value.type, 64),
    status: text(value.status, 64),
    severity: text(value.severity, 64),
    schedule: safeSchedule(value.schedule),
    recipients: safeHistoricalTextArray(value.recipients, { maximum: 100, textMaximum: 320 }),
    internal_recipients: safeHistoricalTextArray(value.internal_recipients, {
      maximum: 100,
      textMaximum: 320,
    }),
    client_recipients: safeHistoricalTextArray(value.client_recipients, {
      maximum: 100,
      textMaximum: 320,
    }),
    generate_client_report: bool(value.generate_client_report),
    generate_internal_report: bool(value.generate_internal_report),
    client_delivery_mode: text(value.client_delivery_mode, 64),
    safety_settings: safeSafetySettings(value.safety_settings),
    monitored_campaigns: Array.isArray(value.monitored_campaigns)
      ? value.monitored_campaigns.slice(0, MAX_CAMPAIGNS).map((campaign) => ({
          campaign_id: safeIdentifier(campaign?.campaign_id),
          campaign_name: text(campaign?.campaign_name, 512),
        }))
      : [],
    is_archived: value.is_archived === true,
    archived_at: value.archived_at || null,
    archived_by: actorIdentity(actor),
    client: {
      id: identity.client.id,
      name: identity.client.name,
      is_archived: identity.client.isArchived === true,
    },
    metaAccount: identity.metaAccount,
    last_summary: text(value.last_summary),
    last_signal_at: value.last_signal_at || null,
    next_run_at: value.next_run_at || null,
    last_run_at: value.last_run_at || null,
    lastRunAt: run.ran_at || value.last_run_at || null,
    reportRunCount: number(counts.reportRuns) || 0,
    signalCount: number(counts.signals) || 0,
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
    identitySources: identity.sources,
    identityCompleteness: identityCompleteness({
      identity,
      sources: identity.sources,
    }),
  };
};

export const serializeArchivedReportSummary = serializeReportHistorySummary;

export const serializeHistoricalReportRunSummary = (reportRun, fallback = {}) => {
  const value = record(reportRun);
  const identity = resolveRunIdentity(value, fallback);
  return {
    _id: value._id,
    id: idString(value),
    agency_id: value.agency_id || null,
    client_id: value.client_id || null,
    report_id: value.report_id || null,
    ran_at: value.ran_at || value.createdAt || null,
    createdAt: value.createdAt || null,
    status: text(value.status, 64),
    execution_stage: text(value.execution_stage, 64),
    trigger_type: text(value.trigger_type, 64),
    severity: text(value.severity, 64),
    summary: text(value.summary),
    key_delta: text(value.key_delta),
    likely_cause: text(value.likely_cause),
    decision: text(value.decision),
    next_signal: text(value.next_signal),
    context: safeContext(value.context_snapshot),
    context_snapshot: safeContext(value.context_snapshot),
    client: identity.client,
    report: identity.report,
    metaAccount: identity.metaAccount,
    artifactAvailability: {
      client: hasArtifact(value.client_report),
      internal: hasArtifact(value.internal_report),
    },
    client_report: safeArtifactStatus(value.client_report),
    internal_report: safeArtifactStatus(value.internal_report),
    period: safePeriod(value.period),
    comparison: safeComparison(value.comparison),
    narrative: safeNarrative(value.narrative),
    identitySources: identity.sources,
    identityCompleteness: identityCompleteness({
      identity,
      sources: identity.sources,
    }),
  };
};

export const serializeHistoricalReportRunDetail = (reportRun, fallback = {}) => {
  const value = record(reportRun);
  const summary = serializeHistoricalReportRunSummary(value, fallback);
  return {
    ...summary,
    startedAt: value.started_at || null,
    completedAt: value.completed_at || null,
    displayMetrics: safeMetrics(value.comparison?.currentPeriodMetrics),
    dataQuality: safeDataQuality(value.narrative?.dataQuality),
    campaigns: Array.isArray(value.monitored_campaigns)
      ? value.monitored_campaigns.slice(0, MAX_CAMPAIGNS).map((campaign) => ({
          id: safeIdentifier(campaign?.campaign_id),
          name: text(campaign?.campaign_name, 512),
        }))
      : [],
    delivery: {
      client: safeArtifactStatus(value.client_report),
      internal: safeArtifactStatus(value.internal_report),
    },
  };
};

export const serializeHistoricalSignal = (signal, fallback = {}) => {
  const value = record(signal);
  const context = safeSignalContext(value.context_snapshot);
  const currentClient = record(fallback.client);
  const currentReport = record(fallback.report);
  const snapshotClientName = context?.client?.name || null;
  const snapshotReportName = context?.report?.name || null;
  const client = {
    id: idString(value.client_id || currentClient._id || currentClient.id),
    name: snapshotClientName || text(currentClient.name, 512),
  };
  const report = {
    id: idString(value.report_id || currentReport._id || currentReport.id),
    name: snapshotReportName || text(currentReport.name, 512),
  };
  const metaAccount = context?.metaAccount || { id: null, externalId: null, name: null };
  const sources = {
    agency: context?.workspace?.name ? "snapshot" : "unknown",
    client: sourceFor({
      snapshotValue: snapshotClientName,
      currentValue: currentClient.name,
    }),
    report: sourceFor({
      snapshotValue: snapshotReportName,
      currentValue: currentReport.name,
    }),
    metaAccount:
      metaAccount.id || metaAccount.externalId || metaAccount.name ? "snapshot" : "unknown",
  };
  const identity = { client, report, metaAccount };
  const issueId = idString(value.issue_id);
  const issueMatchingStatus =
    text(value.issue_matching_status, 64) ||
    (issueId ? "matched" : "legacy_ungrouped");

  return {
    _id: value._id,
    id: idString(value),
    agency_id: value.agency_id || null,
    client_id: value.client_id || null,
    report_id: value.report_id || null,
    report_run_id: value.report_run_id || null,
    type: text(value.type, 128),
    severity: text(value.severity, 64),
    title: text(value.title, 512),
    description: text(value.description),
    recommendation: text(value.recommendation),
    campaign_id: text(value.campaign_id, 256),
    detected_at: value.detected_at || value.createdAt || null,
    context,
    context_snapshot: legacySignalContext(context),
    client,
    report,
    metaAccount,
    metadata: safeSignalMetadata(value.metadata),
    issue: {
      id: issueId,
      occurrenceNumber: number(value.issue_occurrence_number),
      fingerprintSnapshot: text(value.issue_fingerprint_snapshot, 64),
      matchingStatus: issueMatchingStatus,
      matchingReason: text(value.issue_matching_reason, 128),
      matchingVersion: number(value.matching_version),
      matchedAt: safeHistoricalDate(value.matched_at),
    },
    identitySources: sources,
    identityCompleteness: identityCompleteness({ identity, sources }),
  };
};

export const serializeHistoricalActivity = (
  activity,
  actor = null,
  { actorSource = "unknown" } = {}
) => {
  const value = record(activity);
  const metadata = safeActivityMetadata(value.metadata);
  const actorSnapshotName = text(metadata.recorder_display_name_snapshot, 512);
  const currentActor = actorIdentity(actor);
  const resolvedActor = actorSnapshotName
    ? { id: idString(value.user_id), displayName: actorSnapshotName }
    : currentActor;
  const resolvedActorSource = actorSnapshotName
    ? "snapshot"
    : resolvedActor && actorSource === "workspace_member"
      ? "workspace_member"
      : "unknown";
  const sources = {
    agency: "unknown",
    client: hasHistoricalValue(metadata.client_name) ? "snapshot" : "unknown",
    report: hasHistoricalValue(metadata.report_name) ? "snapshot" : "unknown",
    metaAccount: "unknown",
  };
  const requiredSources = [
    ...(idString(value.client_id) ? [sources.client] : []),
    ...(idString(value.report_id) ? [sources.report] : []),
    ...(idString(value.user_id) ? [resolvedActorSource] : []),
  ];
  const reliableSources = new Set(["snapshot", "workspace_member"]);
  const completeness =
    requiredSources.length > 0 && requiredSources.every((source) => reliableSources.has(source))
      ? "complete"
      : requiredSources.some((source) => reliableSources.has(source))
        ? "partial"
        : "legacy_unknown";
  const display = getActivityDisplay({
    type: value.type,
    title: value.title,
    description: value.description,
    severity: value.severity,
    metadata,
  });
  return {
    _id: value._id,
    id: idString(value),
    agency_id: value.agency_id || null,
    client_id: value.client_id || null,
    report_id: value.report_id || null,
    user_id: value.user_id || null,
    actor: resolvedActor,
    actorSource: resolvedActorSource,
    type: text(value.type, 128),
    title: text(value.title, 512) || display.title,
    description: text(value.description) || display.description,
    severity: text(value.severity, 64),
    metadata,
    createdAt: value.createdAt || null,
    display,
    identitySources: sources,
    identityCompleteness: completeness,
  };
};

export const serializeHistoricalArtifact = ({ reportRun, audience }) => {
  const value = record(reportRun);
  const artifact = record(audience === "client" ? value.client_report : value.internal_report);
  if (!Object.keys(artifact).length) return null;
  const safety = record(artifact.safety);
  return {
    audience,
    subject: typeof artifact.subject === "string" ? artifact.subject : null,
    html: typeof artifact.html === "string" ? artifact.html : null,
    text: typeof artifact.text === "string" ? artifact.text : null,
    status: text(artifact.status, 64),
    generatedAt: value.artifacts_ready_at || value.createdAt || null,
    sentAt: artifact.sent_at || null,
    safetyWarnings:
      audience === "client"
        ? [
            ...safeHistoricalTextArray(safety.reasons),
            ...safeHistoricalTextArray(safety.warnings),
          ].slice(0, 20)
        : [],
  };
};
