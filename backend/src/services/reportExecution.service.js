import crypto from "crypto";

import { MetaAdAccount, MetaConnection, Report, ReportRun } from "../models/index.js";
import { runRequiredTransaction } from "./requiredTransaction.service.js";
import { withOperationalReportScope } from "../utils/archiveScope.js";
import {
  fenceMetaAccountBindingInTransaction,
  normalizeMetaBindingRevision,
} from "./metaAccountBinding.service.js";

export const REPORT_EXECUTION_LEASE_MS = 15 * 60 * 1000;
const REPORT_EXECUTION_HEARTBEAT_MS = 4 * 60 * 1000;

const normalizeSource = (source) =>
  ["manual", "scheduled", "api"].includes(source) ? source : "api";

export const isDuplicateKeyError = (error) => error?.code === 11000;

export const buildExecutionKey = ({
  reportId,
  source,
  scheduledFor = null,
  uniqueId = crypto.randomUUID(),
}) => {
  const normalizedSource = normalizeSource(source);
  const id = String(reportId);

  if (normalizedSource === "scheduled") {
    const slot = new Date(scheduledFor);
    if (Number.isNaN(slot.getTime())) {
      const error = new Error("A scheduled execution requires a valid scheduled slot.");
      error.code = "REPORT_SCHEDULE_SLOT_MISSING";
      error.status = 400;
      throw error;
    }

    return `scheduled:${id}:${slot.toISOString()}`;
  }

  return `${normalizedSource}:${id}:${uniqueId}`;
};

export const acquireReportExecutionLease = async ({
  reportId,
  source,
  now = new Date(),
  leaseMs = REPORT_EXECUTION_LEASE_MS,
  ReportModel = Report,
}) => {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + leaseMs);
  const report = await ReportModel.findOneAndUpdate(
    withOperationalReportScope({
      _id: reportId,
      $or: [
        { execution_lock: { $exists: false } },
        { execution_lock: null },
        { "execution_lock.expires_at": { $lte: now } },
      ],
    }),
    {
      $set: {
        execution_lock: {
          token,
          source: normalizeSource(source),
          acquired_at: now,
          expires_at: expiresAt,
        },
      },
    },
    { new: true }
  );

  return report
    ? { acquired: true, report, token, expiresAt }
    : { acquired: false, report: null, token: null, expiresAt: null };
};

export const renewReportExecutionLease = async ({
  reportId,
  agencyId,
  token,
  now = new Date(),
  leaseMs = REPORT_EXECUTION_LEASE_MS,
  ReportModel = Report,
}) => {
  if (!agencyId || !token) return false;

  const result = await ReportModel.updateOne(
    withOperationalReportScope({
      _id: reportId,
      agency_id: agencyId,
      "execution_lock.token": token,
      "execution_lock.expires_at": { $gt: now },
    }),
    {
      $set: {
        "execution_lock.expires_at": new Date(now.getTime() + leaseMs),
      },
    }
  );

  return result.modifiedCount === 1 || result.matchedCount === 1;
};

export const releaseReportExecutionLease = async ({
  reportId,
  token,
  ReportModel = Report,
}) => {
  if (!token) return false;

  const result = await ReportModel.updateOne(
    {
      _id: reportId,
      "execution_lock.token": token,
    },
    {
      $unset: {
        execution_lock: 1,
      },
    }
  );

  return result.modifiedCount === 1;
};

