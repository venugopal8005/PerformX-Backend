import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import express from "express";

import { createMetaComplianceHandlers } from "../src/controllers/metaCompliance.controller.js";
import MetaDataDeletionRequest from "../src/models/MetaDataDeletionRequest.js";
import { requireMetaCallbackForm } from "../src/routes/meta.routes.js";
import { createMetaComplianceService } from "../src/services/metaCompliance.service.js";
import {
  hashMetaUserId,
  verifyMetaSignedRequest,
} from "../src/utils/metaSignedRequest.js";

const APP_SECRET = "test-meta-app-secret";
const META_USER_ID = "meta-user-123";
const CONFIRMATION_CODE = "confirmation-code-1234567890";

const signPayload = (payload, secret = APP_SECRET) => {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  return `${signature}.${encodedPayload}`;
};

const validPayload = (overrides = {}) => ({
  algorithm: "HMAC-SHA256",
  issued_at: 1_700_000_000,
  user_id: META_USER_ID,
  ...overrides,
});

const makeQuery = (value) => {
  const query = {
    lean: async () => value,
    select: () => query,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return query;
};

const valuesEqual = (left, right) => String(left) === String(right);

const getPath = (target, path) =>
  path.split(".").reduce((value, part) => value?.[part], target);

const setPath = (target, path, value) => {
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.reduce((current, part) => {
    current[part] ||= {};
    return current[part];
  }, target);
  parent[key] = value;
};

const unsetPath = (target, path) => {
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.reduce((current, part) => current?.[part], target);
  if (parent) delete parent[key];
};

const matches = (record, filter) =>
  Object.entries(filter).every(([path, expected]) => {
    const actual = getPath(record, path);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) {
        return expected.$in.some((candidate) => valuesEqual(actual, candidate));
      }
      if ("$gt" in expected) return actual > expected.$gt;
    }
    return valuesEqual(actual, expected);
  });

const applyUpdate = (record, update, { inserting = false } = {}) => {
  if (inserting) {
    for (const [path, value] of Object.entries(update.$setOnInsert || {})) {
      setPath(record, path, value);
    }
  }
  for (const [path, value] of Object.entries(update.$set || {})) {
    setPath(record, path, value);
  }
  for (const path of Object.keys(update.$unset || {})) unsetPath(record, path);
};

