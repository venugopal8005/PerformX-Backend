import { getNextRunAt } from "../utils/reportSchedule.js";
import { logAction, logError } from "../utils/controllerLogger.js";
import { Agency, Activity, Client, Report, ReportRun, Signal, User } from "../models/index.js";
import { compareMetrics } from "./metricComparison.service.js";
import { fetchMetaInsights } from "./metaInsights.service.js";
import { aggregateMetaMetrics } from "./metaInsights.service.js";
import { getComparisonWindows } from "./timeWindowAggregator.service.js";
import { recordActivity, recordSignalActivities } from "./activityRecorder.service.js";
import {
  hasValidatedMetaPerformanceEvidence,
  saveSignalsFromNarrative,
} from "./signalGenerator.service.js";
import { generateOperationalInsight } from "../../performanceNarratorEngine.js";
import {
  prepareReportDelivery,
  processPersistedReportDelivery,
  summarizeReportDelivery,
} from "./reportDelivery.service.js";
import { resolveValidatedMetaContextForReport } from "./metaContext.service.js";
import {
  acquireReportExecutionLease,
  buildExecutionKey,
  findOrCreateReportRun,
  persistGeneratedReportEvidenceWithMetaBindingFence,
  releaseReportExecutionLease,
  renewReportExecutionLease,
  startReportExecutionLeaseHeartbeat,
} from "./reportExecution.service.js";
import { assertExecutionIntegrityReady } from "./executionIntegrityIndexes.service.js";
import { processReportRunIssues } from "./issueMatching.service.js";
import { buildReportRunContextSnapshot } from "./historicalContextSnapshot.service.js";
import { buildReportRunEvaluationEvidence } from "./reportEvaluationEvidence.service.js";
import { processReportRunEvaluations, runEvaluationMaintenance } from "./evaluation.service.js";
import { runPhase5ReviewMaintenance } from "./reviewReconciliation.service.js";
import {
  isArchivedDocument,
  withOperationalReportScope,
} from "../utils/archiveScope.js";

const SCOPE = "ReportRunner";
const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORICAL_FALLBACK_LOOKBACK_DAYS =
  Number(process.env.META_HISTORICAL_FALLBACK_DAYS) || 365;
const REPORT_EXECUTION_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export const getArchiveExecutionBlockReason = ({ report, client } = {}) => {
  if (isArchivedDocument(report)) return "report_archived";
  if (isArchivedDocument(client)) return "client_archived";
  return null;
};

const findResumableUniqueExecutionKey = async (report, source) => {
  const reportRun = await ReportRun.findOne({
    report_id: report._id,
    agency_id: report.agency_id,
    trigger_type: source,
    execution_key: { $exists: true, $ne: null },
    execution_stage: { $ne: "completed" },
  })
    .sort({ started_at: -1, createdAt: -1 })
    .select("execution_key")
    .lean();

  return reportRun?.execution_key || null;
};

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

const ensureReportAccess = (report, agencyId) => {
  if (!agencyId) return;

  if (normalizeObjectId(report.agency_id) !== normalizeObjectId(agencyId)) {
    throw new Error("Report not found for agency");
  }
};

const severityForActivity = (signals) =>
  signals.length
    ? mapReportSeverity(signals) === "high"
      ? "critical"
      : "moderate"
    : "stable";

