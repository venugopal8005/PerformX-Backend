import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  PHASE4_EVALUATION_INDEXES,
  applyPhase4EvaluationIndexes,
  initializePhase4EvaluationIntegrity,
  inspectPhase4EvaluationIndexes,
  resetPhase4EvaluationIntegrityReadiness,
} from "../src/services/phase4EvaluationIndexes.service.js";
import {
  PHASE5_REVIEW_INDEXES,
  applyPhase5ReviewIndexes,
  initializePhase5ReviewIntegrity,
  inspectPhase5ReviewIndexes,
  resetPhase5ReviewIntegrityReadiness,
} from "../src/services/phase5ReviewIndexes.service.js";

const backendDirectory = fileURLToPath(new URL("..", import.meta.url));
const phase4Script = fileURLToPath(
  new URL("../src/scripts/applyPhase4EvaluationIndexes.js", import.meta.url)
);
const phase5Script = fileURLToPath(
  new URL("../src/scripts/applyPhase5ReviewIndexes.js", import.meta.url)
);
const quietLogger = { log() {} };

let replset;
let client;
let databaseSequence = 0;

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(replset.getUri());
  await client.connect();
});

after(async () => {
  await client?.close();
  await replset?.stop();
});

const freshDatabase = (label) =>
  client.db(`phase45_index_bootstrap_${label}_${databaseSequence++}`);

const phase4Collections = (db) => ({
  evaluations: db.collection("evaluations"),
  evaluation_series: db.collection("evaluation_series"),
});

const phase5Collections = (db) => ({
  review_items: db.collection("review_items"),
  review_actions: db.collection("review_actions"),
  review_reconciliation_checkpoints: db.collection(
    "review_reconciliation_checkpoints"
  ),
});

const collectionNames = async (db) =>
  (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(({ name }) => name)
    .sort();

const normalizeIndexIdentity = (index) => ({
  name: index.name,
  key: Object.entries(index.key || {}),
  unique: index.unique === true,
  sparse: index.sparse === true,
  partialFilterExpression: index.partialFilterExpression || null,
  collation: index.collation || null,
  expireAfterSeconds: index.expireAfterSeconds ?? null,
  hidden: index.hidden === true,
  wildcardProjection: index.wildcardProjection || null,
  storageEngine: index.storageEngine || null,
});

const persistedIndexInventory = async (collections) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(collections).map(async ([collectionName, collection]) => [
        collectionName,
        (await collection.listIndexes().toArray())
          .map(normalizeIndexIdentity)
          .sort((left, right) => left.name.localeCompare(right.name)),
      ])
    )
  );

const assertPersistedDeclarations = async ({ collections, specs }) => {
  const inventory = await persistedIndexInventory(collections);
  let declaredIndexCount = 0;

  for (const [collectionName, indexes] of Object.entries(inventory)) {
    const identifierIndexes = indexes.filter(({ name }) => name === "_id_");
    assert.equal(identifierIndexes.length, 1);
    assert.deepEqual(identifierIndexes[0].key, [["_id", 1]]);

    const persistedDeclarations = indexes.filter(({ name }) => name !== "_id_");
    const expectedDeclarations = specs
      .filter(({ collection }) => collection === collectionName)
      .map(normalizeIndexIdentity)
      .sort((left, right) => left.name.localeCompare(right.name));

    assert.deepEqual(persistedDeclarations, expectedDeclarations);
    declaredIndexCount += persistedDeclarations.length;
  }

  assert.equal(declaredIndexCount, specs.length);
  return inventory;
};

const assertNoDocuments = async (collections) => {
  for (const collection of Object.values(collections)) {
    assert.equal(await collection.countDocuments({}), 0);
  }
};

const runInspectScript = (script, databaseName) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, "--inspect"], {
      cwd: backendDirectory,
      env: { ...process.env, MONGO_URI: replset.getUri(databaseName) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });

