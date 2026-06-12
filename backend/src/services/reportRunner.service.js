import {
  formatPerformanceEmail,
  formatPerformanceEmailSubject,
} from "../utils/performanceEmailFormatter.js";
import { getNextRunAt } from "../utils/reportSchedule.js";
import { logAction, logError } from "../utils/controllerLogger.js";
import { Activity, MetaConnection, Report, ReportRun } from "../models/index.js";
import { compareMetrics } from "./metricComparison.service.js";
import { fetchMetaInsights } from "./metaInsights.service.js";
import { aggregateMetaMetrics } from "./metaInsights.service.js";
import { getComparisonWindows } from "./timeWindowAggregator.service.js";
import { recordActivity, recordSignalActivities } from "./activityRecorder.service.js";
import { saveSignalsFromNarrative } from "./signalGenerator.service.js";
import { generateOperationalInsight } from "../../performanceNarratorEngine.js";

const SCOPE = "ReportRunner";
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_FALLBACK_LOOKBACK_DAYS =
  Number(process.env.META_HISTORICAL_FALLBACK_DAYS) || 365;

const formatDate = (date) => date.toISOString().slice(0, 10);

const addDays = (dateString, days) => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return formatDate(new Date(date.getTime() + days * DAY_MS));
};

const rowDate = (row = {}) => row.date_start || row.date || row.dateStop || null;

const hasMetricData = (metrics = {}) =>
  ["spend", "impressions", "clicks", "reach", "conversions"].some(
    (metric) => Number(metrics[metric]) > 0
  );

const rowsBetween = (rows = [], start, end) =>
  rows.filter((row) => {
    const date = rowDate(row);
    return date && date >= start && date <= end;
  });

const getActiveDates = (rows = []) => {
  const byDate = new Map();

  rows.forEach((row) => {
    const date = rowDate(row);
    if (!date) return;

    const current = byDate.get(date) || [];
    current.push(row);
    byDate.set(date, current);
  });

  return Array.from(byDate.entries())
    .filter(([, dateRows]) => hasMetricData(aggregateMetaMetrics(dateRows)))
    .map(([date]) => date)
    .sort();
};

const buildHistoricalFallbackPeriod = (type, rows) => {
  const activeDates = getActiveDates(rows);
  const latestActiveDate = activeDates.at(-1);

  if (!latestActiveDate) return null;

  if (type === "weekly" || type === "monthly") {
    const windowDays = type === "weekly" ? 7 : 30;
    const current = {
      start: addDays(latestActiveDate, -(windowDays - 1)),
      end: latestActiveDate,
    };
    const previous = {
      start: addDays(latestActiveDate, -(windowDays * 2 - 1)),
      end: addDays(latestActiveDate, -windowDays),
    };

    return {
      type,
      current,
      previous,
      latestActiveDate,
    };
  }

  const previousActiveDate = [...activeDates]
    .reverse()
    .find((date) => date < latestActiveDate);

  if (!previousActiveDate) return null;

  return {
    type: "daily",
    current: {
      start: latestActiveDate,
      end: latestActiveDate,
    },
    previous: {
      start: previousActiveDate,
      end: previousActiveDate,
    },
    latestActiveDate,
  };
};

const buildComparison = ({ period, currentInsights, previousInsights, mode, disclaimer, scheduledPeriod }) => {
  const comparison = {
    mode,
    period,
    scheduledPeriod,
    currentPeriodMetrics: currentInsights.metrics,
    previousPeriodMetrics: previousInsights.metrics,
    deltas: compareMetrics(currentInsights.metrics, previousInsights.metrics),
    rawRows: [...currentInsights.rows, ...previousInsights.rows],
    rowCounts: {
      current: currentInsights.rows.length,
      previous: previousInsights.rows.length,
      total: currentInsights.rows.length + previousInsights.rows.length,
    },
  };

  if (disclaimer) {
    comparison.disclaimer = disclaimer;
  }

  return comparison;
};

const shouldUseHistoricalFallback = (comparison) =>
  !hasMetricData(comparison.currentPeriodMetrics) &&
  !hasMetricData(comparison.previousPeriodMetrics);

