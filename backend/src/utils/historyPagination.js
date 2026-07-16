import mongoose from "mongoose";
import { logError } from "./controllerLogger.js";

export const HISTORY_PAGE_DEFAULT = 25;
export const HISTORY_PAGE_MAX = 100;

export class HistoryPaginationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HistoryPaginationError";
    this.code = code;
    this.status = 400;
  }
}

export const isValidObjectId = (value) => mongoose.isObjectIdOrHexString(value);

export const parseHistoryLimit = (
  value,
  { defaultLimit = HISTORY_PAGE_DEFAULT, maximum = HISTORY_PAGE_MAX } = {}
) => {
  if (value === undefined || value === null || value === "") return defaultLimit;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HistoryPaginationError(
      "INVALID_PAGINATION_LIMIT",
      "History limit must be a positive integer."
    );
  }

  return Math.min(parsed, maximum);
};

export const encodeHistoryCursor = ({ timestamp, id }) => {
  if (!isValidObjectId(id)) {
    throw new HistoryPaginationError("INVALID_CURSOR", "History cursor is invalid.");
  }

  const normalizedTimestamp = timestamp ? new Date(timestamp) : null;
  if (normalizedTimestamp && Number.isNaN(normalizedTimestamp.getTime())) {
    throw new HistoryPaginationError("INVALID_CURSOR", "History cursor is invalid.");
  }

  return Buffer.from(
    JSON.stringify({
      v: 1,
      t: normalizedTimestamp?.toISOString() || null,
      i: String(id),
    })
  ).toString("base64url");
};

export const decodeHistoryCursor = (cursor) => {
  if (!cursor) return null;

  try {
    const decoded = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const timestamp = decoded.t === null ? null : new Date(decoded.t);

    if (
      decoded.v !== 1 ||
      !isValidObjectId(decoded.i) ||
      (timestamp && Number.isNaN(timestamp.getTime()))
    ) {
      throw new Error("invalid");
    }

    return {
      timestamp,
      id: new mongoose.Types.ObjectId(decoded.i),
    };
  } catch {
    throw new HistoryPaginationError("INVALID_CURSOR", "History cursor is invalid.");
  }
};

const missingTimestampScope = (timestampField) => ({
  $or: [{ [timestampField]: null }, { [timestampField]: { $exists: false } }],
});

export const buildDescendingCursorScope = (timestampField, cursor) => {
  const decoded = typeof cursor === "string" ? decodeHistoryCursor(cursor) : cursor;
  if (!decoded) return {};

  if (!decoded.timestamp) {
    return {
      $and: [missingTimestampScope(timestampField), { _id: { $lt: decoded.id } }],
    };
  }

  return {
    $or: [
      { [timestampField]: { $lt: decoded.timestamp } },
      { [timestampField]: decoded.timestamp, _id: { $lt: decoded.id } },
      missingTimestampScope(timestampField),
    ],
  };
};

export const withCursorScope = (query, timestampField, cursor) => {
  const cursorScope = buildDescendingCursorScope(timestampField, cursor);
  if (!Object.keys(cursorScope).length) return query;
  return { $and: [query, cursorScope] };
};

export const finalizeHistoryPage = ({ documents, limit, timestampField }) => {
  const hasMore = documents.length > limit;
  const items = hasMore ? documents.slice(0, limit) : documents;
  const last = items.at(-1);

  return {
    items,
    page: {
      nextCursor:
        hasMore && last
          ? encodeHistoryCursor({ timestamp: last[timestampField] || null, id: last._id })
          : null,
      hasMore,
      limit,
    },
  };
};

export const historyNotFound = (res, label = "History record") =>
  res.status(404).json({
    success: false,
    code: "HISTORY_RECORD_NOT_FOUND",
    message: `${label} not found.`,
  });

const CONTROLLED_HISTORY_ERRORS = new Set([
  "INVALID_CURSOR",
  "INVALID_PAGINATION_LIMIT",
  "INVALID_HISTORY_FILTER",
  "INVALID_DATE_RANGE",
  "HISTORY_FILTER_REQUIRED",
  "INVALID_ARTIFACT_AUDIENCE",
]);

export const historyRequestError = (res, error, fallback) => {
  if (
    CONTROLLED_HISTORY_ERRORS.has(error?.code) &&
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message || fallback,
    });
  }

  logError("History", "HISTORICAL_READ_FAILED", error, { operation: fallback });
  return res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: "Unable to load historical data",
  });
};
