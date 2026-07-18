import { isDeepStrictEqual } from "node:util";

const spec = ({ collection, name, key, unique = false, partialFilterExpression = null, reason }) => Object.freeze({
  collection, name, key: Object.freeze({ ...key }), unique, sparse: false,
  partialFilterExpression: partialFilterExpression ? Object.freeze(structuredClone(partialFilterExpression)) : null, reason,
});
const active = ["open", "acknowledged", "snoozed"];
export const PHASE5_REVIEW_INDEXES = Object.freeze([
  spec({ collection: "review_items", name: "phase5_review_active_identity_unique", key: { agency_id: 1, active_key: 1 }, unique: true, partialFilterExpression: { active_key: { $type: "string" } }, reason: "One active generation per source" }),
  spec({ collection: "review_items", name: "phase5_review_issue_generation_unique", key: { agency_id: 1, issue_id: 1, generation: 1 }, unique: true, partialFilterExpression: { type: "issue_review" }, reason: "Issue generation allocation" }),
  spec({ collection: "review_items", name: "phase5_review_evaluation_generation_unique", key: { agency_id: 1, evaluation_series_id: 1, generation: 1 }, unique: true, partialFilterExpression: { type: "evaluation_review" }, reason: "Evaluation generation allocation" }),
  spec({ collection: "review_items", name: "phase5_review_workspace_queue", key: { agency_id: 1, state: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, reason: "Workspace queue" }),
  spec({ collection: "review_items", name: "phase5_review_workspace_type_queue", key: { agency_id: 1, state: 1, type: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, reason: "Typed workspace queue" }),
  spec({ collection: "review_items", name: "phase5_review_client_queue", key: { agency_id: 1, client_id: 1, state: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, reason: "Client queue" }),
  spec({ collection: "review_items", name: "phase5_review_campaign_queue", key: { agency_id: 1, campaign_id: 1, state: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 }, reason: "Campaign queue" }),
  spec({ collection: "review_items", name: "phase5_review_authority_scan", key: { agency_id: 1, state: 1, _id: 1 }, reason: "Authority reconciliation" }),
  spec({ collection: "review_items", name: "phase5_review_evaluation_lookup", key: { agency_id: 1, evaluation_id: 1 }, partialFilterExpression: { evaluation_id: { $type: "objectId" } }, reason: "Evaluation lookup" }),
  spec({ collection: "review_items", name: "phase5_review_snooze_expiry", key: { state: 1, snoozed_until: 1, _id: 1 }, partialFilterExpression: { state: "snoozed", snoozed_until: { $type: "date" } }, reason: "Snooze expiry" }),
  spec({ collection: "review_actions", name: "phase5_review_action_sequence", key: { agency_id: 1, review_item_id: 1, sequence: -1 }, unique: true, reason: "Action ordering" }),
  spec({ collection: "review_actions", name: "phase5_review_action_idempotency", key: { agency_id: 1, idempotency_key: 1 }, unique: true, reason: "Action idempotency" }),
  spec({ collection: "review_actions", name: "phase5_review_action_issue_cursor", key: { agency_id: 1, issue_id: 1, occurred_at: -1, _id: -1 }, reason: "Issue timeline" }),
  spec({ collection: "review_reconciliation_checkpoints", name: "phase5_review_checkpoint_lease", key: { "processing_lock.expires_at": 1 }, partialFilterExpression: { "processing_lock.expires_at": { $type: "date" } }, reason: "Expired leases" }),
  spec({ collection: "review_items", name: "phase5_review_workspace_summary_candidates", key: { agency_id: 1, createdAt: 1, _id: 1 }, partialFilterExpression: { state: { $in: active } }, reason: "Bounded workspace summary" }),
  spec({ collection: "review_items", name: "phase5_review_client_summary_candidates", key: { agency_id: 1, client_id: 1, createdAt: 1, _id: 1 }, partialFilterExpression: { state: { $in: active } }, reason: "Bounded Client summary" }),
]);

const ordered = (value = {}) => value instanceof Map ? [...value.entries()] : Array.isArray(value) ? value : Object.entries(value || {});
const absent = (value) => value == null;
const absentFalse = (value) => absent(value) || value === false;
const semantic = new Set(["key", "name", "ns", "v", "unique", "sparse", "partialFilterExpression", "hidden", "collation", "expireAfterSeconds", "wildcardProjection", "background", "storageEngine"]);
export const hasExactPhase5IndexKey = (actual, expected) => isDeepStrictEqual(ordered(actual), ordered(expected));
export const hasExactPhase5IndexOptions = (actual = {}, expected = {}) =>
  (actual.unique === true) === (expected.unique === true) && (actual.sparse === true) === (expected.sparse === true) &&
  isDeepStrictEqual(actual.partialFilterExpression || null, expected.partialFilterExpression || null) && absentFalse(actual.hidden) &&
  absent(actual.collation) && absent(actual.expireAfterSeconds) && absent(actual.wildcardProjection) && absentFalse(actual.background) &&
  absent(actual.storageEngine) && Object.keys(actual).every((field) => semantic.has(field));
const readIndexes = async (collection) => {
  try { return typeof collection?.listIndexes === "function" ? collection.listIndexes().toArray() : await collection.indexes(); }
  catch (error) { if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return []; throw error; }
};
export const classifyPhase5Index = (expected, indexes = []) => {
  const named = indexes.find((item) => item.name === expected.name);
  if (named) {
    const keyExact = hasExactPhase5IndexKey(named.key, expected.key);
    const optionsExact = hasExactPhase5IndexOptions(named, expected);
    return { classification: keyExact && optionsExact ? "exact_match" : "name_conflict", keyExact, optionsExact, matchingIndexName: named.name, applicationRequired: !(keyExact && optionsExact) };
  }
  const equivalent = indexes.find((item) => hasExactPhase5IndexKey(item.key, expected.key) && hasExactPhase5IndexOptions(item, expected));
  if (equivalent) return { classification: "equivalent_different_name", keyExact: true, optionsExact: true, matchingIndexName: equivalent.name, applicationRequired: true };
  const sameKey = indexes.find((item) => hasExactPhase5IndexKey(item.key, expected.key));
  return { classification: sameKey ? "wrong_options" : "missing", keyExact: Boolean(sameKey), optionsExact: false, matchingIndexName: sameKey?.name || null, applicationRequired: true };
};
export const inspectPhase5ReviewIndexes = async ({ collections, specs = PHASE5_REVIEW_INDEXES } = {}) => {
  const cache = new Map(); const results = [];
  for (const expected of specs) {
    const collection = collections?.[expected.collection];
    if (!collection) throw Object.assign(new Error("A Phase 5 Review collection is unavailable."), { code: "PHASE5_REVIEW_COLLECTION_UNAVAILABLE" });
    if (!cache.has(expected.collection)) cache.set(expected.collection, await readIndexes(collection));
    results.push({ collection: expected.collection, expectedName: expected.name, expectedKey: expected.key, expectedOptions: { unique: expected.unique, sparse: false, partialFilterExpression: expected.partialFilterExpression }, reason: expected.reason, ...classifyPhase5Index(expected, cache.get(expected.collection)) });
  }
  return results;
};
const managementError = (code, message, results = []) => Object.assign(new Error(message), { code, results });
export const applyPhase5ReviewIndexes = async ({ collections, specs = PHASE5_REVIEW_INDEXES, logger = console } = {}) => {
  const before = await inspectPhase5ReviewIndexes({ collections, specs });
  const conflicts = before.filter((item) => ["name_conflict", "wrong_options", "equivalent_different_name"].includes(item.classification));
  if (conflicts.length) throw managementError("PHASE5_REVIEW_INDEX_CONFLICT", "Phase 5 Review indexes require manual conflict resolution.", conflicts);
  const created = [];
  for (const result of before) {
    if (result.classification !== "missing") continue;
    const expected = specs.find((item) => item.name === result.expectedName);
    logger.log?.(`[phase5-review-indexes] creating ${expected.collection}.${expected.name}`);
    await collections[expected.collection].createIndex(expected.key, { name: expected.name, unique: expected.unique, ...(expected.partialFilterExpression ? { partialFilterExpression: expected.partialFilterExpression } : {}) });
    created.push(expected.name);
  }
  const after = await inspectPhase5ReviewIndexes({ collections, specs });
  if (after.some((item) => item.applicationRequired)) throw managementError("PHASE5_REVIEW_INDEX_VERIFICATION_FAILED", "Phase 5 Review index verification failed.", after);
  return { results: after, created };
};
export const managePhase5ReviewIndexes = async ({ mode = "inspect", ...options } = {}) => {
  if (mode === "inspect") return { results: await inspectPhase5ReviewIndexes(options), created: [] };
  if (mode === "apply") return applyPhase5ReviewIndexes(options);
  throw managementError("PHASE5_REVIEW_INDEX_MODE_INVALID", "Phase 5 Review index mode is invalid.");
};
let readiness = { state: "uninitialized", ready: false, results: [], error: null };
export const resetPhase5ReviewIntegrityReadiness = () => { readiness = { state: "uninitialized", ready: false, results: [], error: null }; };
export const getPhase5ReviewIntegrityReadiness = () => ({ ...readiness });
export const initializePhase5ReviewIntegrity = async ({ collections } = {}) => {
  try {
    const results = await inspectPhase5ReviewIndexes({ collections });
    const ready = results.every((item) => !item.applicationRequired);
    readiness = { state: ready ? "ready" : "blocked", ready, results, error: ready ? null : managementError("REVIEW_INDEXES_NOT_READY", "Required Review indexes are not ready.") };
    return { ...readiness };
  } catch (error) { readiness = { state: "blocked", ready: false, results: [], error }; throw error; }
};
export const assertPhase5ReviewIntegrityReady = () => {
  if (readiness.ready) return true;
  throw Object.assign(new Error("Review services are temporarily unavailable."), { code: "REVIEW_INDEXES_NOT_READY", status: 503 });
};