const persistRunEvents = async ({ report, reportRun, narrative, comparison, userId }) => {
  if (
    reportRun.events_persistence_status ===
    "skipped_unvalidated_legacy_evidence"
  ) {
    return {
      signals: await Signal.find({ report_run_id: reportRun._id }).sort({ detected_at: 1 }),
      activities: [],
    };
  }

  if (reportRun.events_persisted_at) {
    return {
      signals: await Signal.find({ report_run_id: reportRun._id }).sort({ detected_at: 1 }),
      activities: [],
    };
  }

  if (!hasValidatedMetaPerformanceEvidence(reportRun)) {
    await ReportRun.updateOne(
      {
        _id: reportRun._id,
        events_persisted_at: null,
        events_persistence_status: { $ne: "persisted" },
      },
      {
        $set: {
          events_persistence_status: "skipped_unvalidated_legacy_evidence",
          events_persistence_reason: "meta_performance_evidence_not_validated",
        },
      }
    );
    return {
      signals: await Signal.find({ report_run_id: reportRun._id }).sort({ detected_at: 1 }),
      activities: [],
    };
  }

  const signals = await saveSignalsFromNarrative({
    report,
    reportRun,
    narrative,
    comparison,
    reportRunId: reportRun._id,
  });
  const activities = [];
  activities.push(
    await recordActivity({
      agency_id: report.agency_id,
      client_id: report.client_id,
      report_id: report._id,
      user_id: userId || report.created_by,
      type: "report_executed",
      title: `${report.name} executed`,
      description: buildReportSummary(narrative),
      severity: severityForActivity(signals),
      idempotency_key: `report-run:${reportRun._id}:executed`,
      metadata: {
        report_run_id: reportRun._id,
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
      user_id: userId || report.created_by,
      report_run_id: reportRun._id,
    }))
  );

  if (narrative.userInsight?.decisionBrief?.decision) {
    activities.push(
      await recordActivity({
        agency_id: report.agency_id,
        client_id: report.client_id,
        report_id: report._id,
        user_id: userId || report.created_by,
        type: "decision_generated",
        title: narrative.userInsight.decisionBrief.label || "Decision generated",
        description: narrative.userInsight.decisionBrief.primaryAction,
        severity: signals.length ? signals[0].severity : "stable",
        idempotency_key: `report-run:${reportRun._id}:decision-generated`,
        metadata: {
          report_run_id: reportRun._id,
          decision: narrative.userInsight.decisionBrief.decision,
          confidence: narrative.userInsight.decisionBrief.confidence,
        },
      })
    );
  }

  await ReportRun.updateOne(
    { _id: reportRun._id },
    {
      $set: {
        signal_ids: signals.map((signal) => signal._id),
        severity: mapReportSeverity(signals),
        events_persisted_at: new Date(),
        events_persistence_status: "persisted",
        events_persistence_reason: null,
      },
    }
  );

  return { signals, activities };
};

const buildGeneratedRunFields = ({
  report,
  narrative,
  comparison,
  preparedDelivery,
  metaAdAccount,
  evaluationEvidence,
  now,
}) => ({
  evaluation_evidence: evaluationEvidence,
  status: mapRunStatus(narrative),
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
  next_signal:
    narrative.nextSignal || narrative.userInsight?.watchNext?.goodSign || null,
  period: comparison?.period || narrative.period || {},
  comparison,
  narrative,
  engine_output: narrative,
  email_subject: preparedDelivery.internalReport?.subject || null,
  email_html: preparedDelivery.internalReport?.html || null,
  internal_report: preparedDelivery.internalReport,
  client_report: preparedDelivery.clientReport,
  notification: preparedDelivery.notification,
  execution_stage: "artifacts_ready",
  artifacts_ready_at: now,
  failure: null,
  next_retry_at: null,
});

const markRunFailed = async ({ report, reportRun, stage, error, userId }) => {
  if (!reportRun) return;
  const failure = {
    stage,
    code: error?.code || "REPORT_RUN_FAILED",
    message: String(error?.message || "Report execution failed.").slice(0, 500),
    failed_at: new Date(),
  };
  const update = {
    execution_stage: "failed",
    status: "failed",
    failure,
    summary: failure.message,
  };
  if (!reportRun.narrative) {
    update.narrative = {
      status: "failed",
      reason: failure.message,
      code: failure.code,
    };
    update.engine_output = update.narrative;
  }
  await ReportRun.updateOne({ _id: reportRun._id }, { $set: update });
  await recordActivity({
    agency_id: report.agency_id,
    client_id: report.client_id,
    report_id: report._id,
    user_id: userId || report.created_by,
    type: "report_failed",
    title: `${report.name} failed`,
    description: failure.message,
    severity: "critical",
    idempotency_key: `report-run:${reportRun._id}:failed:${stage}`,
    metadata: {
      report_run_id: reportRun._id,
      failure_stage: stage,
      error_code: failure.code,
    },
  }).catch(() => null);
};

