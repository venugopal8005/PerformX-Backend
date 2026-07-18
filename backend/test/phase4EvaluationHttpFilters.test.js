import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { getEvaluations } from "../src/controllers/evaluations.controller.js";
import { Client, Evaluation, Issue } from "../src/models/index.js";

let replset;
let server;
let origin;
let agencyId;

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of ["clients", "issues", "evaluations"]) await mongoose.connection.createCollection(name).catch(() => {});
  const app = express();
  app.get("/api/evaluations", (req, _res, next) => {
    req.user = { agencyId };
    next();
  }, getEvaluations);
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await replset.stop();
});
beforeEach(async () => {
  agencyId = new mongoose.Types.ObjectId();
  await Promise.all([Client.collection.deleteMany({}), Issue.collection.deleteMany({}), Evaluation.collection.deleteMany({})]);
});

const oid = () => new mongoose.Types.ObjectId();
const get = async (query) => {
  const response = await fetch(`${origin}/api/evaluations?${query}`);
  return { status: response.status, body: await response.json() };
};

test("own active and archived Client filters return bounded history", async () => {
  const active = oid();
  const archived = oid();
  await Client.collection.insertMany([
    { _id: active, agency_id: agencyId, name: "Active", is_archived: false },
    { _id: archived, agency_id: agencyId, name: "Archived", is_archived: true },
  ]);
  assert.equal((await get(`clientId=${active}`)).status, 200);
  assert.equal((await get(`clientId=${archived}`)).status, 200);
});

test("missing and foreign Client filters return the same non-disclosing 404", async () => {
  const foreign = oid();
  await Client.collection.insertOne({ _id: foreign, agency_id: oid(), name: "Foreign", is_archived: false });
  const missingResult = await get(`clientId=${oid()}`);
  const foreignResult = await get(`clientId=${foreign}`);
  assert.equal(missingResult.status, 404);
  assert.equal(foreignResult.status, 404);
  assert.deepEqual(foreignResult.body, missingResult.body);
});

test("own Issue returns 200 while missing and foreign Issues return the same 404", async () => {
  const own = oid();
  const foreign = oid();
  await Issue.collection.insertMany([
    { _id: own, agency_id: agencyId },
    { _id: foreign, agency_id: oid() },
  ]);
  assert.equal((await get(`issueId=${own}`)).status, 200);
  const missingResult = await get(`issueId=${oid()}`);
  const foreignResult = await get(`issueId=${foreign}`);
  assert.equal(missingResult.status, 404);
  assert.equal(foreignResult.status, 404);
  assert.deepEqual(foreignResult.body, missingResult.body);
});

test("foreign Evaluation documents cannot cross the authenticated agency scope", async () => {
  const clientId = oid();
  const foreignAgency = oid();
  await Client.collection.insertOne({ _id: clientId, agency_id: agencyId, name: "Own", is_archived: false });
  await Evaluation.collection.insertOne({ _id: oid(), agency_id: foreignAgency, client_id: clientId, calculated_at: new Date(), status: "ready" });
  const result = await get(`clientId=${clientId}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.evaluations, []);
});
