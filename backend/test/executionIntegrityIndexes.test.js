import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import {
  REQUIRED_EXECUTION_INTEGRITY_INDEXES,
  getExecutionIntegrityReadiness,
  initializeExecutionIntegrity,
  isRequiredExecutionIntegrityIndex,
  markExecutionIntegrityUnavailable,
  verifyExecutionIntegrityIndexes,
} from "../src/services/executionIntegrityIndexes.service.js";
import { runExecutionIntegrityVerificationCommand } from "../src/scripts/verifyExecutionIntegrity.js";

const makeCollection = ({
  collectionName,
  indexes = [],
  duplicates = [],
} = {}) => {
  const state = {
    indexes: structuredClone(indexes),
    createCalls: [],
    duplicateQueries: 0,
  };

  return {
    collectionName,
    state,
    async indexes() {
      return structuredClone(state.indexes);
    },
    aggregate() {
      state.duplicateQueries += 1;
      return { toArray: async () => structuredClone(duplicates) };
    },
    async createIndex(key, options) {
      state.createCalls.push({ key: structuredClone(key), options: structuredClone(options) });
      state.indexes.push({ key: structuredClone(key), ...structuredClone(options) });
      return options.name;
    },
  };
};

const makeModels = ({ indexes = {}, duplicates = {} } = {}) => {
  const collections = {};
  for (const required of REQUIRED_EXECUTION_INTEGRITY_INDEXES) {
    collections[required.modelName] = makeCollection({
      collectionName: required.modelName.toLowerCase(),
      indexes: indexes[required.modelName] || [],
      duplicates: duplicates[required.modelName] || [],
    });
  }

  return {
    models: Object.fromEntries(
      Object.entries(collections).map(([modelName, collection]) => [
        modelName,
        { collection },
      ])
    ),
    collections,
  };
};

const requiredIndex = (modelName) =>
  REQUIRED_EXECUTION_INTEGRITY_INDEXES.find((item) => item.modelName === modelName);

beforeEach(() => {
  markExecutionIntegrityUnavailable();
});

test("verifies the exact required ReportRun, Signal, and Activity indexes", async () => {
  const configured = makeModels({
    indexes: Object.fromEntries(
      REQUIRED_EXECUTION_INTEGRITY_INDEXES.map((required) => [
        required.modelName,
        [{
          name: required.name,
          key: required.key,
          unique: true,
          ...(required.partialFilterExpression
            ? { partialFilterExpression: required.partialFilterExpression }
            : { sparse: true }),
        }],
      ])
    ),
  });

  const results = await verifyExecutionIntegrityIndexes({ models: configured.models });

  assert.deepEqual(results.map((result) => result.status), ["verified", "verified", "verified"]);
  for (const collection of Object.values(configured.collections)) {
    assert.equal(collection.state.createCalls.length, 0);
    assert.equal(collection.state.duplicateQueries, 0);
  }
});

test("creates only missing required indexes after duplicate checks", async () => {
  const configured = makeModels();
  const unrelated = { name: "unrelated_index", key: { agency_id: 1 } };
  configured.collections.ReportRun.state.indexes.push(unrelated);

  const results = await verifyExecutionIntegrityIndexes({ models: configured.models });

  assert.deepEqual(results.map((result) => result.status), ["created", "created", "created"]);
  for (const required of REQUIRED_EXECUTION_INTEGRITY_INDEXES) {
    const collection = configured.collections[required.modelName];
    assert.equal(collection.state.createCalls.length, 1);
    assert.deepEqual(collection.state.createCalls[0], {
      key: required.key,
      options: {
        name: required.name,
        unique: true,
        ...(required.partialFilterExpression
          ? { partialFilterExpression: required.partialFilterExpression }
          : { sparse: true }),
      },
    });
    assert.ok(collection.state.indexes.some((index) => isRequiredExecutionIntegrityIndex(index, required)));
    assert.equal(collection.state.duplicateQueries, 1);
  }
  assert.deepEqual(configured.collections.ReportRun.state.indexes[0], unrelated);
});

for (const required of REQUIRED_EXECUTION_INTEGRITY_INDEXES) {
  test(`blocks ${required.modelName} index creation when duplicate values exist`, async () => {
    const configured = makeModels({
      duplicates: {
        [required.modelName]: [{ count: 2, sample_ids: ["doc-1", "doc-2"] }],
      },
    });

    await assert.rejects(
      verifyExecutionIntegrityIndexes({ models: configured.models }),
      (error) =>
        error.code === "EXECUTION_INTEGRITY_DUPLICATES_FOUND" &&
        error.details.modelName === required.modelName &&
        error.details.field === required.field
    );
    assert.equal(configured.collections[required.modelName].state.createCalls.length, 0);
  });
}

test("does not accept a similar non-unique or non-sparse index as sufficient", async () => {
  const reportRun = requiredIndex("ReportRun");
  const signal = requiredIndex("Signal");
  const activity = requiredIndex("Activity");
  const configured = makeModels({
    indexes: {
      ReportRun: [{ name: "wrong_report_run", key: reportRun.key, sparse: true }],
      Signal: [{ name: "wrong_signal", key: signal.key, unique: true }],
      Activity: [{
        name: "partial_activity",
        key: activity.key,
        unique: true,
        partialFilterExpression: { idempotency_key: { $exists: true } },
      }],
    },
  });

  const results = await verifyExecutionIntegrityIndexes({ models: configured.models });

  assert.deepEqual(results.map((result) => result.status), ["created", "created", "verified"]);
  assert.equal(configured.collections.ReportRun.state.indexes.length, 2);
  assert.equal(configured.collections.Signal.state.indexes.length, 2);
  assert.equal(configured.collections.Activity.state.createCalls.length, 0);
});

