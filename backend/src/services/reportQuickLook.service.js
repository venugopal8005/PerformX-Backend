import { aggregateMetaMetrics, fetchMetaInsights } from "./metaInsights.service.js";
import { resolveMetaContextForAccount } from "./metaContext.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = Number(process.env.META_QUICK_LOOK_LOOKBACK_DAYS) || 365;
const LIFETIME_LOOKBACK_DAYS =
  Number(process.env.META_QUICK_LOOK_LIFETIME_DAYS) || 1095;

const RANGE_TYPES = new Set([
  "last_available",
  "last_7_days",
  "last_14_days",
  "last_30_days",
  "this_month",
  "last_month",
  "lifetime",
  "custom",
]);

const PURCHASE_VALUE_ACTION_TYPES = [
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
];

const METRIC_CONFIG = [
  {
    key: "ctr",
    label: "CTR",
    format: "percent",
    positiveWhen: "higher",
    available: (metrics) => numberValue(metrics.impressions) > 0,
    helperText: "No impressions recorded.",
  },
  {
    key: "clicks",
    label: "Clicks",
    format: "number",
    positiveWhen: "higher",
    available: () => true,
  },
  {
    key: "cpc",
    label: "CPC",
    format: "currency",
    positiveWhen: "lower",
    available: (metrics) => numberValue(metrics.clicks) > 0,
    helperText: "No clicks recorded.",
  },
  {
    key: "cpa",
    label: "CPA",
    format: "currency",
    positiveWhen: "lower",
    available: (metrics) => numberValue(metrics.conversions) > 0,
    helperText: "No conversions recorded.",
  },
  {
    key: "conversions",
    label: "Conversions",
    format: "number",
    positiveWhen: "higher",
    available: () => true,
  },
  {
    key: "spend",
    label: "Spend",
    format: "currency",
    positiveWhen: "neutral",
    available: () => true,
  },
  {
    key: "roas",
    label: "ROAS",
    format: "multiple",
    positiveWhen: "higher",
    available: (metrics) =>
      numberValue(metrics.spend) > 0 &&
      (metrics.hasPurchaseValue || numberValue(metrics.purchaseValue) > 0),
    helperText: "Purchase value unavailable.",
  },
];

const numberValue = (value) => {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const nullableNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value, decimals = 2) => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const safeDivide = (numerator, denominator) => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
};

const parseDate = (dateString) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ""))) return null;
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatDate = (date) => date.toISOString().slice(0, 10);

const addDays = (dateString, days) => {
  const date = parseDate(dateString);
  if (!date) return null;
  return formatDate(new Date(date.getTime() + days * DAY_MS));
};

const compareDates = (left, right) => {
  const leftDate = parseDate(left);
  const rightDate = parseDate(right);
  if (!leftDate || !rightDate) return 0;
  return leftDate.getTime() - rightDate.getTime();
};

const daysBetweenInclusive = (startDate, endDate) => {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (!start || !end) return 0;
  return Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
};

const previousSameLengthPeriod = (period) => {
  const days = daysBetweenInclusive(period.start, period.end);
  if (days <= 0) return null;

  return {
    start: addDays(period.start, -days),
    end: addDays(period.start, -1),
  };
};

const monthParts = (dateString) => {
  const date = parseDate(dateString);
  if (!date) return null;

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
  };
};

const monthStart = (dateString) => {
  const parts = monthParts(dateString);
  if (!parts) return null;
  return formatDate(new Date(Date.UTC(parts.year, parts.month, 1)));
};

const shiftMonthStart = (dateString, monthOffset) => {
  const parts = monthParts(dateString);
  if (!parts) return null;
  return formatDate(new Date(Date.UTC(parts.year, parts.month + monthOffset, 1)));
};

const monthEnd = (dateString) => {
  const parts = monthParts(dateString);
  if (!parts) return null;
  return formatDate(new Date(Date.UTC(parts.year, parts.month + 1, 0)));
};

const rowDate = (row = {}) =>
  row.date_start || row.date || row.dateStop || row.date_stop || null;

const rowsBetween = (rows = [], startDate, endDate) =>
  rows.filter((row) => {
    const date = rowDate(row);
    return date && date >= startDate && date <= endDate;
  });

const sumActionValues = (actions = [], actionTypes = []) => {
  if (!Array.isArray(actions)) return 0;

  return actions.reduce((sum, action) => {
    if (!actionTypes.includes(action?.action_type)) return sum;
    return sum + numberValue(action.value);
  }, 0);
};