const updateReportAfterCompletion = async ({
  report,
  reportRun,
  signals,
  leaseToken,
  completedAt,
}) => {
  const nextRunAt = getNextRunAt(report, completedAt);
  const update = {
    last_summary: reportRun.summary,
    severity: reportRun.severity,
    last_run_at: completedAt,
    next_run_at: nextRunAt,
  };
  if (signals.length) update.last_signal_at = completedAt;

  const result = await Report.updateOne(
    {
      _id: report._id,
      "execution_lock.token": leaseToken,
    },
    { $set: update }
  );
  if (result.matchedCount !== 1) {
    const error = new Error("Report execution lease was lost before completion.");
    error.code = "REPORT_EXECUTION_LEASE_LOST";
    error.status = 409;
    throw error;
  }

  Object.assign(report, update);
  return nextRunAt;
};

const buildRunResult = ({
  report,
  reportRun,
  signals = [],
  activities = [],
  clientName,
  skipped = false,
  reason = null,
}) => {
  const internalReport = reportRun?.internal_report || null;
  const clientReport = reportRun?.client_report || null;
  const notification = reportRun?.notification || null;
  const delivery = internalReport
    ? summarizeReportDelivery({ internalReport, clientReport, notification })
    : null;

  return {
    skipped,
    reason,
    report,
    connection: {
      ad_account_id:
        reportRun?.meta_account_external_id_snapshot ||
        report.meta_account_external_id_snapshot,
      ad_account_name:
        reportRun?.meta_account_name_snapshot || report.meta_account_name_snapshot,
    },
    comparison: reportRun?.comparison,
    narrative: reportRun?.narrative,
    reportRun,
    signals,
    activities,
    emailSubject: internalReport?.subject || reportRun?.email_subject || null,
    emailHtml: internalReport?.html || reportRun?.email_html || null,
    internalReport,
    clientReport,
    notification,
    delivery,
    clientName,
    recipients:
      internalReport?.recipients?.map((recipient) => recipient.email) ||
      report.internal_recipients ||
      report.recipients ||
      [],
  };
};

export const processReportRunIssuesBeforeDelivery = async ({
  reportRunId,
  allowFailedRetry = false,
  metadata,
  beforeDelivery = async () => {},
  issueProcessor = processReportRunIssues,
  evaluationProcessor = processReportRunEvaluations,
  deliveryProcessor = processPersistedReportDelivery,
} = {}) => {
  await issueProcessor({ reportRunId });
  try {
    await evaluationProcessor({ reportRunId });
  } catch (error) {
    logError(SCOPE, "EVALUATION_PROCESSING_ISOLATED_FAILURE", error, { reportRunId });
  }
  await beforeDelivery();
  return deliveryProcessor({ reportRunId, allowFailedRetry, metadata });
};

