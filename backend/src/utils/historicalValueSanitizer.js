import mongoose from "mongoose";

export const HISTORY_TEXT_MAX = 4000;
export const HISTORY_ARRAY_MAX = 20;

const isPlainRecord = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const asHistoricalRecord = (value) =>
  isPlainRecord(value) || value instanceof mongoose.Document ? value : null;

export const safeHistoricalString = (value, maximum = HISTORY_TEXT_MAX) =>
  typeof value === "string" ? value.slice(0, maximum) : null;

export const safeHistoricalNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export const safeHistoricalBoolean = (value) =>
  typeof value === "boolean" ? value : null;

export const safeHistoricalDate = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

export const safeHistoricalObjectId = (value) => {
  if (!value) return null;
  const candidate = value?._id || value;
  return mongoose.isObjectIdOrHexString(candidate) ? String(candidate) : null;
};

export const safeHistoricalTextArray = (
  value,
  { maximum = HISTORY_ARRAY_MAX, textMaximum = HISTORY_TEXT_MAX } = {}
) =>
  Array.isArray(value)
    ? value
        .slice(0, maximum)
        .map((item) => safeHistoricalString(item, textMaximum))
        .filter((item) => item !== null)
    : [];

export const hasHistoricalValue = (value) =>
  value !== null && value !== undefined && value !== "";
