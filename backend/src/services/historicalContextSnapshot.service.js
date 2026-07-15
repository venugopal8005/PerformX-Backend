const SNAPSHOT_VERSION = 1;
const SNAPSHOT_SOURCES = new Set(["execution", "backfill_current_reference"]);

const plain = (value) => value?.toObject?.({ depopulate: true }) || value || null;

const nullableName = (value) => {
  const name = String(value || "").trim();
  return name || null;
};

const snapshotSource = (source) =>
  SNAPSHOT_SOURCES.has(source) ? source : "backfill_current_reference";

export const buildReportConfigurationSnapshot = (reportInput) => {
  const report = plain(reportInput);
  if (!report) return null;

  const schedule = plain(report.schedule) || {};
  return {
    type: report.type || null,
    schedule: {
      timezone: schedule.timezone || null,
      time_of_day: schedule.time_of_day || null,
      day_of_week: Number.isInteger(schedule.day_of_week)
        ? schedule.day_of_week
        : null,
      day_of_month: Number.isInteger(schedule.day_of_month)
        ? schedule.day_of_month
        : null,
    },
    client_delivery_mode: report.client_delivery_mode || null,
    generate_client_report:
      typeof report.generate_client_report === "boolean"
        ? report.generate_client_report
        : null,
    generate_internal_report:
      typeof report.generate_internal_report === "boolean"
        ? report.generate_internal_report
        : null,
  };
};

export const buildReportRunContextSnapshot = ({
  agency,
  client,
  report,
  actor,
  capturedAt,
  source = "execution",
}) => {
  const workspaceDocument = plain(agency);
  const clientDocument = plain(client);
  const reportDocument = plain(report);
  const actorDocument = plain(actor);

  return {
    version: SNAPSHOT_VERSION,
    captured_at: new Date(capturedAt),
    source: snapshotSource(source),
    workspace: {
      name: nullableName(workspaceDocument?.name),
    },
    client: {
      name: nullableName(clientDocument?.name),
    },
    report: {
      name: nullableName(reportDocument?.name),
      configuration: buildReportConfigurationSnapshot(reportDocument),
    },
    actor: {
      name: nullableName(actorDocument?.full_name),
    },
  };
};

const snapshotCampaigns = ({ monitoredCampaigns = [], campaignId = null }) => {
  const requestedId = campaignId ? String(campaignId) : null;
  const seen = new Set();
  const campaigns = [];

  for (const item of monitoredCampaigns || []) {
    const campaign = plain(item) || {};
    const id = String(campaign.campaign_id || "").trim();
    if (!id || seen.has(id) || (requestedId && id !== requestedId)) continue;
    seen.add(id);
    campaigns.push({
      campaign_id: id,
      campaign_name: nullableName(campaign.campaign_name),
    });
  }

  if (requestedId && !seen.has(requestedId)) {
    campaigns.push({ campaign_id: requestedId, campaign_name: null });
  }

  return campaigns;
};

export const buildSignalContextSnapshotFromReportRun = ({
  reportRun: reportRunInput,
  campaignId = null,
  capturedAt = null,
}) => {
  const reportRun = plain(reportRunInput);
  if (!reportRun) return null;

  const runContext = plain(reportRun.context_snapshot) || {};
  return {
    version: SNAPSHOT_VERSION,
    captured_at: new Date(
      capturedAt || runContext.captured_at || reportRun.started_at || reportRun.ran_at
    ),
    source: snapshotSource(runContext.source),
    workspace: {
      name: nullableName(plain(runContext.workspace)?.name),
    },
    client: {
      name: nullableName(plain(runContext.client)?.name),
    },
    report: {
      name: nullableName(plain(runContext.report)?.name),
    },
    meta_account: {
      meta_ad_account_id: reportRun.meta_ad_account_id || null,
      external_account_id:
        nullableName(reportRun.meta_account_external_id_snapshot),
      name: nullableName(reportRun.meta_account_name_snapshot),
    },
    campaigns: snapshotCampaigns({
      monitoredCampaigns: reportRun.monitored_campaigns,
      campaignId,
    }),
  };
};

export const buildSignalCurrentReferenceSnapshot = ({
  agency,
  client,
  report,
  campaignId = null,
  campaignName = null,
  capturedAt,
}) => ({
  version: SNAPSHOT_VERSION,
  captured_at: new Date(capturedAt),
  source: "backfill_current_reference",
  workspace: { name: nullableName(plain(agency)?.name) },
  client: { name: nullableName(plain(client)?.name) },
  report: { name: nullableName(plain(report)?.name) },
  meta_account: {
    meta_ad_account_id: null,
    external_account_id: null,
    name: null,
  },
  campaigns: campaignId
    ? [{ campaign_id: String(campaignId), campaign_name: nullableName(campaignName) }]
    : [],
});

export const HISTORICAL_CONTEXT_SNAPSHOT_VERSION = SNAPSHOT_VERSION;
