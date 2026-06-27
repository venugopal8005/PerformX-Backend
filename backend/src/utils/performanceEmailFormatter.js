const THEME_BY_URGENCY = {
  act_today: {
    label: "Action needed",
    primary: "#e11d48",
    dark: "#9f1239",
    accent: "#fb7185",
    background: "#fff1f2",
    border: "#fecdd3",
    soft: "#fff7f8",
    softBackground: "#fff7f8",
    strongBorder: "#fb7185",
  },
  review_today: {
    label: "Review today",
    primary: "#ea580c",
    dark: "#9a3412",
    accent: "#fdba74",
    background: "#fffbf5",
    border: "#fed7aa",
    soft: "#fff7ed",
    softBackground: "#fff7ed",
    strongBorder: "#fb923c",
  },
  monitor: {
    label: "Monitor",
    primary: "#2563eb",
    dark: "#1e3a8a",
    accent: "#93c5fd",
    background: "#eff6ff",
    border: "#bfdbfe",
    soft: "#f8fbff",
    softBackground: "#f8fbff",
    strongBorder: "#60a5fa",
  },
  opportunity: {
    label: "Opportunity",
    primary: "#059669",
    dark: "#065f46",
    accent: "#6ee7b7",
    background: "#ecfdf5",
    border: "#a7f3d0",
    soft: "#f6fffb",
    softBackground: "#f6fffb",
    strongBorder: "#34d399",
  },
  fix_data: {
    label: "Data needed",
    primary: "#475569",
    dark: "#0f172a",
    accent: "#cbd5e1",
    background: "#f8fafc",
    border: "#cbd5e1",
    soft: "#ffffff",
    softBackground: "#ffffff",
    strongBorder: "#94a3b8",
  },
};

const DEFAULT_THEME = THEME_BY_URGENCY.monitor;

function formatPerformanceEmail(narrative, meta = {}) {
  if (isDataIssueReport(narrative)) {
    return renderDataIssueReportEmail(narrative, meta);
  }

  return renderNormalPerformanceReportEmail(narrative, meta);
}

function renderNormalPerformanceReportEmail(narrative, meta = {}) {
  const userInsight = narrative?.userInsight || {};
  const theme = resolveReportTheme(narrative);
  const period = narrative?.period || {};
  const campaign = narrative?.campaign || {};
  const decisionBrief = userInsight.decisionBrief || {};
  const preheader =
    summaryPrimaryAction(narrative) ||
    decisionBrief.primaryAction ||
    userInsight.headline ||
    narrative?.executiveSummary ||
    "Meta Ads performance report";
  const includeMetricSnapshot = meta.includeMetricSnapshot !== false;
  const content = `
            ${renderHeader(theme, meta, campaign, period)}
            ${renderImportantSummaryBlock(narrative, meta, theme)}
            ${renderDetailsEvidenceBlock(narrative, theme, {
              includeMetricSnapshot,
            })}
            ${meta.includeDiagnostics === false ? "" : renderDiagnosticsBlock(narrative)}
            ${renderFooter(meta)}`;

  return renderEmailDocument(meta, preheader, content);
}

function renderDataIssueReportEmail(narrative, meta = {}) {
  const userInsight = narrative?.userInsight || {};
  const theme = resolveReportTheme(narrative);
  const period = narrative?.period || {};
  const campaign = narrative?.campaign || {};
  const preheader =
    userInsight.decisionBrief?.primaryAction ||
    narrative?.disclaimer ||
    "Fix the Meta data window before optimizing.";
  const includeMetricSnapshot = meta.includeMetricSnapshot !== false;
  const content = `
            ${renderHeader(theme, meta, campaign, period)}
            ${renderImportantSummaryBlock(narrative, meta, theme, { dataIssue: true })}
            ${renderFixDataBlock(theme, narrative)}
            ${renderDetailsEvidenceBlock(narrative, theme, {
              fallback: true,
              includeMetricSnapshot,
            })}
            ${meta.includeDiagnostics === false ? "" : renderDiagnosticsBlock(narrative)}
            ${renderFooter(meta)}`;

  return renderEmailDocument(meta, preheader, content);
}

function renderEmailDocument(meta, preheader, content) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(meta.subject || "Meta Ads Performance Report")}</title>
  </head>
  <body style="margin:0;padding:0;background:#e5e7eb;font-family:Inter,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Arial,Helvetica,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(preheader)}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#e5e7eb;margin:0;padding:28px 0;">
      <tr>
        <td align="center" style="padding:0 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #d1d5db;box-shadow:0 16px 38px rgba(15,23,42,.13);">
            ${content}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function isDataIssueReport(narrative) {
  return (
    narrative?.decisionType?.id === "data_issue" ||
    narrative?.trustGate?.actionability === "fix_data" ||
    narrative?.userInsight?.urgency === "fix_data"
  );
}

function isOpportunityReport(narrative) {
  return (
    narrative?.decisionType?.id === "opportunity" ||
    narrative?.userInsight?.urgency === "opportunity" ||
    narrative?.userInsight?.decisionBrief?.decision === "protect_and_scale"
  );
}

function isAuctionPressureReport(narrative) {
  return (
    narrative?.likelyCause?.id === "auction_pressure" ||
    narrative?.userInsight?.decisionBrief?.decision === "avoid_expensive_auction" ||
    (narrative?.decisionType?.id === "budget_action" &&
      /auction|expensive|scale/i.test(String(narrative?.userInsight?.decisionBrief?.label || "")))
  );
}

function resolveActionability(narrative) {
  if (isDataIssueReport(narrative)) return "fix_data";
  if (isOpportunityReport(narrative)) return "opportunity";
  if (isAuctionPressureReport(narrative)) return "review_today";
  return narrative?.trustGate?.actionability || narrative?.userInsight?.urgency || "monitor";
}

function resolveReportTheme(narrative) {
  return THEME_BY_URGENCY[resolveActionability(narrative)] || DEFAULT_THEME;
}

function formatPerformanceEmailSubject(narrative, meta = {}) {
  const userInsight = narrative?.userInsight || {};
  const campaignName =
    narrative?.campaign?.name || meta.campaignName || "Meta Ads";
  const urgency = resolveActionability(narrative);
  const focusAd = userInsight.adToFixFirst?.adName;
  const decisionLabel = userInsight.decisionBrief?.label;
  const decisionType = narrative?.decisionType?.id;
  const headline = focusAd
    ? `${decisionLabel || "Fix"}: ${focusAd}`
    : decisionLabel || userInsight.headline || narrative?.keyDelta || "Performance update";
  const periodDate = formatPeriodLabel(narrative?.period?.current);
  const dateSuffix = periodDate && periodDate !== "Unknown period" ? ` - ${periodDate}` : "";

  const prefixByUrgency = {
    act_today: "Action needed",
    review_today: "Review today",
    monitor: "Monitor",
    opportunity: "Opportunity",
    fix_data: "Data needed",
  };

  const prefix =
    decisionType === "data_issue"
      ? "Data needed"
      : prefixByUrgency[urgency] || "Monitor";

  if (focusAd) {
    return truncateSubject(`${prefix}: ${subjectActionVerb(userInsight.decisionBrief)} ${focusAd} in ${campaignName}${dateSuffix}`);
  }

  return truncateSubject(`${prefix}: ${campaignName} - ${headline}${dateSuffix}`);
}

function renderHeader(theme, meta, campaign, period) {
  const title = formatHeaderTitle(meta);
  const campaignName = campaign.name || meta.campaignName || "Account report";
  const currentPeriod = formatPeriodLabel(period.current);
  const previousPeriod = formatPeriodLabel(period.previous);
  const dateText = currentPeriod !== "Unknown period" && previousPeriod !== "Unknown period"
    ? `${previousPeriod} vs ${currentPeriod}`
    : formatDate(new Date());

  return `
    <tr>
      <td style="padding:0;background:#0f172a;color:#ffffff;">
        <div style="height:6px;background:${theme.primary};line-height:6px;font-size:6px;">&nbsp;</div>
        <div style="padding:24px 28px 22px;background:#0f172a;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:12px;line-height:17px;color:#94a3b8;font-weight:800;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(title)}</div>
              <div style="font-size:26px;line-height:32px;font-weight:800;margin-top:7px;color:#ffffff;">${escapeHtml(campaignName)}</div>
              <div style="font-size:14px;line-height:20px;color:#cbd5e1;margin-top:6px;">${escapeHtml(dateText)}</div>
            </td>
            <td align="right" style="vertical-align:top;">
              <span style="display:inline-block;background:${theme.primary};color:#ffffff;font-size:12px;line-height:18px;font-weight:800;padding:8px 12px;border-radius:999px;text-transform:uppercase;letter-spacing:.03em;">${escapeHtml(theme.label)}</span>
            </td>
          </tr>
        </table>
        </div>
      </td>
    </tr>`;
}

function formatHeaderTitle(meta = {}) {
  if (meta.sampleMode || meta.isSampleReport) return "Sample report";

  const title = meta.title || "Meta Ads Performance Report";
  if (/^mock report/i.test(String(title))) return "Sample report";
  return title;
}

function renderDisclaimer(narrative) {
  if (!narrative?.disclaimer) return "";

  return `
    <tr>
      <td style="padding:16px 28px 0;background:#ffffff;">
        <div style="border:1px solid #fde68a;border-radius:12px;background:#fffbeb;padding:12px 14px;">
          <div style="font-size:13px;line-height:20px;color:#92400e;">
            <b>Data window note:</b> ${escapeHtml(narrative.disclaimer)}
          </div>
        </div>
      </td>
    </tr>`;
}

function renderDataWindowWarning(narrative) {
  const scheduledWindow = formatComparisonWindow(narrative?.scheduledPeriod);
  const latestAvailable = latestAvailableDeliveryLabel(narrative);
  const scheduledText =
    scheduledWindow !== "Unknown period"
      ? scheduledWindow
      : "the scheduled comparison window";
  const latestText =
    latestAvailable !== "Unknown period"
      ? latestAvailable
      : "the latest available delivery window";

  return `
    <tr>
      <td style="padding:18px 28px 0;background:#ffffff;">
        <div style="border:1px solid #fde68a;border-radius:12px;background:#fffbeb;padding:14px 16px;">
          <div style="font-size:16px;line-height:22px;color:#78350f;font-weight:800;">Data window note</div>
          <div style="font-size:14px;line-height:22px;color:#92400e;margin-top:6px;">
            No delivery was found in the scheduled comparison window: <b>${escapeHtml(scheduledText)}</b>.
          </div>
          <div style="font-size:14px;line-height:22px;color:#92400e;margin-top:4px;">
            This report used latest available delivery ending: <b>${escapeHtml(latestText)}</b>.
          </div>
        </div>
      </td>
    </tr>`;
}

