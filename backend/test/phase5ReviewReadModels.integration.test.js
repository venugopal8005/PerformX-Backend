import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import {
  Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewAction,
  ReviewItem, Signal,
} from "../src/models/index.js";
import { getIssueTimeline } from "../src/services/issueTimeline.service.js";
import { listReviewItems } from "../src/services/reviewQueue.service.js";
import { getBoundedReviewSummary } from "../src/services/reviewSummary.service.js";
import { applyPhase5ReviewIndexes, initializePhase5ReviewIntegrity } from "../src/services/phase5ReviewIndexes.service.js";

let replset;
const collectionNames = ["activities", "clients", "evaluations", "evaluation_series", "interventions", "issues", "meta_ad_accounts", "review_actions", "review_items", "review_reconciliation_checkpoints", "signals"];
const Models = { Activity, Client, Evaluation, EvaluationSeries, Intervention, Issue, MetaAdAccount, ReviewAction, ReviewItem, Signal };
before(async () => {
  process.env.JWT_SECRET = "phase5-read-model-secret-12345";
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
  for (const name of collectionNames) await mongoose.connection.createCollection(name).catch(() => {});
  const reviewCollections = { review_items: mongoose.connection.collection("review_items"), review_actions: mongoose.connection.collection("review_actions"), review_reconciliation_checkpoints: mongoose.connection.collection("review_reconciliation_checkpoints") };
  await applyPhase5ReviewIndexes({ collections: reviewCollections, logger: { log() {} } });
  await initializePhase5ReviewIntegrity({ collections: reviewCollections });
});
after(async () => { await mongoose.disconnect(); await replset.stop(); });
beforeEach(async () => { for (const name of collectionNames) await mongoose.connection.collection(name).deleteMany({}); });

const oid = () => new mongoose.Types.ObjectId();
const baseAuthority = async ({ now = new Date("2026-07-18T08:00:00.000Z") } = {}) => {
  const ids = { agency: oid(), client: oid(), account: oid(), issue: oid(), report: oid() };
  await mongoose.connection.collection("clients").insertOne({ _id: ids.client, agency_id: ids.agency, name: "Client", is_archived: false, createdAt: now, updatedAt: now });
  await mongoose.connection.collection("meta_ad_accounts").insertOne({ _id: ids.account, agency_id: ids.agency, client_id: ids.client, name: "Account", ad_account_id: "act_1", is_active: true, is_accessible: true, binding_revision: 1 });
  await mongoose.connection.collection("issues").insertOne({ _id: ids.issue, agency_id: ids.agency, client_id: ids.client, meta_ad_account_id: ids.account, report_ids: [ids.report], status: "open", current_severity: "moderate", lifecycle_revision: 1, createdAt: now, updatedAt: now });
  return { ids, now };
};
const reviewDocument = ({ ids, now, overrides = {} }) => ({
  _id: oid(), agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, meta_ad_account_id: ids.account,
  meta_binding_revision_snapshot: 1, campaign_id: "campaign-1", type: "issue_review", generation: 1,
  active_key: `issue_review:${oid()}`, reason: "issue_created", state: "open", priority: "high", priority_rank: 1,
  priority_source: "issue_severity:moderate", source_revision: 1, opened_at: now, latest_evidence_at: now,
  action_sequence: 1, revision: 1, last_projected_event_key: "phase5:test:event", last_projected_event_hash: "a".repeat(64),
  context_snapshot: { version: 1, captured_at: now, client: { id: ids.client, name: "Client", provenance: "snapshot" }, account: { id: ids.account, name: "Account", external_id: "act_1", provenance: "snapshot" }, campaign: { id: "campaign-1", name: "Campaign", provenance: "snapshot" }, issue: { id: ids.issue, name: null, title: "CTR dropped", provenance: "snapshot" }, report: null, source_title: "CTR dropped", source_summary: "CTR is below baseline.", provenance: "snapshot" },
  createdAt: now, updatedAt: now, ...overrides,
});