const buildHistoricalFallbackComparison = async ({
  accessToken,
  adAccountId,
  campaigns,
  reportType,
  scheduledPeriod,
}) => {
  const lookbackEnd = scheduledPeriod.current?.end;
  const lookbackStart = addDays(lookbackEnd, -HISTORICAL_FALLBACK_LOOKBACK_DAYS);
  const historicalInsights = await fetchMetaInsights({
    accessToken,
    adAccountId,
    dateRange: {
      start: lookbackStart,
      end: lookbackEnd,
    },
    campaigns,
    level: "campaign",
  });
  const historicalPeriod = buildHistoricalFallbackPeriod(reportType, historicalInsights.rows);

  if (!historicalPeriod) return null;

  const currentRows = rowsBetween(
    historicalInsights.rows,
    historicalPeriod.current.start,
    historicalPeriod.current.end
  );
  const previousRows = rowsBetween(
    historicalInsights.rows,
    historicalPeriod.previous.start,
    historicalPeriod.previous.end
  );
  const currentMetrics = aggregateMetaMetrics(currentRows);
  const previousMetrics = aggregateMetaMetrics(previousRows);

  if (!hasMetricData(currentMetrics) || !hasMetricData(previousMetrics)) {
    return null;
  }

  const period = {
    type: historicalPeriod.type,
    source: "historical_fallback",
    current: historicalPeriod.current,
    previous: historicalPeriod.previous,
    latestActiveDate: historicalPeriod.latestActiveDate,
  };
  const disclaimer =
    `No delivery was found in the scheduled ${scheduledPeriod.type} comparison window ` +
    `(${scheduledPeriod.previous.start} to ${scheduledPeriod.current.end}). ` +
    `This report uses the latest available campaign delivery ending ${historicalPeriod.latestActiveDate}.`;

  return buildComparison({
    period,
    currentInsights: {
      rows: currentRows,
      metrics: currentMetrics,
    },
    previousInsights: {
      rows: previousRows,
      metrics: previousMetrics,
    },
    mode: "historical_fallback",
    disclaimer,
    scheduledPeriod,
  });
};

const attachComparisonDisclaimer = (narrative, comparison) => {
  if (!comparison.disclaimer) return narrative;

  const warnings = narrative.dataQuality?.warnings || [];
  const caveats = narrative.userInsight?.trust?.caveats || [];

  narrative.disclaimer = comparison.disclaimer;
  narrative.comparisonMode = comparison.mode;
  narrative.scheduledPeriod = comparison.scheduledPeriod;
  narrative.dataQuality = {
    ...(narrative.dataQuality || {}),
    warnings: [comparison.disclaimer, ...warnings],
  };
  narrative.userInsight = {
    ...(narrative.userInsight || {}),
    trust: {
      ...(narrative.userInsight?.trust || {}),
      caveats: [comparison.disclaimer, ...caveats],
    },
  };

  return narrative;
};

const mapReportSeverity = (signals = []) => {
  if (signals.some((signal) => signal.severity === "critical")) return "high";
  if (signals.some((signal) => signal.severity === "moderate")) return "medium";
  return "low";
};

const normalizeObjectId = (value) => value?.toString?.() || value;

const buildReportSummary = (narrative) => {
  return (
    narrative.userInsight?.plainSummary ||
    narrative.executiveSummary ||
    "Report executed successfully. No material operational signal was detected."
  );
};

const mapRunStatus = (narrative) => {
  if (narrative?.status === "ok") return "ok";
  if (narrative?.status === "insufficient_data") return "insufficient_data";
  return "failed";
};