test("requires the guarded Phase 3 migration when the legacy one-Signal index exists", async () => {
  const configured = makeModels({
    indexes: {
      Signal: [{
        name: "report_run_id_1",
        key: { report_run_id: 1 },
        unique: true,
        sparse: true,
      }],
    },
  });

  await assert.rejects(
    verifyExecutionIntegrityIndexes({ models: configured.models }),
    (error) =>
      error.code === "EXECUTION_INTEGRITY_SIGNAL_INDEX_MIGRATION_REQUIRED" &&
      error.details.indexName === "report_run_id_1"
  );
  assert.equal(configured.collections.Signal.state.createCalls.length, 0);
  assert.equal(configured.collections.Signal.state.duplicateQueries, 0);
});

test("legacy Signal uniqueness blocks readiness even when the new identity index also exists", async () => {
  const signalIdentity = requiredIndex("Signal");
  const configured = makeModels({
    indexes: {
      ReportRun: [{
        key: requiredIndex("ReportRun").key,
        unique: true,
        sparse: true,
      }],
      Signal: [
        {
          name: signalIdentity.name,
          key: signalIdentity.key,
          unique: true,
          partialFilterExpression: signalIdentity.partialFilterExpression,
        },
        {
          name: "report_run_id_1",
          key: { report_run_id: 1 },
          unique: true,
          sparse: true,
        },
      ],
    },
  });

  await assert.rejects(
    verifyExecutionIntegrityIndexes({ models: configured.models }),
    (error) => error.code === "EXECUTION_INTEGRITY_SIGNAL_INDEX_MIGRATION_REQUIRED"
  );
  assert.equal(configured.collections.Signal.state.createCalls.length, 0);
});

test("rejects partial indexes that exclude legitimate execution key values", () => {
  const required = requiredIndex("ReportRun");
  const unsafeConditions = [
    { execution_key: { $ne: "excluded-real-key" } },
    { execution_key: { $type: "string" } },
    { execution_key: { $exists: true, $ne: "excluded-real-key" } },
    {
      execution_key: { $exists: true },
      execution_stage: { $ne: "failed" },
    },
  ];

  for (const partialFilterExpression of unsafeConditions) {
    assert.equal(
      isRequiredExecutionIntegrityIndex(
        {
          key: required.key,
          unique: true,
          partialFilterExpression,
        },
        required
      ),
      false
    );
  }
});

test("accepts only an exact present-field partial predicate as sparse-equivalent", () => {
  const required = requiredIndex("ReportRun");

  assert.equal(
    isRequiredExecutionIntegrityIndex(
      {
        key: required.key,
        unique: true,
        partialFilterExpression: {
          execution_key: { $exists: true },
        },
      },
      required
    ),
    true
  );
});

test("startup failure leaves integrity unavailable and does not start the scheduler", async () => {
  const configured = makeModels({
    duplicates: { ReportRun: [{ count: 2, sample_ids: ["run-1", "run-2"] }] },
  });
  let schedulerStarted = false;

  const result = await initializeExecutionIntegrity({
    models: configured.models,
    startScheduler: async () => {
      schedulerStarted = true;
    },
  });

  assert.equal(result.ready, false);
  assert.equal(schedulerStarted, false);
  assert.equal(getExecutionIntegrityReadiness().ready, false);
});

test("startup starts the scheduler only after all indexes verify", async () => {
  const configured = makeModels();
  let schedulerStarted = false;

  const result = await initializeExecutionIntegrity({
    models: configured.models,
    startScheduler: async () => {
      schedulerStarted = true;
      assert.equal(getExecutionIntegrityReadiness().ready, true);
    },
  });

  assert.equal(result.ready, true);
  assert.equal(schedulerStarted, true);
});

test("manual verification command returns a safe process result", async () => {
  const logs = [];
  let disconnected = false;
  const fakeMongoose = {
    connection: { readyState: 1 },
    async connect() {},
    async disconnect() {
      disconnected = true;
    },
  };
  const code = await runExecutionIntegrityVerificationCommand({
    mongooseInstance: fakeMongoose,
    models: {},
    verify: async () => [{ modelName: "ReportRun", field: "execution_key", status: "verified" }],
    logger: {
      log: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
  });

  assert.equal(code, 0);
  assert.equal(disconnected, true);
  assert.ok(logs.some((message) => message.includes("verified")));
});

test("manual verification command returns non-zero on integrity failure", async () => {
  const errors = [];
  const fakeMongoose = {
    connection: { readyState: 1 },
    async connect() {},
    async disconnect() {},
  };
  const code = await runExecutionIntegrityVerificationCommand({
    mongooseInstance: fakeMongoose,
    models: {},
    verify: async () => {
      const error = new Error("duplicate execution keys");
      error.code = "EXECUTION_INTEGRITY_DUPLICATES_FOUND";
      throw error;
    },
    logger: {
      log() {},
      error: (message) => errors.push(message),
    },
  });

  assert.equal(code, 1);
  assert.match(errors[0], /EXECUTION_INTEGRITY_DUPLICATES_FOUND/);
});
