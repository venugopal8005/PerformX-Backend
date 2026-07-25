import mongoose from "mongoose";

import {
  Activity,
  Client,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
} from "../models/index.js";
import { recordActivity } from "./activityRecorder.service.js";
import { buildLegacyDispatchState } from "./reportDelivery.service.js";
import {
  acquireClientLifecycleLease,
  releaseClientLifecycleLease,
  requireClientLifecycleLeaseOwnership,
  startClientLifecycleLeaseHeartbeat,
} from "./clientLifecycle.service.js";
import { logAction } from "../utils/controllerLogger.js";
import {
  runRequiredTransaction,
  supportsRequiredTransactions,
} from "./requiredTransaction.service.js";
import {
  isArchivedDocument,
  withOperationalClientScope,
  withOperationalReportScope,
} from "../utils/archiveScope.js";
import { closeReviewItemsForAuthority, projectSourceSafely } from "./reviewProjection.service.js";

const models = {
  Activity,
  Client,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
};

const sessionOptions = (session) => (session ? { session } : {});

const withSession = (query, session) =>
  session && typeof query?.session === "function" ? query.session(session) : query;

const hasValidExecutionLease = (report, now) => {
  const expiresAt = report?.execution_lock?.expires_at;
  return Boolean(expiresAt && new Date(expiresAt) > now);
};

const noValidExecutionLeaseFilter = (now) => ({
  $or: [
    { execution_lock: { $exists: false } },
    { execution_lock: null },
    { "execution_lock.expires_at": { $exists: false } },
    { "execution_lock.expires_at": { $lte: now } },
  ],
});

export const supportsArchiveTransactions = supportsRequiredTransactions;

const runArchiveTransaction = async ({ mongooseInstance, work }) => {
  if (!supportsArchiveTransactions(mongooseInstance)) {
    logAction(
      "ArchiveLifecycle",
      "ARCHIVE_TRANSACTION_UNAVAILABLE",
      { transactionCapability: "unavailable" },
      "yellow"
    );
    return runRequiredTransaction({
      mongooseInstance,
      work,
      unavailableCode: "archive_transaction_unavailable",
      unavailableMessage:
        "Archive operations require a transaction-capable database deployment.",
    });
  }
  return runRequiredTransaction({ mongooseInstance, work });
};

const cancelUnsentClientArtifacts = async ({
  ReportRunModel,
  agencyId,
  reportIds,
  userId,
  now,
  session,
}) => {
  if (!reportIds.length) return { matchedCount: 0, modifiedCount: 0 };
  return ReportRunModel.updateMany(
    {
      agency_id: agencyId,
      report_id: { $in: reportIds },
      "client_report.dispatch.status": { $in: ["pending", "failed"] },
    },
    {
      $set: {
        "client_report.status": "cancelled",
        "client_report.dispatch.status": "not_required",
        "client_report.cancelled_at": now,
        "client_report.cancelled_by": userId || null,
      },
    },
    { session }
  );
};

const normalizeLegacyClientDispatches = async ({
  ReportRunModel,
  agencyId,
  reportIds,
  session,
}) => {
  if (!reportIds.length) return { matchedCount: 0, modifiedCount: 0 };
  const missingDispatchScope = {
    agency_id: agencyId,
    report_id: { $in: reportIds },
    client_report: { $ne: null },
    $or: [
      { "client_report.dispatch": { $exists: false } },
      { "client_report.dispatch": null },
      { "client_report.dispatch.status": { $exists: false } },
    ],
  };
  const reportRuns = await withSession(
    ReportRunModel.find(missingDispatchScope).select("_id client_report"),
    session
  );
  let modifiedCount = 0;

  for (const reportRun of reportRuns) {
    const result = await ReportRunModel.updateOne(
      {
        _id: reportRun._id,
        agency_id: agencyId,
        $or: [
          { "client_report.dispatch": { $exists: false } },
          { "client_report.dispatch": null },
          { "client_report.dispatch.status": { $exists: false } },
        ],
      },
      {
        $set: {
          "client_report.dispatch": buildLegacyDispatchState({
            reportRunId: reportRun._id,
            audience: "client",
            artifact: reportRun.client_report,
          }),
        },
      },
      { session }
    );
    modifiedCount += Number(result.modifiedCount || 0);
  }

  return { matchedCount: reportRuns.length, modifiedCount };
};

const findActiveClientDispatch = async ({
  ReportRunModel,
  agencyId,
  reportIds,
  session,
}) => {
  if (!reportIds.length) return null;
  return withSession(
    ReportRunModel.findOne({
      agency_id: agencyId,
      report_id: { $in: reportIds },
      "client_report.dispatch.status": "dispatching",
    }).select("_id report_id"),
    session
  );
};

