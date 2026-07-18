import { isDeepStrictEqual } from "node:util";

const spec = ({ collection, name, key, unique = false, partialFilterExpression = null, reason }) => Object.freeze({
  collection,
  name,
  key: Object.freeze({ ...key }),
  unique,
  sparse: false,
  partialFilterExpression: partialFilterExpression ? Object.freeze(structuredClone(partialFilterExpression)) : null,
  reason,
});

export const PHASE4_EVALUATION_INDEXES = Object.freeze([
  spec({ collection: "evaluations", name: "phase4_evaluations_intervention_history", key: { agency_id: 1, intervention_id: 1, sequence: -1 }, unique: true, reason: "Immutable Intervention Evaluation history" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_issue_cursor", key: { agency_id: 1, issue_id: 1, calculated_at: -1, _id: -1 }, reason: "Issue Evaluation history" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_client_cursor", key: { agency_id: 1, client_id: 1, calculated_at: -1, _id: -1 }, reason: "Client Evaluation history" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_status_cursor", key: { agency_id: 1, status: 1, calculated_at: -1, _id: -1 }, reason: "Status-filtered Evaluation history" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_result_cursor", key: { agency_id: 1, observed_result: 1, calculated_at: -1, _id: -1 }, partialFilterExpression: { observed_result: { $type: "string" } }, reason: "Result-filtered Evaluation history" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_metric_cursor", key: { agency_id: 1, primary_metric: 1, calculated_at: -1, _id: -1 }, partialFilterExpression: { primary_metric: { $type: "string" } }, reason: "Metric-filtered Evaluation history" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_idempotency_unique", key: { agency_id: 1, idempotency_key: 1 }, unique: true, reason: "Agency-scoped Evaluation idempotency" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_supersedes_unique", key: { agency_id: 1, supersedes_evaluation_id: 1 }, unique: true, partialFilterExpression: { supersedes_evaluation_id: { $type: "objectId" } }, reason: "One immutable successor per Evaluation version" }),
  spec({ collection: "evaluations", name: "phase4_evaluations_report_run_trigger_unique", key: { agency_id: 1, source_report_run_id: 1, intervention_id: 1, rule_version: 1 }, unique: true, partialFilterExpression: { source_report_run_id: { $type: "objectId" }, trigger_type: "report_run" }, reason: "ReportRun-trigger convergence" }),
  spec({ collection: "evaluation_series", name: "phase4_evaluation_series_intervention_unique", key: { agency_id: 1, intervention_id: 1 }, unique: true, reason: "One processing authority per Intervention" }),
  spec({ collection: "evaluation_series", name: "phase4_evaluation_series_current_lookup", key: { agency_id: 1, current_evaluation_id: 1 }, partialFilterExpression: { current_evaluation_id: { $type: "objectId" } }, reason: "Current Evaluation lookup" }),
  spec({ collection: "evaluation_series", name: "phase4_evaluation_series_lease_expiry", key: { "processing_lock.expires_at": 1 }, partialFilterExpression: { "processing_lock.expires_at": { $type: "date" } }, reason: "Expired processing lease reconciliation" }),
]);

const orderedKey = (value = {}) => value instanceof Map ? [...value.entries()] : Array.isArray(value) ? value : Object.entries(value || {});
const absent = (value) => value == null;
const absentOrFalse = (value) => absent(value) || value === false;
const semanticFields = new Set(["key", "name", "ns", "v", "unique", "sparse", "partialFilterExpression", "hidden", "collation", "expireAfterSeconds", "wildcardProjection", "background", "storageEngine"]);
export const hasExactPhase4IndexKey = (actual, expected) => isDeepStrictEqual(orderedKey(actual), orderedKey(expected));
export const hasExactPhase4IndexOptions = (actual = {}, expected = {}) =>
  (actual.unique === true) === (expected.unique === true) &&
  (actual.sparse === true) === (expected.sparse === true) &&
  isDeepStrictEqual(actual.partialFilterExpression || null, expected.partialFilterExpression || null) &&
  absentOrFalse(actual.hidden) && absent(actual.collation) && absent(actual.expireAfterSeconds) &&
  absent(actual.wildcardProjection) && absentOrFalse(actual.background) && absent(actual.storageEngine) &&
  Object.keys(actual).every((field) => semanticFields.has(field));

const readIndexes = async (collection) => {
  try {
    return typeof collection?.listIndexes === "function" ? collection.listIndexes().toArray() : await collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
};

export const classifyPhase4Index = (expected, indexes = []) => {
  const named = indexes.find((index) => index.name === expected.name);
  if (named) {
    const keyExact = hasExactPhase4IndexKey(named.key, expected.key);
    const optionsExact = hasExactPhase4IndexOptions(named, expected);
    return { classification: keyExact && optionsExact ? "exact_match" : "name_conflict", keyExact, optionsExact, matchingIndexName: named.name, applicationRequired: !(keyExact && optionsExact) };
  }
  const equivalent = indexes.find((index) => hasExactPhase4IndexKey(index.key, expected.key) && hasExactPhase4IndexOptions(index, expected));
  if (equivalent) return { classification: "equivalent_different_name", keyExact: true, optionsExact: true, matchingIndexName: equivalent.name, applicationRequired: true };
  const sameKey = indexes.find((index) => hasExactPhase4IndexKey(index.key, expected.key));
  return { classification: sameKey ? "wrong_options" : "missing", keyExact: Boolean(sameKey), optionsExact: false, matchingIndexName: sameKey?.name || null, applicationRequired: true };
};

export const inspectPhase4EvaluationIndexes = async ({ collections, specs = PHASE4_EVALUATION_INDEXES } = {}) => {
  const indexCache = new Map();
  const results = [];
  for (const expected of specs) {
    const collection = collections?.[expected.collection];
    if (!collection) {
      const error = new Error(`Phase 4 collection ${expected.collection} is unavailable.`);
      error.code = "PHASE4_EVALUATION_COLLECTION_UNAVAILABLE";
      throw error;
    }
    if (!indexCache.has(expected.collection)) indexCache.set(expected.collection, await readIndexes(collection));
    results.push({
      collection: expected.collection,
      expectedName: expected.name,
      expectedKey: expected.key,
      expectedOptions: { unique: expected.unique, sparse: expected.sparse, partialFilterExpression: expected.partialFilterExpression },
      reason: expected.reason,
      ...classifyPhase4Index(expected, indexCache.get(expected.collection)),
    });
  }
  return results;
};

const managementError = (code, message, results = []) => Object.assign(new Error(message), { code, results });
export const applyPhase4EvaluationIndexes = async ({ collections, specs = PHASE4_EVALUATION_INDEXES, logger = console } = {}) => {
  const before = await inspectPhase4EvaluationIndexes({ collections, specs });
  const conflicts = before.filter((item) => ["name_conflict", "wrong_options", "equivalent_different_name"].includes(item.classification));
  if (conflicts.length) throw managementError("PHASE4_EVALUATION_INDEX_CONFLICT", "Phase 4 Evaluation indexes contain conflicts requiring manual review.", conflicts);
  const created = [];
  for (const result of before) {
    if (result.classification !== "missing") continue;
    const expected = specs.find((item) => item.name === result.expectedName);
    logger.log?.(`[phase4-evaluation-indexes] creating ${expected.collection}.${expected.name}`);
    await collections[expected.collection].createIndex(expected.key, {
      name: expected.name,
      unique: expected.unique,
      ...(expected.partialFilterExpression ? { partialFilterExpression: expected.partialFilterExpression } : {}),
    });
    created.push(expected.name);
  }
  const after = await inspectPhase4EvaluationIndexes({ collections, specs });
  if (after.some((item) => item.applicationRequired)) throw managementError("PHASE4_EVALUATION_INDEX_VERIFICATION_FAILED", "Phase 4 index verification failed after application.", after);
  return { results: after, created };
};

export const managePhase4EvaluationIndexes = async ({ mode = "inspect", ...options } = {}) => {
  if (mode === "inspect") return { results: await inspectPhase4EvaluationIndexes(options), created: [] };
  if (mode === "apply") return applyPhase4EvaluationIndexes(options);
  throw managementError("PHASE4_EVALUATION_INDEX_MODE_INVALID", "Phase 4 index mode is invalid.");
};

let readiness = { state: "uninitialized", ready: false, results: [], error: null };
export const resetPhase4EvaluationIntegrityReadiness = () => { readiness = { state: "uninitialized", ready: false, results: [], error: null }; };
export const getPhase4EvaluationIntegrityReadiness = () => ({ ...readiness });
export const initializePhase4EvaluationIntegrity = async ({ collections } = {}) => {
  try {
    const results = await inspectPhase4EvaluationIndexes({ collections });
    const ready = results.every((item) => !item.applicationRequired);
    readiness = { state: ready ? "ready" : "blocked", ready, results, error: ready ? null : managementError("EVALUATION_INDEXES_NOT_READY", "Required Phase 4 Evaluation indexes are not ready.", results.filter((item) => item.applicationRequired)) };
    return { ...readiness };
  } catch (error) {
    readiness = { state: "blocked", ready: false, results: [], error };
    throw error;
  }
};
export const assertPhase4EvaluationIntegrityReady = () => {
  if (readiness.ready) return true;
  const error = new Error("Required Phase 4 Evaluation indexes are not ready.");
  error.code = "EVALUATION_INDEXES_NOT_READY";
  error.status = 503;
  throw error;
};

