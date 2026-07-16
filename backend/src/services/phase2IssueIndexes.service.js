import { isDeepStrictEqual } from "node:util";

const spec = ({ collection, name, key, unique = false, partialFilterExpression = null, reason }) =>
  Object.freeze({
    collection,
    name,
    key: Object.freeze({ ...key }),
    unique,
    sparse: false,
    partialFilterExpression: partialFilterExpression
      ? Object.freeze(structuredClone(partialFilterExpression))
      : null,
    reason,
  });

export const PHASE2_ISSUE_INDEXES = Object.freeze([
  spec({
    collection: "issues",
    name: "phase2_issues_active_identity_unique",
    key: { agency_id: 1, client_id: 1, fingerprint_version: 1, active_fingerprint: 1 },
    unique: true,
    partialFilterExpression: { active_fingerprint: { $type: "string" } },
    reason: "One active Issue per canonical fingerprint",
  }),
  spec({ collection: "issues", name: "phase2_issues_fingerprint_history", key: { agency_id: 1, client_id: 1, fingerprint_version: 1, fingerprint: 1, resolved_at: -1, _id: -1 }, reason: "Resolved recurrence lookup" }),
  spec({ collection: "issues", name: "phase2_issues_workspace_cursor", key: { agency_id: 1, last_seen_at: -1, _id: -1 }, reason: "Workspace Issue history" }),
  spec({ collection: "issues", name: "phase2_issues_client_cursor", key: { agency_id: 1, client_id: 1, last_seen_at: -1, _id: -1 }, reason: "Client Issue history" }),
  spec({ collection: "issues", name: "phase2_issues_report_cursor", key: { agency_id: 1, report_ids: 1, last_seen_at: -1, _id: -1 }, reason: "Report Issue history" }),
  spec({ collection: "issues", name: "phase2_issues_status_cursor", key: { agency_id: 1, status: 1, last_seen_at: -1, _id: -1 }, reason: "Issue status filtering" }),
  spec({ collection: "issues", name: "phase2_issues_severity_cursor", key: { agency_id: 1, current_severity: 1, last_seen_at: -1, _id: -1 }, reason: "Issue severity filtering" }),
  spec({ collection: "issues", name: "phase2_issues_account_cursor", key: { agency_id: 1, client_id: 1, meta_ad_account_id: 1, last_seen_at: -1, _id: -1 }, reason: "Meta account Issue history" }),
  spec({ collection: "signals", name: "phase2_signals_issue_cursor", key: { agency_id: 1, issue_id: 1, detected_at: -1, _id: -1 }, reason: "Signal occurrences for an Issue" }),
  spec({
    collection: "signals",
    name: "phase2_signals_issue_occurrence_unique",
    key: { issue_id: 1, issue_occurrence_number: 1 },
    unique: true,
    partialFilterExpression: {
      issue_id: { $type: "objectId" },
      issue_occurrence_number: { $type: "number" },
    },
    reason: "Unique occurrence number within an Issue",
  }),
]);

export const PHASE2_CRITICAL_INDEX_NAMES = Object.freeze([
  "phase2_issues_active_identity_unique",
  "phase2_signals_issue_occurrence_unique",
]);