const extractPurchaseRoas = (row = {}) => {
  if (typeof row.purchase_roas === "number" || typeof row.purchase_roas === "string") {
    return numberValue(row.purchase_roas);
  }

  if (Array.isArray(row.purchase_roas)) {
    const purchaseRoas =
      row.purchase_roas.find((item) =>
        PURCHASE_VALUE_ACTION_TYPES.includes(item?.action_type)
      ) || row.purchase_roas[0];

    return numberValue(purchaseRoas?.value);
  }

  return nullableNumber(row.roas);
};

const extractPurchaseValue = (row = {}) => {
  const directValue = nullableNumber(
    row.purchaseValue ??
      row.purchase_value ??
      row.conversionValue ??
      row.conversion_value ??
      row.website_purchase_roas_value
  );

  if (directValue !== null) return directValue;

  const actionValue = sumActionValues(row.action_values, PURCHASE_VALUE_ACTION_TYPES);
  if (actionValue > 0) return actionValue;

  const roas = extractPurchaseRoas(row);
  const spend = numberValue(row.spend);
  if (roas !== null && roas > 0 && spend > 0) {
    return roas * spend;
  }

  return null;
};

const aggregateQuickLookMetrics = (rows = []) => {
  const baseMetrics = aggregateMetaMetrics(rows);
  let purchaseValue = null;

  rows.forEach((row) => {
    const rowPurchaseValue = extractPurchaseValue(row);
    if (rowPurchaseValue === null) return;
    purchaseValue = (purchaseValue || 0) + rowPurchaseValue;
  });

  const roas =
    purchaseValue !== null && baseMetrics.spend > 0
      ? round(purchaseValue / baseMetrics.spend, 2)
      : baseMetrics.roas;

  return {
    ...baseMetrics,
    purchaseValue: purchaseValue === null ? null : round(purchaseValue, 2),
    hasPurchaseValue: purchaseValue !== null,
    roas,
  };
};

const metricsFromSnapshot = (metrics = {}) => {
  const spend = numberValue(metrics.spend);
  const impressions = numberValue(metrics.impressions);
  const clicks = numberValue(metrics.clicks);
  const conversions = numberValue(metrics.conversions);
  const purchaseValue = nullableNumber(
    metrics.purchaseValue ??
      metrics.purchase_value ??
      metrics.conversionValue ??
      metrics.conversion_value
  );
  const ctr = nullableNumber(metrics.ctr) ?? round(safeDivide(clicks * 100, impressions) || 0, 2);
  const cpc = nullableNumber(metrics.cpc) ?? round(safeDivide(spend, clicks) || 0, 2);
  const cpa =
    nullableNumber(metrics.cpa) ?? round(safeDivide(spend, conversions) || 0, 2);
  const roas =
    purchaseValue !== null && spend > 0
      ? round(purchaseValue / spend, 2)
      : numberValue(metrics.roas);

  return {
    impressions,
    clicks,
    spend,
    reach: numberValue(metrics.reach),
    conversions,
    ctr,
    cpc,
    cpm: numberValue(metrics.cpm),
    frequency: numberValue(metrics.frequency),
    cpa,
    roas,
    conversionRate: numberValue(metrics.conversionRate),
    purchaseValue,
    hasPurchaseValue: purchaseValue !== null || numberValue(metrics.roas) > 0,
  };
};

const hasMetricData = (metrics = {}) =>
  ["spend", "impressions", "clicks", "reach", "conversions"].some(
    (metric) => numberValue(metrics[metric]) > 0
  );

const getActiveDates = (rows = []) => {
  const rowsByDate = new Map();

  rows.forEach((row) => {
    const date = rowDate(row);
    if (!date) return;
    rowsByDate.set(date, [...(rowsByDate.get(date) || []), row]);
  });

  return Array.from(rowsByDate.entries())
    .filter(([, dateRows]) => hasMetricData(aggregateQuickLookMetrics(dateRows)))
    .map(([date]) => date)
    .sort();
};

const formatNumber = (value, maximumFractionDigits = 0) =>
  new Intl.NumberFormat("en-IN", {
    maximumFractionDigits,
  }).format(value);

const formatCurrency = (value, currency) => {
  const maxDecimals = Math.abs(value) > 99 ? 0 : 2;
  return `${currency} ${formatNumber(value, maxDecimals)}`;
};

const formatMetricValue = (value, format, currency) => {
  if (format === "percent") return `${formatNumber(value, 2)}%`;
  if (format === "currency") return formatCurrency(value, currency);
  if (format === "multiple") return `${formatNumber(value, 2)}x`;
  return formatNumber(value, Number.isInteger(value) ? 0 : 2);
};

