import { Client, MetaAdAccount, MetaConnection } from "../models/index.js";
import { getMetaAccessToken } from "../utils/metaToken.js";
import { isArchivedDocument } from "../utils/archiveScope.js";
import {
  buildPermittedWorkspaceConnectionPredicate,
  readPersistedMetaBindingRevision,
  resolveValidatedMetaAccountBinding,
} from "./metaAccountBinding.service.js";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
const MAX_GRAPH_PAGES = 100;

export class MetaContextError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = "MetaContextError";
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

export const metaErrorResponse = (error, fallbackMessage = "Meta request failed") => ({
  success: false,
  code: error?.code || "META_REQUEST_FAILED",
  message: error?.message || fallbackMessage,
  ...(error?.reason ? { reason: error.reason } : {}),
  ...(error?.invalidCampaignIds
    ? { invalidCampaignIds: error.invalidCampaignIds }
    : {}),
});

const fetchGraphPages = async (initialUrl) => {
  const rows = [];
  const visited = new Set();
  let nextUrl = initialUrl;
  let pageCount = 0;

  while (nextUrl) {
    if (visited.has(nextUrl) || pageCount >= MAX_GRAPH_PAGES) {
      throw new MetaContextError(
        "META_PAGINATION_LIMIT",
        "Meta returned too many result pages. Narrow the request and try again.",
        502
      );
    }

    visited.add(nextUrl);
    pageCount += 1;

    const response = await fetch(nextUrl);
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new MetaContextError(
        "META_API_ERROR",
        data.error?.message || "Meta API request failed.",
        502
      );
    }

    rows.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
  }

  return rows;
};

export const findWorkspaceMetaConnection = async (
  agencyId,
  { includeToken = false, requireActive = true } = {}
) => {
  const selection = includeToken ? "+access_token +access_token_encrypted" : "";
  let connection = await MetaConnection.findOne({
    ...buildPermittedWorkspaceConnectionPredicate({
      agencyId,
      requireActive,
    }),
    connection_scope: "workspace",
  }).select(selection);

  if (connection) return connection;

  const legacyWorkspaceCandidates = await MetaConnection.find({
    ...buildPermittedWorkspaceConnectionPredicate({
      agencyId,
      requireActive,
    }),
    connection_scope: null,
  })
    .select(selection)
    .sort({ updatedAt: -1 })
    .limit(2);

  if (legacyWorkspaceCandidates.length > 1) {
    throw new MetaContextError(
      "META_RECONNECT_REQUIRED",
      "Multiple workspace Meta connections need migration. Reconnect Meta from Settings.",
      409
    );
  }

  return legacyWorkspaceCandidates[0] || null;
};

export const requireWorkspaceMetaConnection = async (agencyId, options = {}) => {
  const connection = await findWorkspaceMetaConnection(agencyId, {
    includeToken: true,
    ...options,
  });

  if (!connection) {
    throw new MetaContextError(
      "META_NOT_CONNECTED",
      "Meta Ads is not connected for this workspace.",
      400
    );
  }

  if (["expired", "permission_error", "revoked"].includes(connection.status)) {
    throw new MetaContextError(
      "META_RECONNECT_REQUIRED",
      "Meta access needs attention. Reconnect Meta from Settings.",
      400
    );
  }

  if (connection.token_expires_at && connection.token_expires_at <= new Date()) {
    throw new MetaContextError(
      "META_RECONNECT_REQUIRED",
      "Meta access has expired. Reconnect Meta from Settings.",
      400
    );
  }

  const accessToken = getMetaAccessToken(connection);
  if (!accessToken) {
    throw new MetaContextError(
      "META_RECONNECT_REQUIRED",
      "Meta access is unavailable. Reconnect Meta from Settings.",
      400
    );
  }

  return { connection, accessToken };
};

export const getAssignedMetaAccountForClient = async ({
  agencyId,
  clientId,
  requireAccessible = true,
}) => {
  const client = await Client.findOne({ _id: clientId, agency_id: agencyId });

  if (!client) {
    throw new MetaContextError("CLIENT_NOT_FOUND", "Client not found.", 404);
  }
  if (isArchivedDocument(client)) {
    throw new MetaContextError(
      "CLIENT_ARCHIVED",
      "Archived clients cannot receive Meta account assignments or create reports.",
      409
    );
  }

  const accounts = await MetaAdAccount.find({
    agency_id: agencyId,
    client_id: client._id,
    is_active: true,
    ...(requireAccessible ? { is_accessible: true } : {}),
  }).limit(2);

  if (!accounts.length) {
    throw new MetaContextError(
      "META_ACCOUNT_NOT_ASSIGNED",
      `No Meta ad account is assigned to ${client.name}.`,
      400
    );
  }

  if (accounts.length > 1) {
    throw new MetaContextError(
      "META_ACCOUNT_ASSIGNMENT_AMBIGUOUS",
      "This client has multiple Meta ad accounts assigned. Resolve the assignment in Settings.",
      409
    );
  }

  return { client, metaAdAccount: accounts[0] };
};

