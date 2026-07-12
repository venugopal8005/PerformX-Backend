import dotenv from "dotenv";
import mongoose from "mongoose";

import { MetaAdAccount } from "../src/models/MetaAdAccount.js";
import { MetaConnection } from "../src/models/MetaConnection.js";
import { Report } from "../src/models/Report.js";
import { ReportRun } from "../src/models/ReportRun.js";

const defaultEnvPath = process.cwd().endsWith("/backend") ? ".env" : "backend/.env";
dotenv.config({ path: process.env.ENV_FILE || defaultEnvPath });

const apply = process.argv.includes("--apply");

const summary = {
  workspaces: 0,
  workspaceConnectionsFound: 0,
  legacyConnectionsFound: 0,
  canonicalConnectionsSelected: 0,
  canonicalConnectionsCreated: 0,
  metaAdAccountsCreated: 0,
  metaAdAccountsRelinked: 0,
  reportsBackfilled: 0,
  reportRunsBackfilled: 0,
  unresolvedReports: [],
  ambiguousWorkspaces: [],
  legacyRecordsDeactivated: 0,
};

const sameIdentity = (left, right) => {
  if (left.meta_user_id && right.meta_user_id) {
    return String(left.meta_user_id) === String(right.meta_user_id);
  }

  return Boolean(
    left.access_token_encrypted &&
      right.access_token_encrypted &&
      left.access_token_encrypted === right.access_token_encrypted
  );
};

const chooseCanonical = async (agencyId, workspaceConnections, legacyConnections) => {
  const activeWorkspace = workspaceConnections.filter((connection) => connection.is_active);

  if (activeWorkspace.length === 1) return { connection: activeWorkspace[0], created: false };
  if (activeWorkspace.length > 1 || workspaceConnections.length > 1) return null;
  if (workspaceConnections.length === 1) return { connection: workspaceConnections[0], created: false };
  if (!legacyConnections.length) return { connection: null, created: false };

  const first = legacyConnections[0];
  if (!legacyConnections.every((connection) => sameIdentity(first, connection))) return null;

  if (!apply) {
    return {
      connection: { ...first.toObject(), _id: first._id, agency_id: agencyId, client_id: null },
      created: true,
      dryRun: true,
    };
  }

  const canonical = await MetaConnection.create({
    agency_id: agencyId,
    connection_scope: "workspace",
    client_id: null,
    meta_user_id: first.meta_user_id,
    meta_user_name: first.meta_user_name,
    business_id: first.business_id,
    access_token_encrypted: first.access_token_encrypted,
    token_expires_at: first.token_expires_at,
    permissions: first.permissions || [],
    status: first.is_active ? first.status || "active" : "revoked",
    last_synced_at: first.last_synced_at,
    last_error: first.last_error,
    is_active: first.is_active,
    connected_by: first.connected_by,
    connected_at: first.createdAt || new Date(),
  });

  return { connection: canonical, created: true };
};

