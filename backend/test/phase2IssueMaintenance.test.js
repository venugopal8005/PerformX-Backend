import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PHASE2_ISSUE_INDEXES,
  applyPhase2IssueIndexes,
  assertPhase2IssueIntegrityReady,
  getPhase2IssueIntegrityReadiness,
  initializePhase2IssueIntegrity,
  inspectPhase2IssueIndexes,
  managePhase2IssueIndexes,
  resetPhase2IssueIntegrityReadiness,
} from "../src/services/phase2IssueIndexes.service.js";
import { runPhase2IssueIndexCommand } from "../src/scripts/applyPhase2IssueIndexes.js";
import { runPhase2IssueMigrationCommand } from "../src/scripts/migratePhase2Issues.js";

const exact = (spec, name = spec.name) => ({
  name,
  key: { ...spec.key },
  unique: spec.unique,
  sparse: false,
  ...(spec.partialFilterExpression
    ? { partialFilterExpression: structuredClone(spec.partialFilterExpression) }
    : {}),
});

const collectionsFor = ({ indexes = {}, persist = true, delay = false } = {}) => {
  const collections = {};
  const state = { creates: [], drops: 0, active: 0, maxActive: 0 };
  for (const name of new Set(PHASE2_ISSUE_INDEXES.map((item) => item.collection))) {
    const inventory = structuredClone(indexes[name] || []);
    collections[name] = {
      listIndexes() { return { toArray: async () => structuredClone(inventory) }; },
      async createIndex(key, options) {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        state.creates.push(options.name);
        if (delay) await new Promise((resolve) => setTimeout(resolve, 1));
        if (persist) inventory.push({ key: structuredClone(key), ...structuredClone(options) });
        state.active -= 1;
      },
      async dropIndex() { state.drops += 1; throw new Error("must not drop"); },
    };
  }
  return { collections, state };
};

const allExact = () => PHASE2_ISSUE_INDEXES.reduce((result, item) => {
  result[item.collection] ||= [];
  result[item.collection].push(exact(item));
  return result;
}, {});

test("Phase 2 index inspection is read-only and exact inventory is ready", async () => {
  const setup = collectionsFor({ indexes: allExact() });
  const result = await managePhase2IssueIndexes({ mode: "inspect", collections: setup.collections });
  assert.equal(result.results.every((item) => item.classification === "exact_match"), true);
  assert.deepEqual(setup.state.creates, []);
  assert.equal(setup.state.drops, 0);
});

test("Phase 2 apply creates only missing indexes sequentially and is idempotent", async () => {
  const setup = collectionsFor({ delay: true });
  const first = await applyPhase2IssueIndexes({ collections: setup.collections, logger: { log() {} } });
  assert.equal(first.created.length, 10);
  assert.equal(setup.state.maxActive, 1);
  assert.equal(setup.state.drops, 0);
  const second = await applyPhase2IssueIndexes({ collections: setup.collections, logger: { log() {} } });
  assert.equal(second.created.length, 0);
});

test("conflicting name, options, and key order fail closed while exact equivalent names satisfy", async () => {
  const target = PHASE2_ISSUE_INDEXES[0];
  for (const bad of [
    { ...exact(target), key: Object.fromEntries(Object.entries(target.key).reverse()) },
    { ...exact(target), unique: false },
  ]) {
    const setup = collectionsFor({ indexes: { issues: [bad] } });
    await assert.rejects(
      applyPhase2IssueIndexes({ collections: setup.collections, logger: { log() {} } }),
      (error) => error.code === "PHASE2_ISSUE_INDEX_CONFLICT"
    );
    assert.deepEqual(setup.state.creates, []);
  }
  const equivalent = collectionsFor({
    indexes: { issues: [exact(target, "equivalent-name")] },
  });
  const result = await inspectPhase2IssueIndexes({
    collections: equivalent.collections,
    specs: [target],
  });
  assert.equal(result[0].classification, "equivalent_different_name");
  assert.equal(result[0].applicationRequired, false);
});