const percentChange = (currentValue, previousValue) => {
  const current = nullableNumber(currentValue);
  const previous = nullableNumber(previousValue);

  if (current === null || previous === null) return null;
  if (previous === 0 && current === 0) {
    return {
      value: 0,
      displayValue: "0%",
      isNew: false,
    };
  }
  if (previous === 0) {
    return {
      value: null,
      displayValue: "New",
      isNew: true,
    };
  }

  const value = round(((current - previous) / Math.abs(previous)) * 100, 1);

  return {
    value,
    displayValue: `${value > 0 ? "+" : ""}${formatNumber(value, 1)}%`,
    isNew: false,
  };
};

const spendDirection = ({ metrics, previousMetrics, delta }) => {
  if (!delta || delta.value === null || delta.value === 0) return "neutral";

  const spendIncreased = delta.value > 0;
  const conversionsDelta = percentChange(metrics.conversions, previousMetrics.conversions);
  const cpaDelta = percentChange(metrics.cpa, previousMetrics.cpa);
  const roasDelta = percentChange(metrics.roas, previousMetrics.roas);

  if (
    spendIncreased &&
    ((cpaDelta?.value !== null && cpaDelta?.value > 0 && numberValue(metrics.conversions) > 0) ||
      (roasDelta?.value !== null && roasDelta?.value < 0))
  ) {
    return "negative";
  }

  if (
    spendIncreased &&
    conversionsDelta?.value !== null &&
    conversionsDelta.value > 0 &&
    (!cpaDelta || cpaDelta.value === null || cpaDelta.value <= 0)
  ) {
    return "positive";
  }

  return "neutral";
};

const metricDirection = ({ config, metrics, previousMetrics, delta, comparisonAvailable }) => {
  if (!comparisonAvailable || !delta) return "neutral";
  if (config.positiveWhen === "neutral") {
    return config.key === "spend"
      ? spendDirection({ metrics, previousMetrics, delta })
      : "neutral";
  }
  if (delta.displayValue === "New") {
    return config.positiveWhen === "higher" ? "positive" : "neutral";
  }
  if (delta.value === null || delta.value === 0) return "neutral";

  const improved =
    config.positiveWhen === "higher" ? delta.value > 0 : delta.value < 0;
  return improved ? "positive" : "negative";
};

const buildMetricCards = ({
  metrics,
  previousMetrics,
  comparisonAvailable,
  currency,
  noData,
}) =>
  METRIC_CONFIG.reduce((cards, config) => {
    const value = numberValue(metrics[config.key]);
    const previousValue = previousMetrics ? numberValue(previousMetrics[config.key]) : null;
    const available = !noData && config.available(metrics);
    const delta =
      available && comparisonAvailable
        ? percentChange(value, previousValue)
        : null;

    cards[config.key] = {
      label: config.label,
      value: available ? value : null,
      displayValue: available ? formatMetricValue(value, config.format, currency) : "N/A",
      deltaPercent: delta?.value ?? null,
      displayDelta: delta?.displayValue || null,
      available,
      direction: available
        ? metricDirection({
            config,
            metrics,
            previousMetrics: previousMetrics || {},
            delta,
            comparisonAvailable,
          })
        : "neutral",
      helperText: available
        ? null
        : noData
          ? "No performance data available."
          : config.helperText || "Metric unavailable.",
    };

    return cards;
  }, {});

const rangeLabel = (rangeType) =>
  ({
    last_available: "Latest available",
    last_7_days: "Last 7 days",
    last_14_days: "Last 14 days",
    last_30_days: "Last 30 days",
    this_month: "This month",
    last_month: "Last month",
    lifetime: "Lifetime",
    custom: "Custom",
  })[rangeType] || "Latest available";

const isFallbackComparison = (comparison = {}, period = {}) =>
  comparison.mode === "historical_fallback" ||
  period.source === "historical_fallback" ||
  Boolean(comparison.disclaimer);

const currencyForRun = (reportRun = {}) =>
  reportRun.narrative?.currency ||
  reportRun.engine_output?.currency ||
  reportRun.comparison?.currency ||
  "INR";

