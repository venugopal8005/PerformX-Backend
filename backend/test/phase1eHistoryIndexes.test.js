import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Activity, Report, Signal } from "../src/models/index.js";
import {
  PHASE1E_HISTORY_INDEXES,
  applyPhase1EHistoryIndexes,
  classifyPhase1EHistoryIndex,
  hasExactHistoryIndexOptions,
  hasExactIndexKey,
  inspectPhase1EHistoryIndexes,
  managePhase1EHistoryIndexes,
  normalizeOrderedIndexKey,
} from "../src/services/phase1eHistoryIndexes.service.js";
import { REQUIRED_EXECUTION_INTEGRITY_INDEXES } from "../src/services/executionIntegrityIndexes.service.js";
import {
  connectMongooseWithIndexManagementDisabled,
  MONGOOSE_CONNECTION_OPTIONS,
} from "../src/services/mongooseConnection.service.js";
import {
  parsePhase1EHistoryIndexMode,
  runPhase1EHistoryIndexCommand,
} from "../src/scripts/applyPhase1EHistoryIndexes.js";

const expectedDefinitions = [
  ["phase1e_reports_client_archived_cursor", { agency_id: 1, client_id: 1, is_archived: 1, archived_at: -1, _id: -1 }],
  ["phase1e_signals_workspace_cursor", { agency_id: 1, detected_at: -1, _id: -1 }],
  ["phase1e_signals_type_cursor", { agency_id: 1, type: 1, detected_at: -1, _id: -1 }],
  ["phase1e_signals_severity_cursor", { agency_id: 1, severity: 1, detected_at: -1, _id: -1 }],
  ["phase1e_activities_workspace_cursor", { agency_id: 1, createdAt: -1, _id: -1 }],
  ["phase1e_activities_actor_cursor", { agency_id: 1, user_id: 1, createdAt: -1, _id: -1 }],
  ["phase1e_activities_type_cursor", { agency_id: 1, type: 1, createdAt: -1, _id: -1 }],
  ["phase1e_activities_severity_cursor", { agency_id: 1, severity: 1, createdAt: -1, _id: -1 }],
];

const exactIndex = (spec, { name = spec.name, ...overrides } = {}) => ({
  name,
  key: spec.key,
  unique: false,
  sparse: false,
  ...overrides,
});

const makeCollection = ({
  name,
  indexes = [],
  createOrder,
  failOnName,
  persistCreates = true,
} = {}) => {
  const state = {
    indexes: structuredClone(indexes),
    listCalls: 0,
    createCalls: [],
    dropCalls: [],
    activeCreates: 0,
    maxConcurrentCreates: 0,
  };
  return {
    collectionName: name,
    state,
    listIndexes() {
      state.listCalls += 1;
      return { toArray: async () => structuredClone(state.indexes) };
    },
    async createIndex(key, options) {
      state.activeCreates += 1;
      state.maxConcurrentCreates = Math.max(
        state.maxConcurrentCreates,
        state.activeCreates
      );
      state.createCalls.push({ key: structuredClone(key), options: structuredClone(options) });
      createOrder?.push(options.name);
      await Promise.resolve();
      state.activeCreates -= 1;
      if (options.name === failOnName) throw new Error("simulated create failure");
      if (persistCreates) {
        state.indexes.push({ key: structuredClone(key), ...structuredClone(options) });
      }
      return options.name;
    },
    async dropIndex(nameToDrop) {
      state.dropCalls.push(nameToDrop);
      throw new Error("dropIndex must never be called");
    },
  };
};

const makeCollections = ({
  indexes = {},
  createOrder = [],
  failOnName,
  persistCreates = true,
} = {}) => {
  const collections = {};
  for (const name of new Set(PHASE1E_HISTORY_INDEXES.map((spec) => spec.collection))) {
    collections[name] = makeCollection({
      name,
      indexes: indexes[name] || [],
      createOrder,
      failOnName,
      persistCreates,
    });
  }
  return { collections, createOrder };
};