const migrateWorkspace = async (agencyId) => {
  const [workspaceConnections, legacyConnections, accounts, reports] = await Promise.all([
    MetaConnection.find({ agency_id: agencyId, client_id: null })
      .select("+access_token +access_token_encrypted")
      .sort({ updatedAt: -1 }),
    MetaConnection.find({ agency_id: agencyId, client_id: { $ne: null } })
      .select("+access_token +access_token_encrypted")
      .sort({ updatedAt: -1 }),
    MetaAdAccount.find({ agency_id: agencyId }),
    Report.find({ agency_id: agencyId }),
  ]);

  summary.workspaceConnectionsFound += workspaceConnections.length;
  summary.legacyConnectionsFound += legacyConnections.length;

  const choice = await chooseCanonical(agencyId, workspaceConnections, legacyConnections);
  if (!choice) {
    summary.ambiguousWorkspaces.push(String(agencyId));
    return;
  }

  const canonical = choice.connection;
  if (!canonical) return;
  summary.canonicalConnectionsSelected += 1;
  if (choice.created) summary.canonicalConnectionsCreated += 1;

  if (apply && !choice.created && canonical.connection_scope !== "workspace") {
    canonical.connection_scope = "workspace";
    canonical.client_id = null;
    canonical.connected_at = canonical.connected_at || canonical.createdAt || new Date();
    await canonical.save();
  }

  const safeLegacyIds = new Set(
    legacyConnections
      .filter((legacy) => sameIdentity(canonical, legacy))
      .map((legacy) => String(legacy._id))
  );

  const legacyAccountsByExternalId = new Map();
  const externalIdsByClient = new Map();
  for (const legacy of legacyConnections) {
    if (!safeLegacyIds.has(String(legacy._id)) || !legacy.ad_account_id) continue;
    const key = String(legacy.ad_account_id);
    legacyAccountsByExternalId.set(key, [
      ...(legacyAccountsByExternalId.get(key) || []),
      legacy,
    ]);
    if (legacy.client_id) {
      const clientKey = String(legacy.client_id);
      externalIdsByClient.set(
        clientKey,
        new Set([...(externalIdsByClient.get(clientKey) || []), key])
      );
    }
  }

  for (const [externalId, sources] of legacyAccountsByExternalId.entries()) {
    if (accounts.some((account) => account.ad_account_id === externalId)) continue;

    const clientIds = [
      ...new Set(sources.map((source) => String(source.client_id || "")).filter(Boolean)),
    ];
    const source = sources[0];
    const hasUnambiguousClient =
      clientIds.length === 1 && externalIdsByClient.get(clientIds[0])?.size === 1;
    const accountData = {
      _id: new mongoose.Types.ObjectId(),
      agency_id: agencyId,
      meta_connection_id: canonical._id,
      client_id: hasUnambiguousClient ? source.client_id : null,
      assignment_scope: hasUnambiguousClient ? "v1" : null,
      ad_account_id: externalId,
      name: source.ad_account_name || externalId,
      last_synced_at: source.last_synced_at || source.updatedAt || new Date(),
      last_seen_at: source.last_synced_at || source.updatedAt || new Date(),
      is_accessible: source.is_active !== false,
      is_active: true,
    };

    summary.metaAdAccountsCreated += 1;
    if (apply) {
      const created = await MetaAdAccount.create(accountData);
      accounts.push(created);
    } else {
      accounts.push(accountData);
    }
  }

  for (const account of accounts) {
    if (String(account.meta_connection_id) === String(canonical._id)) continue;
    if (!safeLegacyIds.has(String(account.meta_connection_id))) continue;

    summary.metaAdAccountsRelinked += 1;
    if (apply) {
      account.meta_connection_id = canonical._id;
      await account.save();
    }
  }

  const accountsByClient = new Map();
  for (const account of accounts) {
    if (!account.client_id) continue;
    const key = String(account.client_id);
    accountsByClient.set(key, [...(accountsByClient.get(key) || []), account]);
  }

  for (const [clientId, clientAccounts] of accountsByClient.entries()) {
    if (clientAccounts.length !== 1) continue;
    if (apply && clientAccounts[0].assignment_scope !== "v1") {
      clientAccounts[0].assignment_scope = "v1";
      await clientAccounts[0].save();
    }
  }

  for (const report of reports) {
    let account = report.meta_ad_account_id
      ? accounts.find((item) => String(item._id) === String(report.meta_ad_account_id))
      : null;

    if (!account) {
      const assigned = accountsByClient.get(String(report.client_id)) || [];
      if (assigned.length === 1) account = assigned[0];
    }

    if (!account || String(account.agency_id) !== String(agencyId)) {
      summary.unresolvedReports.push(String(report._id));
      continue;
    }

    if (!report.meta_ad_account_id) summary.reportsBackfilled += 1;
    if (apply) {
      report.meta_ad_account_id = account._id;
      report.meta_account_external_id_snapshot =
        report.meta_account_external_id_snapshot || account.ad_account_id;
      report.meta_account_name_snapshot = report.meta_account_name_snapshot || account.name;
      await report.save();
    }

    const runQuery = {
      agency_id: agencyId,
      report_id: report._id,
      meta_ad_account_id: null,
    };

    if (apply) {
      const runResult = await ReportRun.updateMany(runQuery, {
        $set: {
          meta_ad_account_id: account._id,
          meta_account_external_id_snapshot: account.ad_account_id,
          meta_account_name_snapshot: account.name,
        },
      });
      summary.reportRunsBackfilled += runResult.modifiedCount;
    } else {
      summary.reportRunsBackfilled += await ReportRun.countDocuments(runQuery);
    }
  }

  const safeLegacyConnections = legacyConnections.filter((legacy) =>
    safeLegacyIds.has(String(legacy._id))
  );
  summary.legacyRecordsDeactivated += safeLegacyConnections.length;

  if (apply && safeLegacyConnections.length) {
    await MetaConnection.updateMany(
      { _id: { $in: safeLegacyConnections.map((connection) => connection._id) } },
      {
        $set: {
          connection_scope: "legacy_client",
          is_active: false,
          status: "revoked",
          last_error: "Deactivated by workspace Meta connection migration.",
        },
        $unset: { access_token: "", access_token_encrypted: "" },
      }
    );
  }
};

const main = async () => {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required");
  await mongoose.connect(process.env.MONGO_URI, {
    autoIndex: false,
    autoCreate: false,
  });

  const [connectionAgencyIds, reportAgencyIds] = await Promise.all([
    MetaConnection.distinct("agency_id"),
    Report.distinct("agency_id"),
  ]);
  const agencyIds = [
    ...new Map(
      [...connectionAgencyIds, ...reportAgencyIds].map((agencyId) => [String(agencyId), agencyId])
    ).values(),
  ];
  summary.workspaces = agencyIds.length;

  for (const agencyId of agencyIds) {
    await migrateWorkspace(agencyId);
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }, null, 2));
};

try {
  await main();
} catch (error) {
  console.error(`Meta migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
