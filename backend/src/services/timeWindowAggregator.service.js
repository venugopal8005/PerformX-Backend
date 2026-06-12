const DAY_MS = 24 * 60 * 60 * 1000;

const formatDate = (date) => date.toISOString().slice(0, 10);

const addDays = (dateString, days) => {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  return formatDate(new Date(date.getTime() + days * DAY_MS));
};

const todayInTimezone = (timezone = "UTC", now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
};

export const getComparisonWindows = (type = "daily", options = {}) => {
  const timezone = options.timezone || "Asia/Kolkata";
  const today = todayInTimezone(timezone, options.now);
  const anchorDate = options.anchorDate || addDays(today, -1);
  const normalizedType = String(type || "daily").toLowerCase();

  if (normalizedType === "weekly") {
    return {
      type: "weekly",
      timezone,
      current: {
        start: addDays(anchorDate, -6),
        end: anchorDate,
      },
      previous: {
        start: addDays(anchorDate, -13),
        end: addDays(anchorDate, -7),
      },
    };
  }

  if (normalizedType === "monthly") {
    return {
      type: "monthly",
      timezone,
      current: {
        start: addDays(anchorDate, -29),
        end: anchorDate,
      },
      previous: {
        start: addDays(anchorDate, -59),
        end: addDays(anchorDate, -30),
      },
    };
  }

  return {
    type: "daily",
    timezone,
    current: {
      start: anchorDate,
      end: anchorDate,
    },
    previous: {
      start: addDays(anchorDate, -1),
      end: addDays(anchorDate, -1),
    },
  };
};