const archiveActivity = ({
  ActivityModel,
  agencyId,
  clientId,
  reportId = null,
  userId,
  type,
  title,
  description,
  metadata,
  idempotencyKey,
  session,
}) =>
  recordActivity({
    agency_id: agencyId,
    client_id: clientId,
    report_id: reportId,
    user_id: userId,
    type,
    title,
    description,
    severity: "stable",
    metadata,
    idempotency_key: idempotencyKey,
    session,
    ActivityModel,
  });

export const archiveClientLifecycle = async ({
  agencyId,
  clientId,
  userId,
  now = new Date(),
  mongooseInstance = mongoose,
  Models = models,
  reviewAuthorityProcessor = closeReviewItemsForAuthority,
} = {}) => {
  const {
    Activity: ActivityModel,
    Client: ClientModel,
    MetaAdAccount: MetaAdAccountModel,
    MetaConnection: MetaConnectionModel,
    Report: ReportModel,
    ReportRun: ReportRunModel,
  } = Models;
  const lease = await acquireClientLifecycleLease({
    agencyId,
    clientId,
    operation: "archive",
    now,
    ClientModel,
  });

  if (!lease.acquired) {
    if (lease.reason === "client_not_found") return { outcome: "not_found" };
    if (lease.reason === "client_archived") {
      return {
        outcome: "already_archived",
        client: lease.client,
        archivedReportCount: 0,
      };
    }
    return { outcome: "lifecycle_in_progress" };
  }
  const lifecycleHeartbeat = startClientLifecycleLeaseHeartbeat({
    agencyId,
    clientId,
    token: lease.token,
    ClientModel,
  });

  try {
    await requireClientLifecycleLeaseOwnership({
      agencyId,
      clientId,
      token: lease.token,
      now,
      ClientModel,
    });
    const outcome = await runArchiveTransaction({
      mongooseInstance,
      work: async (session) => {
      const client = await withSession(
        ClientModel.findOne(
          withOperationalClientScope({
            _id: clientId,
            agency_id: agencyId,
            "lifecycle_lock.token": lease.token,
          })
        ),
        session
      );

      if (!client) {
        const error = new Error("Client lifecycle lease ownership was lost.");
        error.code = "client_lifecycle_operation_in_progress";
        error.status = 409;
        throw error;
      }

      const reports = await withSession(
        ReportModel.find(
          withOperationalReportScope({
            agency_id: agencyId,
            client_id: client._id,
          })
        ).select("_id name +execution_lock"),
        session
      );
      const lockedReportIds = reports
        .filter((report) => hasValidExecutionLease(report, now))
        .map((report) => report._id);

      if (lockedReportIds.length) {
        return {
          outcome: "execution_in_progress",
          reportIds: lockedReportIds,
        };
      }

      const reportIds = reports.map((report) => report._id);
      await normalizeLegacyClientDispatches({
        ReportRunModel,
        agencyId,
        reportIds,
        session,
      });
      const activeDispatch = await findActiveClientDispatch({
        ReportRunModel,
        agencyId,
        reportIds,
        session,
      });
      if (activeDispatch) {
        return {
          outcome: "dispatch_in_progress",
          reportIds: [activeDispatch.report_id],
        };
      }

      await cancelUnsentClientArtifacts({
        ReportRunModel,
        agencyId,
        reportIds,
        userId,
        now,
        session,
      });

      const reportArchiveResult = reportIds.length
        ? await ReportModel.updateMany(
            {
              $and: [
                withOperationalReportScope({
                  _id: { $in: reportIds },
                  agency_id: agencyId,
                  client_id: client._id,
                }),
                noValidExecutionLeaseFilter(now),
              ],
            },
            {
              $set: {
                is_archived: true,
                archived_at: now,
                archived_by: userId,
                status: "paused",
                next_run_at: null,
              },
            },
            sessionOptions(session)
          )
        : { matchedCount: 0, modifiedCount: 0 };

      if (Number(reportArchiveResult.matchedCount || 0) !== reportIds.length) {
        const error = new Error(
          "A report began executing while the client archive was being prepared."
        );
        error.code = "client_report_execution_in_progress";
        error.status = 409;
        throw error;
      }

      await MetaConnectionModel.updateMany(
        {
          agency_id: agencyId,
          client_id: client._id,
        },
        {
          $set: {
            is_active: false,
            status: "revoked",
            disconnected_at: now,
            last_error: "Legacy client connection disabled when the client was archived.",
          },
          $unset: {
            access_token: "",
            access_token_encrypted: "",
          },
        },
        sessionOptions(session)
      );

      await MetaAdAccountModel.updateMany(
        { agency_id: agencyId, client_id: client._id },
        {
          $set: { client_id: null, assignment_scope: null },
          $inc: { binding_revision: 1 },
        },
        sessionOptions(session)
      );

      const archivedClient = await ClientModel.findOneAndUpdate(
        withOperationalClientScope({
          _id: client._id,
          agency_id: agencyId,
          "lifecycle_lock.token": lease.token,
        }),
        {
          $set: {
            is_archived: true,
            archived_at: now,
            archived_by: userId,
          },
        },
        { new: true, ...sessionOptions(session) }
      );

      if (!archivedClient) {
        const error = new Error("Client archive state changed during the transition.");
        error.code = "client_archive_conflict";
        error.status = 409;
        throw error;
      }

      await archiveActivity({
        ActivityModel,
        agencyId,
        clientId: archivedClient._id,
        userId,
        type: "client_archived",
        title: `${archivedClient.name} archived`,
        description:
          "Client was removed from operational use. Historical reporting data was retained.",
        metadata: {
          client_id: archivedClient._id,
          client_name: archivedClient.name,
          archived_report_count: reportIds.length,
        },
        idempotencyKey: `lifecycle:client:${archivedClient._id}:archived`,
        session,
      });

      return {
        outcome: "archived",
        client: archivedClient,
        archivedReportCount: reportIds.length,
        transactional: true,
      };
      },
    });
    if (outcome?.outcome === "archived") {
      await projectSourceSafely(reviewAuthorityProcessor, { agencyId, clientId: outcome.client._id, limit: 50, now }, { operation: "client_archive_post_commit" });
    }
    return outcome;
  } finally {
    await lifecycleHeartbeat.stop();
    await releaseClientLifecycleLease({
      agencyId,
      clientId,
      token: lease.token,
      ClientModel,
    }).catch(() => null);
  }
};

