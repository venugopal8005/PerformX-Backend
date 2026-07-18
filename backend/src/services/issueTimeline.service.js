import mongoose from "mongoose";
import { Activity, Evaluation, Intervention, Issue, ReviewAction, Signal } from "../models/index.js";
import { REVIEW_ERROR, REVIEW_LIMITS, createReviewError } from "../domain/phase5Review.domain.js";
import { safeHistoricalDate, safeHistoricalObjectId, safeHistoricalString } from "../utils/historicalValueSanitizer.js";

const defaultModels = { Activity, Evaluation, Intervention, Issue, ReviewAction, Signal };
const STREAMS = Object.freeze([
  { name: "signals", rank: 10, model: "Signal", time: "detected_at", eventKind: "signal_detected" },
  { name: "intervention_recorded", rank: 20, model: "Intervention", time: "recorded_at", eventKind: "intervention_recorded" },
  { name: "intervention_corrected", rank: 21, model: "Intervention", time: "corrected_at", eventKind: "intervention_corrected", extra: { status: "superseded" } },
  { name: "intervention_cancelled", rank: 22, model: "Intervention", time: "cancellation.cancelled_at", eventKind: "intervention_cancelled", extra: { status: "cancelled" } },
  { name: "evaluations", rank: 30, model: "Evaluation", time: "calculated_at", eventKind: "evaluation_calculated" },
  { name: "review_actions", rank: 40, model: "ReviewAction", time: "occurred_at", eventKind: null },
  { name: "client_archive", rank: 50, model: "Activity", time: "createdAt", eventKind: "client_archived", extra: { type: "client_archived" } },
  { name: "report_archive", rank: 51, model: "Activity", time: "createdAt", eventKind: "report_archived", extra: { type: "report_archived" } },
]);
const text = (value, maximum = 1000) => safeHistoricalString(value, maximum);
const id = safeHistoricalObjectId;
const date = safeHistoricalDate;
const valueAt = (value, path) => path.split(".").reduce((current, key) => current?.[key], value);
const objectId = (value) => mongoose.isObjectIdOrHexString(value) ? String(value) : null;
const initialPositions = () => Object.fromEntries(STREAMS.map((stream) => [stream.name, { timestamp: null, objectId: null, exhausted: false }]));
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (cursor, { agencyId, issueId }) => {
  if (!cursor) return null;
  try {
    if (Buffer.byteLength(String(cursor), "base64url") > REVIEW_LIMITS.cursorBytes) throw new Error("invalid");
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value.v !== 1 || value.agencyId !== String(agencyId) || value.issueId !== String(issueId) || Number.isNaN(new Date(value.snapshotAt).getTime())) throw new Error("invalid");
    if (!value.streams || Object.keys(value.streams).sort().join(",") !== STREAMS.map((entry) => entry.name).sort().join(",")) throw new Error("invalid");
    for (const stream of STREAMS) {
      const position = value.streams[stream.name];
      if (typeof position?.exhausted !== "boolean") throw new Error("invalid");
      if ((position.timestamp == null) !== (position.objectId == null)) throw new Error("invalid");
      if (position.timestamp != null && (Number.isNaN(new Date(position.timestamp).getTime()) || !mongoose.isObjectIdOrHexString(position.objectId))) throw new Error("invalid");
    }
    return value;
  } catch { throw createReviewError(REVIEW_ERROR.INVALID_TIMELINE_CURSOR, "Timeline cursor is invalid.", 400); }
};
const limitFor = (input) => {
  if (input == null || input === "") return 25;
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < 1 || value > REVIEW_LIMITS.timelineLimit) throw createReviewError(REVIEW_ERROR.VALIDATION, "limit is invalid.", 400);
  return value;
};
const below = (field, position) => !position?.timestamp ? {} : { $or: [{ [field]: { $lt: new Date(position.timestamp) } }, { [field]: new Date(position.timestamp), _id: { $lt: position.objectId } }] };
const baseScope = (stream, issue, agencyId) => {
  if (stream.name === "client_archive") return { agency_id: agencyId, client_id: issue.client_id };
  if (stream.name === "report_archive") return { agency_id: agencyId, report_id: { $in: issue.report_ids || [] } };
  return { agency_id: agencyId, issue_id: issue._id };
};
const describe = (stream, document) => {
  if (stream.name === "signals") return { title: document.title || "Signal detected", description: document.description, severity: document.severity };
  if (stream.name.startsWith("intervention_")) return { title: stream.name === "intervention_recorded" ? "Intervention recorded" : stream.name === "intervention_corrected" ? "Intervention corrected" : "Intervention cancelled", description: stream.name === "intervention_cancelled" ? document.cancellation?.reason : document.reason || document.note, actionType: document.action_type };
  if (stream.name === "evaluations") return { title: "Evaluation calculated", description: document.summary, result: document.observed_result, status: document.status };
  if (stream.name === "review_actions") return { title: String(document.action_type || "Review action").replaceAll("_", " "), description: document.note, actionType: document.action_type, resultingState: document.resulting_state, actor: document.actor_snapshot ? { displayName: text(document.actor_snapshot.display_name, 256), workspaceRole: text(document.actor_snapshot.workspace_role, 16) } : null };
  return { title: document.title || (stream.name === "client_archive" ? "Client archived" : "Report archived"), description: document.description };
};
const serialize = (stream, document) => ({
  id: `${stream.name}:${document._id}:${stream.eventKind || document.action_type || "event"}`,
  stream: stream.name,
  kind: stream.eventKind || text(document.action_type, 64),
  sourceId: id(document._id),
  occurredAt: date(valueAt(document, stream.time)),
  rank: stream.rank,
  ...Object.fromEntries(Object.entries(describe(stream, document)).map(([key, value]) => [key, typeof value === "string" ? text(value, key === "description" ? 1000 : 256) : value])),
});
const compare = (left, right) => {
  const time = new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime();
  if (time) return time;
  if (left.rank !== right.rank) return left.rank - right.rank;
  const source = String(right.sourceId).localeCompare(String(left.sourceId));
  return source || left.id.localeCompare(right.id);
};