const buildReportRunDocument = ({
  report,
  narrative,
  comparison,
  signals,
  emailSubject,
  emailHtml,
  now,
  options,
}) => ({
  agency_id: report.agency_id,
  client_id: report.client_id,
  report_id: report._id,
  triggered_by: options.userId || report.created_by,
  trigger_type: options.triggerType || "api",
  status: mapRunStatus(narrative),
  severity: mapReportSeverity(signals),
  summary: buildReportSummary(narrative),
  key_delta: narrative.keyDelta || null,
  likely_cause:
    narrative.likelyCause?.summary ||
    narrative.likelyCause?.archetype ||
    narrative.reason ||
    null,
  decision:
    narrative.userInsight?.decisionBrief?.primaryAction ||
    narrative.decision ||
    null,
  next_signal: narrative.nextSignal || narrative.userInsight?.watchNext?.goodSign || null,
  period: comparison?.period || narrative.period || {},
  comparison,
  narrative,
  signal_ids: signals.map((signal) => signal._id),
  email_subject: emailSubject,
  email_html: emailHtml,
  ran_at: now,
});

const ensureReportAccess = (report, agencyId) => {
  if (!agencyId) return;

  if (normalizeObjectId(report.agency_id) !== normalizeObjectId(agencyId)) {
    throw new Error("Report not found for agency");
  }
};

