import { MetaAdAccount, MetaConnection } from "../models/index.js";
import { getMetaAccessToken } from "../utils/metaToken.js";

const createBindingError = (code, message, status, reason) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.reason = reason;
  return error;
};

const invalidRevisionError = () =>
  createBindingError(
    "META_BINDING_REVISION_INVALID",
    "The Meta ad account binding state is invalid.",
    409,
    "meta_binding_revision_invalid"
  );

const invalidBindingIdentifierError = () =>
  createBindingError(
    "META_REPORT_ACCOUNT_UNRESOLVED",
    "The Meta ad account identifier is invalid.",
    400,
    "meta_account_unresolved"
  );

const castMetaAccountIdentifier = ({ MetaAdAccountModel, path, value }) => {
  if (value == null) return value;

  try {
    const schemaPath = MetaAdAccountModel?.schema?.path?.(path);
    if (!schemaPath || typeof schemaPath.cast !== "function") return value;
    return schemaPath.cast(value);
  } catch {
    throw invalidBindingIdentifierError();
  }
};

const normalizeExplicitRevision = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  throw invalidRevisionError();
};

export const normalizeMetaBindingRevision = (accountOrRevision) => {
  if (accountOrRevision && typeof accountOrRevision === "object") {
    if (accountOrRevision.$errors?.binding_revision) throw invalidRevisionError();
    if (!Object.prototype.hasOwnProperty.call(accountOrRevision, "binding_revision")) {
      return 0;
    }
    return normalizeExplicitRevision(accountOrRevision.binding_revision);
  }

  return normalizeExplicitRevision(accountOrRevision);
};

export const normalizePersistedMetaBindingRevision = (rawAccount) => {
  if (!rawAccount) {
    throw createBindingError(
      "META_REPORT_ACCOUNT_UNRESOLVED",
      "The Meta ad account linked to this report could not be resolved.",
      400,
      "meta_account_unresolved"
    );
  }
  if (!Object.prototype.hasOwnProperty.call(rawAccount, "binding_revision")) {
    return { valid: true, revision: 0, source: "legacy_absent" };
  }

  return {
    valid: true,
    revision: normalizeExplicitRevision(rawAccount.binding_revision),
    source: "explicit",
  };
};

export const readPersistedMetaBindingRevision = async ({
  accountId,
  agencyId,
  session = null,
  MetaAdAccountModel = MetaAdAccount,
}) => {
  const persistedAccountId = castMetaAccountIdentifier({
    MetaAdAccountModel,
    path: "_id",
    value: accountId,
  });
  const persistedAgencyId = castMetaAccountIdentifier({
    MetaAdAccountModel,
    path: "agency_id",
    value: agencyId,
  });
  const rawAccount = await MetaAdAccountModel.collection.findOne(
    {
      _id: persistedAccountId,
      ...(agencyId != null ? { agency_id: persistedAgencyId } : {}),
    },
    {
      projection: { binding_revision: 1 },
      ...(session ? { session } : {}),
    }
  );
  return normalizePersistedMetaBindingRevision(rawAccount);
};

const revisionPredicate = (expectedBindingRevision) => {
  if (expectedBindingRevision === undefined) return {};
  const revision = normalizeMetaBindingRevision(expectedBindingRevision);
  if (revision === 0) {
    return {
      $or: [
        { binding_revision: 0 },
        { binding_revision: { $exists: false } },
      ],
    };
  }
  return { binding_revision: revision };
};

export const buildValidMetaAccountBindingPredicate = ({
  accountId,
  agencyId,
  clientId,
  expectedBindingRevision,
}) => ({
  _id: accountId,
  agency_id: agencyId,
  client_id: clientId,
  is_active: true,
  is_accessible: true,
  ...revisionPredicate(expectedBindingRevision),
});

export const buildPermittedWorkspaceConnectionPredicate = ({
  agencyId,
  connectionId,
  requireActive = true,
} = {}) => ({
  ...(connectionId ? { _id: connectionId } : {}),
  ...(agencyId ? { agency_id: agencyId } : {}),
  client_id: null,
  $or: [
    { connection_scope: "workspace" },
    { connection_scope: null },
    { connection_scope: { $exists: false } },
  ],
  ...(requireActive ? { is_active: true } : {}),
});