const indexesByCollection = (specs = PHASE1E_HISTORY_INDEXES) =>
  specs.reduce((result, spec) => {
    result[spec.collection] ||= [];
    result[spec.collection].push(exactIndex(spec));
    return result;
  }, {});

test("canonical Phase 1E specification contains exactly the eight ordered non-destructive indexes", () => {
  assert.equal(PHASE1E_HISTORY_INDEXES.length, 8);
  assert.deepEqual(
    PHASE1E_HISTORY_INDEXES.map((spec) => [spec.name, spec.key]),
    expectedDefinitions
  );
  for (const spec of PHASE1E_HISTORY_INDEXES) {
    assert.equal(spec.unique, false);
    assert.equal(spec.sparse, false);
    assert.equal("partialFilterExpression" in spec, false);
  }
});

test("exact key comparison rejects compound key order changes", () => {
  const spec = PHASE1E_HISTORY_INDEXES[1];
  assert.equal(hasExactIndexKey(spec.key, spec.key), true);
  assert.equal(
    hasExactIndexKey({ detected_at: -1, agency_id: 1, _id: -1 }, spec.key),
    false
  );
});

test("ordered key normalization supports objects, Maps, and entry arrays", () => {
  const key = PHASE1E_HISTORY_INDEXES[2].key;
  const entries = Object.entries(key);
  const map = new Map(entries);
  const reversedEntries = [entries[1], entries[0], ...entries.slice(2)];

  assert.deepEqual(normalizeOrderedIndexKey(map), entries);
  assert.equal(hasExactIndexKey(map, key), true);
  assert.equal(hasExactIndexKey(entries, key), true);
  assert.equal(hasExactIndexKey(Object.fromEntries(reversedEntries), key), false);
  assert.equal(hasExactIndexKey(new Map(reversedEntries), key), false);
  assert.equal(hasExactIndexKey(reversedEntries, key), false);
  assert.equal(hasExactIndexKey(Object.fromEntries(entries.slice(0, -1)), key), false);
  assert.equal(hasExactIndexKey(Object.fromEntries([...entries, ["extra", 1]]), key), false);
  assert.equal(
    hasExactIndexKey(
      Object.fromEntries(
        entries.map(([field, direction], index) => [
          field,
          index === 0 ? -direction : direction,
        ])
      ),
      key
    ),
    false
  );
  assert.equal(
    hasExactIndexKey({ ...key, agency_id: { direction: 1 } }, key),
    false
  );
  assert.equal(
    hasExactIndexKey(new Map([[null, 1], ...entries.slice(1)]), key),
    false
  );
  assert.equal(
    hasExactIndexKey([...entries.slice(0, -1), ["malformed"]], key),
    false
  );
});

test("inspection classifies exact, equivalent, missing, wrong key, and wrong option inventories", async () => {
  const spec = PHASE1E_HISTORY_INDEXES[1];
  assert.equal(classifyPhase1EHistoryIndex(spec, [exactIndex(spec)]).classification, "exact_match");
  assert.equal(
    classifyPhase1EHistoryIndex(spec, [exactIndex(spec, { name: "equivalent" })]).classification,
    "equivalent_different_name"
  );
  assert.equal(classifyPhase1EHistoryIndex(spec, []).classification, "missing");
  const wrongKeys = classifyPhase1EHistoryIndex(spec, [
    { name: spec.name, key: { agency_id: 1 } },
  ]);
  assert.equal(wrongKeys.classification, "name_conflict");
  assert.equal(wrongKeys.issue, "wrong_keys");

  const wrongOptions = classifyPhase1EHistoryIndex(spec, [
    exactIndex(spec, { unique: true }),
  ]);
  assert.equal(wrongOptions.classification, "name_conflict");
  assert.equal(wrongOptions.issue, "wrong_options");
  assert.equal(hasExactHistoryIndexOptions({ key: spec.key, sparse: true }), false);

  const reversed = { _id: -1, detected_at: -1, agency_id: 1 };
  assert.equal(
    classifyPhase1EHistoryIndex(spec, [{ name: "wrong_order", key: reversed }]).classification,
    "wrong_keys"
  );

  const configured = makeCollections({ indexes: indexesByCollection() });
  const results = await inspectPhase1EHistoryIndexes({ collections: configured.collections });
  assert.equal(results.every((result) => result.classification === "exact_match"), true);
});

