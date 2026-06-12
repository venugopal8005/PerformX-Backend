const METRICS_TO_COMPARE = [
  "ctr",
  "roas",
  "cpm",
  "spend",
  "frequency",
  "impressions",
  "clicks",
  "reach",
  "conversions",
  "cpc",
  "cpa",
  "conversionRate",
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

export const calculatePercentChange = (currentValue, previousValue) => {
  const current = toNumber(currentValue);
  const previous = toNumber(previousValue);

  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return current > 0 ? 100 : -100;

  return round(((current - previous) / Math.abs(previous)) * 100, 2);
};

export const compareMetrics = (currentMetrics = {}, previousMetrics = {}) => {
  return METRICS_TO_COMPARE.reduce((changes, metric) => {
    changes[`${metric}_change_percent`] = calculatePercentChange(
      currentMetrics[metric],
      previousMetrics[metric]
    );
    changes[metric] = changes[`${metric}_change_percent`];
    return changes;
  }, {});
};

export const compareDailyMetrics = compareMetrics;
export const compareWeeklyMetrics = compareMetrics;
export const compareMonthlyMetrics = compareMetrics;

export { METRICS_TO_COMPARE };
