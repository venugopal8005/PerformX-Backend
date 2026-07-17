const ACTIVITY_STYLE = {
  setup: {
    bg: "#eef2ff",
    color: "#4f46e5",
    border: "#c7d2fe",
    badgeBg: "#eef2ff",
    badgeColor: "#4338ca",
  },
  connected: {
    bg: "#ecfeff",
    color: "#0891b2",
    border: "#a5f3fc",
    badgeBg: "#ecfeff",
    badgeColor: "#0e7490",
  },
  active: {
    bg: "#ecfdf5",
    color: "#059669",
    border: "#a7f3d0",
    badgeBg: "#ecfdf5",
    badgeColor: "#047857",
  },
  paused: {
    bg: "#f8fafc",
    color: "#64748b",
    border: "#cbd5e1",
    badgeBg: "#f1f5f9",
    badgeColor: "#475569",
  },
  analysis: {
    bg: "#eff6ff",
    color: "#2563eb",
    border: "#bfdbfe",
    badgeBg: "#eff6ff",
    badgeColor: "#1d4ed8",
  },
  decision: {
    bg: "#fffbeb",
    color: "#d97706",
    border: "#fde68a",
    badgeBg: "#fffbeb",
    badgeColor: "#b45309",
  },
  delivered: {
    bg: "#f0fdf4",
    color: "#16a34a",
    border: "#bbf7d0",
    badgeBg: "#f0fdf4",
    badgeColor: "#15803d",
  },
  warning: {
    bg: "#fff7ed",
    color: "#ea580c",
    border: "#fed7aa",
    badgeBg: "#fff7ed",
    badgeColor: "#c2410c",
  },
  danger: {
    bg: "#fef2f2",
    color: "#dc2626",
    border: "#fecaca",
    badgeBg: "#fef2f2",
    badgeColor: "#b91c1c",
  },
  neutral: {
    bg: "#f8fafc",
    color: "#475569",
    border: "#e2e8f0",
    badgeBg: "#f8fafc",
    badgeColor: "#334155",
  },
};

const ACTIVITY_DISPLAY = {
  client_created: {
    label: "Client created",
    icon: "UserPlus",
    tone: "setup",
    fallbackTitle: "Client created",
    fallbackDescription: "Client workspace was created and is ready for setup.",
  },
  client_updated: {
    label: "Client updated",
    icon: "Pencil",
    tone: "analysis",
    fallbackTitle: "Client updated",
    fallbackDescription: "Client workspace details were updated.",
  },
  client_deleted: {
    label: "Client deleted",
    icon: "Trash2",
    tone: "danger",
    fallbackTitle: "Client deleted",
    fallbackDescription: "Client workspace and related monitoring data were deleted.",
  },
  client_archived: {
    label: "Client archived",
    icon: "Archive",
    tone: "paused",
    fallbackTitle: "Client archived",
    fallbackDescription: "Client was removed from operational use while history was retained.",
  },
  meta_connected: {
    label: "Meta connected",
    icon: "PlugZap",
    tone: "connected",
    fallbackTitle: "Meta account connected",
    fallbackDescription: "Meta access was connected for this client.",
  },
  report_created: {
    label: "Monitor created",
    icon: "FilePlus2",
    tone: "setup",
    fallbackTitle: "Monitor created",
    fallbackDescription: "A new performance monitor was created.",
  },
  report_started: {
    label: "Monitor started",
    icon: "PlayCircle",
    tone: "active",
    fallbackTitle: "Monitor started",
    fallbackDescription: "Automated monitoring is now active.",
  },
  report_paused: {
    label: "Monitor paused",
    icon: "PauseCircle",
    tone: "paused",
    fallbackTitle: "Monitor paused",
    fallbackDescription: "Automated monitoring was paused.",
  },
  report_archived: {
    label: "Monitor archived",
    icon: "Archive",
    tone: "paused",
    fallbackTitle: "Monitor archived",
    fallbackDescription: "Monitor was removed from operational use while history was retained.",
  },
  intervention_recorded: {
    label: "Action recorded",
    icon: "ClipboardCheck",
    tone: "analysis",
    fallbackTitle: "Intervention recorded",
    fallbackDescription: "A human action was recorded for a performance Issue.",
  },
  intervention_corrected: {
    label: "Action corrected",
    icon: "FilePenLine",
    tone: "decision",
    fallbackTitle: "Intervention corrected",
    fallbackDescription: "A corrected action record superseded the previous Intervention.",
  },
  intervention_cancelled: {
    label: "Action cancelled",
    icon: "Ban",
    tone: "paused",
    fallbackTitle: "Intervention cancelled",
    fallbackDescription: "The recorded action was cancelled without deleting its history.",
  },
  report_executed: {
    label: "Analyzed",
    icon: "Activity",
    tone: "analysis",
    fallbackTitle: "Performance analyzed",
    fallbackDescription: "The report ran and performance data was reviewed.",
  },
  decision_generated: {
    label: "Decision",
    icon: "Lightbulb",
    tone: "decision",
    fallbackTitle: "Decision generated",
    fallbackDescription: "A recommended next action was generated.",
  },
  signal_detected: {
    label: "Signal",
    icon: "Radar",
    tone: "warning",
    fallbackTitle: "Performance signal detected",
    fallbackDescription: "A meaningful movement was detected in the ad metrics.",
  },
  report_sent: {
    label: "Email sent",
    icon: "MailCheck",
    tone: "delivered",
    fallbackTitle: "Recommendation email sent",
    fallbackDescription: "Recommendation email was delivered to the selected recipients.",
  },
  report_failed: {
    label: "Failed",
    icon: "AlertTriangle",
    tone: "danger",
    fallbackTitle: "Report failed",
    fallbackDescription: "The report could not run.",
  },
  campaign_synced: {
    label: "Campaigns synced",
    icon: "RefreshCcw",
    tone: "connected",
    fallbackTitle: "Campaigns synced",
    fallbackDescription: "Latest Meta campaigns, ad sets, and ads were synced.",
  },
};