export const isPermittedWorkspaceConnection = (connection) =>
  Boolean(
    connection &&
      connection.client_id == null &&
      (connection.connection_scope === "workspace" ||
        connection.connection_scope == null)
  );

const requireSession = (session) => {
  if (session) return;
  throw createBindingError(
    "META_BINDING_TRANSACTION_REQUIRED",
    "Meta account binding validation requires a database transaction.",
    503,
    "meta_binding_transaction_required"
  );
};

const classifyBindingFailure = async ({
  accountId,
  agencyId,
  clientId,
  expectedBindingRevision,
  session,
  MetaAdAccountModel,
  persistedRevisionReader,
}) => {
  const account = await MetaAdAccountModel.findOne({
    _id: accountId,
    agency_id: agencyId,
  })
    .select("+binding_fence_counter")
    .session(session);

  if (!account) {
    throw createBindingError(
      "META_REPORT_ACCOUNT_UNRESOLVED",
      "The Meta ad account linked to this report could not be resolved.",
      400,
      "meta_account_unresolved"
    );
  }
  const { revision: bindingRevision } = await persistedRevisionReader({
    accountId,
    agencyId,
    session,
    MetaAdAccountModel,
  });
  if (account.is_active !== true || account.is_accessible !== true) {
    throw createBindingError(
      "META_ACCOUNT_INACCESSIBLE",
      "The Meta ad account used by this report is no longer accessible.",
      400,
      "meta_account_inaccessible"
    );
  }
  if (!account.client_id || String(account.client_id) !== String(clientId)) {
    throw createBindingError(
      "META_REPORT_BINDING_INVALID",
      "The Meta ad account is no longer assigned to this report's client.",
      409,
      account.client_id
        ? "meta_account_client_mismatch"
        : "meta_account_unassigned"
    );
  }
  if (
    expectedBindingRevision !== undefined &&
    bindingRevision !==
      normalizeMetaBindingRevision(expectedBindingRevision)
  ) {
    throw createBindingError(
      "META_ACCOUNT_ASSIGNMENT_CHANGED",
      "The Meta ad account assignment changed during report processing.",
      409,
      "meta_account_assignment_changed"
    );
  }

  throw createBindingError(
    "META_REPORT_BINDING_INVALID",
    "The Meta ad account binding is no longer valid.",
    409,
    "meta_account_binding_invalid"
  );
};

export const requirePermittedWorkspaceConnection = async ({
  account,
  agencyId,
  session = null,
  includeToken = false,
  MetaConnectionModel = MetaConnection,
}) => {
  let query = MetaConnectionModel.findOne(
    buildPermittedWorkspaceConnectionPredicate({
      connectionId: account.meta_connection_id,
      agencyId,
    })
  );
  if (includeToken) query = query.select("+access_token +access_token_encrypted");
  if (session) query = query.session(session);
  const connection = await query;

  if (!connection) {
    throw createBindingError(
      "META_NOT_CONNECTED",
      "Meta Ads is not connected for this workspace.",
      400,
      "workspace_meta_connection_invalid"
    );
  }
  if (["expired", "permission_error", "revoked"].includes(connection.status)) {
    throw createBindingError(
      "META_RECONNECT_REQUIRED",
      "Meta access needs attention. Reconnect Meta from Settings.",
      400,
      "workspace_meta_reconnect_required"
    );
  }
  if (connection.token_expires_at && connection.token_expires_at <= new Date()) {
    throw createBindingError(
      "META_RECONNECT_REQUIRED",
      "Meta access has expired. Reconnect Meta from Settings.",
      400,
      "workspace_meta_reconnect_required"
    );
  }

  if (!includeToken) return { connection };
  const accessToken = getMetaAccessToken(connection);
  if (!accessToken) {
    throw createBindingError(
      "META_RECONNECT_REQUIRED",
      "Meta access is unavailable. Reconnect Meta from Settings.",
      400,
      "workspace_meta_reconnect_required"
    );
  }
  return { connection, accessToken };
};