const createFixture = () => {
  const state = {
    connections: [
      {
        _id: "connection-workspace",
        agency_id: "agency-1",
        connection_scope: "workspace",
        meta_user_id: META_USER_ID,
        meta_user_name: "Meta profile",
        business_id: "business-1",
        ad_account_id: "act-1",
        ad_account_name: "Account one",
        access_token: "raw-access-token",
        access_token_encrypted: "encrypted-access-token",
        token_expires_at: new Date("2027-01-01T00:00:00Z"),
        permissions: ["ads_read"],
        connected_by: "narrative-user-1",
        status: "active",
        is_active: true,
      },
      {
        _id: "connection-legacy",
        agency_id: "agency-2",
        connection_scope: "legacy_client",
        meta_user_id: META_USER_ID,
        access_token: "legacy-access-token",
        access_token_encrypted: "legacy-encrypted-token",
        permissions: ["ads_read"],
        connected_by: "narrative-user-2",
        status: "active",
        is_active: true,
      },
      {
        _id: "connection-other",
        agency_id: "agency-3",
        meta_user_id: "another-meta-user",
        access_token: "other-access-token",
        status: "active",
        is_active: true,
      },
    ],
    accounts: [
      {
        _id: "account-1",
        agency_id: "agency-1",
        meta_connection_id: "connection-workspace",
        is_accessible: true,
      },
      {
        _id: "account-2",
        agency_id: "agency-2",
        meta_connection_id: "connection-legacy",
        is_accessible: true,
      },
      {
        _id: "account-other",
        agency_id: "agency-3",
        meta_connection_id: "connection-other",
        is_accessible: true,
      },
    ],
    activities: [
      {
        _id: "activity-1",
        metadata: { meta_user_id: META_USER_ID, non_private_event: "connected" },
      },
      {
        _id: "activity-other",
        metadata: { meta_user_id: "another-meta-user" },
      },
    ],
    deletionRequests: [],
    reports: [{ _id: "report-1", meta_ad_account_id: "account-1" }],
    reportRuns: [{ _id: "run-1", report_id: "report-1" }],
  };

  const MetaConnectionModel = {
    find: (filter) => makeQuery(state.connections.filter((item) => matches(item, filter))),
    updateMany: async (filter, update) => {
      const found = state.connections.filter((item) => matches(item, filter));
      found.forEach((item) => applyUpdate(item, update));
      return { matchedCount: found.length, modifiedCount: found.length };
    },
  };

  const MetaAdAccountModel = {
    updateMany: async (filter, update) => {
      const found = state.accounts.filter((item) => matches(item, filter));
      found.forEach((item) => applyUpdate(item, update));
      return { matchedCount: found.length, modifiedCount: found.length };
    },
  };

  const ActivityModel = {
    updateMany: async (filter, update) => {
      const found = state.activities.filter((item) => matches(item, filter));
      found.forEach((item) => applyUpdate(item, update));
      return { matchedCount: found.length, modifiedCount: found.length };
    },
  };

  const DeletionRequestModel = {
    findOneAndUpdate: (filter, update, options = {}) => {
      let found = state.deletionRequests.find((item) => matches(item, filter));
      if (!found && options.upsert) {
        found = { _id: `deletion-${state.deletionRequests.length + 1}` };
        applyUpdate(found, update, { inserting: true });
        state.deletionRequests.push(found);
      } else if (found) {
        applyUpdate(found, update);
      }
      return makeQuery(found || null);
    },
    findOne: (filter) =>
      makeQuery(state.deletionRequests.find((item) => matches(item, filter)) || null),
    updateOne: async (filter, update) => {
      const found = state.deletionRequests.find((item) => matches(item, filter));
      if (found) applyUpdate(found, update);
      return { matchedCount: found ? 1 : 0, modifiedCount: found ? 1 : 0 };
    },
  };

  const service = createMetaComplianceService({
    MetaConnectionModel,
    MetaAdAccountModel,
    ActivityModel,
    DeletionRequestModel,
    confirmationCodeFactory: () => CONFIRMATION_CODE,
  });

  return { service, state };
};