const SIGNAL_DISPLAY = {
  creative_fatigue: {
    label: "Creative fatigue",
    icon: "ImageOff",
    tone: "warning",
    fallbackTitle: "Creative fatigue detected",
    fallbackDescription: "Creative performance is weakening. Refresh or rotate the weakest ads.",
  },
  audience_saturation: {
    label: "Audience saturation",
    icon: "Users",
    tone: "warning",
    fallbackTitle: "Audience saturation detected",
    fallbackDescription: "The audience may be overexposed. Check frequency, CPM, and audience size.",
  },
  engagement_quality_drop: {
    label: "Engagement quality drop",
    icon: "MousePointerClick",
    tone: "warning",
    fallbackTitle: "Engagement quality dropped",
    fallbackDescription: "Traffic quality weakened. Check CTR, CPC, and post-click behavior.",
  },
  aggressive_scaling: {
    label: "Aggressive scaling",
    icon: "Rocket",
    tone: "warning",
    fallbackTitle: "Aggressive scaling detected",
    fallbackDescription: "Spend increased faster than performance can currently justify.",
  },
  conversion_funnel_breakdown: {
    label: "Funnel issue",
    icon: "FilterX",
    tone: "danger",
    fallbackTitle: "Conversion funnel issue detected",
    fallbackDescription: "Clicks are not turning into conversions efficiently. Check the landing page and offer.",
  },
  auction_pressure: {
    label: "Auction pressure",
    icon: "BadgeDollarSign",
    tone: "warning",
    fallbackTitle: "Auction pressure increased",
    fallbackDescription: "Delivery became more expensive. Check CPM, placement mix, and competition.",
  },
  delivery_instability: {
    label: "Delivery instability",
    icon: "Activity",
    tone: "warning",
    fallbackTitle: "Delivery instability detected",
    fallbackDescription: "Delivery is fluctuating. Avoid major edits until the pattern is clearer.",
  },
  traffic_quality_drop: {
    label: "Traffic quality drop",
    icon: "RouteOff",
    tone: "warning",
    fallbackTitle: "Traffic quality dropped",
    fallbackDescription: "Clicks or visits appear less valuable than before.",
  },
  volume_loss: {
    label: "Volume loss",
    icon: "TrendingDown",
    tone: "danger",
    fallbackTitle: "Volume loss detected",
    fallbackDescription: "Delivery or conversions dropped. Check budget, learning status, and audience size.",
  },
  healthy_scaling: {
    label: "Healthy scaling",
    icon: "TrendingUp",
    tone: "active",
    fallbackTitle: "Healthy scaling signal",
    fallbackDescription: "Growth looks efficient. Scale carefully while watching cost and quality.",
  },
  stable_performance: {
    label: "Stable",
    icon: "CheckCircle2",
    tone: "active",
    fallbackTitle: "Performance is stable",
    fallbackDescription: "No major action is needed right now. Keep monitoring.",
  },
  data_quality_issue: {
    label: "Data quality",
    icon: "DatabaseZap",
    tone: "warning",
    fallbackTitle: "More data needed",
    fallbackDescription: "There is not enough reliable data to make a confident recommendation.",
  },
  ctr_decline: {
    label: "CTR drop",
    icon: "MousePointerClick",
    tone: "warning",
    fallbackTitle: "CTR drop detected",
    fallbackDescription: "Fewer people are clicking. Review the hook, offer, and creative relevance.",
  },
  roas_drop: {
    label: "ROAS drop",
    icon: "TrendingDown",
    tone: "danger",
    fallbackTitle: "ROAS drop detected",
    fallbackDescription: "Revenue efficiency has declined. Avoid scaling until quality improves.",
  },
  cpm_spike: {
    label: "CPM spike",
    icon: "BadgeDollarSign",
    tone: "warning",
    fallbackTitle: "CPM spike detected",
    fallbackDescription: "Delivery became more expensive. Check auction pressure and placements.",
  },
  frequency_spike: {
    label: "Frequency spike",
    icon: "Repeat",
    tone: "warning",
    fallbackTitle: "Frequency spike detected",
    fallbackDescription: "The same audience is seeing ads too often. Refresh creative or expand audience.",
  },
  audience_overlap: {
    label: "Audience overlap",
    icon: "GitMerge",
    tone: "warning",
    fallbackTitle: "Audience overlap detected",
    fallbackDescription: "Audiences may be competing with each other. Review targeting overlap.",
  },
  pacing_warning: {
    label: "Pacing warning",
    icon: "Gauge",
    tone: "warning",
    fallbackTitle: "Pacing warning detected",
    fallbackDescription: "Spend or delivery changed faster than performance justifies.",
  },
  metric_anomaly: {
    label: "Metric anomaly",
    icon: "Radar",
    tone: "analysis",
    fallbackTitle: "Performance anomaly detected",
    fallbackDescription: "One or more key metrics moved outside the expected range.",
  },
};