export const startReportExecutionLeaseHeartbeat = ({
  reportId,
  agencyId,
  token,
  ReportModel = Report,
  intervalMs = REPORT_EXECUTION_HEARTBEAT_MS,
}) => {
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();

  const timer = setInterval(() => {
    renewal = renewal
      .then(async () => {
        if (stopped) return;
        const renewed = await renewReportExecutionLease({
          reportId,
          agencyId,
          token,
          ReportModel,
        });
        if (!renewed) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    assertOwned() {
      if (!lost) return;
      throw createReportExecutionLeaseLostError();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewal;
    },
  };
};

export const createReportExecutionLeaseLostError = () => {
  const error = new Error("Report execution lease ownership was lost.");
  error.code = "REPORT_EXECUTION_LEASE_LOST";
  error.status = 409;
  error.reason = "report_execution_lease_lost";
  return error;
};

export const createReportClientLineageChangedError = () => {
  const error = new Error(
    "The report client changed before this execution could claim its history."
  );
  error.code = "REPORT_CLIENT_LINEAGE_CHANGED";
  error.status = 409;
  error.reason = "report_client_lineage_changed";
  return error;
};

const requireTransactionSession = (session) => {
  if (session) return;
  const error = new Error(
    "Initial report execution history requires a MongoDB transaction."
  );
  error.code = "REPORT_EXECUTION_TRANSACTION_REQUIRED";
  error.status = 503;
  throw error;
};

const applySession = (query, session) =>
  typeof query?.session === "function" ? query.session(session) : query;

export const fenceReportExecutionLeaseInTransaction = async ({
  reportId,
  agencyId,
  token,
  expectedClientId,
  session,
  now = new Date(),
  leaseMs = REPORT_EXECUTION_LEASE_MS,
  ReportModel = Report,
}) => {
  requireTransactionSession(session);

  const report = await ReportModel.findOneAndUpdate(
    withOperationalReportScope({
      _id: reportId,
      agency_id: agencyId,
      client_id: expectedClientId,
      "execution_lock.token": token,
      "execution_lock.expires_at": { $gt: now },
    }),
    {
      $set: {
        "execution_lock.expires_at": new Date(now.getTime() + leaseMs),
      },
    },
    { new: true, session }
  );
  if (report) return report;

  const currentQuery = ReportModel.findOne({ _id: reportId, agency_id: agencyId });
  const current = await applySession(currentQuery, session);
  if (!current) {
    const error = new Error("Report is no longer available for execution.");
    error.code = "REPORT_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (current.is_archived === true) {
    const error = new Error("Archived reports cannot be executed.");
    error.code = "REPORT_ARCHIVED";
    error.status = 409;
    throw error;
  }
  if (String(current.client_id) !== String(expectedClientId)) {
    throw createReportClientLineageChangedError();
  }
  throw createReportExecutionLeaseLostError();
};

const buildInitialReportRun = ({
  report,
  metaAdAccount,
  metaBindingRevision,
  contextSnapshot,
  executionKey,
  source,
  scheduledFor,
  period,
  userId,
  now,
}) => ({
  agency_id: report.agency_id,
  client_id: report.client_id,
  report_id: report._id,
  context_snapshot: contextSnapshot,
  meta_ad_account_id: metaAdAccount._id,
  meta_account_external_id_snapshot: metaAdAccount.ad_account_id || null,
  meta_account_name_snapshot: metaAdAccount.name || null,
  meta_binding_revision_snapshot: metaBindingRevision,
  monitored_campaigns: report.monitored_campaigns || [],
  triggered_by: userId || report.created_by || null,
  trigger_type: normalizeSource(source),
  execution_key: executionKey,
  scheduled_for: scheduledFor || null,
  execution_stage: "claimed",
  execution_attempt_count: 0,
  started_at: now,
  status: "running",
  severity: "low",
  period: period || {},
  comparison: {},
  narrative: null,
  engine_output: null,
  ran_at: now,
});

export const findOrCreateReportRun = async ({
  report,
  leaseToken,
  contextSnapshot,
  executionKey,
  source,
  scheduledFor,
  period,
  userId,
  now = new Date(),
  ownershipNow = null,
  ReportModel = Report,
  ReportRunModel = ReportRun,
  MetaAdAccountModel = MetaAdAccount,
  MetaConnectionModel = MetaConnection,
  metaBindingFence = fenceMetaAccountBindingInTransaction,
  transactionRunner = runRequiredTransaction,
}) => {
  const existing = await ReportRunModel.findOne({ execution_key: executionKey });
  if (existing) {
    const renewalTime = ownershipNow || new Date();
    const renewed = await renewReportExecutionLease({
      reportId: report._id,
      agencyId: report.agency_id,
      token: leaseToken,
      now: renewalTime,
      ReportModel,
    });
    if (!renewed) throw createReportExecutionLeaseLostError();
    return { reportRun: existing, created: false };
  }

  try {
    return await transactionRunner({
      unavailableCode: "REPORT_EXECUTION_TRANSACTION_REQUIRED",
      unavailableMessage:
        "Initial report execution history requires a transaction-capable database deployment.",
      work: async (session) => {
        const fenceTime = ownershipNow || new Date();
        const fencedReport = await fenceReportExecutionLeaseInTransaction({
          reportId: report._id,
          agencyId: report.agency_id,
          token: leaseToken,
          expectedClientId: report.client_id,
          session,
          now: fenceTime,
          ReportModel,
        });
        const { account: fencedMetaAdAccount, bindingRevision } =
          await metaBindingFence({
            accountId: fencedReport.meta_ad_account_id,
            agencyId: fencedReport.agency_id,
            clientId: fencedReport.client_id,
            session,
            MetaAdAccountModel,
            MetaConnectionModel,
          });
        const existingQuery = ReportRunModel.findOne({
          execution_key: executionKey,
        });
        const transactionExisting = await applySession(existingQuery, session);
        if (transactionExisting) {
          return { reportRun: transactionExisting, created: false };
        }

        const document = buildInitialReportRun({
          report: fencedReport,
          metaAdAccount: fencedMetaAdAccount,
          metaBindingRevision: bindingRevision,
          contextSnapshot,
          executionKey,
          source,
          scheduledFor,
          period,
          userId,
          now,
        });
        const created = await ReportRunModel.create([document], { session });
        return { reportRun: created[0], created: true };
      },
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    const winner = await ReportRunModel.findOne({ execution_key: executionKey });
    if (!winner) throw error;
    const renewalTime = ownershipNow || new Date();
    const renewed = await renewReportExecutionLease({
      reportId: report._id,
      agencyId: report.agency_id,
      token: leaseToken,
      now: renewalTime,
      ReportModel,
    });
    if (!renewed) throw createReportExecutionLeaseLostError();
    return { reportRun: winner, created: false };
  }
};

export const persistGeneratedReportEvidenceWithMetaBindingFence = async ({
  reportRun,
  leaseToken,
  generatedFields,
  now = new Date(),
  ownershipNow = null,
  ReportModel = Report,
  ReportRunModel = ReportRun,
  MetaAdAccountModel = MetaAdAccount,
  MetaConnectionModel = MetaConnection,
  metaBindingFence = fenceMetaAccountBindingInTransaction,
  transactionRunner = runRequiredTransaction,
  afterMetaFence = null,
  afterEvidenceWrite = null,
}) => {
  const expectedRevision = normalizeMetaBindingRevision(
    reportRun.meta_binding_revision_snapshot
  );

  return transactionRunner({
    unavailableCode: "REPORT_EXECUTION_TRANSACTION_REQUIRED",
    unavailableMessage:
      "Generated report evidence requires a transaction-capable database deployment.",
    work: async (session) => {
      await fenceReportExecutionLeaseInTransaction({
        reportId: reportRun.report_id,
        agencyId: reportRun.agency_id,
        token: leaseToken,
        expectedClientId: reportRun.client_id,
        session,
        now: ownershipNow || new Date(),
        ReportModel,
      });
      await metaBindingFence({
        accountId: reportRun.meta_ad_account_id,
        agencyId: reportRun.agency_id,
        clientId: reportRun.client_id,
        expectedBindingRevision: expectedRevision,
        session,
        MetaAdAccountModel,
        MetaConnectionModel,
      });
      if (afterMetaFence) await afterMetaFence({ session });

      const updated = await ReportRunModel.findOneAndUpdate(
        {
          _id: reportRun._id,
          agency_id: reportRun.agency_id,
          report_id: reportRun.report_id,
          client_id: reportRun.client_id,
          meta_ad_account_id: reportRun.meta_ad_account_id,
          meta_binding_revision_snapshot: expectedRevision,
        },
        {
          $set: {
            ...generatedFields,
            meta_binding_performance_validated_at: now,
          },
        },
        { new: true, session }
      );
      if (!updated) {
        const error = new Error(
          "The report execution binding changed before generated evidence was saved."
        );
        error.code = "META_ACCOUNT_ASSIGNMENT_CHANGED";
        error.status = 409;
        error.reason = "meta_account_assignment_changed";
        throw error;
      }
      if (afterEvidenceWrite) await afterEvidenceWrite({ session, reportRun: updated });
      return updated;
    },
  });
};
