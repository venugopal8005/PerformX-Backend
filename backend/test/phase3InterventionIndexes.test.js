import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PHASE3_INTERVENTION_INDEXES,
  applyPhase3InterventionIndexes,
  assertPhase3InterventionIntegrityReady,
  initializePhase3InterventionIntegrity,
  managePhase3InterventionIndexes,
  resetPhase3InterventionIntegrityReadiness,
} from "../src/services/phase3InterventionIndexes.service.js";
import {
  parsePhase3InterventionIndexMode,
  runPhase3InterventionIndexCommand,
} from "../src/scripts/applyPhase3InterventionIndexes.js";

const exact = (spec, name = spec.name) => ({
  name,
  key: { ...spec.key },
  unique: spec.unique,
  sparse: false,
  ...(spec.partialFilterExpression
    ? { partialFilterExpression: structuredClone(spec.partialFilterExpression) }
    : {}),
});

const collectionFor = ({ indexes = [], persist = true, delay = false } = {}) => {
  const inventory = structuredClone(indexes);
  const state = { creates: [], drops: 0, active: 0, maxActive: 0 };
  return {
    state,
    collection: {
      listIndexes: () => ({ toArray: async () => structuredClone(inventory) }),
      async createIndex(key, options) {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        state.creates.push(options.name);
        if (delay) await new Promise((resolve) => setTimeout(resolve, 1));
        if (persist) inventory.push({ key: structuredClone(key), ...structuredClone(options) });
        state.active -= 1;
      },
      async dropIndex() { state.drops += 1; throw new Error("must not drop"); },
    },
  };
};

test("Phase 3 declares exactly eight required indexes", () => {
  assert.equal(PHASE3_INTERVENTION_INDEXES.length, 8);
  assert.equal(PHASE3_INTERVENTION_INDEXES.filter((item) => item.unique).length, 3);
  assert.deepEqual(PHASE3_INTERVENTION_INDEXES.map((item) => item.name), [
    "phase3_interventions_issue_cursor", "phase3_interventions_client_cursor",
    "phase3_interventions_actor_cursor", "phase3_interventions_action_cursor",
    "phase3_interventions_status_cursor", "phase3_interventions_idempotency_unique",
    "phase3_interventions_supersedes_unique", "phase3_interventions_cancellation_key_unique",
  ]);
});

test("inspect is mutation-free and exact inventory is ready", async () => {
  const setup = collectionFor({
    indexes: PHASE3_INTERVENTION_INDEXES.map((item) => exact(item)),
  });
  const result = await managePhase3InterventionIndexes({ mode: "inspect", collection: setup.collection });
  assert.equal(result.results.every((item) => item.classification === "exact_match"), true);
  assert.deepEqual(setup.state.creates, []);
  assert.equal(setup.state.drops, 0);
});

test("apply creates missing indexes sequentially and is idempotent", async () => {
  const setup = collectionFor({ delay: true });
  const first = await applyPhase3InterventionIndexes({ collection: setup.collection, logger: { log() {} } });
  const second = await applyPhase3InterventionIndexes({ collection: setup.collection, logger: { log() {} } });
  assert.equal(first.created.length, 8);
  assert.equal(second.created.length, 0);
  assert.equal(setup.state.maxActive, 1);
  assert.equal(setup.state.drops, 0);
});

test("key order and semantic option conflicts fail before createIndex", async () => {
  const target = PHASE3_INTERVENTION_INDEXES[5];
  for (const bad of [
    { ...exact(target), key: Object.fromEntries(Object.entries(target.key).reverse()) },
    { ...exact(target), unique: false },
    { ...exact(target), hidden: true },
  ]) {
    const setup = collectionFor({ indexes: [bad] });
    await assert.rejects(
      applyPhase3InterventionIndexes({ collection: setup.collection, specs: [target], logger: { log() {} } }),
      (error) => error.code === "PHASE3_INTERVENTION_INDEX_CONFLICT"
    );
    assert.deepEqual(setup.state.creates, []);
  }
});

