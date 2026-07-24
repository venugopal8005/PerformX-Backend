const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

const META_INSIGHT_FIELDS = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "spend",
  "reach",
  "frequency",
  "cpm",
  "actions",
  "action_values",
  "purchase_roas",
  "cost_per_action_type",
  "action_attribution_windows",
].join(",");

const PURCHASE_ACTION_TYPES = [
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
];
const CONVERSION_ACTION_TYPES = [
  "purchase",
  "lead",
  "complete_registration",
  "submit_application",
  "schedule_total",
  "onsite_conversion.messaging_conversation_started_7d",
  "offsite_conversion.fb_pixel_purchase",
];

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const round = (value, decimals = 2) => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const safeDivide = (numerator, denominator) => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }

  return numerator / denominator;
};

const formatAdAccountId = (adAccountId) => {
  const value = String(adAccountId || "").trim();
  return value.startsWith("act_") ? value : `act_${value}`;
};

const normalizeAttributionWindows = (value) => {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((item) => String(item || "").trim().toLowerCase());
  if (normalized.some((item) => !item)) return null;
  return [...new Set(normalized)].sort();
};

const attributionContextFromRows = (rows, requestedWindows) => {
  const requested = normalizeAttributionWindows(requestedWindows);
  if (requested?.length) {
    return { windows: requested, source: "request", comparable: true };
  }
  const observed = rows.map((row) =>
    normalizeAttributionWindows(row?.action_attribution_windows ?? row?.attribution_windows)
  );
  const supplied = observed.filter((item) => item?.length);
  if (!supplied.length) return { windows: [], source: "unavailable", comparable: false };
  const signatures = new Set(supplied.map((item) => JSON.stringify(item)));
  const complete = supplied.length === rows.length;
  if (!complete || signatures.size !== 1) {
    return { windows: [], source: "response_rows", comparable: false };
  }
  return { windows: supplied[0], source: "response_rows", comparable: true };
};

const sumActionValues = (actions = [], actionTypes = []) => {
  if (!Array.isArray(actions)) return 0;

  return actions.reduce((sum, action) => {
    if (!actionTypes.includes(action?.action_type)) return sum;
    return sum + toNumber(action.value);
  }, 0);
};

const extractPurchaseRoas = (row = {}) => {
  if (typeof row.purchase_roas === "number" || typeof row.purchase_roas === "string") {
    return toNumber(row.purchase_roas);
  }

  if (Array.isArray(row.purchase_roas)) {
    const purchaseRoas =
      row.purchase_roas.find((item) =>
        ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"].includes(
          item?.action_type
        )
      ) || row.purchase_roas[0];

    return toNumber(purchaseRoas?.value);
  }

  return toNumber(row.roas);
};

export const normalizeMetaInsightRow = (row = {}) => {
  const spend = toNumber(row.spend);
  const impressions = toNumber(row.impressions);
  const clicks = toNumber(row.clicks);
  const reach = toNumber(row.reach);
  const conversions = sumActionValues(row.actions, CONVERSION_ACTION_TYPES);
  const ctr = toNumber(row.ctr) || safeDivide(clicks * 100, impressions);
  const cpc = toNumber(row.cpc) || safeDivide(spend, clicks);
  const cpm = toNumber(row.cpm) || safeDivide(spend * 1000, impressions);
  const frequency =
    toNumber(row.frequency) || safeDivide(impressions, reach) || toNumber(row.freq);
  const roas = extractPurchaseRoas(row);
  const cpa = safeDivide(spend, conversions);

  return {
    campaign_id: row.campaign_id || null,
    campaign_name: row.campaign_name || null,
    adset_id: row.adset_id || null,
    adset_name: row.adset_name || null,
    ad_id: row.ad_id || null,
    ad_name: row.ad_name || null,
    impressions: round(impressions, 0),
    clicks: round(clicks, 0),
    ctr: round(ctr, 2),
    spend: round(spend, 2),
    cpc: round(cpc, 2),
    cpm: round(cpm, 2),
    frequency: round(frequency, 2),
    reach: round(reach, 0),
    conversions: round(conversions, 2),
    roas: round(roas, 2),
    cpa: round(cpa, 2),
    conversionRate: round(safeDivide(conversions * 100, clicks), 2),
    action_attribution_windows: normalizeAttributionWindows(
      row.action_attribution_windows ?? row.attribution_windows
    ),
  };
};