const buildResponse = ({
  reportRun,
  report,
  rangeType,
  period,
  currentMetrics,
  previousMetrics,
  comparisonAvailable,
  isFallback = false,
  fallbackReason = null,
  warnings = [],
  source = "snapshot",
  noData = false,
}) => {
  const currency = currencyForRun(reportRun);
  const allWarnings = [...warnings];

  if (source === "meta_fetch") {
    allWarnings.push("Quick look was recalculated from Meta insight rows.");
  }
  if (rangeType === "lifetime" && source === "meta_fetch") {
    allWarnings.push(
      `Lifetime uses the latest ${LIFETIME_LOOKBACK_DAYS} days available to Narrative.`
    );
  }

  return {
    reportRunId: reportRun._id,
    clientId: reportRun.client_id || report.client_id,
    range: {
      type: rangeType,
      label: rangeLabel(rangeType),
      startDate: period?.current?.start || null,
      endDate: period?.current?.end || null,
      isFallback,
      fallbackReason,
    },
    comparison: {
      available: Boolean(comparisonAvailable),
      previousStartDate: comparisonAvailable ? period?.previous?.start || null : null,
      previousEndDate: comparisonAvailable ? period?.previous?.end || null : null,
      label: comparisonAvailable ? "Previous comparable period" : null,
    },
    metrics: buildMetricCards({
      metrics: currentMetrics || {},
      previousMetrics: previousMetrics || {},
      comparisonAvailable,
      currency,
      noData,
    }),
    dataQuality: {
      level: noData ? "insufficient" : allWarnings.length ? "usable" : "strong",
      warnings: allWarnings,
    },
  };
};

const buildNoDataResponse = ({ reportRun, report, rangeType, period, warnings = [] }) =>
  buildResponse({
    reportRun,
    report,
    rangeType,
    period,
    currentMetrics: {},
    previousMetrics: {},
    comparisonAvailable: false,
    warnings,
    noData: true,
  });

const buildSnapshotQuickLook = ({ reportRun, report, rangeType }) => {
  if (rangeType !== "last_available") return null;

  const comparison = reportRun.comparison || {};
  const period = comparison.period || reportRun.period || {};
  const currentPeriod = period.current;

  if (!currentPeriod?.start || !currentPeriod?.end) return null;

  const rawRows = Array.isArray(comparison.rawRows) ? comparison.rawRows : [];
  const currentRows = rowsBetween(rawRows, currentPeriod.start, currentPeriod.end);
  const previousRows = period.previous
    ? rowsBetween(rawRows, period.previous.start, period.previous.end)
    : [];
  const currentMetrics = currentRows.length
    ? aggregateQuickLookMetrics(currentRows)
    : metricsFromSnapshot(comparison.currentPeriodMetrics);
  const previousMetrics = previousRows.length
    ? aggregateQuickLookMetrics(previousRows)
    : metricsFromSnapshot(comparison.previousPeriodMetrics);
  const noData = !hasMetricData(currentMetrics);

  if (noData) {
    return buildNoDataResponse({
      reportRun,
      report,
      rangeType,
      period,
      warnings: comparison.disclaimer ? [comparison.disclaimer] : [],
    });
  }

  return buildResponse({
    reportRun,
    report,
    rangeType,
    period,
    currentMetrics,
    previousMetrics,
    comparisonAvailable: Boolean(period.previous && hasMetricData(previousMetrics)),
    isFallback: isFallbackComparison(comparison, period),
    fallbackReason: comparison.disclaimer || null,
    warnings: comparison.disclaimer ? [comparison.disclaimer] : [],
  });
};

const resolveDatePeriod = ({ rangeType, latestActiveDate, earliestActiveDate, query }) => {
  if (rangeType === "last_available") {
    return {
      current: {
        start: latestActiveDate,
        end: latestActiveDate,
      },
      previous: null,
    };
  }

  if (rangeType === "last_7_days" || rangeType === "last_14_days" || rangeType === "last_30_days") {
    const days = Number(rangeType.match(/\d+/)?.[0] || 7);
    const current = {
      start: addDays(latestActiveDate, -(days - 1)),
      end: latestActiveDate,
    };

    return {
      current,
      previous: previousSameLengthPeriod(current),
    };
  }

  if (rangeType === "this_month") {
    const current = {
      start: monthStart(latestActiveDate),
      end: latestActiveDate,
    };
    const previousMonthStart = shiftMonthStart(latestActiveDate, -1);
    const previous = {
      start: previousMonthStart,
      end: addDays(previousMonthStart, daysBetweenInclusive(current.start, current.end) - 1),
    };

    return {
      current,
      previous,
    };
  }

  if (rangeType === "last_month") {
    const currentStart = shiftMonthStart(latestActiveDate, -1);
    const current = {
      start: currentStart,
      end: monthEnd(currentStart),
    };
    const previousStart = shiftMonthStart(latestActiveDate, -2);

    return {
      current,
      previous: {
        start: previousStart,
        end: monthEnd(previousStart),
      },
    };
  }

  if (rangeType === "lifetime") {
    return {
      current: {
        start: earliestActiveDate,
        end: latestActiveDate,
      },
      previous: null,
    };
  }

  const startDate = query.startDate || query.start;
  const endDate = query.endDate || query.end;

  if (!parseDate(startDate) || !parseDate(endDate)) {
    throw new Error("Custom quick look range requires valid startDate and endDate.");
  }

  if (compareDates(startDate, endDate) > 0) {
    throw new Error("Custom quick look startDate must be before endDate.");
  }

  const current = {
    start: startDate,
    end: endDate,
  };

  return {
    current,
    previous: previousSameLengthPeriod(current),
  };
};