test("workspace summary counts actionable and unexpired snoozed items exactly", async () => {
  const fixture = await baseAuthority();
  const open = reviewDocument(fixture);
  const snoozed = reviewDocument({ ...fixture, overrides: { active_key: `issue_review:${oid()}`, generation: 2, state: "snoozed", snoozed_at: fixture.now, snoozed_until: new Date("2026-07-19T08:00:00.000Z") } });
  await mongoose.connection.collection("review_items").insertMany([open, snoozed]);
  const summary = await getBoundedReviewSummary({ agencyId: fixture.ids.agency, Models, now: fixture.now });
  assert.equal(summary.completeness, "complete");
  assert.deepEqual(summary.counts, { active: 2, actionable: 1, snoozed: 1, critical: 0, high: 1, normal: 0, issueReview: 1, evaluationReview: 0 });
});

test("summary excludes archived, reassigned, and resolved authority immediately", async () => {
  const fixture = await baseAuthority();
  await mongoose.connection.collection("review_items").insertOne(reviewDocument(fixture));
  await mongoose.connection.collection("clients").updateOne({ _id: fixture.ids.client }, { $set: { is_archived: true } });
  let summary = await getBoundedReviewSummary({ agencyId: fixture.ids.agency, Models, now: fixture.now });
  assert.equal(summary.counts.active, 0);
  await mongoose.connection.collection("clients").updateOne({ _id: fixture.ids.client }, { $set: { is_archived: false } });
  await mongoose.connection.collection("meta_ad_accounts").updateOne({ _id: fixture.ids.account }, { $set: { client_id: oid(), binding_revision: 2 } });
  summary = await getBoundedReviewSummary({ agencyId: fixture.ids.agency, Models, now: fixture.now });
  assert.equal(summary.counts.active, 0);
  await mongoose.connection.collection("meta_ad_accounts").updateOne({ _id: fixture.ids.account }, { $set: { client_id: fixture.ids.client, binding_revision: 1 } });
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { status: "resolved" } });
  summary = await getBoundedReviewSummary({ agencyId: fixture.ids.agency, Models, now: fixture.now });
  assert.equal(summary.counts.active, 0);
});

test("archived Client summary returns complete zero without scanning Review candidates", async () => {
  const fixture = await baseAuthority();
  await mongoose.connection.collection("clients").updateOne({ _id: fixture.ids.client }, { $set: { is_archived: true } });
  await mongoose.connection.collection("review_items").insertOne(reviewDocument(fixture));
  const result = await getBoundedReviewSummary({ agencyId: fixture.ids.agency, clientId: fixture.ids.client, Models, now: fixture.now });
  assert.equal(result.archived, true);
  assert.equal(result.completeness, "complete");
  assert.equal(result.scannedCandidates, 0);
  assert.equal(result.counts.active, 0);
});

test("Client summary is agency isolated and malformed identity is non-disclosing", async () => {
  const fixture = await baseAuthority();
  await assert.rejects(getBoundedReviewSummary({ agencyId: oid(), clientId: fixture.ids.client, Models, now: fixture.now }), (error) => error.code === "REVIEW_NOT_FOUND" && error.status === 404);
  await assert.rejects(getBoundedReviewSummary({ agencyId: fixture.ids.agency, clientId: "bad-id", Models, now: fixture.now }), (error) => error.code === "REVIEW_NOT_FOUND" && error.status === 404);
});

