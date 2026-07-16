const indexSpec = ({ collection, name, key, reason }) =>
  Object.freeze({
    collection,
    name,
    key: Object.freeze({ ...key }),
    unique: false,
    sparse: false,
    reason,
  });

export const PHASE1E_HISTORY_INDEXES = Object.freeze([
  indexSpec({
    collection: "reports",
    name: "phase1e_reports_client_archived_cursor",
    key: { agency_id: 1, client_id: 1, is_archived: 1, archived_at: -1, _id: -1 },
    reason: "Archived Reports filtered by Client",
  }),
  indexSpec({
    collection: "signals",
    name: "phase1e_signals_workspace_cursor",
    key: { agency_id: 1, detected_at: -1, _id: -1 },
    reason: "Workspace Signal history",
  }),
  indexSpec({
    collection: "signals",
    name: "phase1e_signals_type_cursor",
    key: { agency_id: 1, type: 1, detected_at: -1, _id: -1 },
    reason: "Signal history filtered by type",
  }),
  indexSpec({
    collection: "signals",
    name: "phase1e_signals_severity_cursor",
    key: { agency_id: 1, severity: 1, detected_at: -1, _id: -1 },
    reason: "Signal history filtered by severity",
  }),
  indexSpec({
    collection: "activities",
    name: "phase1e_activities_workspace_cursor",
    key: { agency_id: 1, createdAt: -1, _id: -1 },
    reason: "Workspace Activity history",
  }),
  indexSpec({
    collection: "activities",
    name: "phase1e_activities_actor_cursor",
    key: { agency_id: 1, user_id: 1, createdAt: -1, _id: -1 },
    reason: "Activity history filtered by actor",
  }),
  indexSpec({
    collection: "activities",
    name: "phase1e_activities_type_cursor",
    key: { agency_id: 1, type: 1, createdAt: -1, _id: -1 },
    reason: "Activity history filtered by type",
  }),
  indexSpec({
    collection: "activities",
    name: "phase1e_activities_severity_cursor",
    key: { agency_id: 1, severity: 1, createdAt: -1, _id: -1 },
    reason: "Activity history filtered by severity",
  }),
]);

export const normalizeOrderedIndexKey = (value = {}) => {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) {
    return value.every(
      (entry) =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string"
    )
      ? value.map(([field, direction]) => [field, direction])
      : [];
  }
  if (value && typeof value === "object") return Object.entries(value);
  return [];
};

export const hasExactIndexKey = (actual = {}, expected = {}) => {
  const actualEntries = normalizeOrderedIndexKey(actual);
  const expectedEntries = normalizeOrderedIndexKey(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(([field, direction], index) => {
      const expectedEntry = expectedEntries[index];
      return expectedEntry?.[0] === field && expectedEntry?.[1] === direction;
    })
  );
};

const hasSameFields = (actual = {}, expected = {}) => {
  const actualFields = normalizeOrderedIndexKey(actual)
    .map(([field]) => field)
    .sort();
  const expectedFields = normalizeOrderedIndexKey(expected)
    .map(([field]) => field)
    .sort();
  return (
    actualFields.length === expectedFields.length &&
    actualFields.every((field, index) => field === expectedFields[index])
  );
};

const benignInventoryFields = new Set(["key", "name", "ns", "v"]);
const canonicalSemanticFields = new Set([
  "unique",
  "sparse",
  "partialFilterExpression",
  "hidden",
  "collation",
  "expireAfterSeconds",
  "wildcardProjection",
  "background",
]);

const isAbsent = (value) => value == null;
const isAbsentOrFalse = (value) => isAbsent(value) || value === false;

const unexpectedOptionNames = (index = {}) =>
  Object.keys(index).filter(
    (field) =>
      !benignInventoryFields.has(field) && !canonicalSemanticFields.has(field)
  );

export const hasExactHistoryIndexOptions = (index = {}) =>
  isAbsentOrFalse(index.unique) &&
  isAbsentOrFalse(index.sparse) &&
  isAbsent(index.partialFilterExpression) &&
  isAbsentOrFalse(index.hidden) &&
  isAbsent(index.collation) &&
  isAbsent(index.expireAfterSeconds) &&
  isAbsent(index.wildcardProjection) &&
  isAbsentOrFalse(index.background) &&
  unexpectedOptionNames(index).length === 0;

const safeOptions = (index = {}) => ({
  unique: index.unique === true,
  sparse: index.sparse === true,
  partialFilterExpression: index.partialFilterExpression || null,
  hidden: index.hidden === true,
  collation: index.collation || null,
  expireAfterSeconds: index.expireAfterSeconds ?? null,
  wildcardProjection: index.wildcardProjection || null,
  background: index.background === true,
  unexpectedOptions: unexpectedOptionNames(index),
});