const findPreviousActiveDate = (activeDates, currentDate) =>
  [...activeDates].reverse().find((date) => date < currentDate) || null;

const getFetchWindow = (period) => {
  const dates = [
    period.current?.start,
    period.current?.end,
    period.previous?.start,
    period.previous?.end,
  ].filter(Boolean);

  return {
    start: dates.sort()[0],
    end: dates.sort().at(-1),
  };
};

const fetchRows = async ({ accessToken, externalAdAccountId, report, dateRange }) => {
  const insights = await fetchMetaInsights({
    accessToken,
    adAccountId: externalAdAccountId,
    dateRange,
    campaigns: report.monitored_campaigns,
    level: "campaign",
  });

  return insights.rows;
};

const buildMetaQuickLook = async ({ reportRun, report, rangeType, query }) => {
  const metaAdAccountId = reportRun.meta_ad_account_id || report.meta_ad_account_id;
  const context = await resolveMetaContextForAccount({
    agencyId: report.agency_id,
    metaAdAccountId,
  });
  const { accessToken, externalAdAccountId } = context;

  const today = formatDate(new Date());
  const lookbackEnd = addDays(today, -1);
  const lookbackDays = rangeType === "lifetime" ? LIFETIME_LOOKBACK_DAYS : DEFAULT_LOOKBACK_DAYS;
  const lookbackStart = addDays(lookbackEnd, -(lookbackDays - 1));
  const lookbackRows = await fetchRows({
    accessToken,
    externalAdAccountId,
    report,
    dateRange: {
      start: lookbackStart,
      end: lookbackEnd,
    },
  });
  const activeDates = getActiveDates(lookbackRows);
  const latestActiveDate = activeDates.at(-1);
  const earliestActiveDate = activeDates[0];

  if (!latestActiveDate || !earliestActiveDate) {
    return buildNoDataResponse({
      reportRun,
      report,
      rangeType,
      period: {
        current: {
          start: lookbackStart,
          end: lookbackEnd,
        },
      },
    });
  }

  const period = resolveDatePeriod({
    rangeType,
    latestActiveDate,
    earliestActiveDate,
    query,
  });

  if (rangeType === "last_available") {
    const previousActiveDate = findPreviousActiveDate(activeDates, latestActiveDate);
    period.previous = previousActiveDate
      ? {
          start: previousActiveDate,
          end: previousActiveDate,
        }
      : null;
  }

  const fetchWindow = getFetchWindow(period);
  const needsExplicitFetch =
    compareDates(fetchWindow.start, lookbackStart) < 0 ||
    compareDates(fetchWindow.end, lookbackEnd) > 0;
  const sourceRows = needsExplicitFetch
    ? await fetchRows({
        accessToken,
        externalAdAccountId,
        report,
        dateRange: fetchWindow,
      })
    : lookbackRows;
  const currentRows = rowsBetween(sourceRows, period.current.start, period.current.end);
  const previousRows = period.previous
    ? rowsBetween(sourceRows, period.previous.start, period.previous.end)
    : [];
  const currentMetrics = aggregateQuickLookMetrics(currentRows);
  const previousMetrics = aggregateQuickLookMetrics(previousRows);
  const noData = !hasMetricData(currentMetrics);

  if (noData) {
    return buildNoDataResponse({
      reportRun,
      report,
      rangeType,
      period,
    });
  }

  return buildResponse({
    reportRun,
    report,
    rangeType,
    period,
    currentMetrics,
    previousMetrics,
    comparisonAvailable: Boolean(period.previous && hasMetricData(previousMetrics)),
    source: "meta_fetch",
  });
};

export const buildReportRunQuickLook = async ({ reportRun, report, query = {} }) => {
  const requestedRange = query.range || query.quickRange || "last_available";
  const rangeType = RANGE_TYPES.has(requestedRange) ? requestedRange : "last_available";
  const snapshotQuickLook = buildSnapshotQuickLook({ reportRun, report, rangeType });

  if (snapshotQuickLook) return snapshotQuickLook;

  return buildMetaQuickLook({
    reportRun,
    report,
    rangeType,
    query,
  });
};
