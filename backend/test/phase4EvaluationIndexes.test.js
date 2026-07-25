import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASE4_EVALUATION_INDEXES,
  applyPhase4EvaluationIndexes,
  classifyPhase4Index,
  initializePhase4EvaluationIntegrity,
  resetPhase4EvaluationIntegrityReadiness,
} from "../src/services/phase4EvaluationIndexes.service.js";
import { parsePhase4EvaluationIndexMode, runPhase4EvaluationIndexCommand } from "../src/scripts/applyPhase4EvaluationIndexes.js";

const mongodbIndex = (spec) => ({ v: 2, key: spec.key, name: spec.name, ...(spec.unique ? { unique: true } : {}), ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}) });
const collections = ({ indexes = new Map(), creates = [] } = {}) => Object.fromEntries(["evaluations", "evaluation_series"].map((name) => [name, { listIndexes: () => ({ toArray: async () => indexes.get(name) || [{ v: 2, key: { _id: 1 }, name: "_id_" }] }), createIndex: async (key, options) => { creates.push({ collection: name, key, options }); const spec = PHASE4_EVALUATION_INDEXES.find((item) => item.name === options.name); indexes.set(name, [...(indexes.get(name) || [{ v: 2, key: { _id: 1 }, name: "_id_" }]), mongodbIndex(spec)]); } }]));

test("Phase 4 declares exactly twelve approved index specifications", () => {
  assert.equal(PHASE4_EVALUATION_INDEXES.length, 12);
  assert.equal(new Set(PHASE4_EVALUATION_INDEXES.map((item) => item.name)).size, 12);
});
test("exact key order and semantic options are required", () => {
  const expected = PHASE4_EVALUATION_INDEXES[0];
  assert.equal(classifyPhase4Index(expected, [mongodbIndex(expected)]).classification, "exact_match");
  assert.equal(classifyPhase4Index(expected, [{ ...mongodbIndex(expected), key: { intervention_id: 1, agency_id: 1, sequence: -1 } }]).classification, "name_conflict");
});
test("equivalent index under another name is a conflict", () => {
  const expected = PHASE4_EVALUATION_INDEXES[1];
  assert.equal(classifyPhase4Index(expected, [{ ...mongodbIndex(expected), name: "wrong_name" }]).classification, "equivalent_different_name");
});
test("conflicts prevent all index creation", async () => {
  const expected = PHASE4_EVALUATION_INDEXES[0];
  const creates = [];
  const indexMap = new Map([["evaluations", [{ ...mongodbIndex(expected), unique: false }]]]);
  await assert.rejects(applyPhase4EvaluationIndexes({ collections: collections({ indexes: indexMap, creates }), logger: { log() {} } }), (error) => error.code === "PHASE4_EVALUATION_INDEX_CONFLICT");
  assert.equal(creates.length, 0);
});
test("apply creates missing exact indexes sequentially and verifies them", async () => {
  const creates = [];
  const result = await applyPhase4EvaluationIndexes({ collections: collections({ creates }), logger: { log() {} } });
  assert.equal(creates.length, 12);
  assert.equal(result.results.every((item) => item.classification === "exact_match"), true);
});
test("readiness blocks when any exact index is absent", async () => {
  resetPhase4EvaluationIntegrityReadiness();
  const state = await initializePhase4EvaluationIntegrity({ collections: collections() });
  assert.equal(state.ready, false);
  assert.equal(state.state, "blocked");
});
test("invalid CLI syntax is rejected before connection", async () => {
  assert.throws(() => parsePhase4EvaluationIndexMode(["--apply", "extra"]), /Use no flag/);
  let connected = 0;
  const code = await runPhase4EvaluationIndexCommand({ argv: ["--bad"], mongooseInstance: { connection: { readyState: 0 }, connect: async () => { connected += 1; } }, logger: { error() {} } }).catch((error) => error);
  assert.equal(connected, 0);
  assert.equal(code.code, "PHASE4_EVALUATION_INDEX_CLI_INVALID");
});
test("inspect mode never calls createIndex", async () => {
  const creates = [];
  const state = await initializePhase4EvaluationIntegrity({ collections: collections({ creates }) });
  assert.equal(creates.length, 0);
  assert.equal(state.ready, false);
});

