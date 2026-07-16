import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { getClients } from "../src/controllers/clients.controller.js";
import {
  Client,
  MetaAdAccount,
  MetaConnection,
  Report,
} from "../src/models/index.js";

let mongoServer;

const response = () => ({
  statusCode: 200,
  payload: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.payload = payload;
    return this;
  },
});

const createClient = ({ agencyId, name, archived = false }) =>
  Client.create({
    agency_id: agencyId,
    name,
    status: "stable",
    is_archived: archived,
    archived_at: archived ? new Date("2026-07-01T00:00:00.000Z") : null,
  });

const createReport = ({
  agencyId,
  clientId,
  userId,
  name,
  status = "active",
  archived = false,
  campaigns = [],
}) =>
  Report.create({
    agency_id: agencyId,
    client_id: clientId,
    created_by: userId,
    name,
    type: "daily",
    status,
    severity: "low",
    monitored_campaigns: campaigns.map((campaignId) => ({
      campaign_id: campaignId,
      campaign_name: campaignId,
    })),
    schedule: { timezone: "UTC", time_of_day: "09:00" },
    is_archived: archived,
    archived_at: archived ? new Date("2026-07-01T00:00:00.000Z") : null,
  });

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), {
    dbName: `narrative_client_summary_${Date.now()}`,
  });
  await Promise.all([
    Client.init(),
    MetaAdAccount.init(),
    MetaConnection.init(),
    Report.init(),
  ]);
}, { timeout: 120_000 });

beforeEach(async () => {
  await Promise.all([
    Client.deleteMany({}),
    MetaAdAccount.deleteMany({}),
    MetaConnection.deleteMany({}),
    Report.deleteMany({}),
  ]);
});

after(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, { timeout: 30_000 });

test("active Client summaries are scoped, deduplicated, Meta-free, and batched", async () => {
  const agencyId = new mongoose.Types.ObjectId();
  const foreignAgencyId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const single = await createClient({ agencyId, name: "Single Report" });
  const multiple = await createClient({ agencyId, name: "Multiple Reports" });
  const empty = await createClient({ agencyId, name: "No Reports" });
  const otherClient = await createClient({ agencyId, name: "Other Client" });
  await createClient({ agencyId, name: "Archived Client", archived: true });
  await createClient({ agencyId: foreignAgencyId, name: "Foreign Client" });

  await createReport({
    agencyId,
    clientId: single._id,
    userId,
    name: "Single Active",
    campaigns: ["single-campaign"],
  });
  await createReport({
    agencyId,
    clientId: multiple._id,
    userId,
    name: "First Active",
    campaigns: ["campaign-a", "campaign-a"],
  });
  await createReport({
    agencyId,
    clientId: multiple._id,
    userId,
    name: "Second Active",
    campaigns: ["campaign-b"],
  });
  await createReport({
    agencyId,
    clientId: multiple._id,
    userId,
    name: "Paused Coverage",
    status: "paused",
    campaigns: ["campaign-a", "campaign-c"],
  });
  await createReport({
    agencyId,
    clientId: multiple._id,
    userId,
    name: "Archived Report",
    archived: true,
    campaigns: ["archived-campaign"],
  });
  await createReport({
    agencyId,
    clientId: otherClient._id,
    userId,
    name: "Other Client Report",
    campaigns: ["other-campaign"],
  });
  await createReport({
    agencyId: foreignAgencyId,
    clientId: multiple._id,
    userId,
    name: "Foreign Agency Report",
    campaigns: ["foreign-campaign"],
  });
  await Report.collection.insertOne({
    agency_id: agencyId,
    client_id: multiple._id,
    created_by: userId,
    name: "Malformed Campaign Evidence",
    type: "daily",
    status: "paused",
    severity: "low",
    monitored_campaigns: [
      null,
      {},
      { campaign_id: null },
      { campaign_id: 42 },
      { campaign_id: "   " },
    ],
    schedule: { timezone: "UTC", time_of_day: "09:00" },
    is_archived: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const connection = await MetaConnection.create({
    agency_id: agencyId,
    connection_scope: "workspace",
    access_token: "test-only-token",
    status: "active",
    is_active: true,
  });
  const account = await MetaAdAccount.create({
    agency_id: agencyId,
    meta_connection_id: connection._id,
    client_id: single._id,
    assignment_scope: "v1",
    ad_account_id: "act_summary_test",
    name: "Assigned Summary Account",
    is_active: true,
    is_accessible: true,
  });

  const originalAggregate = Report.aggregate;
  let aggregateCalls = 0;
  Report.aggregate = function aggregateOnce(...args) {
    aggregateCalls += 1;
    return originalAggregate.apply(this, args);
  };

  try {
    const res = response();
    await getClients({ user: { agencyId: String(agencyId) } }, res);

    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    assert.equal(aggregateCalls, 1);
    assert.equal(res.payload.clients.length, 4);

    const byName = new Map(res.payload.clients.map((client) => [client.name, client]));
    assert.equal(byName.get("Single Report").activeReportCount, 1);
    assert.equal(byName.get("Single Report").monitoredCampaignCount, 1);
    assert.equal(byName.get("Single Report").meta_ad_account._id.toString(), account._id.toString());
    assert.equal(byName.get("Multiple Reports").activeReportCount, 2);
    assert.equal(byName.get("Multiple Reports").monitoredCampaignCount, 3);
    assert.equal(byName.get("No Reports").activeReportCount, 0);
    assert.equal(byName.get("No Reports").monitoredCampaignCount, 0);
    assert.equal(byName.get("Other Client").activeReportCount, 1);
    assert.equal(byName.has("Archived Client"), false);
    assert.equal(byName.has("Foreign Client"), false);
  } finally {
    Report.aggregate = originalAggregate;
  }
});

test("an empty active Client list skips Report aggregation", async () => {
  const agencyId = new mongoose.Types.ObjectId();
  const originalAggregate = Report.aggregate;
  let aggregateCalls = 0;
  Report.aggregate = function unexpectedAggregate(...args) {
    aggregateCalls += 1;
    return originalAggregate.apply(this, args);
  };

  try {
    const res = response();
    await getClients({ user: { agencyId: String(agencyId) } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.payload.clients, []);
    assert.equal(aggregateCalls, 0);
  } finally {
    Report.aggregate = originalAggregate;
  }
});

test("eligible Reports with only missing or malformed campaigns return zero campaigns", async () => {
  const agencyId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const client = await createClient({ agencyId, name: "Invalid Campaigns Only" });

  await createReport({
    agencyId,
    clientId: client._id,
    userId,
    name: "Empty Campaign Array",
    campaigns: [],
  });
  await Report.collection.insertMany([
    {
      agency_id: agencyId,
      client_id: client._id,
      created_by: userId,
      name: "Missing Campaign Array",
      type: "daily",
      status: "active",
      severity: "low",
      schedule: { timezone: "UTC", time_of_day: "09:00" },
      is_archived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      agency_id: agencyId,
      client_id: client._id,
      created_by: userId,
      name: "Malformed Campaign Array",
      type: "daily",
      status: "active",
      severity: "low",
      monitored_campaigns: [
        null,
        {},
        { campaign_id: null },
        { campaign_id: 42 },
        { campaign_id: "   " },
      ],
      schedule: { timezone: "UTC", time_of_day: "09:00" },
      is_archived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const res = response();
  await getClients({ user: { agencyId: String(agencyId) } }, res);

  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.clients.length, 1);
  assert.equal(res.payload.clients[0].activeReportCount, 3);
  assert.equal(res.payload.clients[0].monitoredCampaignCount, 0);
});