export const resolveMetaContextForAccount = async ({
  agencyId,
  metaAdAccountId,
  requireAccessible = true,
}) => {
  if (!metaAdAccountId) {
    throw new MetaContextError(
      "META_REPORT_ACCOUNT_UNRESOLVED",
      "A Meta ad account must be assigned to this report before it can run.",
      400
    );
  }

  const metaAdAccount = await MetaAdAccount.findOne({
    _id: metaAdAccountId,
    agency_id: agencyId,
  });

  if (!metaAdAccount) {
    throw new MetaContextError(
      "META_REPORT_ACCOUNT_UNRESOLVED",
      "The Meta ad account linked to this report could not be resolved.",
      400
    );
  }

  if (
    requireAccessible &&
    (metaAdAccount.is_active === false || metaAdAccount.is_accessible === false)
  ) {
    throw new MetaContextError(
      "META_ACCOUNT_INACCESSIBLE",
      "The Meta ad account used by this report is no longer accessible.",
      400
    );
  }

  if (!metaAdAccount.client_id) {
    throw new MetaContextError(
      "META_ACCOUNT_NOT_ASSIGNED",
      "This Meta ad account must be assigned to a client before campaigns can be refreshed.",
      400
    );
  }

  await readPersistedMetaBindingRevision({
    accountId: metaAdAccount._id,
    agencyId,
  });

  const connection = await MetaConnection.findOne({
    ...buildPermittedWorkspaceConnectionPredicate({
      agencyId,
      connectionId: metaAdAccount.meta_connection_id,
    }),
  }).select("+access_token +access_token_encrypted");

  if (!connection) {
    throw new MetaContextError(
      "META_NOT_CONNECTED",
      "Meta Ads is not connected for this workspace.",
      400
    );
  }

  if (["expired", "permission_error", "revoked"].includes(connection.status)) {
    throw new MetaContextError(
      "META_RECONNECT_REQUIRED",
      "Meta access needs attention. Reconnect Meta from Settings.",
      400
    );
  }

  if (connection.token_expires_at && connection.token_expires_at <= new Date()) {
    throw new MetaContextError(
      "META_RECONNECT_REQUIRED",
      "Meta access has expired. Reconnect Meta from Settings.",
      400
    );
  }

  const accessToken = getMetaAccessToken(connection);
  if (!accessToken) {
    throw new MetaContextError(
      "META_RECONNECT_REQUIRED",
      "Meta access is unavailable. Reconnect Meta from Settings.",
      400
    );
  }

  return {
    connection,
    metaAdAccount,
    accessToken,
    externalAdAccountId: metaAdAccount.ad_account_id,
  };
};

export const resolveValidatedMetaContextForReport = async (
  report,
  { expectedClientId, expectedBindingRevision } = {}
) => {
  if (isArchivedDocument(report)) {
    throw new MetaContextError(
      "REPORT_ARCHIVED",
      "Archived reports cannot be used for live Meta operations.",
      409
    );
  }

  if (!report?.meta_ad_account_id) {
    throw new MetaContextError(
      "META_REPORT_ACCOUNT_UNRESOLVED",
      "A Meta ad account must be assigned to this report before it can run.",
      400
    );
  }

  return resolveValidatedMetaAccountBinding({
    agencyId: report.agency_id,
    accountId: report.meta_ad_account_id,
    clientId: expectedClientId || report.client_id,
    expectedBindingRevision,
  });
};

export const resolveMetaContextForReport = resolveValidatedMetaContextForReport;

export const fetchCampaignsForMetaAccount = async ({ accessToken, externalAdAccountId }) => {
  const url = new URL(
    `https://graph.facebook.com/${GRAPH_VERSION}/${externalAdAccountId}/campaigns`
  );
  url.searchParams.set("fields", "id,name,status,objective");
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", accessToken);

  return fetchGraphPages(url.toString());
};

export const validateCampaignsForMetaAccount = async ({
  accessToken,
  externalAdAccountId,
  campaigns = [],
}) => {
  const requestedIds = campaigns
    .map((campaign) => String(campaign.campaign_id || campaign.campaignId || "").trim())
    .filter(Boolean);

  if (!requestedIds.length) return [];

  const availableCampaigns = await fetchCampaignsForMetaAccount({
    accessToken,
    externalAdAccountId,
  });
  const validIds = new Set(availableCampaigns.map((campaign) => String(campaign.id)));
  const invalidCampaignIds = requestedIds.filter((campaignId) => !validIds.has(campaignId));

  if (invalidCampaignIds.length) {
    throw new MetaContextError(
      "INVALID_META_CAMPAIGNS",
      "One or more selected campaigns do not belong to the report's Meta ad account.",
      400,
      { invalidCampaignIds }
    );
  }

  return availableCampaigns;
};

export const fetchAllAccessibleMetaAdAccounts = async (accessToken) => {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/me/adaccounts`);
  url.searchParams.set(
    "fields",
    "id,account_id,name,currency,timezone_name,account_status"
  );
  url.searchParams.set("limit", "200");
  url.searchParams.set("access_token", accessToken);

  return fetchGraphPages(url.toString());
};