test("equivalent definitions under different names conflict and keep readiness closed", async () => {
  const target = PHASE3_INTERVENTION_INDEXES[5];
  const setup = collectionFor({ indexes: [exact(target, "legacy_equivalent_name")] });
  const inspection = await managePhase3InterventionIndexes({
    mode: "inspect",
    collection: setup.collection,
    specs: [target],
  });
  assert.equal(inspection.results[0].classification, "equivalent_different_name");
  assert.equal(inspection.results[0].applicationRequired, true);
  await assert.rejects(
    applyPhase3InterventionIndexes({
      collection: setup.collection,
      specs: [target],
      logger: { log() {} },
    }),
    (error) => error.code === "PHASE3_INTERVENTION_INDEX_CONFLICT"
  );
  assert.deepEqual(setup.state.creates, []);

  resetPhase3InterventionIntegrityReadiness();
  const allWrongName = collectionFor({
    indexes: PHASE3_INTERVENTION_INDEXES.map((item) =>
      exact(item, `legacy_${item.name}`)
    ),
  });
  const readiness = await initializePhase3InterventionIntegrity({
    collection: allWrongName.collection,
  });
  assert.equal(readiness.ready, false);
  assert.throws(
    () => assertPhase3InterventionIntegrityReady(),
    (error) => error.code === "INTERVENTION_INDEXES_NOT_READY"
  );
  resetPhase3InterventionIntegrityReadiness();
});

test("post-apply verification fails closed when create results are not persisted", async () => {
  const setup = collectionFor({ persist: false });
  await assert.rejects(
    applyPhase3InterventionIndexes({ collection: setup.collection, logger: { log() {} } }),
    (error) => error.code === "PHASE3_INTERVENTION_INDEX_VERIFICATION_FAILED"
  );
});

test("readiness is explicit and Intervention writes fail closed", async () => {
  resetPhase3InterventionIntegrityReadiness();
  assert.throws(
    () => assertPhase3InterventionIntegrityReady(),
    (error) => error.code === "INTERVENTION_INDEXES_NOT_READY"
  );
  const missing = collectionFor();
  assert.equal((await initializePhase3InterventionIntegrity({ collection: missing.collection })).ready, false);
  const exactSetup = collectionFor({
    indexes: PHASE3_INTERVENTION_INDEXES.map((item) => exact(item)),
  });
  assert.equal((await initializePhase3InterventionIntegrity({ collection: exactSetup.collection })).ready, true);
  assert.equal(assertPhase3InterventionIntegrityReady(), true);
  resetPhase3InterventionIntegrityReadiness();
});

test("invalid CLI arguments are rejected before opening a database connection", async () => {
  assert.throws(
    () => parsePhase3InterventionIndexMode(["--inspect", "--apply"]),
    (error) => error.code === "PHASE3_INTERVENTION_INDEX_CLI_INVALID"
  );
  let connections = 0;
  const fakeMongoose = { connect: async () => { connections += 1; }, connection: {} };
  await assert.rejects(
    runPhase3InterventionIndexCommand({
      argv: ["--bad"],
      env: { MONGO_URI: "redacted" },
      mongooseInstance: fakeMongoose,
    }),
    (error) => error.code === "PHASE3_INTERVENTION_INDEX_CLI_INVALID"
  );
  assert.equal(connections, 0);
});

test("index CLI disconnects after inspect/apply success and failure", async () => {
  for (const mode of ["inspect", "apply"]) {
    for (const shouldFail of [false, true]) {
      let connections = 0;
      let disconnects = 0;
      const connection = {
        readyState: 0,
        db: { collection: () => ({}) },
      };
      const fakeMongoose = {
        connection,
        async connect() {
          connections += 1;
          connection.readyState = 1;
        },
        async disconnect() {
          disconnects += 1;
          connection.readyState = 0;
        },
      };
      const exitCode = await runPhase3InterventionIndexCommand({
        argv: [`--${mode}`],
        env: { MONGO_URI: "mongodb://isolated.invalid/phase3" },
        mongooseInstance: fakeMongoose,
        manage: async () => {
          if (shouldFail) throw new Error("isolated index failure");
          return { results: [], created: [] };
        },
        logger: { log() {}, error() {} },
      });
      assert.equal(exitCode, shouldFail ? 1 : 0);
      assert.equal(connections, 1);
      assert.equal(disconnects, 1);
    }
  }
});
