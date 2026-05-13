const THEME_BY_URGENCY = {
  act_today: {
    label: "Action needed today",
    primary: "#e11d48",
    dark: "#881337",
    accent: "#fb7185",
    background: "#fff1f2",
    border: "#fecdd3",
    soft: "#fff7f8",
  },
  review_today: {
    label: "Review today",
    primary: "#ea580c",
    dark: "#9a3412",
    accent: "#fdba74",
    background: "#fff7ed",
    border: "#fed7aa",
    soft: "#fffbf5",
  },
  monitor: {
    label: "Monitor",
    primary: "#2563eb",
    dark: "#1e3a8a",
    accent: "#93c5fd",
    background: "#eff6ff",
    border: "#bfdbfe",
    soft: "#f8fbff",
  },
  opportunity: {
    label: "Opportunity",
    primary: "#059669",
    dark: "#065f46",
    accent: "#6ee7b7",
    background: "#ecfdf5",
    border: "#a7f3d0",
    soft: "#f6fffb",
  },
  fix_data: {
    label: "Data needed",
    primary: "#475569",
    dark: "#0f172a",
    accent: "#cbd5e1",
    background: "#f8fafc",
    border: "#cbd5e1",
    soft: "#ffffff",
  },
};

const DEFAULT_THEME = THEME_BY_URGENCY.monitor;

function formatPerformanceEmail(narrative, meta = {}) {
  const userInsight = narrative?.userInsight || {};
  const theme = THEME_BY_URGENCY[userInsight.urgency] || DEFAULT_THEME;
  const period = narrative?.period || {};
  const campaign = narrative?.campaign || {};
  const snapshot = narrative?.snapshot || {};
  const financialImpact = narrative?.financialImpact || {};
  const severity = narrative?.severity || {};
  const decisionBrief = userInsight.decisionBrief || {};
  const preheader =
    decisionBrief.primaryAction ||
    userInsight.headline ||
    narrative?.executiveSummary ||
    "Meta Ads performance report";
  const includeMetricSnapshot = meta.includeMetricSnapshot !== false;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(meta.subject || "Meta Ads Performance Report")}</title>
  </head>
  <body style="margin:0;padding:0;background:#e5e7eb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(preheader)}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#e5e7eb;margin:0;padding:28px 0;">
      <tr>
        <td align="center" style="padding:0 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #d1d5db;box-shadow:0 16px 38px rgba(15,23,42,.13);">
            ${renderHeader(theme, meta, campaign, period)}
            ${renderInsightHero(theme, userInsight, narrative)}
            ${renderImpactAndConfidence(theme, financialImpact, severity, userInsight)}
            ${renderPlainEvidence(userInsight)}
            ${includeMetricSnapshot ? renderMetricSnapshot(snapshot, userInsight) : ""}
            ${renderAdFocus(theme, userInsight)}
            ${renderAdsToWatch(userInsight)}
            ${renderNextSteps(theme, userInsight)}
            ${renderWatchNext(theme, userInsight)}
            ${renderDataQualityNote(narrative)}
            ${meta.includeDiagnostics ? renderDiagnostics(narrative) : ""}
            ${renderFooter(meta)}
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function formatPerformanceEmailSubject(narrative, meta = {}) {
  const userInsight = narrative?.userInsight || {};
  const campaignName =
    narrative?.campaign?.name || meta.campaignName || "Meta Ads";
  const urgency = userInsight.urgency || "monitor";
  const focusAd = userInsight.adToFixFirst?.adName;
  const decisionLabel = userInsight.decisionBrief?.label;
  const headline = focusAd
    ? `${decisionLabel || "Fix"}: ${focusAd}`
    : decisionLabel || userInsight.headline || narrative?.keyDelta || "Performance update";
  const periodDate = narrative?.period?.current;
  const dateSuffix = periodDate ? ` - ${periodDate}` : "";

  const prefixByUrgency = {
    act_today: "Action needed",
    review_today: "Review today",
    monitor: "Performance update",
    opportunity: "Opportunity spotted",
    fix_data: "Data needed",
  };

  const prefix = prefixByUrgency[urgency] || "Performance update";

  if (focusAd) {
    return truncateSubject(`${prefix}: ${subjectActionVerb(userInsight.decisionBrief)} ${focusAd} in ${campaignName}${dateSuffix}`);
  }

  return truncateSubject(`${prefix}: ${campaignName} - ${headline}${dateSuffix}`);
}