export const runReport = async (reportId, options = {}) => {
  assertExecutionIntegrityReady();
  const now = options.now || new Date();
  const source = ["manual", "scheduled", "api"].includes(options.triggerType)
    ? options.triggerType
    : "api";
  const initialReport = await Report.findById(reportId);

  if (!initialReport) throw new Error("Report not found");
  ensureReportAccess(initialReport, options.agencyId);
  const initialClient = await Client.findOne({
    _id: initialReport.client_id,
    agency_id: initialReport.agency_id,
  })
    .select("is_archived")
    .lean();
  if (!initialClient) {
    const error = new Error("The Client referenced by this report no longer exists.");
    error.code = "CLIENT_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  const initialArchiveReason = getArchiveExecutionBlockReason({
    report: initialReport,
    client: initialClient,
  });
  if (initialArchiveReason) {
    return { skipped: true, reason: initialArchiveReason, report: initialReport };
  }

  if (!options.force && initialReport.status !== "active") {
    return { skipped: true, reason: "Report is not active", report: initialReport };
  }
  if (!options.force && initialReport.next_run_at && now < initialReport.next_run_at) {
    return { skipped: true, reason: "Report is not due yet", report: initialReport };
  }

  const lease = await acquireReportExecutionLease({
    reportId,
    source,
    now: options.leaseNow || new Date(),
  });
  if (!lease.acquired) {
    return {
      skipped: true,
      reason: "report_execution_in_progress",
      report: initialReport,
    };
  }

  const report = lease.report;
  const heartbeat = startReportExecutionLeaseHeartbeat({
    reportId,
    agencyId: report.agency_id,
    token: lease.token,
  });
  let reportRun = null;
  let failureStage = "claimed";

  try {
    ensureReportAccess(report, options.agencyId);
    const executionClient = await Client.findOne({
      _id: report.client_id,
      agency_id: report.agency_id,
    })
      .select("name is_archived")
      .lean();
    if (!executionClient) {
      const error = new Error("The Client referenced by this report no longer exists.");
      error.code = "CLIENT_NOT_FOUND";
      error.status = 404;
      throw error;
    }
    const archiveReason = getArchiveExecutionBlockReason({
      report,
      client: executionClient,
    });
    if (archiveReason) {
      return { skipped: true, reason: archiveReason, report };
    }
    const scheduledFor =
      source === "scheduled"
        ? options.scheduledFor || initialReport.next_run_at
        : null;
    // Deliberate manual/API runs get fresh keys after completion. If the previous
    // attempt stopped mid-run, the next call resumes that durable execution.
    const resumableUniqueKey =
      ["manual", "api"].includes(source) && !options.executionKey
        ? await findResumableUniqueExecutionKey(report, source)
        : null;
    const executionKey =
      options.executionKey ||
      resumableUniqueKey ||
      buildExecutionKey({ reportId: report._id, source, scheduledFor });
    const period = getComparisonWindows(report.type, {
      timezone: report.schedule?.timezone,
      now,
    });
    const actorId = options.userId || report.created_by || null;
    const [executionAgency, executionActor] = await Promise.all([
      Agency.findById(report.agency_id).select("name").lean(),
      actorId ? User.findById(actorId).select("full_name").lean() : null,
    ]);
    const contextSnapshot = buildReportRunContextSnapshot({
      agency: executionAgency,
      client: executionClient,
      report,
      actor: executionActor,
      capturedAt: now,
      source: "execution",
    });
    const runResolution = await findOrCreateReportRun({
      report,
      leaseToken: lease.token,
      contextSnapshot,
      executionKey,
      source,
      scheduledFor,
      period,
      userId: options.userId,
      now,
    });
    reportRun = runResolution.reportRun;

    logAction(SCOPE, "REPORT_EXECUTION_CLAIMED", {
      reportId: report._id,
      reportRunId: reportRun._id,
      executionKey,
      executionSource: source,
      scheduledFor,
      created: runResolution.created,
    }, "cyan");

    if (reportRun.execution_stage === "completed") {
      const signals = await Signal.find({ report_run_id: reportRun._id });
      await updateReportAfterCompletion({
        report,
        reportRun,
        signals,
        leaseToken: lease.token,
        completedAt: reportRun.completed_at || reportRun.updatedAt || now,
      });
      return buildRunResult({
        report,
        reportRun,
        signals,
        skipped: true,
        reason: "execution_already_completed",
      });
    }

    const hasArtifacts = Boolean(
      reportRun.artifacts_ready_at &&
        reportRun.narrative &&
        reportRun.internal_report?.html
    );
    if (
      source === "scheduled" &&
      hasArtifacts &&
      reportRun.next_retry_at &&
      new Date(reportRun.next_retry_at) > now
    ) {
      return buildRunResult({
        report,
        reportRun,
        skipped: true,
        reason: "report_execution_retry_pending",
      });
    }

    let signals = [];
    let activities = [];
    let clientName = report.name || "Client";

    if (!hasArtifacts) {
      failureStage = "generating";
      reportRun = await ReportRun.findByIdAndUpdate(
        reportRun._id,
        {
          $set: {
            execution_stage: "generating",
            status: "running",
            failure: null,
            next_retry_at: null,
          },
          $inc: { execution_attempt_count: 1 },
        },
        { new: true }
      );
      const metaContext = await resolveValidatedMetaContextForReport(
        {
          agency_id: reportRun.agency_id,
          client_id: reportRun.client_id,
          meta_ad_account_id: reportRun.meta_ad_account_id,
        },
        {
          expectedClientId: reportRun.client_id,
          expectedBindingRevision:
            reportRun.meta_binding_revision_snapshot,
        }
      );
      const { accessToken, metaAdAccount, externalAdAccountId } = metaContext;
      const client = await Client.findOne({
        _id: report.client_id,
        agency_id: report.agency_id,
      }).lean();
      clientName = client?.name || report.name || "Client";
      const [currentInsights, previousInsights] = await Promise.all([
        fetchMetaInsights({
          accessToken,
          adAccountId: externalAdAccountId,
          dateRange: period.current,
          campaigns: report.monitored_campaigns,
        }),
        fetchMetaInsights({
          accessToken,
          adAccountId: externalAdAccountId,
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
        const fallback = await buildHistoricalFallbackComparison({
          accessToken,
          adAccountId: externalAdAccountId,
          campaigns: report.monitored_campaigns,
          reportType: report.type,
          scheduledPeriod: period,
        });
        if (fallback) comparison = fallback;
      }

      const previousRun = await ReportRun.findOne({
        _id: { $ne: reportRun._id },
        report_id: report._id,
        agency_id: report.agency_id,
        narrative: { $ne: null },
      })
        .sort({ ran_at: -1 })
        .lean();
      const narrative = attachComparisonDisclaimer(
        generateOperationalInsight(
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
              adAccountId: externalAdAccountId,
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
        ),
        comparison
      );
      const generatedAt = now.toLocaleString("en-IN", {
        timeZone: report.schedule?.timezone || "Asia/Kolkata",
      });
      const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
      const preparedDelivery = prepareReportDelivery({
        reportRunId: reportRun._id,
        report,
        narrative,
        comparison,
        clientName,
        generatedAt,
        reportUrl: `${clientOrigin}/reports/${report._id}`,
      });
      const evaluationEvidence = buildReportRunEvaluationEvidenceFromInsights({
        currentInsights,
        report,
        period: comparison.period,
        metaAdAccount,
        metaBindingRevision: reportRun.meta_binding_revision_snapshot,
        comparisonMode: comparison.mode,
        source,
        capturedAt: now,
        fallbackCurrency: options.currency || null,
      });

      heartbeat.assertOwned();
      failureStage = "performance_evidence";
      reportRun = await persistGeneratedReportEvidenceWithMetaBindingFence({
        reportRun,
        leaseToken: lease.token,
        generatedFields: buildGeneratedRunFields({
            report,
            narrative,
            comparison,
            preparedDelivery,
            metaAdAccount,
            evaluationEvidence,
            now,
        }),
      });
    } else {
      if (reportRun.execution_stage === "failed") {
        reportRun = await ReportRun.findByIdAndUpdate(
          reportRun._id,
          {
            $set: {
              execution_stage: "artifacts_ready",
              status: mapRunStatus(reportRun.narrative),
              failure: null,
            },
          },
          { new: true }
        );
      }
      const client = await Client.findOne({
        _id: report.client_id,
        agency_id: report.agency_id,
      }).lean();
      clientName = client?.name || report.name || "Client";
    }

    failureStage = "events";
    const eventResult = await persistRunEvents({
      report,
      reportRun,
      narrative: reportRun.narrative,
      comparison: reportRun.comparison,
      userId: options.userId,
    });
    signals = eventResult.signals;
    activities = eventResult.activities;
    reportRun = await ReportRun.findById(reportRun._id);

    failureStage = "issues";
    const deliveryResult = await processReportRunIssuesBeforeDelivery({
      reportRunId: reportRun._id,
      allowFailedRetry: hasArtifacts,
      metadata: {
        agencyId: report.agency_id,
        clientId: report.client_id,
        reportId: report._id,
        reportName: report.name,
        clientName,
      },
      issueProcessor: options.issueProcessor || processReportRunIssues,
      evaluationProcessor: options.evaluationProcessor || processReportRunEvaluations,
      beforeDelivery: async () => {
        reportRun = await ReportRun.findById(reportRun._id);
        const renewed = await renewReportExecutionLease({
          reportId: report._id,
          agencyId: report.agency_id,
          token: lease.token,
        });
        if (!renewed) {
          const error = new Error("Report execution lease was lost before delivery.");
          error.code = "REPORT_EXECUTION_LEASE_LOST";
          error.status = 409;
          throw error;
        }
        heartbeat.assertOwned();
        failureStage = "delivery";
      },
    });
    reportRun = deliveryResult.reportRun;

    if (deliveryResult.hasInProgress) {
      return buildRunResult({
        report,
        reportRun,
        signals,
        activities,
        clientName,
        skipped: true,
        reason: "report_delivery_in_progress",
      });
    }

    if (deliveryResult.hasSafeFailure) {
      const nextRetryAt = new Date(now.getTime() + REPORT_EXECUTION_RETRY_COOLDOWN_MS);
      reportRun = await ReportRun.findByIdAndUpdate(
        reportRun._id,
        {
          $set: {
            execution_stage: "artifacts_ready",
            next_retry_at: nextRetryAt,
          },
        },
        { new: true }
      );
      return buildRunResult({
        report,
        reportRun,
        signals,
        activities,
        clientName,
      });
    }

    const completedAt = new Date();
    reportRun = await ReportRun.findByIdAndUpdate(
      reportRun._id,
      {
        $set: {
          execution_stage: "completed",
          completed_at: completedAt,
          next_retry_at: null,
        },
      },
      { new: true }
    );
    await updateReportAfterCompletion({
      report,
      reportRun,
      signals,
      leaseToken: lease.token,
      completedAt,
    });

    logAction(SCOPE, "REPORT_RUN_COMPLETED", {
      reportId: report._id,
      reportRunId: reportRun._id,
      executionKey: reportRun.execution_key,
      signalCount: signals.length,
      internalReportStatus: reportRun.internal_report?.status,
      internalDispatchStatus: reportRun.internal_report?.dispatch?.status,
      clientReportStatus: reportRun.client_report?.status,
      clientDispatchStatus: reportRun.client_report?.dispatch?.status,
      notificationStatus: reportRun.notification?.status || "not_required",
      deliveryUncertain: deliveryResult.hasUncertain,
      nextRunAt: report.next_run_at,
    }, deliveryResult.hasUncertain ? "yellow" : "green");

    return buildRunResult({
      report,
      reportRun,
      signals,
      activities,
      clientName,
    });
  } catch (error) {
    if (error?.code !== "REPORT_EXECUTION_LEASE_LOST") {
      await markRunFailed({
        report,
        reportRun,
        stage: failureStage,
        error,
        userId: options.userId,
      }).catch(() => null);
    }
    throw error;
  } finally {
    await heartbeat.stop();
    await releaseReportExecutionLease({
      reportId,
      token: lease.token,
    }).catch(() => null);
  }
};

export const runDueReports = async (options = {}) => {
  assertExecutionIntegrityReady();
  const now = options.now || new Date();
  const reports = await Report.find(
    withOperationalReportScope({
      status: "active",
      next_run_at: { $lte: now },
      ...(options.agencyId ? { agency_id: options.agencyId } : {}),
    })
  ).sort({ next_run_at: 1 });
  const results = [];

  for (const report of reports) {
    try {
      results.push(
        await runReport(report._id, {
          ...options,
          now,
          triggerType: options.triggerType || "scheduled",
          scheduledFor: report.next_run_at,
        })
      );
    } catch (err) {
      logError(SCOPE, "REPORT_RUN_FAILED", err, {
        reportId: report._id,
      });

    }
  }

  if (options.evaluationMaintenanceProcessor || ReportRun.db?.readyState === 1) {
    try {
      await (options.evaluationMaintenanceProcessor || runEvaluationMaintenance)({
        agencyId: options.agencyId || null,
      });
    } catch (error) {
      logError(SCOPE, "EVALUATION_MAINTENANCE_ISOLATED_FAILURE", error, {
        agencyId: options.agencyId || null,
      });
    }
    try {
      await (options.reviewMaintenanceProcessor || runPhase5ReviewMaintenance)({
        agencyId: options.agencyId || null,
      });
    } catch (error) {
      logError(SCOPE, "REVIEW_MAINTENANCE_ISOLATED_FAILURE", error, {
        agencyId: options.agencyId || null,
      });
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
export const buildReportRunEvaluationEvidenceFromInsights = ({
  currentInsights,
  report,
  period,
  metaAdAccount,
  metaBindingRevision,
  comparisonMode,
  source,
  capturedAt,
  fallbackCurrency = null,
} = {}) => buildReportRunEvaluationEvidence({
  currentRows: currentInsights?.rows,
  monitoredCampaigns: report?.monitored_campaigns,
  period,
  timezone: report?.schedule?.timezone || null,
  currency: metaAdAccount?.currency || fallbackCurrency,
  attributionContext: currentInsights?.attributionContext,
  metaBindingRevision,
  comparisonMode,
  cadence: report?.type,
  triggerType: source,
  capturedAt,
});