test("semantic option comparison rejects incompatible behavior and ignores benign metadata", async () => {
  const spec = PHASE1E_HISTORY_INDEXES[1];
  const equivalent = exactIndex(spec, {
    name: "equivalent_with_metadata",
    hidden: false,
    background: false,
    v: 2,
    ns: "test.signals",
  });
  assert.equal(
    classifyPhase1EHistoryIndex(spec, [equivalent]).classification,
    "equivalent_different_name"
  );

  for (const incompatible of [
    { unique: true },
    { sparse: true },
    { partialFilterExpression: { agency_id: { $exists: true } } },
    { hidden: true },
    { collation: { locale: "en" } },
    { expireAfterSeconds: 3600 },
    { expireAfterSeconds: 0 },
    { wildcardProjection: { agency_id: 1 } },
    { background: true },
    { storageEngine: { wiredTiger: {} } },
  ]) {
    const sameName = classifyPhase1EHistoryIndex(spec, [
      exactIndex(spec, incompatible),
    ]);
    assert.equal(sameName.classification, "name_conflict");
    assert.equal(sameName.issue, "wrong_options");

    const differentName = classifyPhase1EHistoryIndex(spec, [
      exactIndex(spec, { name: "incompatible", ...incompatible }),
    ]);
    assert.equal(differentName.classification, "wrong_options");
  }

  const configured = makeCollections({
    indexes: {
      [spec.collection]: [
        exactIndex(spec, { storageEngine: { wiredTiger: {} } }),
      ],
    },
  });
  await assert.rejects(
    applyPhase1EHistoryIndexes({
      collections: configured.collections,
      logger: { log() {} },
    }),
    (error) => error.code === "PHASE1E_HISTORY_INDEX_CONFLICT"
  );
  assert.equal(configured.createOrder.length, 0);
});