test("Phase 4 missing-collection inspect is structured, non-mutating, and exits not ready", async () => {
  const db = freshDatabase("phase4_inspect");
  const collections = phase4Collections(db);
  assert.deepEqual(await collectionNames(db), []);
  await assertNoDocuments(collections);
  assert.deepEqual(await collectionNames(db), []);

  const results = await inspectPhase4EvaluationIndexes({
    collections,
  });

  assert.equal(results.length, 12);
  assert.equal(results.every(({ classification }) => classification === "missing"), true);
  assert.deepEqual(await collectionNames(db), []);
  await assertNoDocuments(collections);
  assert.deepEqual(await collectionNames(db), []);

  const scriptDatabase = `phase45_index_bootstrap_phase4_script_${databaseSequence++}`;
  const execution = await runInspectScript(phase4Script, scriptDatabase);
  assert.equal(execution.code, 2);
  assert.equal(execution.signal, null);
  assert.equal(execution.stderr.includes("NamespaceNotFound"), false);
  assert.equal((execution.stdout.match(/\bmissing$/gm) || []).length, 12);
  assert.deepEqual(await collectionNames(client.db(scriptDatabase)), []);
});

test("Phase 4 apply bootstraps exact indexes without documents and is idempotent", async () => {
  const db = freshDatabase("phase4_apply");
  const collections = phase4Collections(db);
  const first = await applyPhase4EvaluationIndexes({ collections, logger: quietLogger });

  assert.equal(first.created.length, 12);
  assert.equal(first.results.every(({ classification }) => classification === "exact_match"), true);
  assert.deepEqual(await collectionNames(db), ["evaluation_series", "evaluations"]);
  const firstInventory = await assertPersistedDeclarations({
    collections,
    specs: PHASE4_EVALUATION_INDEXES,
  });
  await assertNoDocuments(collections);

  const second = await applyPhase4EvaluationIndexes({ collections, logger: quietLogger });
  assert.deepEqual(second.created, []);
  assert.equal(second.results.every(({ classification }) => classification === "exact_match"), true);
  const secondInventory = await assertPersistedDeclarations({
    collections,
    specs: PHASE4_EVALUATION_INDEXES,
  });
  assert.deepEqual(secondInventory, firstInventory);
  await assertNoDocuments(collections);
});

test("Phase 4 conflicts fail closed without replacing or extending indexes", async () => {
  const db = freshDatabase("phase4_conflict");
  const collections = phase4Collections(db);
  const expected = PHASE4_EVALUATION_INDEXES[0];
  await collections.evaluations.createIndex(expected.key, { name: expected.name });
  const beforeConflict = await persistedIndexInventory({
    evaluations: collections.evaluations,
  });

  await assert.rejects(
    applyPhase4EvaluationIndexes({ collections, logger: quietLogger }),
    (error) => error.code === "PHASE4_EVALUATION_INDEX_CONFLICT"
  );

  const indexes = await collections.evaluations.listIndexes().toArray();
  const afterConflict = await persistedIndexInventory({
    evaluations: collections.evaluations,
  });
  assert.deepEqual(afterConflict, beforeConflict);
  assert.equal(indexes.length, 2);
  assert.notEqual(indexes.find(({ name }) => name === expected.name)?.unique, true);
  assert.deepEqual(await collectionNames(db), ["evaluations"]);
});

test("Phase 5 missing-collection inspect is structured, non-mutating, and exits not ready", async () => {
  const db = freshDatabase("phase5_inspect");
  const collections = phase5Collections(db);
  assert.deepEqual(await collectionNames(db), []);
  await assertNoDocuments(collections);
  assert.deepEqual(await collectionNames(db), []);

  const results = await inspectPhase5ReviewIndexes({
    collections,
  });

  assert.equal(results.length, 16);
  assert.equal(results.every(({ classification }) => classification === "missing"), true);
  assert.deepEqual(await collectionNames(db), []);
  await assertNoDocuments(collections);
  assert.deepEqual(await collectionNames(db), []);

  const scriptDatabase = `phase45_index_bootstrap_phase5_script_${databaseSequence++}`;
  const execution = await runInspectScript(phase5Script, scriptDatabase);
  assert.equal(execution.code, 2);
  assert.equal(execution.signal, null);
  assert.equal(execution.stderr.includes("NamespaceNotFound"), false);
  assert.equal((execution.stdout.match(/"classification": "missing"/g) || []).length, 16);
  assert.deepEqual(await collectionNames(client.db(scriptDatabase)), []);
});