export const getIssueTimeline = async ({ agencyId, issueId, cursor = null, limit = null, Models = defaultModels, now = new Date() } = {}) => {
  if (!mongoose.isObjectIdOrHexString(issueId)) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Issue not found.", 404);
  const issue = await Models.Issue.findOne({ _id: issueId, agency_id: agencyId }).select("_id client_id report_ids").lean();
  if (!issue) throw createReviewError(REVIEW_ERROR.NOT_FOUND, "Issue not found.", 404);
  const pageLimit = limitFor(limit);
  const parsed = decode(cursor, { agencyId, issueId });
  const snapshotAt = parsed ? new Date(parsed.snapshotAt) : now;
  const positions = parsed ? structuredClone(parsed.streams) : initialPositions();
  const fetched = new Map();
  await Promise.all(STREAMS.map(async (stream) => {
    const position = positions[stream.name];
    if (position.exhausted) { fetched.set(stream.name, []); return; }
    const model = Models[stream.model];
    const query = {
      ...baseScope(stream, issue, agencyId), ...stream.extra,
      [stream.time]: { $ne: null, $lte: snapshotAt },
      createdAt: { $lte: snapshotAt },
      ...below(stream.time, position),
    };
    const documents = await model.find(query).sort({ [stream.time]: -1, _id: -1 }).limit(pageLimit + 1).lean();
    fetched.set(stream.name, documents);
  }));
  const candidates = STREAMS.flatMap((stream) => (fetched.get(stream.name) || []).slice(0, pageLimit).map((document) => serialize(stream, document))).sort(compare);
  const entries = candidates.slice(0, pageLimit);
  const emittedByStream = new Map();
  entries.forEach((entry) => emittedByStream.set(entry.stream, [...(emittedByStream.get(entry.stream) || []), entry]));
  for (const stream of STREAMS) {
    const documents = fetched.get(stream.name) || [];
    const emitted = emittedByStream.get(stream.name) || [];
    if (emitted.length) {
      const last = emitted.at(-1);
      positions[stream.name] = { timestamp: last.occurredAt, objectId: last.sourceId, exhausted: documents.length <= emitted.length };
    } else if (!documents.length) positions[stream.name].exhausted = true;
  }
  const complete = STREAMS.every((stream) => positions[stream.name].exhausted);
  return { entries, page: { limit: pageLimit, snapshotAt: snapshotAt.toISOString(), nextCursor: complete ? null : encode({ v: 1, agencyId: String(agencyId), issueId: String(issueId), snapshotAt: snapshotAt.toISOString(), streams: positions }) } };
};

export const ISSUE_TIMELINE_STREAMS = STREAMS;
export const issueTimelineInternals = { compare, decode, encode, initialPositions };