test("application connection wiring disables automatic indexes and preserves explicit integrity startup", async () => {
  let capturedUri = null;
  let capturedOptions = null;
  const fakeMongoose = {
    async connect(uri, options) {
      capturedUri = uri;
      capturedOptions = options;
    },
  };

  await connectMongooseWithIndexManagementDisabled({
    mongooseInstance: fakeMongoose,
    uri: "mongodb://redacted.invalid/test",
  });
  assert.equal(capturedUri, "mongodb://redacted.invalid/test");
  assert.deepEqual(capturedOptions, { autoIndex: false, autoCreate: false });
  assert.equal(MONGOOSE_CONNECTION_OPTIONS.autoIndex, false);
  assert.equal(MONGOOSE_CONNECTION_OPTIONS.autoCreate, false);

  const serverSource = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(serverSource, /connectMongooseWithIndexManagementDisabled\s*\(\s*\{/);
  assert.match(serverSource, /initializeExecutionIntegrity\s*\(\s*\{/);
});

test("default and explicit inspect modes are read-only", async () => {
  const configured = makeCollections();
  assert.equal(parsePhase1EHistoryIndexMode([]), "inspect");
  assert.equal(parsePhase1EHistoryIndexMode(["--inspect"]), "inspect");
  assert.equal(parsePhase1EHistoryIndexMode(["--apply"]), "apply");

  await managePhase1EHistoryIndexes({ collections: configured.collections });
  await managePhase1EHistoryIndexes({ mode: "inspect", collections: configured.collections });
  for (const collection of Object.values(configured.collections)) {
    assert.equal(collection.state.createCalls.length, 0);
    assert.equal(collection.state.dropCalls.length, 0);
  }
});

test("apply creates only missing indexes sequentially and verifies the final inventory", async () => {
  const first = PHASE1E_HISTORY_INDEXES[0];
  const second = PHASE1E_HISTORY_INDEXES[1];
  const configured = makeCollections({
    indexes: {
      [first.collection]: [exactIndex(first)],
      [second.collection]: [exactIndex(second, { name: "already_equivalent" })],
    },
  });
  const result = await applyPhase1EHistoryIndexes({
    collections: configured.collections,
    logger: { log() {} },
  });

  assert.equal(result.created.length, 6);
  assert.deepEqual(
    configured.createOrder,
    PHASE1E_HISTORY_INDEXES.slice(2).map((spec) => spec.name)
  );
  assert.equal(result.after.every((item) => item.applicationRequired === false), true);
  for (const collection of Object.values(configured.collections)) {
    assert.equal(collection.state.maxConcurrentCreates <= 1, true);
    assert.equal(collection.state.dropCalls.length, 0);
  }
});

test("apply refuses conflicts without creating or replacing indexes", async () => {
  const spec = PHASE1E_HISTORY_INDEXES[0];
  const configured = makeCollections({
    indexes: { [spec.collection]: [{ name: spec.name, key: { agency_id: 1 } }] },
  });
  await assert.rejects(
    applyPhase1EHistoryIndexes({
      collections: configured.collections,
      logger: { log() {} },
    }),
    (error) => error.code === "PHASE1E_HISTORY_INDEX_CONFLICT"
  );
  assert.equal(configured.createOrder.length, 0);
});

test("a creation failure stops all later index creation", async () => {
  const failureName = PHASE1E_HISTORY_INDEXES[2].name;
  const configured = makeCollections({ failOnName: failureName });
  await assert.rejects(
    applyPhase1EHistoryIndexes({
      collections: configured.collections,
      logger: { log() {} },
    }),
    (error) => error.code === "PHASE1E_HISTORY_INDEX_CREATE_FAILED"
  );
  assert.deepEqual(
    configured.createOrder,
    PHASE1E_HISTORY_INDEXES.slice(0, 3).map((spec) => spec.name)
  );
});

test("repeated, mixed, positional, and unknown CLI arguments fail before connection", async () => {
  let connectCalls = 0;
  const configured = makeCollections();
  const fakeMongoose = {
    connection: {
      readyState: 0,
      db: { collection: (name) => configured.collections[name] },
    },
    async connect() {
      connectCalls += 1;
      this.connection.readyState = 1;
    },
    async disconnect() {
      this.connection.readyState = 0;
    },
  };
  for (const argv of [
    ["--inspect", "--inspect"],
    ["--apply", "--apply"],
    ["--inspect", "--apply"],
    ["--apply", "--inspect"],
    ["--apply", "--unknown"],
    ["positional"],
    ["--unknown"],
    [""],
  ]) {
    const exitCode = await runPhase1EHistoryIndexCommand({
      argv,
      env: { MONGO_URI: "mongodb://redacted.invalid/test" },
      mongooseInstance: fakeMongoose,
      logger: { log() {}, error() {} },
    });
    assert.equal(exitCode, 1);
  }
  assert.equal(connectCalls, 0);
  assert.equal(configured.createOrder.length, 0);
  assert.equal(
    Object.values(configured.collections).every(
      (collection) => collection.state.createCalls.length === 0
    ),
    true
  );
});

test("CLI disconnects after a managed failure and disables automatic index creation", async () => {
  let disconnected = false;
  let connectOptions = null;
  const configured = makeCollections();
  const fakeMongoose = {
    connection: {
      readyState: 0,
      db: { collection: (name) => configured.collections[name] },
    },
    async connect(_uri, options) {
      connectOptions = options;
      this.connection.readyState = 1;
    },
    async disconnect() {
      disconnected = true;
      this.connection.readyState = 0;
    },
  };
  const exitCode = await runPhase1EHistoryIndexCommand({
    argv: ["--inspect"],
    env: { MONGO_URI: "mongodb://redacted.invalid/test" },
    mongooseInstance: fakeMongoose,
    manage: async () => {
      throw Object.assign(new Error("simulated failure"), { code: "SIMULATED" });
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(connectOptions, { autoIndex: false, autoCreate: false });
  assert.equal(disconnected, true);
});

test("CLI disconnects after a successful read-only inspection", async () => {
  let disconnected = false;
  const configured = makeCollections({ indexes: indexesByCollection() });
  const fakeMongoose = {
    connection: {
      readyState: 0,
      db: { collection: (name) => configured.collections[name] },
    },
    async connect() {
      this.connection.readyState = 1;
    },
    async disconnect() {
      disconnected = true;
      this.connection.readyState = 0;
    },
  };

  const exitCode = await runPhase1EHistoryIndexCommand({
    argv: ["--inspect"],
    env: { MONGO_URI: "mongodb://redacted.invalid/test" },
    mongooseInstance: fakeMongoose,
    logger: { log() {}, error() {} },
  });

  assert.equal(exitCode, 0);
  assert.equal(disconnected, true);
  for (const collection of Object.values(configured.collections)) {
    assert.equal(collection.state.createCalls.length, 0);
    assert.equal(collection.state.dropCalls.length, 0);
  }
});

test("post-apply verification failure returns failure and disconnects without rollback claims", async () => {
  let disconnected = false;
  const logs = [];
  const errors = [];
  const configured = makeCollections({ persistCreates: false });
  const fakeMongoose = {
    connection: {
      readyState: 0,
      db: { collection: (name) => configured.collections[name] },
    },
    async connect() {
      this.connection.readyState = 1;
    },
    async disconnect() {
      disconnected = true;
      this.connection.readyState = 0;
    },
  };

  const exitCode = await runPhase1EHistoryIndexCommand({
    argv: ["--apply"],
    env: { MONGO_URI: "mongodb://redacted.invalid/test" },
    mongooseInstance: fakeMongoose,
    logger: {
      log(message) { logs.push(message); },
      error(message) { errors.push(message); },
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(disconnected, true);
  assert.equal(configured.createOrder.length, PHASE1E_HISTORY_INDEXES.length);
  assert.equal(
    Object.values(configured.collections).every(
      (collection) => collection.state.listCalls >= 2
    ),
    true
  );
  assert.equal(errors.some((message) => message.includes("PHASE1E_HISTORY_INDEX_VERIFICATION_FAILED")), true);
  assert.equal(logs.some((message) => message.includes("complete mode=apply")), false);
  assert.equal([...logs, ...errors].some((message) => /rollback/i.test(message)), false);
});

test("schema declarations exactly match every canonical specification", () => {
  const models = { reports: Report, signals: Signal, activities: Activity };
  for (const spec of PHASE1E_HISTORY_INDEXES) {
    const declaration = models[spec.collection].schema
      .indexes()
      .find(([, options]) => options.name === spec.name);
    assert.ok(declaration, spec.name);
    assert.deepEqual(declaration[0], spec.key);
    assert.equal(declaration[1].unique, false);
    assert.equal(declaration[1].sparse, false);
    assert.equal("partialFilterExpression" in declaration[1], false);
  }
});

test("execution-integrity index definitions remain unchanged", () => {
  assert.deepEqual(
    REQUIRED_EXECUTION_INTEGRITY_INDEXES.map(({ modelName, field, key, name }) => ({
      modelName,
      field,
      key,
      name,
    })),
    [
      { modelName: "ReportRun", field: "execution_key", key: { execution_key: 1 }, name: "execution_integrity_execution_key_unique" },
      { modelName: "Signal", field: "report_run_id", key: { report_run_id: 1 }, name: "execution_integrity_report_run_signal_unique" },
      { modelName: "Activity", field: "idempotency_key", key: { idempotency_key: 1 }, name: "execution_integrity_activity_key_unique" },
    ]
  );
});