const readIndexes = async (collection) => {
  try {
    if (typeof collection?.listIndexes === "function") {
      return await collection.listIndexes().toArray();
    }
    if (typeof collection?.indexes === "function") {
      return await collection.indexes();
    }
    throw new Error("Collection does not expose an index metadata API.");
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
};

const collectionFor = (collections, name) =>
  collections instanceof Map ? collections.get(name) : collections?.[name];

export const classifyPhase1EHistoryIndex = (spec, indexes = []) => {
  const named = indexes.find((index) => index.name === spec.name);
  if (named) {
    const keysMatch = hasExactIndexKey(named.key, spec.key);
    const optionsMatch = hasExactHistoryIndexOptions(named);
    if (keysMatch && optionsMatch) {
      return {
        classification: "exact_match",
        issue: null,
        matchingIndexName: named.name,
        currentKey: named.key,
        currentOptions: safeOptions(named),
        applicationRequired: false,
      };
    }
    return {
      classification: "name_conflict",
      issue: keysMatch ? "wrong_options" : "wrong_keys",
      matchingIndexName: named.name,
      currentKey: named.key,
      currentOptions: safeOptions(named),
      applicationRequired: true,
    };
  }

  const equivalent = indexes.find(
    (index) =>
      hasExactIndexKey(index.key, spec.key) && hasExactHistoryIndexOptions(index)
  );
  if (equivalent) {
    return {
      classification: "equivalent_different_name",
      issue: null,
      matchingIndexName: equivalent.name,
      currentKey: equivalent.key,
      currentOptions: safeOptions(equivalent),
      applicationRequired: false,
    };
  }

  const wrongOptions = indexes.find((index) => hasExactIndexKey(index.key, spec.key));
  if (wrongOptions) {
    return {
      classification: "wrong_options",
      issue: "wrong_options",
      matchingIndexName: wrongOptions.name,
      currentKey: wrongOptions.key,
      currentOptions: safeOptions(wrongOptions),
      applicationRequired: true,
    };
  }

  const wrongKeys = indexes.find((index) => hasSameFields(index.key, spec.key));
  if (wrongKeys) {
    return {
      classification: "wrong_keys",
      issue: "wrong_keys",
      matchingIndexName: wrongKeys.name,
      currentKey: wrongKeys.key,
      currentOptions: safeOptions(wrongKeys),
      applicationRequired: true,
    };
  }

  return {
    classification: "missing",
    issue: null,
    matchingIndexName: null,
    currentKey: null,
    currentOptions: null,
    applicationRequired: true,
  };
};

export const inspectPhase1EHistoryIndexes = async ({
  collections,
  specs = PHASE1E_HISTORY_INDEXES,
} = {}) => {
  const inventoryByCollection = new Map();
  const results = [];

  for (const spec of specs) {
    const collection = collectionFor(collections, spec.collection);
    if (!collection) {
      const error = new Error(`Phase 1E collection ${spec.collection} is unavailable.`);
      error.code = "PHASE1E_HISTORY_COLLECTION_UNAVAILABLE";
      throw error;
    }
    if (!inventoryByCollection.has(spec.collection)) {
      inventoryByCollection.set(spec.collection, await readIndexes(collection));
    }
    results.push({
      collection: spec.collection,
      expectedName: spec.name,
      expectedKey: spec.key,
      expectedOptions: {
        unique: false,
        sparse: false,
        partialFilterExpression: null,
        hidden: false,
        collation: null,
        expireAfterSeconds: null,
        wildcardProjection: null,
        background: false,
        unexpectedOptions: [],
      },
      reason: spec.reason,
      ...classifyPhase1EHistoryIndex(
        spec,
        inventoryByCollection.get(spec.collection)
      ),
    });
  }

  return results;
};

const managementError = (code, message, results = []) => {
  const error = new Error(message);
  error.code = code;
  error.results = results;
  return error;
};

const blockingClassifications = new Set([
  "name_conflict",
  "wrong_keys",
  "wrong_options",
]);

export const applyPhase1EHistoryIndexes = async ({
  collections,
  specs = PHASE1E_HISTORY_INDEXES,
  logger = console,
} = {}) => {
  const before = await inspectPhase1EHistoryIndexes({ collections, specs });
  const conflicts = before.filter((result) =>
    blockingClassifications.has(result.classification)
  );
  if (conflicts.length) {
    throw managementError(
      "PHASE1E_HISTORY_INDEX_CONFLICT",
      "Phase 1E history indexes contain conflicts that require manual review.",
      conflicts
    );
  }

  const created = [];
  for (const result of before) {
    if (result.classification !== "missing") continue;
    const spec = specs.find(
      (candidate) =>
        candidate.collection === result.collection && candidate.name === result.expectedName
    );
    const collection = collectionFor(collections, spec.collection);
    logger.log(`[phase1e-history-indexes] creating ${spec.collection}.${spec.name}`);
    try {
      await collection.createIndex(spec.key, {
        name: spec.name,
        unique: false,
        sparse: false,
      });
    } catch (error) {
      const wrapped = managementError(
        "PHASE1E_HISTORY_INDEX_CREATE_FAILED",
        `Failed to create ${spec.collection}.${spec.name}.`,
        [result]
      );
      wrapped.cause = error;
      throw wrapped;
    }
    created.push({ collection: spec.collection, name: spec.name });
    logger.log(`[phase1e-history-indexes] created ${spec.collection}.${spec.name}`);
  }

  const after = await inspectPhase1EHistoryIndexes({ collections, specs });
  const unsatisfied = after.filter((result) => result.applicationRequired);
  if (unsatisfied.length) {
    throw managementError(
      "PHASE1E_HISTORY_INDEX_VERIFICATION_FAILED",
      "Phase 1E history index verification failed after application.",
      unsatisfied
    );
  }

  return { before, created, after };
};

export const managePhase1EHistoryIndexes = async ({
  mode = "inspect",
  collections,
  specs = PHASE1E_HISTORY_INDEXES,
  logger = console,
} = {}) => {
  if (mode === "inspect") {
    return {
      mode,
      results: await inspectPhase1EHistoryIndexes({ collections, specs }),
      created: [],
    };
  }
  if (mode === "apply") {
    const applied = await applyPhase1EHistoryIndexes({ collections, specs, logger });
    return { mode, results: applied.after, created: applied.created };
  }
  throw managementError(
    "PHASE1E_HISTORY_INDEX_MODE_INVALID",
    "Phase 1E history index mode is invalid."
  );
};
