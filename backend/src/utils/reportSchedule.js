const VALID_FREQUENCIES = ["daily", "weekly", "monthly"];
const DEFAULT_TIMEZONE = "Asia/Kolkata";

const DAY_NAME_TO_INDEX = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function normalizeReportSchedule(input = {}) {
  const scheduleInput = input.schedule || {};
  const frequency = normalizeFrequency(input.type || input.frequency);
  const timeOfDay = normalizeTimeOfDay(
    firstDefined(
      scheduleInput.time_of_day,
      scheduleInput.timeOfDay,
      scheduleInput.time,
      input.time_of_day,
      input.timeOfDay,
      input.time
    )
  );
  const timezone = normalizeTimezone(
    firstDefined(scheduleInput.timezone, scheduleInput.timeZone, input.timezone, input.timeZone) ||
      DEFAULT_TIMEZONE
  );
  const schedule = {
    time_of_day: timeOfDay,
    day_of_week: null,
    day_of_month: null,
    timezone,
  };

  if (frequency === "weekly") {
    schedule.day_of_week = normalizeDayOfWeek(
      firstDefined(
        scheduleInput.day_of_week,
        scheduleInput.dayOfWeek,
        scheduleInput.weekday,
        input.day_of_week,
        input.dayOfWeek,
        input.weekday
      )
    );
  }

  if (frequency === "monthly") {
    schedule.day_of_month = normalizeDayOfMonth(
      firstDefined(
        scheduleInput.day_of_month,
        scheduleInput.dayOfMonth,
        scheduleInput.date_of_month,
        scheduleInput.dateOfMonth,
        scheduleInput.monthDay,
        input.day_of_month,
        input.dayOfMonth,
        input.date_of_month,
        input.dateOfMonth,
        input.monthDay
      )
    );
  }

  return { frequency, type: frequency, schedule };
}

function getNextRunAt(report, fromDate = new Date()) {
  const frequency = normalizeFrequency(report?.type || report?.frequency);
  const schedule = report?.schedule || {};
  const timeOfDay = normalizeTimeOfDay(schedule.time_of_day);
  const timezone = schedule.timezone || DEFAULT_TIMEZONE;
  const nowParts = getLocalParts(fromDate, timezone);
  const [hour, minute] = timeOfDay.split(":").map(Number);
  let candidateParts;

  if (frequency === "daily") {
    candidateParts = {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour,
      minute,
    };

    if (zonedTimeToUtc(candidateParts, timezone) <= fromDate) {
      candidateParts = { ...addLocalDays(nowParts, 1), hour, minute };
    }

    return zonedTimeToUtc(candidateParts, timezone);
  }

  if (frequency === "weekly") {
    const targetDay = normalizeDayOfWeek(schedule.day_of_week);
    const currentDay = dayOfWeek(nowParts);
    let daysToAdd = (targetDay - currentDay + 7) % 7;
    candidateParts = { ...addLocalDays(nowParts, daysToAdd), hour, minute };

    if (zonedTimeToUtc(candidateParts, timezone) <= fromDate) {
      daysToAdd += 7;
      candidateParts = { ...addLocalDays(nowParts, daysToAdd), hour, minute };
    }

    return zonedTimeToUtc(candidateParts, timezone);
  }

  const targetDate = normalizeDayOfMonth(schedule.day_of_month);
  candidateParts = monthlyCandidate(nowParts.year, nowParts.month, targetDate, hour, minute);

  if (zonedTimeToUtc(candidateParts, timezone) <= fromDate) {
    const nextMonth = addLocalMonths(nowParts.year, nowParts.month, 1);
    candidateParts = monthlyCandidate(nextMonth.year, nextMonth.month, targetDate, hour, minute);
  }

  return zonedTimeToUtc(candidateParts, timezone);
}

function normalizeFrequency(value) {
  const frequency = String(value || "").trim().toLowerCase();

  if (!VALID_FREQUENCIES.includes(frequency)) {
    throw new Error("frequency must be daily, weekly, or monthly");
  }

  return frequency;
}

function normalizeTimeOfDay(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):([0-5]\d)$/);

  if (!match) {
    throw new Error("schedule time must be in HH:mm format");
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour < 0 || hour > 23) {
    throw new Error("schedule hour must be between 00 and 23");
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDayOfWeek(value) {
  if (typeof value === "string" && DAY_NAME_TO_INDEX[value.trim().toLowerCase()] !== undefined) {
    return DAY_NAME_TO_INDEX[value.trim().toLowerCase()];
  }

  const day = Number(value);

  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new Error("weekly schedule requires day_of_week from 0-6 or a day name");
  }

  return day;
}

function normalizeDayOfMonth(value) {
  const day = Number(value);

  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error("monthly schedule requires day_of_month from 1-31");
  }

  return day;
}

function normalizeTimezone(value) {
  const timezone = String(value || DEFAULT_TIMEZONE).trim();

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("schedule timezone is invalid");
  }

  return timezone;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function getLocalParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour === "24" ? "00" : values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function zonedTimeToUtc(parts, timeZone) {
  const targetUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let utc = targetUtc;

  for (let index = 0; index < 3; index += 1) {
    const localParts = getLocalParts(new Date(utc), timeZone);
    const localAsUtc = Date.UTC(
      localParts.year,
      localParts.month - 1,
      localParts.day,
      localParts.hour,
      localParts.minute,
      localParts.second || 0,
      0
    );
    utc -= localAsUtc - targetUtc;
  }

  return new Date(utc);
}

function addLocalDays(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addLocalMonths(year, month, monthsToAdd) {
  const date = new Date(Date.UTC(year, month - 1 + monthsToAdd, 1));

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
  };
}

function monthlyCandidate(year, month, targetDay, hour, minute) {
  return {
    year,
    month,
    day: Math.min(targetDay, daysInMonth(year, month)),
    hour,
    minute,
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayOfWeek(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export { DEFAULT_TIMEZONE, VALID_FREQUENCIES, getNextRunAt, normalizeReportSchedule };