function renderHeader(theme, meta, campaign, period) {
  const title = meta.title || "Meta Ads Performance Report";
  const campaignName = campaign.name || meta.campaignName || "Account report";
  const dateText = period.current && period.previous
    ? `${period.previous} vs ${period.current}`
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

function renderInsightHero(theme, userInsight, narrative) {
  const decision = userInsight.decisionBrief || {};
  const diagnosis = userInsight.simpleDiagnosis || {};
  const firstAction = decision.primaryAction || userInsight.whatToDoNext?.[0];
  const doNotDo = decision.doNotDo;

  return `
    <tr>
      <td style="padding:26px 28px 24px;background:${theme.background};border-bottom:1px solid ${theme.border};">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          <tr>
            <td width="8" style="background:${theme.primary};border-radius:999px;font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="padding-left:16px;">
              <div style="font-size:12px;line-height:17px;color:${theme.dark || theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(decision.timeframe || "Next step")}</div>
              <div style="font-size:28px;line-height:34px;font-weight:800;color:#0f172a;margin:5px 0 9px;">${escapeHtml(decision.label || userInsight.headline || "Performance insight is ready.")}</div>
              <div style="font-size:15px;line-height:24px;color:#334155;">${escapeHtml(diagnosis.inPlainEnglish || userInsight.plainSummary || narrative?.executiveSummary || "")}</div>
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
        ${renderWhatHappened(userInsight.whatHappened)}
      </td>
    </tr>`;
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

function renderPlainEvidence(userInsight) {
  const evidence = (userInsight.plainEnglishEvidence || []).filter(Boolean).slice(0, 3);
  if (!evidence.length) return "";

  return `
    <tr>
      <td style="padding:24px 28px 8px;background:#ffffff;">
        ${renderSectionTitle("What changed", "The plain-English signal behind the recommendation.")}
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

function renderNextSteps(theme, userInsight) {
  const checklist = userInsight.decisionBrief?.actionChecklist || [];
  const fallbackSteps = userInsight.whatToDoNext || [];
  const steps = checklist.length ? checklist : fallbackSteps.slice(1, 4);
  if (!steps.length) return "";

  return `
    <tr>
      <td style="padding:10px 28px 24px;background:#ffffff;">
        ${renderSectionTitle("Action checklist", "Follow these in order.")}
        ${steps.slice(0, 4).map((step, index) => `
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

function renderMetricSnapshot(snapshot, userInsight) {
  const preferred = new Set([
    userInsight.decisionBrief?.mainMetric?.label,
    ...(userInsight.watchNext?.metrics || []),
  ].filter(Boolean));
  const allMetrics = [
    ["Spend", snapshot.spend],
    ["CTR", snapshot.ctr],
    ["CPC", snapshot.cpc],
    ["Conversions", snapshot.conversions],
    ["CPA", snapshot.cpa],
    ["Frequency", snapshot.frequency],
    ["CPM", snapshot.cpm],
    ["Clicks", snapshot.clicks],
    ["Impressions", snapshot.impressions],
  ].filter(([, value]) => value);
  const priorityMetrics = allMetrics.filter(([label]) => preferred.has(label));
  const fallbackMetrics = allMetrics.filter(([label]) => !preferred.has(label));
  const metrics = [...priorityMetrics, ...fallbackMetrics].slice(0, 6);

  if (!metrics.length) return "";

  return `
    <tr>
      <td style="padding:0 28px 24px;background:#ffffff;">
        ${renderSectionTitle("Numbers at a glance", "Current value and change versus the previous completed day.")}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
          ${chunk(metrics, 3).map((row) => `
            <tr>
              ${row.map(([label, value]) => renderMetricCell(label, value)).join("")}
              ${Array.from({ length: 3 - row.length }).map(() => `<td style="width:33.33%;"></td>`).join("")}
            </tr>
          `).join("")}
        </table>
      </td>
    </tr>`;
}

function renderMetricCell(label, value) {
  const parsed = parseSnapshotValue(value);
  const tone = metricDeltaTone(label, parsed.delta);

  return `
    <td style="width:33.33%;padding:0 8px 10px 0;vertical-align:top;">
      <div style="border:1px solid ${tone.border};border-radius:12px;padding:12px;background:${tone.background};">
        <div style="font-size:11px;line-height:15px;color:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">${escapeHtml(label)}</div>
        <div style="font-size:17px;line-height:23px;color:#0f172a;font-weight:800;margin-top:4px;">${escapeHtml(parsed.current)}</div>
        ${parsed.delta ? `<div style="display:inline-block;margin-top:7px;border-radius:999px;background:${tone.pill};color:${tone.text};padding:5px 8px;font-size:12px;line-height:14px;font-weight:800;">${escapeHtml(parsed.delta)}</div>` : ""}
      </div>
    </td>`;
}

function renderImpactAndConfidence(theme, financialImpact, severity, userInsight) {
  const impactText = formatImpactLabel(financialImpact);
  const decision = userInsight.decisionBrief || {};

  return `
    <tr>
      <td style="padding:24px 28px 0;background:#ffffff;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border:1px solid ${theme.border};border-radius:14px;background:${theme.background};overflow:hidden;">
          <tr>
            <td width="6" style="background:${theme.primary};font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="padding:18px;vertical-align:top;">
              <div style="font-size:12px;line-height:17px;color:${theme.dark || theme.primary};font-weight:800;text-transform:uppercase;letter-spacing:.06em;">Why it matters</div>
              <div style="font-size:15px;line-height:24px;color:#0f172a;margin-top:6px;">${escapeHtml(userInsight.whyItMatters || financialImpact.summary || "")}</div>
              ${decision.expectedResult ? `<div style="font-size:14px;line-height:22px;color:#334155;margin-top:10px;"><b>Success:</b> ${escapeHtml(decision.expectedResult)}</div>` : ""}
              ${decision.ifNoImprovement ? `<div style="font-size:14px;line-height:22px;color:#334155;margin-top:4px;"><b>If not:</b> ${escapeHtml(decision.ifNoImprovement)}</div>` : ""}
            </td>
          </tr>
          <tr>
            <td width="6" style="background:${theme.primary};font-size:1px;line-height:1px;">&nbsp;</td>
            <td style="padding:0 18px 18px;">
              <span style="display:inline-block;margin-right:8px;margin-top:8px;background:#ffffff;border:1px solid ${theme.border};border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;color:#0f172a;font-weight:800;">Confidence: ${escapeHtml(userInsight.confidence || "Medium")}</span>
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
  return `
    <tr>
      <td style="padding:20px 28px;background:#0f172a;border-top:1px solid #1e293b;">
        <div style="font-size:12px;line-height:18px;color:#cbd5e1;">
          Generated by PerformX${meta.generatedAt ? ` on ${escapeHtml(meta.generatedAt)}` : ""}. This report is based on Meta Ads data available at send time.
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

function parseSnapshotValue(value) {
  const text = String(value || "");
  const match = text.match(/^(.*)\s+\(([-+]?[\d,.]+%)\)$/);

  if (!match) {
    return {
      current: text,
      delta: "",
      deltaNumber: 0,
    };
  }

  return {
    current: match[1].trim(),
    delta: match[2],
    deltaNumber: Number(match[2].replace(/[%+,]/g, "")) || 0,
  };
}

function metricDeltaTone(label, deltaText) {
  const parsed = Number(String(deltaText || "").replace(/[%+,]/g, "")) || 0;
  const lowerIsGood = new Set(["CPC", "CPM", "CPA", "Frequency"]);
  const higherIsGood = new Set(["CTR", "Conversions", "Clicks", "Impressions", "Reach"]);
  let status = "neutral";

  if (Math.abs(parsed) >= 0.05) {
    if (lowerIsGood.has(label)) {
      status = parsed < 0 ? "good" : "bad";
    } else if (higherIsGood.has(label)) {
      status = parsed > 0 ? "good" : "bad";
    }
  }

  if (label === "Spend") {
    status = "neutral";
  }

  const tones = {
    good: {
      background: "#ecfdf5",
      border: "#a7f3d0",
      pill: "#d1fae5",
      text: "#065f46",
    },
    bad: {
      background: "#fff1f2",
      border: "#fecdd3",
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

  return tones[status];
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
  const type = financialImpact?.type || "unknown";
  const amount = Number(financialImpact?.amount || 0);
  const currency = financialImpact?.currency || "";

  if (amount > 0 && currency) {
    return `${type} ${currency} ${formatCompactNumber(amount)}`;
  }

  if (amount > 0) {
    return `${type} ${formatCompactNumber(amount)}`;
  }

  return type;
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

function truncateSubject(subject) {
  const clean = String(subject || "")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length <= 110) return clean;
  return `${clean.slice(0, 107).trim()}...`;
}

export { formatPerformanceEmail, formatPerformanceEmailSubject };