function renderImportantSummaryBlock(narrative, meta, theme, options = {}) {
  return `
    <tr>
      <td style="padding:22px 28px 18px;background:#ffffff;">
        ${renderReportSummaryCard(narrative, meta, {
          theme,
          dataIssue: options.dataIssue,
          sampleMode: options.sampleMode || meta?.sampleMode || meta?.isSampleReport,
        })}
      </td>
    </tr>`;
}

function renderReportSummaryCard(narrative, meta = {}, options = {}) {
  const theme = options.theme || resolveReportTheme(narrative);
  const userInsight = narrative?.userInsight || {};
  const decision = userInsight.decisionBrief || {};
  const dataIssue = options.dataIssue || isDataIssueReport(narrative);
  const compact = Boolean(options.compact);
  const campaignName =
    options.sampleMode || meta.sampleMode || meta.isSampleReport
      ? "Sample report"
      : narrative?.campaign?.name || meta.campaignName || meta.title || "Account report";
  const periodText = formatComparisonWindow(narrative?.period);
  const statusLabel = formatActionability(resolveActionability(narrative));
  const decisionType = dataIssue
    ? "Data Issue"
    : formatSummaryDecisionType(narrative);
  const headline = dataIssue
    ? "Fix data window before optimizing"
    : decision.label || userInsight.headline || "Performance insight is ready.";
  const reason = dataIssue
    ? buildDataIssueSummaryReason(narrative)
    : buildRelationshipSummary(narrative);
  const primaryAction = dataIssue
    ? "Verify the scheduled Meta delivery window and rerun the report."
    : summaryPrimaryAction(narrative);
  const doNotDo = dataIssue
    ? "Do not make campaign optimization decisions from this report."
    : decision.doNotDo || "Do not change budget until the signal is reviewed.";
  const metrics = dataIssue ? [] : buildSummaryMetricItems(narrative);
  const trustChips = buildSummaryTrustChips(narrative, dataIssue);
  const doNotTone = getDoNotTone(narrative);
  const cardPadding = compact ? "16px 17px 15px" : "20px 20px 18px";

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${theme.border};border-top:3px solid ${theme.strongBorder || theme.primary};border-radius:22px;background:${theme.softBackground || theme.soft};overflow:hidden;box-shadow:0 14px 32px rgba(15,23,42,.08);">
      <tr>
        <td style="padding:${cardPadding};">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td style="vertical-align:top;font-size:12px;line-height:18px;color:#64748b;font-weight:700;">
                ${escapeHtml(periodText)}
              </td>
              <td align="right" style="vertical-align:top;">
                <span style="display:inline-block;background:${theme.primary};color:#ffffff;font-size:12px;line-height:16px;font-weight:800;padding:7px 10px;border-radius:999px;">${escapeHtml(statusLabel)}</span>
                <span style="display:inline-block;margin-left:6px;background:#ffffff;border:1px solid ${theme.border};color:${theme.dark || theme.primary};font-size:12px;line-height:16px;font-weight:800;padding:7px 10px;border-radius:999px;">${escapeHtml(decisionType)}</span>
              </td>
            </tr>
          </table>
          <div style="font-size:12px;line-height:18px;color:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin-top:15px;">${escapeHtml(campaignName)}</div>
          <div style="font-size:27px;line-height:33px;color:#0f172a;font-weight:800;margin-top:4px;">${escapeHtml(headline)}</div>
          <div style="font-size:15px;line-height:23px;color:#334155;font-weight:400;margin-top:8px;">${escapeHtml(reason)}</div>
          ${metrics.length ? `
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:15px;">
              <tr>
                ${metrics.map(([label, value]) => renderSummaryMetricCell(label, value, narrative)).join("")}
                ${Array.from({ length: 3 - metrics.length }).map(() => `<td style="width:33.33%;"></td>`).join("")}
              </tr>
            </table>
          ` : ""}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:15px;">
            <tr>
              <td style="padding:14px 15px;background:#ffffff;border:1px solid ${theme.border};border-top:2px solid ${theme.strongBorder || theme.primary};border-radius:16px;box-shadow:0 6px 16px rgba(15,23,42,.06);">
                <div style="font-size:11px;line-height:15px;color:${theme.dark || theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Do this now</div>
                <div style="font-size:15px;line-height:22px;color:#0f172a;font-weight:800;margin-top:4px;">${escapeHtml(primaryAction)}</div>
              </td>
            </tr>
            <tr><td style="height:8px;font-size:8px;line-height:8px;">&nbsp;</td></tr>
            <tr>
              <td style="padding:12px 14px;background:${doNotTone.background};border:1px solid ${doNotTone.border};border-radius:15px;">
                <div style="font-size:11px;line-height:15px;color:${doNotTone.label};font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Do not</div>
                <div style="font-size:14px;line-height:21px;color:${doNotTone.text};font-weight:500;margin-top:4px;">${escapeHtml(doNotDo)}</div>
              </td>
            </tr>
          </table>
          <div style="margin-top:13px;">
            ${trustChips.map(([label, value]) => `<span style="display:inline-block;margin:0 7px 7px 0;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:15px;color:#0f172a;font-weight:700;">${label ? `${escapeHtml(label)}: ` : ""}${escapeHtml(value)}</span>`).join("")}
          </div>
        </td>
      </tr>
    </table>`;
}

function renderSummaryMetricCell(label, value, narrative = null) {
  const parsed = parseSnapshotValue(value);
  const tone = metricDeltaTone(label, parsed.delta, narrative);

  return `
    <td style="width:33.33%;padding:0 8px 0 0;vertical-align:top;">
      <div style="border:1px solid ${tone.border};border-radius:15px;background:${tone.background};padding:11px 12px;box-shadow:0 1px 0 rgba(15,23,42,.03);">
        <div style="font-size:11px;line-height:15px;color:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">${escapeHtml(label)}</div>
        <div style="font-size:16px;line-height:21px;color:#0f172a;font-weight:700;margin-top:3px;">${escapeHtml(parsed.current)}</div>
        ${parsed.delta ? `<div style="display:inline-block;margin-top:6px;border-radius:999px;background:${tone.pill};color:${tone.text};padding:4px 7px;font-size:12px;line-height:14px;font-weight:800;">${escapeHtml(parsed.delta)}</div>` : ""}
      </div>
    </td>`;
}

function renderDetailsEvidenceBlock(narrative, theme, options = {}) {
  const fallback = Boolean(options.fallback);
  const includeMetricSnapshot = options.includeMetricSnapshot !== false;
  const metricSection = includeMetricSnapshot
    ? renderExpandedMetricsSection(narrative, fallback)
    : "";
  const evidenceSection = renderRelationshipEvidenceSection(narrative, fallback);
  const contributorSection = fallback ? "" : renderContributorSection(theme, narrative);
  const actionSection = fallback ? "" : renderActionChecklistSection(theme, narrative);
  const watchSection = fallback ? "" : renderWatchNextSection(theme, narrative);
  const hasContent = [metricSection, evidenceSection, contributorSection, actionSection, watchSection].some(Boolean);

  if (!hasContent) return "";

  return `
    <tr>
      <td style="padding:0 28px 20px;background:#ffffff;">
        <div style="border:1px solid #e2e8f0;border-radius:16px;background:#ffffff;overflow:hidden;">
          <div style="padding:14px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">
            <div style="font-size:16px;line-height:22px;color:#0f172a;font-weight:800;">${fallback ? "Fallback context" : "Details / evidence"}</div>
            <div style="font-size:12px;line-height:18px;color:#64748b;margin-top:2px;">${fallback ? "Use this only as context until the data window is fixed." : "Supporting signals behind the summary decision."}</div>
          </div>
          <div style="padding:14px 16px 4px;">
            ${metricSection}
            ${evidenceSection}
            ${contributorSection}
            ${actionSection}
            ${watchSection}
          </div>
        </div>
      </td>
    </tr>`;
}

function renderExpandedMetricsSection(narrative, fallback) {
  const summaryLabels = new Set(buildSummaryMetricItems(narrative).map(([label]) => label));
  const metrics = buildMetricSnapshotItems(narrative, narrative?.userInsight || {})
    .filter(([label]) => fallback || !summaryLabels.has(label))
    .slice(0, fallback ? 6 : 6);

  if (!metrics.length) return "";

  return renderInnerSection(
    fallback ? "Fallback numbers" : "Expanded metrics",
    fallback
      ? "Latest available data, not the scheduled report window."
      : "Additional useful metrics beyond the summary card.",
    `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        ${chunk(metrics, 3).map((row) => `
          <tr>
            ${row.map(([label, value]) => renderMetricCell(label, value, narrative)).join("")}
            ${Array.from({ length: 3 - row.length }).map(() => `<td style="width:33.33%;"></td>`).join("")}
          </tr>
        `).join("")}
      </table>`
  );
}

function renderRelationshipEvidenceSection(narrative, fallback) {
  const userInsight = narrative?.userInsight || {};
  const evidence = (userInsight.plainEnglishEvidence || []).filter(Boolean).slice(0, 2);
  const relationship = fallback
    ? "This movement is shown for context only. Do not optimize from it until the data window is fixed."
    : buildRelationshipSummary(narrative);

  if (!relationship && !evidence.length) return "";

  return renderInnerSection(
    fallback ? "Fallback movement" : "Evidence",
    "",
    `
      ${relationship ? `<div style="font-size:14px;line-height:22px;color:#0f172a;font-weight:700;margin-bottom:${evidence.length ? "8px" : "0"};">${escapeHtml(relationship)}</div>` : ""}
      ${evidence.length ? `
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;overflow:hidden;">
          ${evidence.map((item, index) => `
            <tr>
              <td width="96" style="padding:11px 12px;vertical-align:top;${index ? "border-top:1px solid #e2e8f0;" : ""}">
                <span style="display:inline-block;background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;padding:6px 8px;font-size:12px;line-height:15px;color:#0f172a;font-weight:800;">${escapeHtml(item.metric)} ${escapeHtml(item.change)}</span>
              </td>
              <td style="padding:11px 12px 11px 0;vertical-align:middle;${index ? "border-top:1px solid #e2e8f0;" : ""}">
                <div style="font-size:13px;line-height:20px;color:#475569;">${escapeHtml(item.meaning)}</div>
              </td>
            </tr>
          `).join("")}
        </table>
      ` : ""}`
  );
}

function renderContributorSection(theme, narrative) {
  const contributor = buildContributorPresentation(narrative);
  if (!contributor) return "";

  return renderInnerSection(
    contributor.title,
    contributor.subtitle,
    `
      <div style="border:1px solid ${theme.border};border-radius:12px;background:${theme.soft};padding:12px 14px;">
        <div style="font-size:15px;line-height:22px;color:#0f172a;font-weight:800;">${escapeHtml(contributor.name)}</div>
        <div style="font-size:13px;line-height:20px;color:#475569;margin-top:4px;">${escapeHtml(contributor.summary)}</div>
        <div style="font-size:13px;line-height:20px;color:#0f172a;margin-top:8px;"><b>Recommended action:</b> ${escapeHtml(contributor.action)}</div>
        ${contributor.evidence.length ? `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px;">
            ${contributor.evidence.slice(0, 2).map((item) => `
              <tr>
                <td width="16" style="font-size:15px;line-height:21px;color:${theme.primary};vertical-align:top;">&bull;</td>
                <td style="font-size:12px;line-height:19px;color:#64748b;padding-bottom:2px;">${escapeHtml(item)}</td>
              </tr>
            `).join("")}
          </table>
        ` : ""}
      </div>`
  );
}

function renderActionChecklistSection(theme, narrative) {
  const userInsight = narrative?.userInsight || {};
  const checklist = userInsight.decisionBrief?.actionChecklist || userInsight.whatToDoNext || [];
  const steps = checklist.filter(Boolean).slice(0, 3);

  if (isAuctionPressureReport(narrative) && steps.length) {
    steps[0] = "Hold budget and compare CPM by placement, audience, and geography before changing creative.";
  }

  if (!steps.length) return "";

  return renderInnerSection(
    "Next actions",
    "The shortest useful sequence.",
    steps.map((step, index) => `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:8px;border:1px solid ${index === 0 ? theme.border : "#e2e8f0"};border-radius:12px;background:${index === 0 ? theme.soft : "#ffffff"};">
        <tr>
          <td width="42" style="padding:10px 0 10px 12px;vertical-align:top;">
            <div style="width:26px;height:26px;border-radius:999px;background:${index === 0 ? theme.primary : "#e2e8f0"};color:${index === 0 ? "#ffffff" : "#334155"};text-align:center;font-size:13px;line-height:26px;font-weight:800;">${index + 1}</div>
          </td>
          <td style="padding:10px 12px 10px 4px;font-size:14px;line-height:21px;color:#0f172a;font-weight:${index === 0 ? "800" : "500"};">${escapeHtml(step)}</td>
        </tr>
      </table>`).join("")
  );
}

function renderWatchNextSection(theme, narrative) {
  const watch = narrative?.userInsight?.watchNext || {};
  const metrics = watch.metrics || [];

  if (!watch.goodSign && !watch.badSign && !metrics.length) return "";

  return renderInnerSection(
    "Watch next",
    `Timeframe: ${watch.timeframe || "Next 48-72 hours"}`,
    `
      ${metrics.length ? `<div style="margin-bottom:9px;">${metrics.map((metric) => `<span style="display:inline-block;background:${theme.background};border:1px solid ${theme.border};color:${theme.dark || theme.primary};border-radius:999px;padding:6px 9px;margin:0 5px 5px 0;font-size:12px;line-height:15px;font-weight:700;">${escapeHtml(metric)}</span>`).join("")}</div>` : ""}
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
        ${watch.goodSign ? `<tr><td style="padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;font-size:13px;line-height:20px;color:#064e3b;"><b>Good:</b> ${escapeHtml(watch.goodSign)}</td></tr>` : ""}
        ${watch.goodSign && watch.badSign ? `<tr><td style="height:7px;font-size:7px;line-height:7px;">&nbsp;</td></tr>` : ""}
        ${watch.badSign ? `<tr><td style="padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;font-size:13px;line-height:20px;color:#9a3412;"><b>Bad:</b> ${escapeHtml(watch.badSign)}</td></tr>` : ""}
      </table>`
  );
}

function renderFixDataBlock(theme, narrative) {
  return `
    <tr>
      <td style="padding:0 28px 20px;background:#ffffff;">
        <div style="border:1px solid ${theme.border};border-radius:16px;background:#f8fafc;overflow:hidden;">
          <div style="padding:14px 16px;background:#fffbeb;border-bottom:1px solid #fde68a;">
            <div style="font-size:16px;line-height:22px;color:#78350f;font-weight:800;">Fix data before reading performance</div>
            <div style="font-size:12px;line-height:18px;color:#92400e;margin-top:2px;">The scheduled window did not contain usable delivery data.</div>
          </div>
          <div style="padding:14px 16px 6px;">
            ${renderDataWindowWarningInner(narrative)}
            ${renderFixDataChecklistInner(theme)}
          </div>
        </div>
      </td>
    </tr>`;
}

function renderDataWindowWarningInner(narrative) {
  const scheduledWindow = formatComparisonWindow(narrative?.scheduledPeriod);
  const latestAvailable = latestAvailableDeliveryLabel(narrative);

  return `
    <div style="border:1px solid #fde68a;border-radius:12px;background:#fffbeb;padding:12px 14px;margin-bottom:12px;">
      <div style="font-size:14px;line-height:20px;color:#78350f;font-weight:800;">Data window note</div>
      <div style="font-size:13px;line-height:21px;color:#92400e;margin-top:5px;">
        No delivery was found in the scheduled comparison window: <b>${escapeHtml(scheduledWindow)}</b>.
      </div>
      <div style="font-size:13px;line-height:21px;color:#92400e;margin-top:3px;">
        This report used latest available delivery ending: <b>${escapeHtml(latestAvailable)}</b>.
      </div>
    </div>`;
}

function renderFixDataChecklistInner(theme) {
  const steps = [
    "Verify the scheduled Meta delivery window and report date range.",
    "Confirm Meta returned spend, impressions, and clicks for the expected period.",
    "Check campaign status, spend limits, permissions, and account connection.",
    "Rerun the report after data is corrected.",
  ];

  return renderInnerSection(
    "Fix-data checklist",
    "Complete these before using the report for optimization.",
    steps.map((step, index) => `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:8px;border:1px solid ${index === 0 ? theme.border : "#e2e8f0"};border-radius:12px;background:#ffffff;">
        <tr>
          <td width="42" style="padding:10px 0 10px 12px;vertical-align:top;">
            <div style="width:26px;height:26px;border-radius:999px;background:${index === 0 ? theme.primary : "#e2e8f0"};color:${index === 0 ? "#ffffff" : "#334155"};text-align:center;font-size:13px;line-height:26px;font-weight:800;">${index + 1}</div>
          </td>
          <td style="padding:10px 12px 10px 4px;font-size:14px;line-height:21px;color:#0f172a;font-weight:${index === 0 ? "800" : "500"};">${escapeHtml(step)}</td>
        </tr>
      </table>`).join("")
  );
}

function renderDiagnosticsBlock(narrative) {
  const userInsight = narrative?.userInsight || {};
  const dataQuality = narrative?.dataQuality || {};
  const trust = userInsight.trust || {};
  const trustGate = narrative?.trustGate || userInsight.trustGate || {};
  const baseline = trust.baseline || narrative?.trustLayer?.baseline || {};
  const filteredSignals = trust.filteredSignals || [];
  const warnings = uniqueNonEmpty([
    ...(trust.caveats || []),
    ...(trustGate.caveats || []),
    ...(dataQuality.warnings || []),
  ]).slice(0, 3);
  const checks = (narrative?.diagnosticChecks || []).filter(Boolean).slice(0, 4);
  const reliabilityText = formatSeverity(trust.level || "unknown");
  const dataScoreText = formatDataScore(trust.score);

  return `
    <tr>
      <td style="padding:0 28px 24px;background:#ffffff;">
        <div style="border:1px solid #e2e8f0;border-radius:16px;background:#f8fafc;padding:14px 16px;">
          <div style="font-size:16px;line-height:22px;color:#0f172a;font-weight:800;">Diagnostics</div>
          <div style="font-size:12px;line-height:18px;color:#64748b;margin-top:2px;">Reliability and data notes behind this recommendation.</div>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;">
            <tr>
              <td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:5px;"><b>Data confidence:</b> ${escapeHtml(formatSeverity(dataQuality.level || "unknown"))}</td>
            </tr>
            <tr>
              <td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:5px;"><b>Reliability:</b> ${escapeHtml(reliabilityText)}${trust.summary ? ` - ${escapeHtml(trust.summary)}` : ""}</td>
            </tr>
            ${dataScoreText ? `<tr><td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:5px;"><b>Data score:</b> ${escapeHtml(dataScoreText)}</td></tr>` : ""}
            <tr>
              <td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:5px;"><b>Baseline:</b> ${escapeHtml(baseline.summary || "No baseline status was provided.")}</td>
            </tr>
            ${warnings.length ? `<tr><td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:5px;"><b>Notes:</b> ${escapeHtml(warnings.join(" "))}</td></tr>` : ""}
          </table>
          ${filteredSignals.length ? `
            <div style="font-size:13px;line-height:20px;color:#475569;margin-top:6px;"><b>Filtered or unreliable metrics:</b></div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:4px;">
              ${filteredSignals.slice(0, 4).map((item) => `
                <tr>
                  <td width="16" style="font-size:15px;line-height:21px;color:#64748b;vertical-align:top;">&bull;</td>
                  <td style="font-size:12px;line-height:19px;color:#64748b;padding-bottom:2px;"><b>${escapeHtml(item.metric || "Metric")}:</b> ${escapeHtml(item.reason || "Signal reliability is limited.")}</td>
                </tr>
              `).join("")}
            </table>
          ` : ""}
          ${checks.length ? `
            <div style="font-size:13px;line-height:20px;color:#475569;margin-top:8px;"><b>Diagnostic checks:</b></div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:4px;">
              ${checks.map((check) => `
                <tr>
                  <td width="16" style="font-size:15px;line-height:21px;color:#64748b;vertical-align:top;">&bull;</td>
                  <td style="font-size:12px;line-height:19px;color:#64748b;padding-bottom:2px;">${escapeHtml(check)}</td>
                </tr>
              `).join("")}
            </table>
          ` : ""}
        </div>
      </td>
    </tr>`;
}

function renderInnerSection(title, subtitle, content) {
  return `
    <div style="margin-bottom:14px;">
      <div style="font-size:14px;line-height:20px;color:#0f172a;font-weight:800;">${escapeHtml(title)}</div>
      ${subtitle ? `<div style="font-size:12px;line-height:18px;color:#64748b;margin-top:1px;margin-bottom:8px;">${escapeHtml(subtitle)}</div>` : `<div style="height:8px;font-size:8px;line-height:8px;">&nbsp;</div>`}
      ${content}
    </div>`;
}

function renderInsightHero(theme, userInsight, narrative) {
  const decision = userInsight.decisionBrief || {};
  const diagnosis = userInsight.simpleDiagnosis || {};
  const firstAction = decision.primaryAction || userInsight.whatToDoNext?.[0];
  const doNotDo = decision.doNotDo;
  const decisionType = narrative?.decisionType;
  const reason =
    decision.plainReason ||
    diagnosis.inPlainEnglish ||
    userInsight.plainSummary ||
    narrative?.executiveSummary ||
    "";

  return `
    <tr>
      <td style="padding:26px 28px 24px;background:${theme.background};border-bottom:1px solid ${theme.border};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td width="8" style="background:${theme.primary};border-radius:999px;font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="padding-left:16px;">
              <div style="font-size:12px;line-height:17px;color:${theme.dark || theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(decision.timeframe || "Next step")}</div>
              <div style="font-size:28px;line-height:34px;font-weight:800;color:#0f172a;margin:5px 0 9px;">${escapeHtml(decision.label || userInsight.headline || "Performance insight is ready.")}</div>
              ${decisionType?.label ? `<div style="display:inline-block;margin-bottom:9px;border:1px solid ${theme.border};border-radius:999px;background:#ffffff;padding:6px 9px;font-size:12px;line-height:15px;color:${theme.dark || theme.primary};font-weight:800;">${escapeHtml(decisionType.label)}</div>` : ""}
              <div style="font-size:15px;line-height:24px;color:#334155;">${escapeHtml(reason)}</div>
              ${renderDecisionPills(theme, narrative, userInsight)}
            </td>
          </tr>
        </table>
        ${firstAction ? `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px;border:1px solid ${theme.border};border-radius:14px;background:#ffffff;box-shadow:0 8px 20px rgba(15,23,42,.06);">
            <tr>
              <td width="52" style="padding:16px 0 16px 16px;vertical-align:top;">
                <div style="width:36px;height:36px;border-radius:999px;background:${theme.primary};color:#ffffff;text-align:center;font-size:18px;line-height:36px;font-weight:800;">1</div>
              </td>
              <td style="padding:16px 18px 16px 10px;">
                <div style="font-size:12px;line-height:16px;color:${theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.05em;">Do this now</div>
                <div style="font-size:17px;line-height:25px;color:#0f172a;font-weight:800;margin-top:4px;">${escapeHtml(firstAction)}</div>
              </td>
            </tr>
          </table>
        ` : ""}
        ${doNotDo ? `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px;border:1px solid #fecdd3;border-radius:12px;background:#fff1f2;">
            <tr>
              <td width="42" style="padding:12px 0 12px 14px;vertical-align:top;">
                <div style="width:26px;height:26px;border-radius:999px;background:#e11d48;color:#ffffff;text-align:center;font-size:16px;line-height:26px;font-weight:800;">!</div>
              </td>
              <td style="font-size:14px;line-height:22px;color:#7f1d1d;padding:12px 14px 12px 6px;">
                <b>Do not:</b> ${escapeHtml(doNotDo)}
              </td>
            </tr>
          </table>
        ` : ""}
      </td>
    </tr>`;
}

function renderDataIssueHero(theme, userInsight, narrative) {
  const decision = userInsight.decisionBrief || {};
  const latestAvailable = latestAvailableDeliveryLabel(narrative);
  const primaryAction = "Verify the scheduled Meta delivery window and rerun the report.";
  const doNotDo =
    decision.doNotDo ||
    "Do not make campaign optimization decisions from this report.";
  const latestLine =
    latestAvailable !== "Unknown period"
      ? `Narrative used the latest available campaign delivery ending ${latestAvailable}.`
      : "Narrative used the latest available campaign delivery as fallback context.";

  return `
    <tr>
      <td style="padding:26px 28px 24px;background:${theme.background};border-bottom:1px solid ${theme.border};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td width="8" style="background:${theme.primary};border-radius:999px;font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="padding-left:16px;">
              <div style="font-size:12px;line-height:17px;color:${theme.dark};font-weight:800;text-transform:uppercase;letter-spacing:.08em;">Data needed</div>
              <div style="font-size:28px;line-height:34px;font-weight:800;color:#0f172a;margin:5px 0 9px;">Fix data window before optimizing</div>
              <div style="font-size:15px;line-height:24px;color:#334155;">
                The scheduled report window had no usable Meta delivery data. ${escapeHtml(latestLine)}
              </div>
              ${renderDecisionPills(theme, narrative, userInsight, { includeImpact: false })}
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px;border:1px solid ${theme.border};border-radius:14px;background:#ffffff;box-shadow:0 8px 20px rgba(15,23,42,.06);">
          <tr>
            <td width="52" style="padding:16px 0 16px 16px;vertical-align:top;">
              <div style="width:36px;height:36px;border-radius:999px;background:${theme.primary};color:#ffffff;text-align:center;font-size:18px;line-height:36px;font-weight:800;">1</div>
            </td>
            <td style="padding:16px 18px 16px 10px;">
              <div style="font-size:12px;line-height:16px;color:${theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.05em;">Do this now</div>
              <div style="font-size:17px;line-height:25px;color:#0f172a;font-weight:800;margin-top:4px;">${escapeHtml(primaryAction)}</div>
            </td>
          </tr>
        </table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px;border:1px solid #fecdd3;border-radius:12px;background:#fff1f2;">
          <tr>
            <td width="42" style="padding:12px 0 12px 14px;vertical-align:top;">
              <div style="width:26px;height:26px;border-radius:999px;background:#e11d48;color:#ffffff;text-align:center;font-size:16px;line-height:26px;font-weight:800;">!</div>
            </td>
            <td style="font-size:14px;line-height:22px;color:#7f1d1d;padding:12px 14px 12px 6px;">
              <b>Do not:</b> ${escapeHtml(doNotDo)}
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderDecisionPills(theme, narrative, userInsight, options = {}) {
  const includeImpact = options.includeImpact !== false;
  const trust = userInsight.trust || {};
  const trustGate = narrative?.trustGate || userInsight.trustGate || {};
  const severity = narrative?.severity || {};
  const financialImpact = narrative?.financialImpact || {};
  const reliabilityText = Number.isFinite(Number(trust.score))
    ? `${capitalize(trust.level || "unknown")} ${trust.score}/100`
    : capitalize(trust.level || "unknown");
  const pills = [
    ["Confidence", userInsight.confidence || userInsight.decisionBrief?.confidence || "Medium"],
    ["Reliability", reliabilityText],
    ["Actionability", trustGate.actionability || userInsight.urgency],
    ["Severity", severity.level || "low"],
  ];
  const impactText = formatImpactLabel(financialImpact);
  const hasMeaningfulImpact =
    includeImpact &&
    financialImpact?.type &&
    !["unknown", "unavailable"].includes(financialImpact.type) &&
    financialImpact.shouldDisplayAmount !== false;

  if (hasMeaningfulImpact) {
    pills.push(["Impact", impactText]);
  }

  return `
    <div style="margin-top:13px;">
      ${pills
        .filter(([, value]) => value)
        .map(([label, value]) => `<span style="display:inline-block;margin:0 7px 7px 0;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:15px;color:#0f172a;font-weight:800;">${escapeHtml(label)}: ${escapeHtml(value)}</span>`)
        .join("")}
    </div>`;
}

function renderWhatHappened(items = []) {
  if (!items.length) return "";

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;">
      ${items.slice(0, 3).map((item) => `
        <tr>
          <td width="24" style="vertical-align:top;padding-top:4px;">
            <div style="width:7px;height:7px;border-radius:999px;background:#64748b;font-size:1px;line-height:1px;">&nbsp;</div>
          </td>
          <td style="font-size:14px;line-height:23px;color:#334155;padding-bottom:5px;">${escapeHtml(item)}</td>
        </tr>
      `).join("")}
    </table>`;
}

function renderPlainEvidence(userInsight, options = {}) {
  const evidence = (userInsight.plainEnglishEvidence || []).filter(Boolean).slice(0, options.maxItems || 3);
  if (!evidence.length) return "";
  const title = options.title || "What changed";
  const subtitle = options.subtitle || "The plain-English signal behind the recommendation.";

  return `
    <tr>
      <td style="padding:24px 28px 8px;background:#ffffff;">
        ${renderSectionTitle(title, subtitle)}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;overflow:hidden;">
          ${evidence.map((item, index) => `
            <tr>
              <td width="104" style="padding:14px;vertical-align:top;${index ? "border-top:1px solid #e2e8f0;" : ""}">
                <span style="display:inline-block;background:#f8fafc;border:1px solid #e2e8f0;border-radius:999px;padding:7px 10px;font-size:13px;line-height:16px;color:#0f172a;font-weight:800;">${escapeHtml(item.metric)} ${escapeHtml(item.change)}</span>
              </td>
              <td style="padding:14px 16px 14px 0;vertical-align:middle;${index ? "border-top:1px solid #e2e8f0;" : ""}">
                <div style="font-size:14px;line-height:21px;color:#334155;">${escapeHtml(item.meaning)}</div>
              </td>
            </tr>
          `).join("")}
        </table>
      </td>
    </tr>`;
}

function renderTopContributor(theme, narrative) {
  const contributor = narrative?.topContributor;
  if (!contributor) return "";
  const evidence = contributor.evidence || [];

  return `
    <tr>
      <td style="padding:8px 28px 18px;background:#ffffff;">
        ${renderSectionTitle("Contributor check", contributor.available ? "Where the movement is coming from." : "How specific this diagnosis can be.")}
        <div style="border:1px solid ${contributor.available ? theme.border : "#e2e8f0"};border-radius:14px;background:${contributor.available ? theme.soft : "#f8fafc"};padding:14px 16px;">
          <div style="font-size:12px;line-height:17px;color:${contributor.available ? theme.dark || theme.primary : "#475569"};font-weight:800;text-transform:uppercase;letter-spacing:.06em;">
            ${escapeHtml(contributor.available ? `Top ${contributor.level || "contributor"}` : "Campaign-level only")}
          </div>
          <div style="font-size:15px;line-height:23px;color:#0f172a;font-weight:800;margin-top:5px;">
            ${escapeHtml(contributor.available ? contributor.name : "Ad-level data was not included")}
          </div>
          <div style="font-size:14px;line-height:22px;color:#475569;margin-top:4px;">
            ${escapeHtml(contributor.available ? contributor.contributionSummary : "Narrative can only diagnose campaign-level movement.")}
          </div>
          ${contributor.recommendedAction ? `<div style="font-size:14px;line-height:22px;color:#0f172a;margin-top:10px;"><b>Recommended action:</b> ${escapeHtml(contributor.recommendedAction)}</div>` : ""}
          ${evidence.length ? `
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:9px;">
              ${evidence.slice(0, 3).map((item) => `
                <tr>
                  <td width="18" style="font-size:16px;line-height:23px;color:${theme.primary};vertical-align:top;">&bull;</td>
                  <td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:2px;">${escapeHtml(item)}</td>
                </tr>
              `).join("")}
            </table>
          ` : ""}
        </div>
      </td>
    </tr>`;
}

function renderAdFocus(theme, userInsight) {
  const ad = userInsight.adToFixFirst;
  const protect = userInsight.adToProtect;

  if (!ad && !protect) return "";

  return `
    <tr>
      <td style="padding:16px 28px 4px;background:#ffffff;">
        ${ad ? renderAdCard(theme, "Ad to fix first", ad, true) : ""}
        ${protect ? renderAdCard(THEME_BY_URGENCY.opportunity, "Ad to protect", protect, false) : ""}
      </td>
    </tr>`;
}

function renderAdsToWatch(userInsight) {
  const ads = (userInsight.adsToWatch || []).filter(Boolean).slice(0, 3);
  if (!ads.length) return "";

  return `
    <tr>
      <td style="padding:0 28px 12px;background:#ffffff;">
        ${renderSectionTitle("Ads to watch", "Secondary ads worth monitoring.")}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:14px;background:#ffffff;overflow:hidden;">
          ${ads.map((ad, index) => `
            <tr>
              <td style="padding:13px 15px;${index ? "border-top:1px solid #e2e8f0;" : ""}">
                <div style="font-size:14px;line-height:20px;color:#0f172a;font-weight:800;">${escapeHtml(ad.adName || "Unknown ad")}</div>
                <div style="font-size:12px;line-height:18px;color:#64748b;margin-top:2px;">
                  ${ad.adsetName ? `Ad set: <b>${escapeHtml(ad.adsetName)}</b>` : ""}
                  ${ad.campaignName ? `${ad.adsetName ? " | " : ""}Campaign: <b>${escapeHtml(ad.campaignName)}</b>` : ""}
                </div>
                <div style="font-size:13px;line-height:20px;color:#475569;margin-top:5px;">${escapeHtml(firstUsefulReason(ad))}</div>
              </td>
            </tr>
          `).join("")}
        </table>
      </td>
    </tr>`;
}

function renderAdCard(theme, title, ad, urgent) {
  const reasons = ad.reasons || [];

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:14px;border:1px solid ${theme.border};border-radius:14px;background:${theme.background};overflow:hidden;">
      <tr>
        <td width="6" style="background:${theme.primary};font-size:1px;line-height:1px;">&nbsp;</td>
        <td style="padding:16px 18px;">
          <div style="font-size:12px;line-height:17px;color:${theme.dark || theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(title)}</div>
          <div style="font-size:20px;line-height:27px;color:#0f172a;font-weight:800;margin-top:6px;">${escapeHtml(ad.adName || "Unknown ad")}</div>
          <div style="font-size:13px;line-height:20px;color:#475569;margin-top:4px;">
            ${ad.adsetName ? `Ad set: <b>${escapeHtml(ad.adsetName)}</b>` : ""}
            ${ad.campaignName ? `${ad.adsetName ? " | " : ""}Campaign: <b>${escapeHtml(ad.campaignName)}</b>` : ""}
          </div>
          ${reasons.length ? `
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:12px;">
              ${reasons.slice(0, 3).map((reason) => `
                <tr>
                  <td width="18" style="font-size:16px;line-height:23px;color:${theme.primary};vertical-align:top;">&bull;</td>
                  <td style="font-size:14px;line-height:23px;color:#334155;padding-bottom:2px;">${escapeHtml(reason)}</td>
                </tr>
              `).join("")}
            </table>
          ` : ""}
          <div style="font-size:15px;line-height:23px;color:#0f172a;font-weight:${urgent ? "800" : "700"};margin-top:12px;">${escapeHtml(ad.action || "")}</div>
        </td>
      </tr>
    </table>`;
}

function renderNextSteps(theme, userInsight, options = {}) {
  const checklist = userInsight.decisionBrief?.actionChecklist || [];
  const fallbackSteps = userInsight.whatToDoNext || [];
  const maxSteps = options.maxSteps || 4;
  const steps = options.steps || (checklist.length ? checklist : fallbackSteps.slice(1, 4));
  if (!steps.length) return "";
  const title = options.title || "Action checklist";
  const subtitle = options.subtitle || "Follow these in order.";

  return `
    <tr>
      <td style="padding:10px 28px 24px;background:#ffffff;">
        ${renderSectionTitle(title, subtitle)}
        ${steps.slice(0, maxSteps).map((step, index) => `
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:10px;border:1px solid ${index === 0 ? theme.border : "#e2e8f0"};border-radius:14px;background:${index === 0 ? theme.soft : "#ffffff"};">
            <tr>
              <td width="50" style="padding:14px 0 14px 16px;vertical-align:top;">
                <div style="width:30px;height:30px;border-radius:999px;background:${index === 0 ? theme.primary : "#e2e8f0"};color:${index === 0 ? "#ffffff" : "#334155"};text-align:center;font-size:14px;line-height:30px;font-weight:800;">${index + 1}</div>
              </td>
              <td style="padding:14px 16px 14px 6px;font-size:15px;line-height:23px;color:#0f172a;font-weight:${index === 0 ? "800" : "500"};">${escapeHtml(step)}</td>
            </tr>
          </table>
        `).join("")}
      </td>
    </tr>`;
}

function renderFixDataChecklist(theme, userInsight) {
  const defaultSteps = [
    "Verify the scheduled Meta delivery window and report date range.",
    "Confirm Meta returned spend, impressions, and clicks for the expected period.",
    "Check campaign status, spend limits, permissions, and account connection.",
    "Rerun the report after data is corrected.",
  ];

  return renderNextSteps(theme, userInsight, {
    title: "Fix-data checklist",
    subtitle: "Complete these before using the metrics for optimization.",
    steps: defaultSteps,
    maxSteps: 4,
  });
}

function renderMetricSnapshot(narrative, options = {}) {
  const userInsight = narrative?.userInsight || {};
  const metrics = buildMetricSnapshotItems(narrative, userInsight).slice(0, 6);

  if (!metrics.length) return "";
  const title = options.title || "Numbers at a glance";
  const subtitle = options.subtitle || "Current value and change versus the previous completed period.";

  return `
    <tr>
      <td style="padding:0 28px 24px;background:#ffffff;">
        ${renderSectionTitle(title, subtitle)}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          ${chunk(metrics, 3).map((row) => `
            <tr>
              ${row.map(([label, value]) => renderMetricCell(label, value, narrative)).join("")}
              ${Array.from({ length: 3 - row.length }).map(() => `<td style="width:33.33%;"></td>`).join("")}
            </tr>
          `).join("")}
        </table>
      </td>
    </tr>`;
}

function buildMetricSnapshotItems(narrative, userInsight) {
  const displayMetrics = narrative?.displayMetrics || {};
  const displayMetricKeys = Object.keys(displayMetrics);

  if (displayMetricKeys.length) {
    const priorityKeys = metricPriorityKeys(narrative, userInsight);
    const picked = new Set();
    const items = [];

    for (const key of priorityKeys) {
      const metric = displayMetrics[key];
      if (!metric || picked.has(key)) continue;
      if (metric.available || key === "cpa" || key === metricKeyFromLabel(userInsight.decisionBrief?.mainMetric?.label)) {
        items.push([metric.label || metricLabelFromKey(key), metric]);
        picked.add(key);
      }
    }

    if (items.length < 6) {
      for (const key of displayMetricKeys) {
        const metric = displayMetrics[key];
        if (!metric || picked.has(key) || !metric.available) continue;
        items.push([metric.label || metricLabelFromKey(key), metric]);
        picked.add(key);
        if (items.length >= 6) break;
      }
    }

    return items;
  }

  const snapshot = narrative?.snapshot || {};
  const priorityLabels = metricPriorityKeys(narrative, userInsight).map(metricLabelFromKey);
  const snapshotItems = [
    ["Spend", snapshot.spend],
    ["CTR", snapshot.ctr],
    ["Clicks", snapshot.clicks],
    ["CPC", snapshot.cpc],
    ["Conversions", snapshot.conversions],
    ["CPA", snapshot.cpa],
    ["ROAS", snapshot.roas],
    ["CPM", snapshot.cpm],
    ["Frequency", snapshot.frequency],
    ["Impressions", snapshot.impressions],
  ].filter(([, value]) => hasSnapshotValue(value));
  const priorityItems = snapshotItems.filter(([label]) => priorityLabels.includes(label));
  const fallbackItems = snapshotItems.filter(([label]) => !priorityLabels.includes(label));

  return [...priorityItems, ...fallbackItems];
}

function renderMetricCell(label, value, narrative = null) {
  const parsed = parseSnapshotValue(value);
  const tone = metricDeltaTone(label, parsed.delta, narrative);

  return `
    <td style="width:33.33%;padding:0 8px 10px 0;vertical-align:top;">
      <div style="border:1px solid ${tone.border};border-radius:12px;padding:12px;background:${tone.background};">
        <div style="font-size:11px;line-height:15px;color:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">${escapeHtml(label)}</div>
        <div style="font-size:17px;line-height:23px;color:#0f172a;font-weight:700;margin-top:4px;">${escapeHtml(parsed.current)}</div>
        ${parsed.delta ? `<div style="display:inline-block;margin-top:7px;border-radius:999px;background:${tone.pill};color:${tone.text};padding:5px 8px;font-size:12px;line-height:14px;font-weight:800;">${escapeHtml(parsed.delta)}</div>` : ""}
        ${parsed.reason ? `<div style="font-size:11px;line-height:16px;color:#64748b;margin-top:6px;">${escapeHtml(parsed.reason)}</div>` : ""}
      </div>
    </td>`;
}

function renderImpactAndConfidence(theme, financialImpact, severity, userInsight) {
  const impactText = formatImpactLabel(financialImpact);
  const decision = userInsight.decisionBrief || {};
  const trust = userInsight.trust || {};
  const trustGate = userInsight.trustGate || {};
  const reliabilityText = trust.score
    ? `${capitalize(trust.level || "unknown")} ${trust.score}/100`
    : capitalize(trust.level || "unknown");

  return `
    <tr>
      <td style="padding:24px 28px 0;background:#ffffff;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${theme.border};border-radius:14px;background:${theme.background};overflow:hidden;">
          <tr>
            <td width="6" style="background:${theme.primary};font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="padding:18px;vertical-align:top;">
              <div style="font-size:12px;line-height:17px;color:${theme.dark || theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Why it matters</div>
              <div style="font-size:15px;line-height:24px;color:#0f172a;margin-top:6px;">${escapeHtml(userInsight.whyItMatters || financialImpact.summary || "")}</div>
              ${trustGate.reasons?.[0] ? `<div style="font-size:14px;line-height:22px;color:#334155;margin-top:10px;"><b>Actionability:</b> ${escapeHtml(trustGate.reasons[0])}</div>` : ""}
              ${trust.summary ? `<div style="font-size:14px;line-height:22px;color:#334155;margin-top:10px;"><b>Reliability:</b> ${escapeHtml(trust.summary)}</div>` : ""}
              ${trust.caveats?.[0] ? `<div style="font-size:13px;line-height:20px;color:#64748b;margin-top:4px;">${escapeHtml(trust.caveats[0])}</div>` : ""}
              ${decision.expectedResult ? `<div style="font-size:14px;line-height:22px;color:#334155;margin-top:10px;"><b>Success:</b> ${escapeHtml(decision.expectedResult)}</div>` : ""}
              ${decision.ifNoImprovement ? `<div style="font-size:14px;line-height:22px;color:#334155;margin-top:4px;"><b>If not:</b> ${escapeHtml(decision.ifNoImprovement)}</div>` : ""}
            </td>
          </tr>
          <tr>
            <td width="6" style="background:${theme.primary};font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="padding:0 18px 18px;">
              <span style="display:inline-block;margin-right:8px;margin-top:8px;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#0f172a;font-weight:800;">Confidence: ${escapeHtml(userInsight.confidence || "Medium")}</span>
              <span style="display:inline-block;margin-right:8px;margin-top:8px;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#0f172a;font-weight:800;">Reliability: ${escapeHtml(reliabilityText)}</span>
              ${trustGate.actionability ? `<span style="display:inline-block;margin-right:8px;margin-top:8px;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#0f172a;font-weight:800;">Actionability: ${escapeHtml(trustGate.actionability)}</span>` : ""}
              <span style="display:inline-block;margin-right:8px;margin-top:8px;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#0f172a;font-weight:800;">Severity: ${escapeHtml(severity.level || "low")}</span>
              <span style="display:inline-block;margin-top:8px;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#0f172a;font-weight:800;">Impact: ${escapeHtml(impactText)}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderWatchNext(theme, userInsight) {
  const watch = userInsight.watchNext || {};
  const metrics = watch.metrics || [];

  return `
    <tr>
      <td style="padding:0 28px 24px;background:#ffffff;">
        ${renderSectionTitle("Watch next", `Timeframe: ${watch.timeframe || "Next 48-72 hours"}`)}
        ${metrics.length ? `<div style="margin-bottom:12px;">${metrics.map((metric) => `<span style="display:inline-block;background:${theme.background};border:1px solid ${theme.border};color:${theme.dark || theme.primary};border-radius:999px;padding:7px 10px;margin:0 6px 6px 0;font-size:13px;line-height:16px;font-weight:700;">${escapeHtml(metric)}</span>`).join("")}</div>` : ""}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td style="padding:12px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;font-size:14px;line-height:22px;color:#064e3b;"><b>Good:</b> ${escapeHtml(watch.goodSign || "")}</td>
          </tr>
          <tr>
            <td style="height:8px;font-size:8px;line-height:8px;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:12px 14px;background:#fff1f2;border:1px solid #fecdd3;border-radius:12px;font-size:14px;line-height:22px;color:#7f1d1d;"><b>Bad:</b> ${escapeHtml(watch.badSign || "")}</td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderDataConfidenceSection(narrative, options = {}) {
  const userInsight = narrative?.userInsight || {};
  const dataQuality = narrative?.dataQuality || {};
  const trust = userInsight.trust || {};
  const trustGate = narrative?.trustGate || userInsight.trustGate || {};
  const baseline = trust.baseline || narrative?.trustLayer?.baseline || {};
  const filteredSignals = trust.filteredSignals || [];
  const warnings = uniqueNonEmpty([
    ...(trust.caveats || []),
    ...(trustGate.caveats || []),
    ...(dataQuality.warnings || []),
  ]).slice(0, 3);
  const diagnosticChecks = (narrative?.diagnosticChecks || []).filter(Boolean).slice(0, 3);
  const title = options.title || "Data confidence";
  const subtitle = options.subtitle || "Reliability notes behind this decision.";
  const reliabilityText = Number.isFinite(Number(trust.score))
    ? `${capitalize(trust.level || "unknown")} ${trust.score}/100`
    : capitalize(trust.level || "unknown");

  return `
    <tr>
      <td style="padding:0 28px 24px;background:#ffffff;">
        ${renderSectionTitle(title, subtitle)}
        <div style="border:1px solid #e2e8f0;border-radius:14px;background:#f8fafc;padding:14px 16px;">
          <div style="font-size:14px;line-height:22px;color:#334155;">
            <b>Data confidence:</b> ${escapeHtml(dataQuality.level || "unknown")}
          </div>
          <div style="font-size:14px;line-height:22px;color:#334155;margin-top:5px;">
            <b>Reliability:</b> ${escapeHtml(reliabilityText || "unknown")}${trust.summary ? ` - ${escapeHtml(trust.summary)}` : ""}
          </div>
          <div style="font-size:14px;line-height:22px;color:#334155;margin-top:5px;">
            <b>Baseline:</b> ${escapeHtml(baseline.summary || "No baseline status was provided.")}
          </div>
          ${warnings.length ? `
            <div style="font-size:14px;line-height:22px;color:#334155;margin-top:5px;">
              <b>Warnings:</b> ${escapeHtml(warnings.join(" "))}
            </div>
          ` : ""}
          ${filteredSignals.length ? `
            <div style="font-size:14px;line-height:22px;color:#334155;margin-top:10px;"><b>Filtered or unreliable metrics:</b></div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:4px;">
              ${filteredSignals.slice(0, 4).map((item) => `
                <tr>
                  <td width="18" style="font-size:16px;line-height:23px;color:#64748b;vertical-align:top;">&bull;</td>
                  <td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:2px;">
                    <b>${escapeHtml(item.metric || "Metric")}:</b> ${escapeHtml(item.reason || "Signal reliability is limited.")}
                  </td>
                </tr>
              `).join("")}
            </table>
          ` : ""}
          ${diagnosticChecks.length ? `
            <div style="font-size:14px;line-height:22px;color:#334155;margin-top:10px;"><b>Diagnostic checks:</b></div>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:4px;">
              ${diagnosticChecks.map((check) => `
                <tr>
                  <td width="18" style="font-size:16px;line-height:23px;color:#64748b;vertical-align:top;">&bull;</td>
                  <td style="font-size:13px;line-height:21px;color:#475569;padding-bottom:2px;">${escapeHtml(check)}</td>
                </tr>
              `).join("")}
            </table>
          ` : ""}
        </div>
      </td>
    </tr>`;
}

function renderDataQualityNote(narrative) {
  const dataQuality = narrative?.dataQuality || {};
  const warnings = dataQuality.warnings || [];
  const level = dataQuality.level || "unknown";

  if (!warnings.length && level === "strong") return "";

  return `
    <tr>
      <td style="padding:0 28px 24px;background:#ffffff;">
        <div style="border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;padding:12px 14px;">
          <div style="font-size:13px;line-height:19px;color:#475569;">
            <b>Data confidence:</b> ${escapeHtml(level)}${warnings[0] ? ` - ${escapeHtml(warnings[0])}` : ""}
          </div>
        </div>
      </td>
    </tr>`;
}

function renderDiagnostics(narrative) {
  const checks = narrative?.diagnosticChecks || [];
  if (!checks.length) return "";

  return `
    <tr>
      <td style="padding:0 28px 26px;background:#ffffff;">
        ${renderSectionTitle("Diagnostic checklist", "Extra checks for deeper review.")}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc;">
          <tr>
            <td style="padding:12px 14px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                ${checks.slice(0, 5).map((check) => `
                  <tr>
                    <td width="18" style="font-size:16px;line-height:23px;color:#6b7280;vertical-align:top;">&bull;</td>
                    <td style="font-size:14px;line-height:23px;color:#4b5563;padding-bottom:3px;">${escapeHtml(check)}</td>
                  </tr>
                `).join("")}
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderFooter(meta) {
  const brandName = meta.brandName || "Narrative";
  return `
    <tr>
      <td style="padding:20px 28px;background:#0f172a;border-top:1px solid #1e293b;">
        <div style="font-size:12px;line-height:18px;color:#cbd5e1;">
          Generated by ${escapeHtml(brandName)}${meta.generatedAt ? ` on ${escapeHtml(meta.generatedAt)}` : ""}. This report is based on Meta Ads data available at send time.
        </div>
      </td>
    </tr>`;
}

function renderSectionTitle(title, subtitle = "") {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:12px;">
      <tr>
        <td style="vertical-align:top;">
          <div style="font-size:18px;line-height:24px;font-weight:800;color:#0f172a;">${escapeHtml(title)}</div>
          ${subtitle ? `<div style="font-size:13px;line-height:19px;color:#64748b;margin-top:2px;">${escapeHtml(subtitle)}</div>` : ""}
        </td>
      </tr>
    </table>`;
}

function buildDataIssueSummaryReason(narrative) {
  const latestAvailable = latestAvailableDeliveryLabel(narrative);

  if (latestAvailable !== "Unknown period") {
    return `The scheduled report window had no usable Meta delivery data, so Narrative used fallback delivery ending ${latestAvailable}.`;
  }

  return "The scheduled report window had no usable Meta delivery data, so this report should not be used for optimization decisions.";
}

function formatSummaryDecisionType(narrative) {
  if (isOpportunityReport(narrative)) return "Scale Signal";
  return formatDecisionType(narrative?.decisionType);
}

function summaryPrimaryAction(narrative) {
  if (isAuctionPressureReport(narrative)) {
    return "Hold budget and compare CPM by placement, audience, and geography before changing creative.";
  }

  return (
    narrative?.userInsight?.decisionBrief?.primaryAction ||
    narrative?.userInsight?.whatToDoNext?.[0] ||
    "Review the report before making changes."
  );
}

function getDoNotTone(narrative) {
  if (isAuctionPressureReport(narrative) || resolveActionability(narrative) === "review_today") {
    return {
      background: "#fff7ed",
      border: "#fed7aa",
      label: "#9a3412",
      text: "#7c2d12",
    };
  }

  if (isOpportunityReport(narrative)) {
    return {
      background: "#f8fafc",
      border: "#d1fae5",
      label: "#065f46",
      text: "#334155",
    };
  }

  if (isDataIssueReport(narrative)) {
    return {
      background: "#f8fafc",
      border: "#cbd5e1",
      label: "#334155",
      text: "#334155",
    };
  }

  return {
    background: "#fff1f2",
    border: "#fecdd3",
    label: "#9f1239",
    text: "#7f1d1d",
  };
}

function formatDataScore(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return "";
  if (numeric >= 95) return "95/100+";
  return `${Math.max(0, Math.round(numeric))}/100`;
}

function buildRelationshipSummary(narrative) {
  const displayMetrics = narrative?.displayMetrics || {};
  const evidence = narrative?.userInsight?.plainEnglishEvidence || [];
  const ctr = displayMetrics.ctr;
  const cpc = displayMetrics.cpc;
  const cpm = displayMetrics.cpm;
  const conversions = displayMetrics.conversions;
  const cpa = displayMetrics.cpa;
  const spend = displayMetrics.spend;

  if (isOpportunityReport(narrative)) {
    const pieces = [
      spend?.delta ? `spend ${movementPhrase("Spend", spend)}` : "",
      conversions?.delta ? `conversions ${movementPhrase("Conversions", conversions)}` : "",
      cpa?.delta ? `CPA ${movementPhrase("CPA", cpa)}` : "",
    ].filter(Boolean);

    if (pieces.length >= 2) {
      return `Scaling held: ${pieces[0]}, while ${pieces.slice(1).join(" and ")}.`;
    }
  }

  if (isAuctionPressureReport(narrative)) {
    if (cpm?.delta && cpc?.delta) {
      const ctrText = ctr?.delta
        ? ` while CTR ${movementPhrase("CTR", ctr)}`
        : "";
      return `Auction costs rose first: CPM ${movementPhrase("CPM", cpm)}, and CPC ${movementPhrase("CPC", cpc)}${ctrText}.`;
    }
  }

  if (narrative?.decisionType?.id === "creative_action") {
    if (ctr?.delta && cpc?.delta) {
      const conversionText = conversions?.delta
        ? `, and conversions ${movementPhrase("Conversions", conversions)}`
        : "";
      return `Engagement weakened first: CTR ${movementPhrase("CTR", ctr)}, CPC ${movementPhrase("CPC", cpc)}${conversionText}.`;
    }
  }

  if (evidence.length) {
    return evidence
      .slice(0, 3)
      .map((item) => `${item.metric} ${item.change}`)
      .join(", ")
      .replace(/, ([^,]*)$/, ", and $1") + ".";
  }

  return narrative?.userInsight?.plainSummary || narrative?.executiveSummary || "The report found a meaningful performance signal.";
}

function movementPhrase(label, metric = {}) {
  const delta = Number(metric.deltaValue ?? String(metric.delta || "").replace(/[%+,]/g, ""));
  const absolute = formatAbsoluteDelta(metric);

  if (!Number.isFinite(delta) || !absolute) return "changed";
  if (Math.abs(delta) < 5) return "stayed mostly stable";

  if (["CPC", "CPM", "Frequency"].includes(label)) {
    return delta > 0 ? `rose ${absolute}` : `improved ${absolute}`;
  }

  if (["CPA"].includes(label)) {
    return delta > 0 ? `rose ${absolute}` : `improved ${absolute}`;
  }

  if (["CTR", "Conversions", "Clicks", "ROAS", "Conversion rate"].includes(label)) {
    return delta > 0 ? `rose ${absolute}` : `dropped ${absolute}`;
  }

  if (label === "Spend") {
    return delta > 0 ? `increased ${absolute}` : `decreased ${absolute}`;
  }

  return delta > 0 ? `increased ${absolute}` : `decreased ${absolute}`;
}

function formatAbsoluteDelta(metric = {}) {
  const value = metric.delta || "";
  const parsed = Number(metric.deltaValue ?? String(value).replace(/[%+,]/g, ""));

  if (!Number.isFinite(parsed)) return "";
  return `${formatCompactNumber(Math.abs(parsed))}%`;
}

function buildSummaryMetricItems(narrative) {
  if (isDataIssueReport(narrative)) return [];

  const userInsight = narrative?.userInsight || {};
  const displayMetrics = narrative?.displayMetrics || {};
  const priorityKeys = isOpportunityReport(narrative)
    ? ["conversions", "cpa", "ctr"]
    : isAuctionPressureReport(narrative)
      ? ["cpm", "cpc", "ctr"]
      : narrative?.decisionType?.id === "creative_action"
        ? ["ctr", "cpc", "conversions"]
        : metricPriorityKeys(narrative, userInsight);
  const fallbackItems = buildMetricSnapshotItems(narrative, userInsight);
  const fallbackByLabel = new Map(fallbackItems.map(([label, value]) => [label, value]));
  const picked = new Set();
  const items = [];

  for (const key of priorityKeys) {
    const metric = displayMetrics[key];
    const label = metric?.label || metricLabelFromKey(key);
    const value = metric || fallbackByLabel.get(label);

    if (!value || picked.has(label)) continue;
    items.push([label, value]);
    picked.add(label);
    if (items.length >= 3) break;
  }

  if (items.length < 3) {
    for (const [label, value] of fallbackItems) {
      if (picked.has(label)) continue;
      items.push([label, value]);
      picked.add(label);
      if (items.length >= 3) break;
    }
  }

  return items.slice(0, 3);
}

function buildSummaryTrustChips(narrative, dataIssue = false) {
  const userInsight = narrative?.userInsight || {};
  const confidence = formatSeverity(
    userInsight.confidence || userInsight.decisionBrief?.confidence || "Medium"
  );
  const impact = formatImpact(narrative?.financialImpact);

  if (dataIssue) {
    return [
      ["Confidence", confidence],
      ["Actionability", formatActionability("fix_data")],
      ["Severity", formatSeverity(resolveSeverity(narrative))],
    ];
  }

  if (isOpportunityReport(narrative)) {
    return [
      ["Confidence", confidence],
      ["Signal strength", formatSignalStrength(resolveSeverity(narrative))],
      ["", impact || "Est. gain: Directional"],
    ];
  }

  const chips = [
    ["Confidence", confidence],
    ["Severity", formatSeverity(resolveSeverity(narrative))],
  ];

  chips.push(impact ? ["", impact] : ["Actionability", formatActionability(resolveActionability(narrative))]);
  return chips.slice(0, 3);
}

function resolveSeverity(narrative) {
  if (isDataIssueReport(narrative)) return "high";
  if (isAuctionPressureReport(narrative)) return "medium";
  return narrative?.severity?.level || "low";
}

function buildContributorPresentation(narrative) {
  const contributor = narrative?.topContributor;
  if (!contributor) return null;

  if (!contributor.available) {
    return {
      title: "Contributor",
      subtitle: "How specific this diagnosis can be.",
      name: "Campaign-level only",
      summary:
        "Ad-level data was not included, so Narrative can only diagnose campaign-level movement.",
      action:
        contributor.recommendedAction ||
        "Break this campaign down by ad before making creative changes.",
      evidence: [],
    };
  }

  if (isOpportunityReport(narrative)) {
    return {
      title: "Winning contributor",
      subtitle: "The strongest positive contributor to protect.",
      name: contributor.name || "Winning segment",
      summary:
        "This contributor drove the strongest positive movement while efficiency improved.",
      action:
        "Keep this winner running and use its hook, audience, or offer angle as the base for 2-3 controlled variations.",
      evidence: positiveContributorEvidence(contributor),
    };
  }

  if (isAuctionPressureReport(narrative)) {
    return {
      title: "Cost-pressure contributor",
      subtitle: "Where the auction pressure appears strongest.",
      name: contributor.name || "Highest cost-pressure segment",
      summary:
        "This segment shows the strongest cost increase. Check audience, placement, geography, and inventory cost before blaming creative.",
      action:
        "Hold scaling here and test lower-cost placements or audiences before increasing budget.",
      evidence: (contributor.evidence || []).filter((item) => !/weakest/i.test(item)),
    };
  }

  if (narrative?.decisionType?.id === "creative_action") {
    return {
      title: "Creative contributor",
      subtitle: "The creative or ad most connected to the signal.",
      name: contributor.name || "Weakest creative",
      summary: contributor.contributionSummary || "This creative contributed most to the decline.",
      action:
        contributor.recommendedAction ||
        "Refresh the hook, visual angle, and primary text before changing budget.",
      evidence: contributor.evidence || [],
    };
  }

  return {
    title: "Contributor",
    subtitle: "Where the movement appears strongest.",
    name: contributor.name || "Top contributor",
    summary: contributor.contributionSummary || "This segment contributed most to the signal.",
    action: contributor.recommendedAction || "Review this contributor first.",
    evidence: contributor.evidence || [],
  };
}

function positiveContributorEvidence(contributor = {}) {
  const deltas = contributor.metrics?.deltas || {};
  const preferred = ["conversions", "cpa", "ctr", "clicks", "cpc"];
  const evidence = preferred
    .map((key) => {
      const label = metricLabelFromKey(key);
      const delta = deltas[key];
      if (!delta) return null;
      return `${label} ${delta}`;
    })
    .filter(Boolean);

  return evidence.length
    ? evidence
    : (contributor.evidence || []).filter((item) => !/weakest|avoid increasing/i.test(item));
}

function formatActionability(value = "") {
  const map = {
    act_today: "Act today",
    review_today: "Review today",
    monitor: "Monitor",
    opportunity: "Opportunity",
    fix_data: "Data needed",
  };
  return map[value] || humanizeValue(value);
}

function formatSeverity(value = "") {
  const map = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    strong: "Strong",
    usable: "Usable",
    limited: "Limited",
    insufficient: "Insufficient",
    unknown: "Unknown",
  };
  return map[String(value).toLowerCase()] || humanizeValue(value);
}

function formatImpact(financialImpact = {}) {
  if (!financialImpact || !financialImpact.type) return "Impact: Unavailable";
  if (financialImpact.type === "unavailable") return "Impact: Unavailable";
  if (financialImpact.shouldDisplayAmount === false) return "Directional impact";

  const amount = financialImpact.displayAmount ||
    (Number(financialImpact.amount) > 0
      ? `${financialImpact.currency || ""} ${formatCompactNumber(Number(financialImpact.amount))}`.trim()
      : "");

  if (!amount) return financialImpact.type === "neutral" ? "Impact: Neutral" : "Impact: Unavailable";
  if (financialImpact.type === "positive") return `Est. gain: ${amount}`;
  if (financialImpact.type === "negative" || financialImpact.type === "loss") {
    return `Est. risk: ${amount}`;
  }
  if (financialImpact.type === "neutral") return "Impact: Neutral";
  return `Est. impact: ${amount}`;
}

function formatDecisionType(decisionType = {}) {
  if (decisionType.label) return decisionType.label;
  return humanizeValue(decisionType.id || "Decision");
}

function formatSignalStrength(value = "") {
  const normalized = String(value || "").toLowerCase();
  const map = {
    critical: "Strong",
    high: "Strong",
    medium: "Moderate",
    low: "Light",
  };
  return map[normalized] || formatSeverity(value || "Medium");
}

function humanizeValue(value = "") {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function metricPriorityKeys(narrative, userInsight) {
  const mainMetricKey = metricKeyFromLabel(userInsight.decisionBrief?.mainMetric?.label);
  const topChangedKey =
    metricKeyFromLabel(userInsight.plainEnglishEvidence?.[0]?.metric) ||
    topChangedDisplayMetricKey(narrative?.displayMetrics || {});
  const watchKeys = (userInsight.watchNext?.metrics || [])
    .map(metricKeyFromLabel)
    .filter(Boolean);

  return uniqueNonEmpty([
    mainMetricKey,
    topChangedKey,
    ...watchKeys,
    "ctr",
    "clicks",
    "cpc",
    "spend",
    "conversions",
    "cpa",
    "roas",
    "cpm",
    "frequency",
  ]);
}

function topChangedDisplayMetricKey(displayMetrics) {
  return Object.entries(displayMetrics)
    .filter(([, metric]) => Number.isFinite(Number(metric?.deltaValue)))
    .sort((a, b) => Math.abs(Number(b[1].deltaValue)) - Math.abs(Number(a[1].deltaValue)))[0]?.[0] || null;
}

function metricKeyFromLabel(label = "") {
  const normalized = String(label || "").trim().toLowerCase();
  const map = {
    spend: "spend",
    impressions: "impressions",
    reach: "reach",
    frequency: "frequency",
    clicks: "clicks",
    ctr: "ctr",
    cpc: "cpc",
    cpm: "cpm",
    conversions: "conversions",
    roas: "roas",
    cpa: "cpa",
    "conversion rate": "conversionRate",
    conversionrate: "conversionRate",
  };

  return map[normalized] || null;
}

function metricLabelFromKey(key = "") {
  const labels = {
    spend: "Spend",
    impressions: "Impressions",
    reach: "Reach",
    frequency: "Frequency",
    clicks: "Clicks",
    ctr: "CTR",
    cpc: "CPC",
    cpm: "CPM",
    conversions: "Conversions",
    roas: "ROAS",
    cpa: "CPA",
    conversionRate: "Conversion rate",
  };

  return labels[key] || capitalize(key);
}

function hasSnapshotValue(value) {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "object") return value.value !== undefined || value.reason;
  return true;
}

function latestAvailableDeliveryLabel(narrative) {
  return formatPeriodLabel(
    narrative?.period?.latestActiveDate ||
      narrative?.period?.current?.end ||
      narrative?.period?.current ||
      narrative?.userInsight?.decisionBrief?.currentDate
  );
}

function formatComparisonWindow(period) {
  if (!period) return "Unknown period";

  const previous = formatPeriodLabel(period.previous);
  const current = formatPeriodLabel(period.current);

  if (previous !== "Unknown period" && current !== "Unknown period") {
    return `${previous} vs ${current}`;
  }

  return current !== "Unknown period" ? current : previous;
}

function uniqueNonEmpty(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const text = typeof item === "string" ? item.trim() : item;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }

  return result;
}

