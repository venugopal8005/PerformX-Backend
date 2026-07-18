import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASE5_REVIEW_INDEXES,
  applyPhase5ReviewIndexes,
  assertPhase5ReviewIntegrityReady,
  classifyPhase5Index,
  initializePhase5ReviewIntegrity,
  resetPhase5ReviewIntegrityReadiness,
} from "../src/services/phase5ReviewIndexes.service.js";
import { parsePhase5ReviewIndexMode, runPhase5ReviewIndexCommand } from "../src/scripts/applyPhase5ReviewIndexes.js";

const mongoIndex = (spec) => ({ v: 2, key: spec.key, name: spec.name, ...(spec.unique ? { unique: true } : {}), ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}) });
const makeCollections = ({ indexes = new Map(), creates = [] } = {}) => Object.fromEntries(
  ["review_items", "review_actions", "review_reconciliation_checkpoints"].map((collection) => [collection, {
    listIndexes: () => ({ toArray: async () => indexes.get(collection) || [{ v: 2, key: { _id: 1 }, name: "_id_" }] }),
    createIndex: async (key, options) => {
      creates.push({ collection, key, options });
      const expected = PHASE5_REVIEW_INDEXES.find((entry) => entry.name === options.name);
      indexes.set(collection, [...(indexes.get(collection) || [{ v: 2, key: { _id: 1 }, name: "_id_" }]), mongoIndex(expected)]);
    },
  }])
);

test("Phase 5 declares the exact fourteen required and two bounded-summary indexes", () => {
  assert.equal(PHASE5_REVIEW_INDEXES.length, 16);
  assert.equal(new Set(PHASE5_REVIEW_INDEXES.map((entry) => entry.name)).size, 16);
  assert.deepEqual(PHASE5_REVIEW_INDEXES[0].key, { agency_id: 1, active_key: 1 });
  assert.equal(PHASE5_REVIEW_INDEXES[0].unique, true);
  assert.equal(PHASE5_REVIEW_INDEXES.filter((entry) => entry.name.includes("summary_candidates")).length, 2);
});

test("index classification requires exact ordered keys and semantic options", () => {
  const expected = PHASE5_REVIEW_INDEXES[3];
  assert.equal(classifyPhase5Index(expected, [mongoIndex(expected)]).classification, "exact_match");
  assert.equal(classifyPhase5Index(expected, [{ ...mongoIndex(expected), key: { state: 1, agency_id: 1, priority_rank: 1, latest_evidence_at: -1, _id: -1 } }]).classification, "name_conflict");
  assert.equal(classifyPhase5Index(expected, [{ ...mongoIndex(expected), hidden: true }]).classification, "name_conflict");
});

test("equivalent differently named indexes fail closed", () => {
  const expected = PHASE5_REVIEW_INDEXES[10];
  assert.equal(classifyPhase5Index(expected, [{ ...mongoIndex(expected), name: "another_name" }]).classification, "equivalent_different_name");
});

test("inspect-only readiness never creates indexes and blocks Review writes", async () => {
  resetPhase5ReviewIntegrityReadiness();
  const creates = [];
  const state = await initializePhase5ReviewIntegrity({ collections: makeCollections({ creates }) });
  assert.equal(state.ready, false);
  assert.equal(creates.length, 0);
  assert.throws(() => assertPhase5ReviewIntegrityReady(), (error) => error.code === "REVIEW_INDEXES_NOT_READY" && error.status === 503);
});

test("explicit apply creates missing indexes sequentially and verifies exact inventory", async () => {
  const creates = [];
  const result = await applyPhase5ReviewIndexes({ collections: makeCollections({ creates }), logger: { log() {} } });
  assert.equal(creates.length, 16);
  assert.equal(result.results.every((entry) => entry.classification === "exact_match"), true);
});

test("any conflict prevents all automatic creation", async () => {
  const expected = PHASE5_REVIEW_INDEXES[0];
  const indexes = new Map([[expected.collection, [{ ...mongoIndex(expected), unique: false }]]]);
  const creates = [];
  await assert.rejects(applyPhase5ReviewIndexes({ collections: makeCollections({ indexes, creates }), logger: { log() {} } }), (error) => error.code === "PHASE5_REVIEW_INDEX_CONFLICT");
  assert.equal(creates.length, 0);
});

test("CLI requires exactly one explicit inspect or apply mode", () => {
  assert.equal(parsePhase5ReviewIndexMode(["--inspect"]), "inspect");
  assert.equal(parsePhase5ReviewIndexMode(["--apply"]), "apply");
  assert.throws(() => parsePhase5ReviewIndexMode([]), /exactly one/);
  assert.throws(() => parsePhase5ReviewIndexMode(["--inspect", "--apply"]), /exactly one/);
});

test("command runner delegates the selected mode without opening external boundaries", async () => {
  const creates = [];
  const result = await runPhase5ReviewIndexCommand({ mode: "inspect", collections: makeCollections({ creates }), logger: { log() {} } });
  assert.equal(result.created.length, 0);
  assert.equal(creates.length, 0);
});