const makeResponse = () => ({
  body: null,
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

test("signed_request verification rejects missing, malformed, and invalid base64url input", () => {
  assert.throws(
    () => verifyMetaSignedRequest(undefined, { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_MISSING"
  );
  assert.throws(
    () => verifyMetaSignedRequest("one.two.three", { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_MALFORMED"
  );
  assert.throws(
    () => verifyMetaSignedRequest("invalid$.payload$", { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_MALFORMED"
  );

  const invalidJsonPayload = Buffer.from("not-json").toString("base64url");
  const invalidJsonSignature = crypto
    .createHmac("sha256", APP_SECRET)
    .update(invalidJsonPayload)
    .digest("base64url");
  assert.throws(
    () =>
      verifyMetaSignedRequest(`${invalidJsonSignature}.${invalidJsonPayload}`, {
        appSecret: APP_SECRET,
      }),
    (error) => error.code === "META_SIGNED_REQUEST_INVALID_PAYLOAD"
  );
});

test("signed_request verification rejects invalid signatures, algorithms, and users", () => {
  assert.throws(
    () => verifyMetaSignedRequest(signPayload(validPayload(), "wrong-secret"), { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_INVALID_SIGNATURE"
  );
  assert.throws(
    () => verifyMetaSignedRequest(signPayload(validPayload({ algorithm: "HMAC-SHA1" })), { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_ALGORITHM_INVALID"
  );
  assert.throws(
    () => verifyMetaSignedRequest(signPayload(validPayload({ user_id: "" })), { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_USER_MISSING"
  );

  const encodedPayload = signPayload(validPayload()).split(".")[1];
  assert.throws(
    () => verifyMetaSignedRequest(`YQ.${encodedPayload}`, { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_INVALID_SIGNATURE"
  );
});

test("valid signed requests preserve legitimate retries and validate issued_at", () => {
  const payload = verifyMetaSignedRequest(
    signPayload(validPayload({ issued_at: 1 })),
    { appSecret: APP_SECRET }
  );
  assert.equal(payload.user_id, META_USER_ID);
  assert.equal(payload.issued_at, 1);

  assert.throws(
    () => verifyMetaSignedRequest(signPayload(validPayload({ issued_at: "yesterday" })), { appSecret: APP_SECRET }),
    (error) => error.code === "META_SIGNED_REQUEST_ISSUED_AT_INVALID"
  );
});

test("missing app secret fails closed and Meta user hashes are stable pseudonyms", () => {
  const request = signPayload(validPayload());
  assert.throws(
    () => verifyMetaSignedRequest(request, { appSecret: "" }),
    (error) => error.code === "META_APP_SECRET_MISSING" && error.status === 503
  );

  const first = hashMetaUserId(META_USER_ID, { appSecret: APP_SECRET });
  const second = hashMetaUserId(META_USER_ID, { appSecret: APP_SECRET });
  assert.equal(first, second);
  assert.notEqual(first, META_USER_ID);
  assert.equal(first.includes(META_USER_ID), false);
});

test("deauthorization is generic and successful for an unknown Meta user", async () => {
  const { service, state } = createFixture();
  const before = structuredClone(state.connections);
  assert.deepEqual(await service.deauthorizeMetaUser("unknown-user"), { success: true });
  assert.deepEqual(state.connections, before);
});

test("deauthorization revokes workspace and legacy connections without deleting history", async () => {
  const { service, state } = createFixture();
  const reportsBefore = structuredClone(state.reports);
  const runsBefore = structuredClone(state.reportRuns);

  assert.deepEqual(await service.deauthorizeMetaUser(META_USER_ID), { success: true });
  assert.deepEqual(await service.deauthorizeMetaUser(META_USER_ID), { success: true });

  for (const connection of state.connections.slice(0, 2)) {
    assert.equal(connection.status, "revoked");
    assert.equal(connection.is_active, false);
    assert.equal("access_token" in connection, false);
    assert.equal("access_token_encrypted" in connection, false);
    assert.ok(connection.disconnected_at instanceof Date);
  }
  assert.equal(state.accounts[0].is_accessible, false);
  assert.equal(state.accounts[1].is_accessible, false);
  assert.equal(state.accounts[2].is_accessible, true);
  assert.equal(state.connections[2].status, "active");
  assert.deepEqual(state.reports, reportsBefore);
  assert.deepEqual(state.reportRuns, runsBefore);
});

test("data deletion scrubs direct Meta identity while preserving local audit identity", async () => {
  const { service, state } = createFixture();
  const metaUserHash = hashMetaUserId(META_USER_ID, { appSecret: APP_SECRET });
  const deletion = await service.requestDataDeletion({
    metaUserId: META_USER_ID,
    metaUserHash,
  });

  assert.equal(deletion.status, "completed");
  assert.equal(deletion.confirmation_code, CONFIRMATION_CODE);
  assert.equal(state.deletionRequests.length, 1);
  assert.equal(state.deletionRequests[0].meta_user_hash, metaUserHash);
  assert.equal(JSON.stringify(state.deletionRequests[0]).includes(META_USER_ID), false);

  for (const connection of state.connections.slice(0, 2)) {
    assert.equal(connection.status, "revoked");
    assert.equal(connection.is_active, false);
    assert.deepEqual(connection.permissions, []);
    assert.equal("meta_user_id" in connection, false);
    assert.equal("meta_user_name" in connection, false);
    assert.equal("business_id" in connection, false);
    assert.equal("ad_account_id" in connection, false);
    assert.equal("ad_account_name" in connection, false);
    assert.equal("token_expires_at" in connection, false);
  }
  assert.equal(state.connections[0].connected_by, "narrative-user-1");
  assert.equal(state.connections[1].connected_by, "narrative-user-2");
  assert.equal("meta_user_id" in state.activities[0].metadata, false);
  assert.equal(state.activities[0].metadata.non_private_event, "connected");
  assert.equal(state.activities[1].metadata.meta_user_id, "another-meta-user");
  assert.equal(state.accounts[0].is_accessible, false);
  assert.equal(state.accounts[1].is_accessible, false);
});

test("repeated deletion reuses confirmation and reconnect-then-delete reruns cleanup", async () => {
  const { service, state } = createFixture();
  const metaUserHash = hashMetaUserId(META_USER_ID, { appSecret: APP_SECRET });
  const first = await service.requestDataDeletion({ metaUserId: META_USER_ID, metaUserHash });
  const second = await service.requestDataDeletion({ metaUserId: META_USER_ID, metaUserHash });
  assert.equal(first.confirmation_code, second.confirmation_code);
  assert.equal(state.deletionRequests.length, 1);

  state.connections.push({
    _id: "connection-reconnected",
    agency_id: "agency-1",
    meta_user_id: META_USER_ID,
    access_token: "new-token",
    connected_by: "narrative-user-1",
    status: "active",
    is_active: true,
  });
  state.accounts.push({
    _id: "account-reconnected",
    agency_id: "agency-1",
    meta_connection_id: "connection-reconnected",
    is_accessible: true,
  });
  state.activities.push({
    _id: "activity-reconnected",
    metadata: { meta_user_id: META_USER_ID },
  });

  const third = await service.requestDataDeletion({ metaUserId: META_USER_ID, metaUserHash });
  const reconnected = state.connections.at(-1);
  assert.equal(third.confirmation_code, first.confirmation_code);
  assert.equal(reconnected.status, "revoked");
  assert.equal("meta_user_id" in reconnected, false);
  assert.equal("access_token" in reconnected, false);
  assert.equal(reconnected.connected_by, "narrative-user-1");
  assert.equal(state.accounts.at(-1).is_accessible, false);
  assert.equal("meta_user_id" in state.activities.at(-1).metadata, false);
});

test("deletion status lookup returns active records and excludes unknown records", async () => {
  const { service } = createFixture();
  const metaUserHash = hashMetaUserId(META_USER_ID, { appSecret: APP_SECRET });
  await service.requestDataDeletion({ metaUserId: META_USER_ID, metaUserHash });
  const found = await service.getDataDeletionStatus(CONFIRMATION_CODE);
  assert.equal(found.status, "completed");
  assert.equal(await service.getDataDeletionStatus("unknown-confirmation-code"), null);
});

test("cleanup failures persist a generic failed state and do not expose database errors", async () => {
  const { state } = createFixture();
  const metaUserHash = hashMetaUserId(META_USER_ID, { appSecret: APP_SECRET });

  const failingService = createMetaComplianceService({
    MetaConnectionModel: {
      find: () => makeQuery(state.connections.filter((item) => item.meta_user_id === META_USER_ID)),
      updateMany: async () => ({ matchedCount: 2, modifiedCount: 2 }),
    },
    MetaAdAccountModel: {
      updateMany: async () => ({ matchedCount: 2, modifiedCount: 2 }),
    },
    ActivityModel: {
      updateMany: async () => {
        throw new Error("private database topology must never be returned");
      },
    },
    DeletionRequestModel: {
      findOneAndUpdate: (filter, update, options = {}) => {
        let found = state.deletionRequests.find((item) => matches(item, filter));
        if (!found && options.upsert) {
          found = { _id: "deletion-failed" };
          applyUpdate(found, update, { inserting: true });
          state.deletionRequests.push(found);
        } else if (found) {
          applyUpdate(found, update);
        }
        return makeQuery(found || null);
      },
      updateOne: async (filter, update) => {
        const found = state.deletionRequests.find((item) => matches(item, filter));
        if (found) applyUpdate(found, update);
        return { matchedCount: found ? 1 : 0 };
      },
    },
    confirmationCodeFactory: () => CONFIRMATION_CODE,
  });

  await assert.rejects(
    failingService.requestDataDeletion({ metaUserId: META_USER_ID, metaUserHash }),
    /private database topology/
  );
  assert.equal(state.deletionRequests[0].status, "failed");
  assert.equal(state.deletionRequests[0].failure_reason, "cleanup_failed");
  assert.equal(state.deletionRequests[0].completed_at, null);
});

test("deletion request model contains only pseudonymous confirmation fields and a TTL index", () => {
  const paths = Object.keys(MetaDataDeletionRequest.schema.paths);
  assert.equal(paths.includes("meta_user_id"), false);
  assert.equal(paths.includes("signed_request"), false);
  assert.equal(paths.includes("access_token"), false);
  assert.equal(paths.includes("agency_id"), false);

  const indexes = MetaDataDeletionRequest.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.meta_user_hash === 1 && options.unique));
  assert.ok(indexes.some(([keys, options]) => keys.confirmation_code === 1 && options.unique));
  assert.ok(
    indexes.some(
      ([keys, options]) => keys.expires_at === 1 && options.expireAfterSeconds === 0
    )
  );
});

test("controllers return generic safe responses without private callback data", async () => {
  const privateValues = [META_USER_ID, APP_SECRET, "agency-1", "connection-1", "raw-token"];
  const handlers = createMetaComplianceHandlers({
    verifySignedRequest: () => validPayload(),
    hashUserId: () => "pseudonymous-hash",
    publicApiOrigin: () => "https://api.example.com",
    service: {
      deauthorizeMetaUser: async () => ({ success: true }),
      requestDataDeletion: async () => ({
        confirmation_code: CONFIRMATION_CODE,
        status: "completed",
      }),
      getDataDeletionStatus: async (code) =>
        code === CONFIRMATION_CODE
          ? {
              confirmation_code: code,
              status: "completed",
              requested_at: new Date("2026-07-25T00:00:00Z"),
              completed_at: new Date("2026-07-25T00:00:01Z"),
              meta_user_hash: "must-not-leak",
              agency_id: "must-not-leak",
            }
          : null,
    },
  });

  const deauthorizeResponse = makeResponse();
  await handlers.deauthorize({ body: { signed_request: "opaque" } }, deauthorizeResponse);
  assert.equal(deauthorizeResponse.statusCode, 200);
  assert.deepEqual(deauthorizeResponse.body, { success: true });

  const deletionResponse = makeResponse();
  await handlers.requestDataDeletion(
    { body: { signed_request: "opaque" } },
    deletionResponse
  );
  assert.deepEqual(deletionResponse.body, {
    url: `https://api.example.com/api/meta/data-deletion/status/${CONFIRMATION_CODE}`,
    confirmation_code: CONFIRMATION_CODE,
  });

  const statusResponse = makeResponse();
  await handlers.getDataDeletionStatus(
    { params: { confirmationCode: CONFIRMATION_CODE } },
    statusResponse
  );
  assert.deepEqual(Object.keys(statusResponse.body).sort(), [
    "completed_at",
    "confirmation_code",
    "requested_at",
    "status",
  ]);

  const serialized = JSON.stringify([
    deauthorizeResponse.body,
    deletionResponse.body,
    statusResponse.body,
  ]);
  for (const privateValue of privateValues) assert.equal(serialized.includes(privateValue), false);
});

test("controllers return controlled errors for invalid callbacks, configuration, and status codes", async () => {
  const handlers = createMetaComplianceHandlers({
    publicApiOrigin: () => {
      const error = new Error("configuration missing");
      error.name = "MetaComplianceConfigurationError";
      throw error;
    },
    service: {
      deauthorizeMetaUser: async () => ({ success: true }),
      requestDataDeletion: async () => null,
      getDataDeletionStatus: async () => null,
    },
  });

  const invalidResponse = makeResponse();
  await handlers.deauthorize({ body: {} }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(invalidResponse.body.code, "META_SIGNED_REQUEST_MISSING");

  const unknownResponse = makeResponse();
  await handlers.getDataDeletionStatus(
    { params: { confirmationCode: "unknown-confirmation-code" } },
    unknownResponse
  );
  assert.equal(unknownResponse.statusCode, 404);
  assert.deepEqual(unknownResponse.body, {
    success: false,
    message: "Deletion request not found.",
  });

  const databaseFailureHandlers = createMetaComplianceHandlers({
    verifySignedRequest: () => validPayload(),
    hashUserId: () => "pseudonymous-hash",
    publicApiOrigin: () => "https://api.example.com",
    service: {
      deauthorizeMetaUser: async () => ({ success: true }),
      requestDataDeletion: async () => {
        throw new Error("private database topology and raw-token");
      },
      getDataDeletionStatus: async () => null,
    },
  });
  const databaseFailureResponse = makeResponse();
  await databaseFailureHandlers.requestDataDeletion(
    { body: { signed_request: "opaque" } },
    databaseFailureResponse
  );
  assert.equal(databaseFailureResponse.statusCode, 500);
  assert.deepEqual(databaseFailureResponse.body, {
    success: false,
    code: "META_COMPLIANCE_CALLBACK_FAILED",
    message: "Meta compliance request could not be completed.",
  });
  assert.equal(JSON.stringify(databaseFailureResponse.body).includes("raw-token"), false);
});

test("missing public API origin fails clearly without trusting request headers", async () => {
  const originalApiOrigin = process.env.API_ORIGIN;
  delete process.env.API_ORIGIN;
  try {
    const handlers = createMetaComplianceHandlers({
      verifySignedRequest: () => validPayload(),
      hashUserId: () => "pseudonymous-hash",
      service: {
        deauthorizeMetaUser: async () => ({ success: true }),
        requestDataDeletion: async () => {
          throw new Error("service must not run without a public origin");
        },
        getDataDeletionStatus: async () => null,
      },
    });
    const response = makeResponse();
    await handlers.requestDataDeletion(
      {
        body: { signed_request: "opaque" },
        headers: { host: "attacker.example.com", "x-forwarded-host": "attacker.example.com" },
      },
      response
    );
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, {
      success: false,
      code: "META_COMPLIANCE_CONFIGURATION_MISSING",
      message: "Meta compliance callback configuration is unavailable.",
    });
    assert.equal(JSON.stringify(response.body).includes("attacker.example.com"), false);
  } finally {
    if (originalApiOrigin === undefined) delete process.env.API_ORIGIN;
    else process.env.API_ORIGIN = originalApiOrigin;
  }
});

const withHttpApp = async (callback) => {
  const app = express();
  app.post("/callback", requireMetaCallbackForm, (req, res) => res.json(req.body));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}/callback`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
};

test("callback parser requires form content type and enforces the 10kb body limit", async () => {
  await withHttpApp(async (url) => {
    const unsupported = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signed_request: "opaque" }),
    });
    assert.equal(unsupported.status, 415);
    assert.equal((await unsupported.json()).code, "META_CALLBACK_CONTENT_TYPE_UNSUPPORTED");

    const accepted = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: "opaque" }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { signed_request: "opaque" });

    const oversized = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ signed_request: "x".repeat(11 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, "META_CALLBACK_BODY_TOO_LARGE");
  });
});

test("Meta compliance routes are public while existing Meta routes retain authentication", async () => {
  const source = await readFile(
    new URL("../src/routes/meta.routes.js", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /metaRouter\.post\("\/deauthorize", requireMetaCallbackForm, deauthorize\)/
  );
  assert.match(
    source,
    /metaRouter\.post\("\/data-deletion", requireMetaCallbackForm, requestDataDeletion\)/
  );
  assert.match(
    source,
    /metaRouter\.get\("\/data-deletion\/status\/:confirmationCode", getDataDeletionStatus\)/
  );
  assert.match(source, /metaRouter\.get\("\/connect", protect, requireWorkspaceMember, meta\)/);

  const serviceSource = await readFile(
    new URL("../src/services/metaCompliance.service.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    serviceSource,
    /Report(?:Run)?Model|Report(?:Run)?\.(?:delete|remove)|deleteMany\(|deleteOne\(/
  );
});
