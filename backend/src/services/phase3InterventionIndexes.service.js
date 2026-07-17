import { isDeepStrictEqual } from "node:util";

const spec = ({ name, key, unique = false, partialFilterExpression = null, reason }) =>
  Object.freeze({
    collection: "interventions",
    name,
    key: Object.freeze({ ...key }),
    unique,
    sparse: false,
    partialFilterExpression: partialFilterExpression
      ? Object.freeze(structuredClone(partialFilterExpression))
      : null,
    reason,
  });

export const PHASE3_INTERVENTION_INDEXES = Object.freeze([
  spec({ name: "phase3_interventions_issue_cursor", key: { agency_id: 1, issue_id: 1, performed_at: -1, _id: -1 }, reason: "Issue Intervention history" }),
  spec({ name: "phase3_interventions_client_cursor", key: { agency_id: 1, client_id: 1, performed_at: -1, _id: -1 }, reason: "Client Intervention history" }),
  spec({
    name: "phase3_interventions_actor_cursor",
    key: { agency_id: 1, performed_by_user_id: 1, performed_at: -1, _id: -1 },
    partialFilterExpression: { performed_by_user_id: { $type: "objectId" } },
    reason: "Intervention history filtered by performer",
  }),
  spec({ name: "phase3_interventions_action_cursor", key: { agency_id: 1, action_type: 1, performed_at: -1, _id: -1 }, reason: "Intervention history filtered by action" }),
  spec({ name: "phase3_interventions_status_cursor", key: { agency_id: 1, status: 1, performed_at: -1, _id: -1 }, reason: "Intervention history filtered by lifecycle status" }),
  spec({ name: "phase3_interventions_idempotency_unique", key: { agency_id: 1, idempotency_key: 1 }, unique: true, reason: "Agency-scoped creation idempotency" }),
  spec({
    name: "phase3_interventions_supersedes_unique",
    key: { agency_id: 1, supersedes_intervention_id: 1 },
    unique: true,
    partialFilterExpression: { supersedes_intervention_id: { $type: "objectId" } },
    reason: "One direct correction successor",
  }),
  spec({
    name: "phase3_interventions_cancellation_key_unique",
    key: { agency_id: 1, "cancellation.idempotency_key": 1 },
    unique: true,
    partialFilterExpression: { "cancellation.idempotency_key": { $type: "string" } },
    reason: "Agency-scoped cancellation idempotency",
  }),
]);

const orderedKey = (value = {}) => {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? Object.entries(value) : [];
};

export const hasExactPhase3IndexKey = (actual, expected) =>
  isDeepStrictEqual(orderedKey(actual), orderedKey(expected));

const semanticFields = new Set([
  "key",
  "name",
  "ns",
  "v",
  "unique",
  "sparse",
  "partialFilterExpression",
  "hidden",
  "collation",
  "expireAfterSeconds",
  "wildcardProjection",
  "background",
  "storageEngine",
]);
const absent = (value) => value == null;
const absentOrFalse = (value) => absent(value) || value === false;

export const hasExactPhase3IndexOptions = (actual = {}, expected = {}) =>
  (actual.unique === true) === (expected.unique === true) &&
  (actual.sparse === true) === (expected.sparse === true) &&
  isDeepStrictEqual(
    actual.partialFilterExpression || null,
    expected.partialFilterExpression || null
  ) &&
  absentOrFalse(actual.hidden) &&
  absent(actual.collation) &&
  absent(actual.expireAfterSeconds) &&
  absent(actual.wildcardProjection) &&
  absentOrFalse(actual.background) &&
  absent(actual.storageEngine) &&
  Object.keys(actual).every((field) => semanticFields.has(field));