test("Phase 5 apply bootstraps exact indexes without documents and is idempotent", async () => {
  const db = freshDatabase("phase5_apply");
  const collections = phase5Collections(db);
  const first = await applyPhase5ReviewIndexes({ collections, logger: quietLogger });

  assert.equal(first.created.length, 16);
  assert.equal(first.results.every(({ classification }) => classification === "exact_match"), true);
  assert.deepEqual(await collectionNames(db), [
    "review_actions",
    "review_items",
    "review_reconciliation_checkpoints",
  ]);
  const firstInventory = await assertPersistedDeclarations({
    collections,
    specs: PHASE5_REVIEW_INDEXES,
  });
  await assertNoDocuments(collections);

  const second = await applyPhase5ReviewIndexes({ collections, logger: quietLogger });
  assert.deepEqual(second.created, []);
  assert.equal(second.results.every(({ classification }) => classification === "exact_match"), true);
  const secondInventory = await assertPersistedDeclarations({
    collections,
    specs: PHASE5_REVIEW_INDEXES,
  });
  assert.deepEqual(secondInventory, firstInventory);
  await assertNoDocuments(collections);
});

test("Phase 5 conflicts fail closed without replacing or extending indexes", async () => {
  const db = freshDatabase("phase5_conflict");
  const collections = phase5Collections(db);
  const expected = PHASE5_REVIEW_INDEXES[0];
  await collections.review_items.createIndex(expected.key, {
    name: expected.name,
    partialFilterExpression: expected.partialFilterExpression,
  });
  const beforeConflict = await persistedIndexInventory({
    review_items: collections.review_items,
  });

  await assert.rejects(
    applyPhase5ReviewIndexes({ collections, logger: quietLogger }),
    (error) => error.code === "PHASE5_REVIEW_INDEX_CONFLICT"
  );

  const indexes = await collections.review_items.listIndexes().toArray();
  const afterConflict = await persistedIndexInventory({
    review_items: collections.review_items,
  });
  assert.deepEqual(afterConflict, beforeConflict);
  assert.equal(indexes.length, 2);
  assert.notEqual(indexes.find(({ name }) => name === expected.name)?.unique, true);
  assert.deepEqual(await collectionNames(db), ["review_items"]);
});

test("Phase 4 and Phase 5 startup readiness remains blocked and non-mutating before apply", async () => {
  const db = freshDatabase("readiness_before");
  const phase4Target = phase4Collections(db);
  const phase5Target = phase5Collections(db);
  assert.deepEqual(await collectionNames(db), []);
  resetPhase4EvaluationIntegrityReadiness();
  resetPhase5ReviewIntegrityReadiness();

  const phase4 = await initializePhase4EvaluationIntegrity({
    collections: phase4Target,
  });
  const phase5 = await initializePhase5ReviewIntegrity({
    collections: phase5Target,
  });

  assert.equal(phase4.ready, false);
  assert.equal(phase4.state, "blocked");
  assert.equal(phase4.results.length, 12);
  assert.equal(phase5.ready, false);
  assert.equal(phase5.state, "blocked");
  assert.equal(phase5.results.length, 16);
  await assertNoDocuments({ ...phase4Target, ...phase5Target });
  assert.deepEqual(await collectionNames(db), []);
});

test("Phase 4 and Phase 5 startup readiness passes after isolated index apply", async () => {
  const db = freshDatabase("readiness_after");
  const phase4Target = phase4Collections(db);
  const phase5Target = phase5Collections(db);
  await applyPhase4EvaluationIndexes({ collections: phase4Target, logger: quietLogger });
  await applyPhase5ReviewIndexes({ collections: phase5Target, logger: quietLogger });
  resetPhase4EvaluationIntegrityReadiness();
  resetPhase5ReviewIntegrityReadiness();

  const phase4 = await initializePhase4EvaluationIntegrity({ collections: phase4Target });
  const phase5 = await initializePhase5ReviewIntegrity({ collections: phase5Target });

  assert.equal(phase4.ready, true);
  assert.equal(phase5.ready, true);
  assert.equal(phase4.results.every(({ classification }) => classification === "exact_match"), true);
  assert.equal(phase5.results.every(({ classification }) => classification === "exact_match"), true);
  await assertPersistedDeclarations({
    collections: phase4Target,
    specs: PHASE4_EVALUATION_INDEXES,
  });
  await assertPersistedDeclarations({
    collections: phase5Target,
    specs: PHASE5_REVIEW_INDEXES,
  });
  await assertNoDocuments({ ...phase4Target, ...phase5Target });
});