export const fenceMetaAccountBindingInTransaction = async ({
  accountId,
  agencyId,
  clientId,
  expectedBindingRevision,
  session,
  requireConnection = true,
  MetaAdAccountModel = MetaAdAccount,
  MetaConnectionModel = MetaConnection,
  persistedRevisionReader = readPersistedMetaBindingRevision,
}) => {
  requireSession(session);
  const account = await MetaAdAccountModel.findOneAndUpdate(
    buildValidMetaAccountBindingPredicate({
      accountId,
      agencyId,
      clientId,
      expectedBindingRevision,
    }),
    { $inc: { binding_fence_counter: 1 } },
    { new: true, session }
  ).select("+binding_fence_counter");

  if (!account) {
    await classifyBindingFailure({
      accountId,
      agencyId,
      clientId,
      expectedBindingRevision,
      session,
      MetaAdAccountModel,
      persistedRevisionReader,
    });
  }
  const { revision: bindingRevision } = await persistedRevisionReader({
    accountId,
    agencyId,
    session,
    MetaAdAccountModel,
  });
  if (requireConnection) {
    await requirePermittedWorkspaceConnection({
      account,
      agencyId,
      session,
      MetaConnectionModel,
    });
  }

  return { account, bindingRevision };
};

export const resolveValidatedMetaAccountBinding = async ({
  accountId,
  agencyId,
  clientId,
  expectedBindingRevision,
  requireToken = true,
  MetaAdAccountModel = MetaAdAccount,
  MetaConnectionModel = MetaConnection,
  persistedRevisionReader = readPersistedMetaBindingRevision,
}) => {
  if (!accountId) {
    throw createBindingError(
      "META_REPORT_ACCOUNT_UNRESOLVED",
      "A Meta ad account must be assigned before live Meta data can be read.",
      400,
      "meta_account_unresolved"
    );
  }
  const queryAccountId = castMetaAccountIdentifier({
    MetaAdAccountModel,
    path: "_id",
    value: accountId,
  });
  const queryAgencyId = castMetaAccountIdentifier({
    MetaAdAccountModel,
    path: "agency_id",
    value: agencyId,
  });
  const account = await MetaAdAccountModel.findOne({
    _id: queryAccountId,
    agency_id: queryAgencyId,
  });
  if (!account) {
    throw createBindingError(
      "META_REPORT_ACCOUNT_UNRESOLVED",
      "The Meta ad account linked to this report could not be resolved.",
      400,
      "meta_account_unresolved"
    );
  }
  const { revision: bindingRevision } = await persistedRevisionReader({
    accountId,
    agencyId,
    MetaAdAccountModel,
  });
  if (account.is_active !== true || account.is_accessible !== true) {
    throw createBindingError(
      "META_ACCOUNT_INACCESSIBLE",
      "The Meta ad account used by this report is no longer accessible.",
      400,
      "meta_account_inaccessible"
    );
  }
  if (!account.client_id || String(account.client_id) !== String(clientId)) {
    throw createBindingError(
      "META_REPORT_BINDING_INVALID",
      "The Meta ad account is no longer assigned to this report's client.",
      409,
      account.client_id
        ? "meta_account_client_mismatch"
        : "meta_account_unassigned"
    );
  }
  if (
    expectedBindingRevision !== undefined &&
    bindingRevision !== normalizeMetaBindingRevision(expectedBindingRevision)
  ) {
    throw createBindingError(
      "META_ACCOUNT_ASSIGNMENT_CHANGED",
      "The Meta ad account assignment changed during report processing.",
      409,
      "meta_account_assignment_changed"
    );
  }

  const connectionContext = await requirePermittedWorkspaceConnection({
    account,
    agencyId,
    includeToken: requireToken,
    MetaConnectionModel,
  });
  return {
    ...connectionContext,
    metaAdAccount: account,
    bindingRevision,
    externalAdAccountId: account.ad_account_id,
  };
};