const readIndexes = async (collection) => {
  try {
    if (typeof collection?.listIndexes === "function") {
      return await collection.listIndexes().toArray();
    }
    if (typeof collection?.indexes === "function") return collection.indexes();
    throw new Error("Intervention collection does not expose index metadata.");
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
};

export const classifyPhase3InterventionIndex = (expected, indexes = []) => {
  const named = indexes.find((index) => index.name === expected.name);
  if (named) {
    const keyExact = hasExactPhase3IndexKey(named.key, expected.key);
    const optionsExact = hasExactPhase3IndexOptions(named, expected);
    return {
      classification: keyExact && optionsExact ? "exact_match" : "name_conflict",
      keyExact,
      optionsExact,
      matchingIndexName: named.name,
      applicationRequired: !(keyExact && optionsExact),
    };
  }
  const equivalent = indexes.find(
    (index) =>
      hasExactPhase3IndexKey(index.key, expected.key) &&
      hasExactPhase3IndexOptions(index, expected)
  );
  if (equivalent) {
    return {
      classification: "equivalent_different_name",
      keyExact: true,
      optionsExact: true,
      matchingIndexName: equivalent.name,
      applicationRequired: true,
    };
  }
  const sameKey = indexes.find((index) => hasExactPhase3IndexKey(index.key, expected.key));
  return {
    classification: sameKey ? "wrong_options" : "missing",
    keyExact: Boolean(sameKey),
    optionsExact: false,
    matchingIndexName: sameKey?.name || null,
    applicationRequired: true,
  };
};

export const inspectPhase3InterventionIndexes = async ({
  collection,
  specs = PHASE3_INTERVENTION_INDEXES,
} = {}) => {
  if (!collection) {
    const error = new Error("Intervention collection is unavailable.");
    error.code = "PHASE3_INTERVENTION_COLLECTION_UNAVAILABLE";
    throw error;
  }
  const indexes = await readIndexes(collection);
  return specs.map((expected) => ({
    collection: expected.collection,
    expectedName: expected.name,
    expectedKey: expected.key,
    expectedOptions: {
      unique: expected.unique,
      sparse: expected.sparse,
      partialFilterExpression: expected.partialFilterExpression,
    },
    reason: expected.reason,
    ...classifyPhase3InterventionIndex(expected, indexes),
  }));
};

const managementError = (code, message, results = []) => {
  const error = new Error(message);
  error.code = code;
  error.results = results;
  return error;
};

export const applyPhase3InterventionIndexes = async ({
  collection,
  specs = PHASE3_INTERVENTION_INDEXES,
  logger = console,
} = {}) => {
  const before = await inspectPhase3InterventionIndexes({ collection, specs });
  const conflicts = before.filter((item) =>
    ["name_conflict", "wrong_options", "equivalent_different_name"].includes(
      item.classification
    )
  );
  if (conflicts.length) {
    throw managementError(
      "PHASE3_INTERVENTION_INDEX_CONFLICT",
      "Phase 3 Intervention indexes contain conflicts requiring manual review.",
      conflicts
    );
  }
  const created = [];
  for (const result of before) {
    if (result.classification !== "missing") continue;
    const expected = specs.find((item) => item.name === result.expectedName);
    logger.log?.(`[phase3-intervention-indexes] creating interventions.${expected.name}`);
    await collection.createIndex(expected.key, {
      name: expected.name,
      unique: expected.unique,
      ...(expected.partialFilterExpression
        ? { partialFilterExpression: expected.partialFilterExpression }
        : {}),
    });
    created.push(expected.name);
  }
  const after = await inspectPhase3InterventionIndexes({ collection, specs });
  if (after.some((item) => item.applicationRequired)) {
    throw managementError(
      "PHASE3_INTERVENTION_INDEX_VERIFICATION_FAILED",
      "Phase 3 Intervention index verification failed after application.",
      after
    );
  }
  return { results: after, created };
};

export const managePhase3InterventionIndexes = async ({ mode = "inspect", ...options } = {}) => {
  if (mode === "inspect") {
    return {
      results: await inspectPhase3InterventionIndexes(options),
      created: [],
    };
  }
  if (mode === "apply") return applyPhase3InterventionIndexes(options);
  throw managementError("PHASE3_INTERVENTION_INDEX_MODE_INVALID", "Phase 3 index mode is invalid.");
};

let readiness = { state: "uninitialized", ready: false, results: [], error: null };

export const resetPhase3InterventionIntegrityReadiness = () => {
  readiness = { state: "uninitialized", ready: false, results: [], error: null };
};

export const getPhase3InterventionIntegrityReadiness = () => ({ ...readiness });

export const initializePhase3InterventionIntegrity = async ({ collection } = {}) => {
  try {
    const results = await inspectPhase3InterventionIndexes({ collection });
    const ready = results.every((item) => !item.applicationRequired);
    readiness = {
      state: ready ? "ready" : "blocked",
      ready,
      results,
      error: ready ? null : managementError(
        "INTERVENTION_INDEXES_NOT_READY",
        "Required Phase 3 Intervention indexes are not ready.",
        results.filter((item) => item.applicationRequired)
      ),
    };
    return { ...readiness };
  } catch (error) {
    readiness = { state: "blocked", ready: false, results: [], error };
    throw error;
  }
};

export const assertPhase3InterventionIntegrityReady = () => {
  if (readiness.ready) return true;
  const error = new Error("Required Phase 3 Intervention indexes are not ready.");
  error.code = "INTERVENTION_INDEXES_NOT_READY";
  error.status = 503;
  throw error;
};