export const runReport = async (reportId, options = {}) => {
  const now = options.now || new Date();
  const report = await Report.findById(reportId);

  if (!report) {
    throw new Error("Report not found");
  }

  ensureReportAccess(report, options.agencyId);

  if (!options.force && report.status !== "active") {
    return {
      skipped: true,
      reason: "Report is not active",
      report,
    };
  }

  if (!options.force && report.next_run_at && now < report.next_run_at) {
    return {
      skipped: true,
      reason: "Report is not due yet",
      report,
    };
  }

  const connection = await MetaConnection.findOne({
    agency_id: report.agency_id,
    client_id: report.client_id,
    is_active: true,
  }).select("+access_token");

  if (!connection) {
    throw new Error("Active Meta connection not found for client");
  }

  if (connection.token_expires_at && connection.token_expires_at <= now) {
    connection.is_active = false;
    await connection.save();
    throw new Error("Meta access token expired. Please reconnect Meta.");
  }

  if (!connection.ad_account_id) {
    throw new Error("Meta ad account not selected for client");
  }

  const period = getComparisonWindows(report.type, {
    timezone: report.schedule?.timezone,
    now,
  });
  const [currentInsights, previousInsights] = await Promise.all([
    fetchMetaInsights({
      accessToken: connection.access_token,
      adAccountId: connection.ad_account_id,
      dateRange: period.current,
      campaigns: report.monitored_campaigns,
    }),
    fetchMetaInsights({
      accessToken: connection.access_token,
      adAccountId: connection.ad_account_id,
      dateRange: period.previous,
      campaigns: report.monitored_campaigns,
    }),
  ]);
  let comparison = buildComparison({
    period,
    currentInsights,
    previousInsights,
    mode: "scheduled_window",
  });

  if (shouldUseHistoricalFallback(comparison)) {
    const historicalComparison = await buildHistoricalFallbackComparison({
      accessToken: connection.access_token,
      adAccountId: connection.ad_account_id,
      campaigns: report.monitored_campaigns,
      reportType: report.type,
      scheduledPeriod: period,
    });

    if (historicalComparison) {
      comparison = historicalComparison;
    }
  }

  const previousRun = await ReportRun.findOne({
    report_id: report._id,
    agency_id: report.agency_id,
  })
    .sort({ ran_at: -1 })
    .lean();
  const narrative = attachComparisonDisclaimer(generateOperationalInsight(
    {
      ...comparison,
      analysisType: `${report.type}_comparison`,
      previousNarrative: previousRun?.narrative
        ? {
            ...previousRun.narrative,
            createdAt: previousRun.ran_at || previousRun.createdAt,
          }
        : null,
      reportGoal: report.reportGoal || report.goal || null,
      context: {
        agencyId: report.agency_id,
        clientId: report.client_id,
        reportId: report._id,
        reportName: report.name,
        adAccountId: connection.ad_account_id,
        campaignName:
          report.monitored_campaigns?.length === 1
            ? report.monitored_campaigns[0].campaign_name
            : report.name,
      },
    },
    {
      currency: options.currency || "INR",
      currencySymbol: options.currencySymbol || "INR ",
      timeZone: report.schedule?.timezone || "Asia/Kolkata",
    }
  ), comparison);
  const signals = await saveSignalsFromNarrative({
    report,
    narrative,
    comparison,
  });
  const activities = [];

  activities.push(
    await recordActivity({
      agency_id: report.agency_id,
      client_id: report.client_id,
      report_id: report._id,
      user_id: options.userId || report.created_by,
      type: "report_executed",
      title: `${report.name} executed`,
      description: buildReportSummary(narrative),
      severity: signals.length ? mapReportSeverity(signals) === "high" ? "critical" : "moderate" : "stable",
        metadata: {
          report_type: report.type,
          period: comparison.period,
          scheduled_period: comparison.scheduledPeriod,
          comparison_mode: comparison.mode,
          row_counts: comparison.rowCounts,
          signal_count: signals.length,
        },
      })
  );

  activities.push(
    ...(await recordSignalActivities({
      signals,
      user_id: options.userId || report.created_by,
    }))
  );

  if (narrative.userInsight?.decisionBrief?.decision) {
    activities.push(
      await recordActivity({
        agency_id: report.agency_id,
        client_id: report.client_id,
        report_id: report._id,
        user_id: options.userId || report.created_by,
        type: "decision_generated",
        title: narrative.userInsight.decisionBrief.label || "Decision generated",
        description: narrative.userInsight.decisionBrief.primaryAction,
        severity: signals.length ? signals[0].severity : "stable",
        metadata: {
          decision: narrative.userInsight.decisionBrief.decision,
          confidence: narrative.userInsight.decisionBrief.confidence,
        },
      })
    );
  }

  report.last_summary = buildReportSummary(narrative);
  report.last_signal_at = signals.length ? now : report.last_signal_at;
  report.severity = mapReportSeverity(signals);
  report.last_run_at = now;
  report.next_run_at = getNextRunAt(report, now);
  await report.save();

  const emailSubject = formatPerformanceEmailSubject(narrative, {
    campaignName: report.name,
  });
  const emailHtml = formatPerformanceEmail(narrative, {
    title: report.name,
    subject: emailSubject,
    campaignName: report.name,
    generatedAt: now.toLocaleString("en-IN", {
      timeZone: report.schedule?.timezone || "Asia/Kolkata",
    }),
  });
  const reportRun = await ReportRun.create(
    buildReportRunDocument({
      report,
      narrative,
      comparison,
      signals,
      emailSubject,
      emailHtml,
      now,
      options,
    })
  );

  logAction(SCOPE, "REPORT_RUN_COMPLETED", {
    reportId: report._id,
    reportRunId: reportRun._id,
    signalCount: signals.length,
    nextRunAt: report.next_run_at,
  }, "green");

  return {
    skipped: false,
    report,
    connection: {
      ad_account_id: connection.ad_account_id,
      ad_account_name: connection.ad_account_name,
    },
    comparison,
    narrative,
    reportRun,
    signals,
    activities,
    emailSubject,
    emailHtml,
    recipients: report.recipients || [],
  };
};

export const runDueReports = async (options = {}) => {
  const now = options.now || new Date();
  const reports = await Report.find({
    status: "active",
    next_run_at: { $lte: now },
  }).sort({ next_run_at: 1 });
  const results = [];

  for (const report of reports) {
    try {
      results.push(
        await runReport(report._id, {
          ...options,
          now,
          triggerType: options.triggerType || "scheduled",
        })
      );
    } catch (err) {
      logError(SCOPE, "REPORT_RUN_FAILED", err, {
        reportId: report._id,
      });

      await recordActivity({
        agency_id: report.agency_id,
        client_id: report.client_id,
        report_id: report._id,
        user_id: options.userId || report.created_by,
        type: "report_failed",
        title: `${report.name} failed`,
        description: err.message,
        severity: "critical",
        metadata: {
          error: err.message,
        },
      }).catch(() => null);
    }
  }

  return {
    ranCount: results.filter((result) => !result.skipped).length,
    checkedCount: reports.length,
    results,
  };
};

export const getRecentReportActivities = (reportId) => {
  return Activity.find({ report_id: reportId }).sort({ createdAt: -1 }).limit(20);
};
