import { MetaAdAccount, MetaConnection, Report } from "../models/index.js";
import { isPermittedWorkspaceConnection } from "./metaAccountBinding.service.js";

const defaultModels = { MetaAdAccount, MetaConnection, Report };

export const auditCurrentReportMetaBindings = async ({
  Models = defaultModels,
  now = new Date(),
} = {}) => {
  const reports = await Models.Report.find({})
    .select("agency_id client_id meta_ad_account_id is_archived status")
    .lean();
  const accountIds = reports.map((report) => report.meta_ad_account_id).filter(Boolean);
  const accounts = await Models.MetaAdAccount.find({ _id: { $in: accountIds } })
    .select(
      "agency_id client_id meta_connection_id is_active is_accessible"
    )
    .lean();
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));
  const connectionIds = accounts.map((account) => account.meta_connection_id).filter(Boolean);
  const connections = await Models.MetaConnection.find({ _id: { $in: connectionIds } })
    .select("agency_id client_id connection_scope is_active status token_expires_at")
    .lean();
  const connectionById = new Map(
    connections.map((connection) => [String(connection._id), connection])
  );

  const result = {
    reports_scanned: reports.length,
    reports_with_meta_binding: 0,
    valid_current_bindings: 0,
    missing_meta_account: 0,
    meta_account_unassigned: 0,
    meta_account_client_mismatch: 0,
    meta_account_inactive: 0,
    meta_account_inaccessible: 0,
    workspace_connection_invalid: 0,
    active_reports_with_invalid_binding: 0,
    archived_reports_with_invalid_binding: 0,
  };

  for (const report of reports) {
    let invalidReason = null;
    if (!report.meta_ad_account_id) {
      invalidReason = "missing_meta_account";
    } else {
      result.reports_with_meta_binding += 1;
      const account = accountById.get(String(report.meta_ad_account_id));
      if (!account || String(account.agency_id) !== String(report.agency_id)) {
        invalidReason = "missing_meta_account";
      } else if (!account.client_id) {
        invalidReason = "meta_account_unassigned";
      } else if (String(account.client_id) !== String(report.client_id)) {
        invalidReason = "meta_account_client_mismatch";
      } else if (account.is_active !== true) {
        invalidReason = "meta_account_inactive";
      } else if (account.is_accessible !== true) {
        invalidReason = "meta_account_inaccessible";
      } else {
        const connection = connectionById.get(String(account.meta_connection_id));
        const connectionInvalid =
          !connection ||
          String(connection.agency_id) !== String(report.agency_id) ||
          !isPermittedWorkspaceConnection(connection) ||
          connection.is_active !== true ||
          ["expired", "permission_error", "revoked"].includes(connection.status) ||
          (connection.token_expires_at && connection.token_expires_at <= now);
        if (connectionInvalid) invalidReason = "workspace_connection_invalid";
      }
    }

    if (!invalidReason) {
      result.valid_current_bindings += 1;
      continue;
    }
    result[invalidReason] += 1;
    if (report.is_archived === true) {
      result.archived_reports_with_invalid_binding += 1;
    } else if (report.status === "active") {
      result.active_reports_with_invalid_binding += 1;
    }
  }

  return result;
};