test("Phase 2 index semantics reject every material or unknown option before creation", async () => {
  const target = PHASE2_ISSUE_INDEXES[0];
  const incompatibleOptions = [
    { background: true },
    { wildcardProjection: { agency_id: 1 } },
    { storageEngine: { wiredTiger: {} } },
    { expireAfterSeconds: 0 },
    { hidden: true },
    { collation: { locale: "en" } },
    { unexpectedSemanticOption: true },
  ];
  for (const options of incompatibleOptions) {
    for (const name of [target.name, "different-name"]) {
      const setup = collectionsFor({
        indexes: { issues: [{ ...exact(target, name), ...options }] },
      });
      await assert.rejects(
        applyPhase2IssueIndexes({
          collections: setup.collections,
          specs: [target],
          logger: { log() {} },
        }),
        (error) => error.code === "PHASE2_ISSUE_INDEX_CONFLICT"
      );
      assert.deepEqual(setup.state.creates, []);
    }
  }
  const compatible = collectionsFor({
    indexes: { issues: [{ ...exact(target), background: false, hidden: false }] },
  });
  const inspected = await inspectPhase2IssueIndexes({
    collections: compatible.collections,
    specs: [target],
  });
  assert.equal(inspected[0].classification, "exact_match");
});

test("Issue readiness is explicit, fail-closed, and stale ready state cannot survive verification failure", async () => {
  resetPhase2IssueIntegrityReadiness();
  assert.equal(getPhase2IssueIntegrityReadiness().state, "uninitialized");
  assert.throws(
    () => assertPhase2IssueIntegrityReady(),
    (error) => error.code === "ISSUE_INDEXES_NOT_READY"
  );

  const missing = collectionsFor();
  const blocked = await initializePhase2IssueIntegrity({ collections: missing.collections });
  assert.equal(blocked.state, "blocked");
  assert.throws(() => assertPhase2IssueIntegrityReady(), /not ready/);

  const readySetup = collectionsFor({ indexes: allExact() });
  const ready = await initializePhase2IssueIntegrity({ collections: readySetup.collections });
  assert.equal(ready.state, "ready");
  assert.equal(assertPhase2IssueIntegrityReady(), true);

  const failedCollections = {
    issues: { listIndexes: () => ({ toArray: async () => { throw new Error("inspection failed"); } }) },
    signals: readySetup.collections.signals,
  };
  await assert.rejects(
    initializePhase2IssueIntegrity({ collections: failedCollections }),
    /inspection failed/
  );
  assert.equal(getPhase2IssueIntegrityReadiness().state, "blocked");
  assert.throws(() => assertPhase2IssueIntegrityReady(), /not ready/);
  resetPhase2IssueIntegrityReadiness();
});

test("post-apply exact verification catches non-persisted create results", async () => {
  const setup = collectionsFor({ persist: false });
  await assert.rejects(
    applyPhase2IssueIndexes({ collections: setup.collections, logger: { log() {} } }),
    (error) => error.code === "PHASE2_ISSUE_INDEX_VERIFICATION_FAILED"
  );
});

test("invalid index CLI performs zero database connections", async () => {
  let connections = 0;
  const fakeMongoose = { connect: async () => { connections += 1; } };
  await assert.rejects(
    runPhase2IssueIndexCommand({ argv: ["--apply", "--inspect"], env: { MONGO_URI: "redacted" }, mongooseInstance: fakeMongoose }),
    (error) => error.code === "PHASE2_ISSUE_INDEX_CLI_INVALID"
  );
  assert.equal(connections, 0);
});

test("invalid migration CLI performs zero database connections", async () => {
  let connections = 0;
  const fakeMongoose = { connect: async () => { connections += 1; } };
  await assert.rejects(
    runPhase2IssueMigrationCommand({ argv: ["--apply", "--expected-eligible=1"], env: { MONGO_URI: "redacted" }, mongooseInstance: fakeMongoose }),
    (error) => error.code === "PHASE2_ISSUE_MIGRATION_CLI_INVALID"
  );
  assert.equal(connections, 0);
});

test("inspection reports missing namespaces without creating them", async () => {
  const collection = {
    listIndexes() {
      return { toArray: async () => { const error = new Error("missing"); error.code = 26; throw error; } };
    },
  };
  const results = await inspectPhase2IssueIndexes({
    collections: { issues: collection, signals: collection },
  });
  assert.equal(results.every((item) => item.classification === "missing"), true);
});