export const normalizePhase2OrderedIndexKey = (value = {}) => {
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

export const hasExactPhase2IndexKey = (actual, expected) =>
  isDeepStrictEqual(
    normalizePhase2OrderedIndexKey(actual),
    normalizePhase2OrderedIndexKey(expected)
  );

const normalizedPartial = (value) => value || null;
const benignInventoryFields = new Set(["key", "name", "ns", "v"]);
const semanticOptionFields = new Set([
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
const unexpectedSemanticOptions = (index = {}) =>
  Object.keys(index).filter(
    (field) =>
      !benignInventoryFields.has(field) && !semanticOptionFields.has(field)
  );

export const hasExactPhase2IndexOptions = (actual = {}, expected = {}) =>
  (actual.unique === true) === (expected.unique === true) &&
  (actual.sparse === true) === (expected.sparse === true) &&
  isDeepStrictEqual(
    normalizedPartial(actual.partialFilterExpression),
    normalizedPartial(expected.partialFilterExpression)
  ) &&
  absentOrFalse(actual.hidden) &&
  absent(actual.collation) &&
  absent(actual.expireAfterSeconds) &&
  absent(actual.wildcardProjection) &&
  absentOrFalse(actual.background) &&
  absent(actual.storageEngine) &&
  unexpectedSemanticOptions(actual).length === 0;

const readIndexes = async (collection) => {
  try {
    if (typeof collection?.listIndexes === "function") {
      return await collection.listIndexes().toArray();
    }
    if (typeof collection?.indexes === "function") return await collection.indexes();
    throw new Error("Collection does not expose index metadata.");
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
};

const collectionFor = (collections, name) =>
  collections instanceof Map ? collections.get(name) : collections?.[name];

export const classifyPhase2IssueIndex = (expected, indexes = []) => {
  const named = indexes.find((index) => index.name === expected.name);
  if (named) {
    const keyExact = hasExactPhase2IndexKey(named.key, expected.key);
    const optionsExact = hasExactPhase2IndexOptions(named, expected);
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
      hasExactPhase2IndexKey(index.key, expected.key) &&
      hasExactPhase2IndexOptions(index, expected)
  );
  if (equivalent) {
    return {
      classification: "equivalent_different_name",
      keyExact: true,
      optionsExact: true,
      matchingIndexName: equivalent.name,
      applicationRequired: false,
    };
  }
  const sameKey = indexes.find((index) => hasExactPhase2IndexKey(index.key, expected.key));
  return {
    classification: sameKey ? "wrong_options" : "missing",
    keyExact: Boolean(sameKey),
    optionsExact: false,
    matchingIndexName: sameKey?.name || null,
    applicationRequired: true,
  };
};

export const inspectPhase2IssueIndexes = async ({
  collections,
  specs = PHASE2_ISSUE_INDEXES,
} = {}) => {
  const inventory = new Map();
  const results = [];
  for (const expected of specs) {
    const collection = collectionFor(collections, expected.collection);
    if (!collection) {
      const error = new Error(`Phase 2 collection ${expected.collection} is unavailable.`);
      error.code = "PHASE2_ISSUE_COLLECTION_UNAVAILABLE";
      throw error;
    }
    if (!inventory.has(expected.collection)) {
      inventory.set(expected.collection, await readIndexes(collection));
    }
    results.push({
      collection: expected.collection,
      expectedName: expected.name,
      expectedKey: expected.key,
      expectedOptions: {
        unique: expected.unique,
        sparse: expected.sparse,
        partialFilterExpression: expected.partialFilterExpression,
      },
      reason: expected.reason,
      ...classifyPhase2IssueIndex(expected, inventory.get(expected.collection)),
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

export const applyPhase2IssueIndexes = async ({
  collections,
  specs = PHASE2_ISSUE_INDEXES,
  logger = console,
} = {}) => {
  const before = await inspectPhase2IssueIndexes({ collections, specs });
  const conflicts = before.filter((result) =>
    ["name_conflict", "wrong_options"].includes(
      result.classification
    )
  );
  if (conflicts.length) {
    throw managementError(
      "PHASE2_ISSUE_INDEX_CONFLICT",
      "Phase 2 Issue indexes contain conflicts requiring manual review.",
      conflicts
    );
  }

  const created = [];
  for (const result of before) {
    if (result.classification !== "missing") continue;
    const expected = specs.find(
      (candidate) =>
        candidate.collection === result.collection &&
        candidate.name === result.expectedName
    );
    const collection = collectionFor(collections, expected.collection);
    logger.log(`[phase2-issue-indexes] creating ${expected.collection}.${expected.name}`);
    await collection.createIndex(expected.key, {
      name: expected.name,
      unique: expected.unique,
      sparse: expected.sparse,
      ...(expected.partialFilterExpression
        ? { partialFilterExpression: expected.partialFilterExpression }
        : {}),
    });
    created.push({ collection: expected.collection, name: expected.name });
  }

  const after = await inspectPhase2IssueIndexes({ collections, specs });
  const unsatisfied = after.filter((result) => result.applicationRequired);
  if (unsatisfied.length) {
    throw managementError(
      "PHASE2_ISSUE_INDEX_VERIFICATION_FAILED",
      "Phase 2 Issue index verification failed after application.",
      unsatisfied
    );
  }
  return { before, created, after };
};

export const managePhase2IssueIndexes = async ({
  mode = "inspect",
  collections,
  specs = PHASE2_ISSUE_INDEXES,
  logger = console,
} = {}) => {
  if (mode === "inspect") {
    return {
      mode,
      results: await inspectPhase2IssueIndexes({ collections, specs }),
      created: [],
    };
  }
  if (mode === "apply") {
    const applied = await applyPhase2IssueIndexes({ collections, specs, logger });
    return { mode, results: applied.after, created: applied.created };
  }
  throw managementError("PHASE2_ISSUE_INDEX_MODE_INVALID", "Phase 2 index mode is invalid.");
};

const initialReadiness = () => ({
  state: "uninitialized",
  ready: false,
  checkedAt: null,
  results: [],
  failureCode: null,
});

let readiness = initialReadiness();

const blockPhase2IssueIntegrity = ({ results = [], failureCode }) => {
  readiness = {
    state: "blocked",
    ready: false,
    checkedAt: new Date(),
    results,
    failureCode: failureCode || "ISSUE_INDEXES_NOT_READY",
  };
};

export const initializePhase2IssueIntegrity = async ({ collections } = {}) => {
  blockPhase2IssueIntegrity({ failureCode: "ISSUE_INDEX_VERIFICATION_IN_PROGRESS" });
  try {
    const results = await inspectPhase2IssueIndexes({ collections });
    const critical = results.filter((result) =>
      PHASE2_CRITICAL_INDEX_NAMES.includes(result.expectedName)
    );
    const ready =
      critical.length === PHASE2_CRITICAL_INDEX_NAMES.length &&
      critical.every((result) => !result.applicationRequired);
    if (!ready) {
      blockPhase2IssueIntegrity({
        results: critical,
        failureCode: "ISSUE_INDEXES_NOT_READY",
      });
      return getPhase2IssueIntegrityReadiness();
    }
    readiness = {
      state: "ready",
      ready: true,
      checkedAt: new Date(),
      results: critical,
      failureCode: null,
    };
    return getPhase2IssueIntegrityReadiness();
  } catch (error) {
    blockPhase2IssueIntegrity({
      failureCode: error?.code || "ISSUE_INDEX_VERIFICATION_FAILED",
    });
    throw error;
  }
};

export const resetPhase2IssueIntegrityReadiness = () => {
  readiness = initialReadiness();
};

export const getPhase2IssueIntegrityReadiness = () => structuredClone(readiness);

export const assertPhase2IssueIntegrityReady = () => {
  if (readiness.state === "ready" && readiness.ready) return true;
  const error = new Error("Phase 2 Issue integrity indexes are not ready.");
  error.code = "ISSUE_INDEXES_NOT_READY";
  error.status = 503;
  error.issueIntegrityFailure = true;
  error.readinessState = readiness.state;
  throw error;
};