export const archiveReportLifecycle = async ({
  agencyId,
  reportId,
  userId,
  now = new Date(),
  mongooseInstance = mongoose,
  Models = models,
} = {}) => {
  const {
    Activity: ActivityModel,
    Report: ReportModel,
    ReportRun: ReportRunModel,
  } = Models;
  const existingReport = await ReportModel.findOne({
    _id: reportId,
    agency_id: agencyId,
  });
  if (!existingReport) return { outcome: "not_found" };
  if (isArchivedDocument(existingReport)) {
    return { outcome: "already_archived", report: existingReport };
  }

  return runArchiveTransaction({
    mongooseInstance,
    work: async (session) => {
      const report = await withSession(
        ReportModel.findOne({ _id: reportId, agency_id: agencyId }).select(
          "+execution_lock"
        ),
        session
      );

      if (!report) return { outcome: "not_found" };
      if (isArchivedDocument(report)) {
        return { outcome: "already_archived", report };
      }
      if (hasValidExecutionLease(report, now)) {
        return { outcome: "execution_in_progress", reportIds: [report._id] };
      }

      await normalizeLegacyClientDispatches({
        ReportRunModel,
        agencyId,
        reportIds: [report._id],
        session,
      });

      const activeDispatch = await withSession(
        ReportRunModel.findOne({
          agency_id: agencyId,
          report_id: report._id,
          "client_report.dispatch.status": "dispatching",
        }).select("_id"),
        session
      );
      if (activeDispatch) {
        return { outcome: "dispatch_in_progress", reportIds: [report._id] };
      }

      await cancelUnsentClientArtifacts({
        ReportRunModel,
        agencyId,
        reportIds: [report._id],
        userId,
        now,
        session,
      });

      const archivedReport = await ReportModel.findOneAndUpdate(
        {
          $and: [
            withOperationalReportScope({
              _id: report._id,
              agency_id: agencyId,
            }),
            noValidExecutionLeaseFilter(now),
          ],
        },
        {
          $set: {
            is_archived: true,
            archived_at: now,
            archived_by: userId,
            status: "paused",
            next_run_at: null,
          },
        },
        { new: true, ...sessionOptions(session) }
      );

      if (!archivedReport) {
        return { outcome: "execution_in_progress", reportIds: [report._id] };
      }

      await archiveActivity({
        ActivityModel,
        agencyId,
        clientId: archivedReport.client_id,
        reportId: archivedReport._id,
        userId,
        type: "report_archived",
        title: `${archivedReport.name} archived`,
        description:
          "Report was removed from operational use. Historical runs and signals were retained.",
        metadata: {
          report_id: archivedReport._id,
          report_name: archivedReport.name,
          client_id: archivedReport.client_id,
        },
        idempotencyKey: `lifecycle:report:${archivedReport._id}:archived`,
        session,
      });

      return {
        outcome: "archived",
        report: archivedReport,
        transactional: true,
      };
    },
  });
};