test("more than 200 candidates returns honest partial observations and an HMAC cursor", async () => {
  const fixture = await baseAuthority();
  const items = [];
  const issues = [];
  for (let index = 0; index < 201; index += 1) {
    const issueId = oid();
    issues.push({ _id: issueId, agency_id: fixture.ids.agency, client_id: fixture.ids.client, meta_ad_account_id: fixture.ids.account, status: "open", current_severity: "moderate", lifecycle_revision: 1, createdAt: fixture.now, updatedAt: fixture.now });
    items.push(reviewDocument({ ...fixture, ids: { ...fixture.ids, issue: issueId }, overrides: { active_key: `issue_review:${issueId}`, generation: 1, createdAt: new Date(fixture.now.getTime() + index), latest_evidence_at: new Date(fixture.now.getTime() + index) } }));
  }
  await mongoose.connection.collection("issues").deleteMany({});
  await mongoose.connection.collection("issues").insertMany(issues);
  await mongoose.connection.collection("review_items").insertMany(items);
  const result = await getBoundedReviewSummary({ agencyId: fixture.ids.agency, Models, now: new Date(fixture.now.getTime() + 500) });
  assert.equal(result.completeness, "partial");
  assert.equal(result.counts, null);
  assert.equal(result.scannedCandidates, 200);
  assert.equal(result.observedCounts.active, 200);
  assert.ok(result.nextCursor);
  const tampered = `${result.nextCursor.slice(0, -1)}${result.nextCursor.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(getBoundedReviewSummary({ agencyId: fixture.ids.agency, cursor: tampered, Models, now: fixture.now }), (error) => error.code === "INVALID_REVIEW_CURSOR");
});

test("queue ordering, filtering, and effective-state exclusion share summary authority", async () => {
  const fixture = await baseAuthority();
  const critical = reviewDocument({ ...fixture, overrides: { priority: "critical", priority_rank: 0, priority_source: "issue_severity:critical", latest_evidence_at: new Date("2026-07-18T09:00:00.000Z") } });
  const normal = reviewDocument({ ...fixture, overrides: { active_key: `issue_review:${oid()}`, generation: 2, priority: "normal", priority_rank: 2, priority_source: "issue_severity:stable" } });
  await mongoose.connection.collection("review_items").insertMany([normal, critical]);
  let result = await listReviewItems({ agencyId: fixture.ids.agency, filters: { state: "open", limit: 1 }, Models, now: fixture.now });
  assert.equal(String(result.items[0].item._id), String(critical._id));
  assert.ok(result.page.nextCursor);
  result = await listReviewItems({ agencyId: fixture.ids.agency, filters: { state: "open", priority: "normal" }, Models, now: fixture.now });
  assert.equal(result.items.length, 1);
  await mongoose.connection.collection("issues").updateOne({ _id: fixture.ids.issue }, { $set: { status: "resolved" } });
  result = await listReviewItems({ agencyId: fixture.ids.agency, filters: { state: "open" }, Models, now: fixture.now });
  assert.equal(result.items.length, 0);
});

const timelineSeed = async () => {
  const fixture = await baseAuthority({ now: new Date("2026-07-18T08:00:00.000Z") });
  const { ids } = fixture; const at = new Date("2026-07-18T09:00:00.000Z");
  const documents = {
    signal: { _id: oid(), agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, title: "Signal", description: "Signal description", severity: "moderate", detected_at: at, createdAt: at, updatedAt: at },
    recorded: { _id: oid(), agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, action_type: "monitor_only", reason: "Observe", status: "active", recorded_at: at, createdAt: at, updatedAt: at },
    corrected: { _id: oid(), agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, action_type: "change_budget", reason: "Corrected", status: "superseded", recorded_at: new Date(at.getTime() - 1000), corrected_at: at, createdAt: at, updatedAt: at },
    cancelled: { _id: oid(), agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, action_type: "no_action", status: "cancelled", recorded_at: new Date(at.getTime() - 2000), cancellation: { reason: "Cancelled", cancelled_at: at }, createdAt: at, updatedAt: at },
    evaluation: { _id: oid(), agency_id: ids.agency, issue_id: ids.issue, status: "ready", observed_result: "mixed", summary: "Mixed result", calculated_at: at, createdAt: at, updatedAt: at },
    action: { _id: oid(), agency_id: ids.agency, client_id: ids.client, issue_id: ids.issue, review_item_id: oid(), action_type: "acknowledged", actor_type: "human", resulting_state: "acknowledged", note: "Reviewed", actor_snapshot: { display_name: "Alex", workspace_role: "member", email: "private@example.com" }, occurred_at: at, recorded_at: at, createdAt: at, updatedAt: at },
    clientArchive: { _id: oid(), agency_id: ids.agency, client_id: ids.client, type: "client_archived", title: "Client archived", description: "Archived", createdAt: at, updatedAt: at },
    reportArchive: { _id: oid(), agency_id: ids.agency, report_id: ids.report, type: "report_archived", title: "Report archived", description: "Archived", createdAt: at, updatedAt: at },
  };
  await mongoose.connection.collection("signals").insertOne(documents.signal);
  await mongoose.connection.collection("interventions").insertMany([documents.recorded, documents.corrected, documents.cancelled]);
  await mongoose.connection.collection("evaluations").insertOne(documents.evaluation);
  await mongoose.connection.collection("review_actions").insertOne(documents.action);
  await mongoose.connection.collection("activities").insertMany([documents.clientArchive, documents.reportArchive]);
  return { ...fixture, at, documents };
};

test("unified Issue timeline composes all eight streams with deterministic equal-time order", async () => {
  const fixture = await timelineSeed();
  const result = await getIssueTimeline({ agencyId: fixture.ids.agency, issueId: fixture.ids.issue, limit: 20, Models, now: new Date("2026-07-18T10:00:00.000Z") });
  assert.deepEqual(new Set(result.entries.map((entry) => entry.stream)), new Set(["signals", "intervention_recorded", "intervention_corrected", "intervention_cancelled", "evaluations", "review_actions", "client_archive", "report_archive"]));
  assert.deepEqual(result.entries.filter((entry) => entry.occurredAt === fixture.at.toISOString()).map((entry) => entry.rank), [10, 20, 21, 22, 30, 40, 50, 51]);
  assert.equal(JSON.stringify(result).includes("private@example.com"), false);
});

test("timeline composite cursor emits no duplicates or skips across pages", async () => {
  const fixture = await timelineSeed();
  const first = await getIssueTimeline({ agencyId: fixture.ids.agency, issueId: fixture.ids.issue, limit: 3, Models, now: new Date("2026-07-18T10:00:00.000Z") });
  const second = await getIssueTimeline({ agencyId: fixture.ids.agency, issueId: fixture.ids.issue, cursor: first.page.nextCursor, limit: 20, Models, now: new Date("2026-07-18T11:00:00.000Z") });
  const ids = [...first.entries, ...second.entries].map((entry) => entry.id);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10);
});

test("timeline snapshot excludes inserts between pages while a fresh session sees them", async () => {
  const fixture = await timelineSeed();
  const snapshotAt = new Date("2026-07-18T10:00:00.000Z");
  const first = await getIssueTimeline({ agencyId: fixture.ids.agency, issueId: fixture.ids.issue, limit: 2, Models, now: snapshotAt });
  const newer = { _id: oid(), agency_id: fixture.ids.agency, client_id: fixture.ids.client, issue_id: fixture.ids.issue, title: "New signal", detected_at: new Date("2026-07-18T10:30:00.000Z"), createdAt: new Date("2026-07-18T10:30:00.000Z"), updatedAt: new Date("2026-07-18T10:30:00.000Z") };
  await mongoose.connection.collection("signals").insertOne(newer);
  const continued = await getIssueTimeline({ agencyId: fixture.ids.agency, issueId: fixture.ids.issue, cursor: first.page.nextCursor, limit: 20, Models, now: new Date("2026-07-18T11:00:00.000Z") });
  assert.equal(continued.entries.some((entry) => entry.sourceId === String(newer._id)), false);
  const fresh = await getIssueTimeline({ agencyId: fixture.ids.agency, issueId: fixture.ids.issue, limit: 20, Models, now: new Date("2026-07-18T11:00:00.000Z") });
  assert.equal(fresh.entries.some((entry) => entry.sourceId === String(newer._id)), true);
});

test("timeline rejects malformed cursors and foreign Issue IDs without disclosure", async () => {
  const fixture = await timelineSeed();
  await assert.rejects(getIssueTimeline({ agencyId: fixture.ids.agency, issueId: fixture.ids.issue, cursor: "not-json", Models }), (error) => error.code === "INVALID_TIMELINE_CURSOR");
  await assert.rejects(getIssueTimeline({ agencyId: oid(), issueId: fixture.ids.issue, Models }), (error) => error.code === "REVIEW_NOT_FOUND" && error.status === 404);
});