const SEVERITY_TONE = {
  stable: "active",
  moderate: "warning",
  critical: "danger",
};

const styleForTone = (tone) => ACTIVITY_STYLE[tone] || ACTIVITY_STYLE.neutral;

const withSeverityTone = (baseTone, severity) => {
  if (severity === "critical" || severity === "moderate") return SEVERITY_TONE[severity];
  return baseTone || SEVERITY_TONE[severity] || "neutral";
};

const buildIconDisplay = ({ icon, tone }) => {
  const style = styleForTone(tone);

  return {
    name: icon,
    background: style.bg,
    color: style.color,
    border: style.border,
    ring: style.border,
  };
};

export const getActivityDisplay = (activity = {}) => {
  const typeConfig = ACTIVITY_DISPLAY[activity.type] || {
    label: "Activity",
    icon: "Circle",
    tone: "neutral",
    fallbackTitle: "Activity recorded",
    fallbackDescription: "An activity was recorded.",
  };
  const signalType = activity.metadata?.signal_type;
  const signalConfig =
    activity.type === "signal_detected" && signalType ? SIGNAL_DISPLAY[signalType] : null;
  const config = signalConfig || typeConfig;
  const tone = withSeverityTone(config.tone || typeConfig.tone, activity.severity);
  const style = styleForTone(tone);

  return {
    type: activity.type,
    signalType: signalType || null,
    label: config.label || typeConfig.label,
    title: activity.title || config.fallbackTitle || typeConfig.fallbackTitle,
    description:
      activity.description ||
      config.fallbackDescription ||
      typeConfig.fallbackDescription ||
      null,
    tone,
    severity: activity.severity || "stable",
    icon: buildIconDisplay({
      icon: config.icon || typeConfig.icon,
      tone,
    }),
    badge: {
      label: config.label || typeConfig.label,
      background: style.badgeBg,
      color: style.badgeColor,
      border: style.border,
    },
  };
};

export const decorateActivity = (activity) => {
  const plain = typeof activity.toObject === "function" ? activity.toObject() : activity;

  return {
    ...plain,
    display: getActivityDisplay(plain),
  };
};
