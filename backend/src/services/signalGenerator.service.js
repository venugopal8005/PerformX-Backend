import { Signal } from "../models/Signal.js";
import { ReportRun } from "../models/ReportRun.js";
import { buildSignalContextSnapshotFromReportRun } from "./historicalContextSnapshot.service.js";
import { normalizeMetaBindingRevision } from "./metaAccountBinding.service.js";

const NARRATOR_SIGNAL_TYPE_MAP = {
  creative_fatigue: "creative_fatigue",
  audience_saturation: "audience_saturation",
  engagement_quality_drop: "ctr_decline",
  aggressive_scaling: "pacing_warning",
  conversion_funnel_breakdown: "metric_anomaly",
  auction_pressure: "cpm_spike",
  delivery_instability: "pacing_warning",
  traffic_quality_drop: "metric_anomaly",
  volume_loss: "pacing_warning",
  healthy_scaling: "healthy_scaling",
  stable_performance: "stable_performance",
};

const mapSeverity = (level) => {
  if (level === "critical" || level === "high") return "critical";
  if (level === "medium") return "moderate";
  return "stable";
};

export const hasValidatedMetaPerformanceEvidence = (reportRun) => {
  if (!reportRun?.meta_binding_performance_validated_at) return false;
  const validatedAt = new Date(reportRun.meta_binding_performance_validated_at);
  if (Number.isNaN(validatedAt.getTime())) return false;

  try {
    normalizeMetaBindingRevision(reportRun.meta_binding_revision_snapshot);
    return true;
  } catch {
    return false;
  }
};

const signalTypeFromNarrative = (narrative) => {
  const archetypeId = narrative?.likelyCause?.id;
  if (NARRATOR_SIGNAL_TYPE_MAP[archetypeId]) return NARRATOR_SIGNAL_TYPE_MAP[archetypeId];

  const topAnomaly = narrative?.rankedAnomalies?.[0];
  if (topAnomaly?.metric === "ctr" && topAnomaly.delta <= 0) return "ctr_decline";
  if (topAnomaly?.metric === "roas" && topAnomaly.delta <= 0) return "roas_drop";
  if (topAnomaly?.metric === "cpm" && topAnomaly.delta >= 0) return "cpm_spike";
  if (topAnomaly?.metric === "frequency" && topAnomaly.delta >= 0) {
    return "frequency_spike";
  }

  return "metric_anomaly";
};

const buildInsufficientDataSignal = ({ report, narrative, comparison }) => ({
  agency_id: report.agency_id,
  client_id: report.client_id,
  report_id: report._id,
  campaign_id: narrative.campaign?.id || null,
  type: "data_quality_issue",
  severity: "moderate",
  title: narrative.userInsight?.headline || "Data needed before recommendations",
  description:
    narrative.reason ||
    narrative.executiveSummary ||
    "There is not enough Meta data to generate a reliable recommendation.",
  recommendation:
    narrative.userInsight?.decisionBrief?.primaryAction ||
    "Fetch Meta Insights with daily breakdown and at least two completed periods.",
  metadata: {
    narrator_status: narrative.status,
    reason: narrative.reason || null,
    data_quality: narrative.dataQuality || null,
    action_checklist: narrative.userInsight?.decisionBrief?.actionChecklist || [],
    watch_next: narrative.userInsight?.watchNext || null,
    period: comparison?.period || narrative.period || null,
  },
  detected_at: new Date(),
});

export const buildSignalsFromNarrative = ({ report, narrative, comparison }) => {
  if (!report || !narrative) return [];

  if (narrative.status === "insufficient_data") {
    return [buildInsufficientDataSignal({ report, narrative, comparison })];
  }

  if (narrative.status !== "ok") return [];

  const severity = mapSeverity(narrative.severity?.level);

  if (severity === "stable" && narrative.likelyCause?.id === "stable_performance") {
    return [];
  }

  const primaryAnomaly = narrative.rankedAnomalies?.[0] || null;

  return [
    {
      agency_id: report.agency_id,
      client_id: report.client_id,
      report_id: report._id,
      campaign_id: narrative.campaign?.id || null,
      type: signalTypeFromNarrative(narrative),
      severity,
      title:
        narrative.userInsight?.headline ||
        narrative.likelyCause?.archetype ||
        "Operational signal detected",
      description: narrative.executiveSummary,
      recommendation:
        narrative.userInsight?.decisionBrief?.primaryAction ||
        narrative.decision ||
        null,
      metadata: {
        narrator_status: narrative.status,
        archetype_id: narrative.likelyCause?.id,
        archetype: narrative.likelyCause?.archetype,
        decision: narrative.userInsight?.decisionBrief?.decision || null,
        key_delta: narrative.keyDelta,
        primary_anomaly: primaryAnomaly,
        deltas: narrative.metrics?.deltas || {},
        current_metrics: comparison?.currentPeriodMetrics || narrative.metrics?.current,
        previous_metrics: comparison?.previousPeriodMetrics || narrative.metrics?.previous,
        period: comparison?.period || narrative.period,
        recommendations: narrative.recommendations || [],
      },
      detected_at: new Date(),
    },
  ];
};

export const saveSignalsFromNarrative = async ({
  report,
  reportRun = null,
  narrative,
  comparison,
  reportRunId = null,
  SignalModel = Signal,
  ReportRunModel = ReportRun,
}) => {
  const signals = buildSignalsFromNarrative({ report, narrative, comparison });

  if (!signals.length) return [];

  if (reportRunId) {
    const historicalReportRun =
      reportRun || (await ReportRunModel.findById(reportRunId));
    const contextSnapshot = historicalReportRun
      ? buildSignalContextSnapshotFromReportRun({
          reportRun: historicalReportRun,
          campaignId: signals[0].campaign_id,
          capturedAt:
            historicalReportRun.context_snapshot?.captured_at ||
            historicalReportRun.started_at ||
            signals[0].detected_at,
        })
      : null;
    const document = {
      ...signals[0],
      report_run_id: reportRunId,
      ...(contextSnapshot ? { context_snapshot: contextSnapshot } : {}),
    };

    try {
      const signal = await SignalModel.findOneAndUpdate(
        { report_run_id: reportRunId },
        { $setOnInsert: document },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return signal ? [signal] : [];
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await SignalModel.findOne({ report_run_id: reportRunId });
      return existing ? [existing] : [];
    }
  }

  return SignalModel.insertMany(signals);
};
