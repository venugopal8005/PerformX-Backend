import { Activity, ReportRun, Signal } from "../models/index.js";

export const REQUIRED_EXECUTION_INTEGRITY_INDEXES = Object.freeze([
  Object.freeze({
    modelName: "ReportRun",
    field: "execution_key",
    key: Object.freeze({ execution_key: 1 }),
    name: "execution_integrity_execution_key_unique",
  }),
  Object.freeze({
    modelName: "Signal",
    field: "report_run_id",
    key: Object.freeze({ report_run_id: 1 }),
    name: "execution_integrity_report_run_signal_unique",
  }),
  Object.freeze({
    modelName: "Activity",
    field: "idempotency_key",
    key: Object.freeze({ idempotency_key: 1 }),
    name: "execution_integrity_activity_key_unique",
  }),
]);

const defaultModels = { ReportRun, Signal, Activity };

let readiness = {
  ready: false,
  checkedAt: null,
  results: [],
  error: null,
};

const integrityError = (message, code, details = {}) => {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  error.details = details;
  return error;
};

const indexEntries = (key = {}) => Object.entries(key);

const hasExactKey = (index, required) => {
  const actual = indexEntries(index?.key);
  const expected = indexEntries(required.key);
  return (
    actual.length === expected.length &&
    actual.every(([field, direction], position) => {
      const [expectedField, expectedDirection] = expected[position] || [];
      return field === expectedField && direction === expectedDirection;
    })
  );
};

const hasEquivalentPartialBehavior = (index, field) => {
  if (index?.sparse === true) return true;

  const filter = index?.partialFilterExpression;
  if (!filter || Object.keys(filter).length !== 1) return false;

  const condition = filter[field];
  if (
    !condition ||
    typeof condition !== "object" ||
    Array.isArray(condition)
  ) {
    return false;
  }

  const entries = Object.entries(condition);
  return (
    entries.length === 1 &&
    entries[0][0] === "$exists" &&
    entries[0][1] === true
  );
};

export const isRequiredExecutionIntegrityIndex = (index, required) =>
  hasExactKey(index, required) &&
  index?.unique === true &&
  hasEquivalentPartialBehavior(index, required.field);

const readCollectionIndexes = async (collection) => {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error?.code === 26 || error?.codeName === "NamespaceNotFound") return [];
    throw error;
  }
};

const findDuplicateValues = async (collection, field) => {
  const cursor = collection.aggregate(
    [
      { $match: { [field]: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: `$${field}`,
          count: { $sum: 1 },
          sample_ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
      {
        $project: {
          _id: 0,
          count: 1,
          sample_ids: { $slice: ["$sample_ids", 3] },
        },
      },
    ],
    { allowDiskUse: true }
  );
  return cursor.toArray();
};

const safeDuplicateSummary = (duplicates = []) =>
  duplicates.map((duplicate) => ({
    count: duplicate.count,
    sampleDocumentIds: (duplicate.sample_ids || []).map(String),
  }));

export const verifyExecutionIntegrityIndexes = async ({
  models = defaultModels,
} = {}) => {
  const results = [];

  for (const required of REQUIRED_EXECUTION_INTEGRITY_INDEXES) {
    const model = models[required.modelName];
    const collection = model?.collection;
    if (!collection) {
      throw integrityError(
        `Execution integrity model ${required.modelName} is unavailable.`,
        "EXECUTION_INTEGRITY_MODEL_UNAVAILABLE",
        { modelName: required.modelName, field: required.field }
      );
    }

    const existingIndexes = await readCollectionIndexes(collection);
    if (
      existingIndexes.some((index) =>
        isRequiredExecutionIntegrityIndex(index, required)
      )
    ) {
      results.push({
        modelName: required.modelName,
        collection: collection.collectionName,
        field: required.field,
        indexName:
          existingIndexes.find((index) =>
            isRequiredExecutionIntegrityIndex(index, required)
          )?.name || required.name,
        status: "verified",
      });
      continue;
    }

    const duplicates = await findDuplicateValues(collection, required.field);
    if (duplicates.length) {
      throw integrityError(
        `Cannot create the required ${required.modelName}.${required.field} unique index because duplicate values exist.`,
        "EXECUTION_INTEGRITY_DUPLICATES_FOUND",
        {
          modelName: required.modelName,
          collection: collection.collectionName,
          field: required.field,
          duplicateGroupCount: duplicates.length,
          duplicates: safeDuplicateSummary(duplicates),
        }
      );
    }

    try {
      await collection.createIndex(required.key, {
        name: required.name,
        unique: true,
        sparse: true,
      });
    } catch (error) {
      throw integrityError(
        `MongoDB rejected the required ${required.modelName}.${required.field} execution integrity index.`,
        "EXECUTION_INTEGRITY_INDEX_CREATE_FAILED",
        {
          modelName: required.modelName,
          collection: collection.collectionName,
          field: required.field,
          mongoCode: error?.code || null,
          mongoCodeName: error?.codeName || null,
        }
      );
    }

    const verifiedIndexes = await readCollectionIndexes(collection);
    if (
      !verifiedIndexes.some((index) =>
        isRequiredExecutionIntegrityIndex(index, required)
      )
    ) {
      throw integrityError(
        `The required ${required.modelName}.${required.field} index could not be verified after creation.`,
        "EXECUTION_INTEGRITY_INDEX_VERIFICATION_FAILED",
        { modelName: required.modelName, field: required.field }
      );
    }

    results.push({
      modelName: required.modelName,
      collection: collection.collectionName,
      field: required.field,
      indexName: required.name,
      status: "created",
    });
  }

  return results;
};

export const markExecutionIntegrityUnavailable = (error = null) => {
  readiness = {
    ready: false,
    checkedAt: new Date(),
    results: [],
    error: error
      ? { code: error.code || "EXECUTION_INTEGRITY_FAILED", message: error.message }
      : null,
  };
  return getExecutionIntegrityReadiness();
};

export const markExecutionIntegrityReady = (results = []) => {
  readiness = {
    ready: true,
    checkedAt: new Date(),
    results: structuredClone(results),
    error: null,
  };
  return getExecutionIntegrityReadiness();
};

export const getExecutionIntegrityReadiness = () => structuredClone(readiness);

export const assertExecutionIntegrityReady = () => {
  if (readiness.ready) return true;
  throw integrityError(
    "Report execution integrity is unavailable. No report delivery was attempted.",
    "report_execution_integrity_unavailable",
    { readiness: getExecutionIntegrityReadiness() }
  );
};

export const initializeExecutionIntegrity = async ({
  models = defaultModels,
  startScheduler = null,
} = {}) => {
  markExecutionIntegrityUnavailable();
  try {
    const results = await verifyExecutionIntegrityIndexes({ models });
    markExecutionIntegrityReady(results);
    if (startScheduler) await startScheduler();
    return { ready: true, results, error: null };
  } catch (error) {
    markExecutionIntegrityUnavailable(error);
    return { ready: false, results: [], error };
  }
};
