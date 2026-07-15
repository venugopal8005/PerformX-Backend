import { ReportRun, Signal } from "../models/index.js";

const defaultModels = { ReportRun, Signal };

const existsWithSession = async (Model, filter, session) => {
  const query = Model.exists(filter);
  if (session && typeof query?.session === "function") query.session(session);
  return Boolean(await query);
};

export const hasReportHistoricalEvidence = async ({
  agencyId,
  reportId,
  session = null,
  Models = defaultModels,
} = {}) => {
  const scope = { agency_id: agencyId, report_id: reportId };
  const reportRunExists = await existsWithSession(
    Models.ReportRun,
    scope,
    session
  );
  const signalExists = await existsWithSession(Models.Signal, scope, session);

  return {
    exists: reportRunExists || signalExists,
    reportRunExists,
    signalExists,
  };
};

export const createReportClientLineageLockedError = () => {
  const error = new Error(
    "This report already has historical performance evidence and cannot be moved to another client."
  );
  error.code = "REPORT_CLIENT_LINEAGE_LOCKED";
  error.status = 409;
  error.reason = "historical_evidence_exists";
  return error;
};

export const createReportExecutionInProgressError = () => {
  const error = new Error(
    "This report is currently running. Try moving it after the execution finishes."
  );
  error.code = "report_execution_in_progress";
  error.status = 409;
  return error;
};

export const hasActiveReportExecutionLease = (
  report,
  now = new Date()
) => {
  const expiresAt = report?.execution_lock?.expires_at;
  return Boolean(expiresAt && new Date(expiresAt) > now);
};

export const assertReportClientReparentAllowed = async ({
  agencyId,
  report,
  session,
  now = new Date(),
  Models = defaultModels,
} = {}) => {
  if (hasActiveReportExecutionLease(report, now)) {
    throw createReportExecutionInProgressError();
  }

  const evidence = await hasReportHistoricalEvidence({
    agencyId,
    reportId: report._id,
    session,
    Models,
  });
  if (evidence.exists) throw createReportClientLineageLockedError();
  return evidence;
};