export const aggregateMetaMetrics = (rows = []) => {
  const totals = rows.reduce(
    (acc, rawRow) => {
      acc.impressions += toNumber(rawRow?.impressions);
      acc.clicks += toNumber(rawRow?.clicks);
      acc.spend += toNumber(rawRow?.spend);
      acc.reach += toNumber(rawRow?.reach);
      acc.conversions += sumActionValues(
        rawRow?.actions,
        CONVERSION_ACTION_TYPES
      );
      acc.conversionValue += sumActionValues(
        rawRow?.action_values,
        PURCHASE_ACTION_TYPES
      );
      return acc;
    },
    {
      impressions: 0,
      clicks: 0,
      spend: 0,
      reach: 0,
      conversions: 0,
      conversionValue: 0,
    }
  );

  return {
    impressions: round(totals.impressions, 0),
    clicks: round(totals.clicks, 0),
    spend: round(totals.spend, 2),
    reach: round(totals.reach, 0),
    conversions: round(totals.conversions, 2),
    ctr: round(safeDivide(totals.clicks * 100, totals.impressions), 2),
    cpc: round(safeDivide(totals.spend, totals.clicks), 2),
    cpm: round(safeDivide(totals.spend * 1000, totals.impressions), 2),
    frequency: round(safeDivide(totals.impressions, totals.reach), 2),
    roas: round(safeDivide(totals.conversionValue, totals.spend), 2),
    cpa: round(safeDivide(totals.spend, totals.conversions), 2),
    conversionRate: round(safeDivide(totals.conversions * 100, totals.clicks), 2),
  };
};

export const fetchMetaInsights = async ({
  accessToken,
  adAccountId,
  dateRange,
  campaigns = [],
  level = "ad",
  actionAttributionWindows = null,
}) => {
  if (!accessToken) throw new Error("Meta access token is required");
  if (!adAccountId) throw new Error("Meta ad account id is required");
  if (!dateRange?.start || !dateRange?.end) {
    throw new Error("Meta insight date range is required");
  }

  const params = new URLSearchParams({
    fields: META_INSIGHT_FIELDS,
    level,
    time_increment: "1",
    access_token: accessToken,
    time_range: JSON.stringify({
      since: dateRange.start,
      until: dateRange.end,
    }),
  });
  const requestedAttributionWindows = normalizeAttributionWindows(actionAttributionWindows);
  if (requestedAttributionWindows?.length) {
    params.set("action_attribution_windows", JSON.stringify(requestedAttributionWindows));
  }
  const campaignIds = campaigns
    .map((campaign) => campaign.campaign_id || campaign.campaignId)
    .filter(Boolean);

  if (campaignIds.length) {
    params.set(
      "filtering",
      JSON.stringify([
        {
          field: "campaign.id",
          operator: "IN",
          value: campaignIds,
        },
      ])
    );
  }

  let nextUrl = `https://graph.facebook.com/${META_GRAPH_VERSION}/${formatAdAccountId(
    adAccountId
  )}/insights?${params.toString()}`;
  const rows = [];
  let paging = null;

  while (nextUrl) {
    const response = await fetch(nextUrl);
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error?.message || "Failed to fetch Meta insights");
    }

    rows.push(...(data.data || []));
    paging = data.paging || null;
    nextUrl = data.paging?.next || null;
  }

  return {
    rows,
    metrics: aggregateMetaMetrics(rows),
    paging,
    attributionContext: attributionContextFromRows(rows, requestedAttributionWindows),
  };
};

export { META_INSIGHT_FIELDS, attributionContextFromRows, formatAdAccountId };