function parseSnapshotValue(value) {
  if (value && typeof value === "object") {
    return {
      current: value.value ?? "N/A",
      delta: value.delta || "",
      deltaNumber: Number(String(value.delta || "").replace(/[%+,]/g, "")) || 0,
      reason: value.reason || "",
    };
  }

  const text = String(value || "");
  const match = text.match(/^(.*)\s+\(([-+]?[\d,.]+%)\)$/);

  if (!match) {
    return {
      current: text,
      delta: "",
      deltaNumber: 0,
      reason: "",
    };
  }

  return {
    current: match[1].trim(),
    delta: match[2],
    deltaNumber: Number(match[2].replace(/[%+,]/g, "")) || 0,
    reason: "",
  };
}

function metricDeltaTone(label, deltaText, narrative = null) {
  const parsed = Number(String(deltaText || "").replace(/[%+,]/g, "")) || 0;
  const lowerIsGood = new Set(["CPC", "CPM", "CPA", "Frequency"]);
  const higherIsGood = new Set(["CTR", "Conversions", "Clicks", "Impressions", "Reach", "ROAS", "Conversion rate"]);
  const magnitude = Math.abs(parsed);
  let direction = "neutral";
  let strength = "neutral";

  if (magnitude >= 5) {
    if (lowerIsGood.has(label)) {
      direction = parsed < 0 ? "good" : "bad";
    } else if (higherIsGood.has(label)) {
      direction = parsed > 0 ? "good" : "bad";
    }

    if (magnitude < 15) strength = "subtle";
    else if (magnitude < 30) strength = "medium";
    else strength = "strong";
  }

  if (label === "Spend") {
    direction = "neutral";
    strength = "neutral";
  }
  const actionability = narrative ? resolveActionability(narrative) : null;

  const tones = {
    subtleGood: {
      background: "#f0fdf4",
      border: "#bbf7d0",
      pill: "#dcfce7",
      text: "#166534",
    },
    mediumGood: {
      background: "#ecfdf5",
      border: "#a7f3d0",
      pill: "#d1fae5",
      text: "#065f46",
    },
    strongGood: {
      background: "#dcfce7",
      border: "#86efac",
      pill: "#bbf7d0",
      text: "#14532d",
    },
    subtleBad: {
      background: "#fff7ed",
      border: "#fed7aa",
      pill: "#ffedd5",
      text: "#9a3412",
    },
    mediumBad: {
      background: "#fff7ed",
      border: "#fdba74",
      pill: "#ffedd5",
      text: "#9a3412",
    },
    strongBad: {
      background: "#ffedd5",
      border: "#fb923c",
      pill: "#fed7aa",
      text: "#9a3412",
    },
    mediumCriticalBad: {
      background: "#fff1f2",
      border: "#fecdd3",
      pill: "#ffe4e6",
      text: "#9f1239",
    },
    strongCriticalBad: {
      background: "#fff1f2",
      border: "#fb7185",
      pill: "#ffe4e6",
      text: "#9f1239",
    },
    neutral: {
      background: "#f8fafc",
      border: "#e2e8f0",
      pill: "#e2e8f0",
      text: "#334155",
    },
  };

  if (direction === "neutral" || strength === "neutral") return tones.neutral;
  if (direction === "bad" && actionability === "act_today") {
    return tones[`${strength}CriticalBad`] || tones.mediumCriticalBad;
  }
  return tones[`${strength}${capitalize(direction)}`] || tones.neutral;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function firstUsefulReason(ad) {
  const reasons = ad?.reasons || [];
  return reasons[0] || ad?.action || "Keep monitoring this ad until the next completed report.";
}

function formatImpactLabel(financialImpact) {
  return formatImpact(financialImpact);
}

function formatCompactNumber(value) {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
}

function subjectActionVerb(decisionBrief = {}) {
  const byDecision = {
    refresh_creative: "Refresh",
    refresh_audience: "Refresh audience for",
    fix_message_fit: "Rewrite",
    hold_scale: "Hold spend on",
    check_post_click: "Check funnel for",
    avoid_expensive_auction: "Hold scaling for",
    stabilize_delivery: "Stabilize",
    cut_low_quality_traffic: "Review traffic from",
    restore_delivery: "Restore delivery for",
    protect_and_scale: "Protect",
    monitor: "Monitor",
  };

  return byDecision[decisionBrief.decision] || "Fix";
}

function capitalize(value) {
  const text = String(value || "");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

function chunk(items, size) {
  const rows = [];
  for (let index = 0; index < items.length; index += size) {
    rows.push(items.slice(index, index + size));
  }
  return rows;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
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

function truncateSubject(subject) {
  const clean = String(subject || "")
    .replace(/\[object Object\]/g, "Unknown period")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length <= 110) return clean;
  return `${clean.slice(0, 107).trim()}...`;
}

export { formatPerformanceEmail, formatPerformanceEmailSubject, renderReportSummaryCard };
