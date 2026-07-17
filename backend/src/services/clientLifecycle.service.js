import crypto from "crypto";

import { Client } from "../models/Client.js";
import { withOperationalClientScope } from "../utils/archiveScope.js";

export const CLIENT_LIFECYCLE_LEASE_MS = 5 * 60 * 1000;
export const CLIENT_LIFECYCLE_HEARTBEAT_MS = 60 * 1000;

const noActiveLifecycleLeaseFilter = (now) => ({
  $or: [
    { lifecycle_lock: { $exists: false } },
    { lifecycle_lock: null },
    { "lifecycle_lock.expires_at": { $exists: false } },
    { "lifecycle_lock.expires_at": { $lte: now } },
  ],
});

export const createClientLifecycleError = (reason) => {
  const definitions = {
    client_not_found: {
      code: "CLIENT_NOT_FOUND",
      message: "Client not found.",
      status: 404,
    },
    client_archived: {
      code: "CLIENT_ARCHIVED",
      message: "Archived clients cannot be used for this operation.",
      status: 409,
    },
    client_lifecycle_operation_in_progress: {
      code: "client_lifecycle_operation_in_progress",
      message: "Another client lifecycle operation is in progress. Try again shortly.",
      status: 409,
    },
    client_lifecycle_lease_lost: {
      code: "client_lifecycle_lease_lost",
      message: "Client lifecycle ownership was lost. Retry the operation.",
      status: 409,
    },
  };
  const definition = definitions[reason] || definitions.client_lifecycle_operation_in_progress;
  const error = new Error(definition.message);
  error.code = definition.code;
  error.status = definition.status;
  return error;
};

export const acquireClientLifecycleLease = async ({
  agencyId,
  clientId,
  operation,
  now = new Date(),
  leaseMs = CLIENT_LIFECYCLE_LEASE_MS,
  ClientModel = Client,
} = {}) => {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + leaseMs);
  const client = await ClientModel.findOneAndUpdate(
    {
      $and: [
        withOperationalClientScope({ _id: clientId, agency_id: agencyId }),
        noActiveLifecycleLeaseFilter(now),
      ],
    },
    {
      $set: {
        lifecycle_lock: {
          token,
          operation,
          acquired_at: now,
          expires_at: expiresAt,
        },
      },
    },
    { new: true }
  );

  if (client) {
    return { acquired: true, client, token, expiresAt, reason: null };
  }

  const existing = await ClientModel.findOne({
    _id: clientId,
    agency_id: agencyId,
  });
  const reason = !existing
    ? "client_not_found"
    : existing.is_archived === true
      ? "client_archived"
      : "client_lifecycle_operation_in_progress";

  return { acquired: false, client: existing || null, token: null, expiresAt: null, reason };
};

export const acquireRequiredClientLifecycleLease = async (options = {}) => {
  const lease = await acquireClientLifecycleLease(options);
  if (!lease.acquired) throw createClientLifecycleError(lease.reason);
  return lease;
};

export const orderedUniqueClientIds = (clientIds = []) =>
  [...new Set(clientIds.filter(Boolean).map((clientId) => String(clientId)))].sort((left, right) =>
    left.localeCompare(right)
  );

export const releaseClientLifecycleLeases = async ({
  agencyId,
  leases = [],
  ClientModel = Client,
} = {}) => {
  const results = [];
  for (const lease of [...leases].reverse()) {
    results.push(
      await releaseClientLifecycleLease({
        agencyId,
        clientId: lease.clientId,
        token: lease.token,
        ClientModel,
      }).catch(() => false)
    );
  }
  return results;
};

export const acquireRequiredClientLifecycleLeases = async ({
  agencyId,
  clientIds = [],
  operation,
  ClientModel = Client,
} = {}) => {
  const orderedClientIds = orderedUniqueClientIds(clientIds);
  const leases = [];
  try {
    for (const clientId of orderedClientIds) {
      const lease = await acquireRequiredClientLifecycleLease({
        agencyId,
        clientId,
        operation,
        ClientModel,
      });
      leases.push({ ...lease, clientId });
    }
    return leases;
  } catch (error) {
    await releaseClientLifecycleLeases({ agencyId, leases, ClientModel });
    throw error;
  }
};

export const renewClientLifecycleLease = async ({
  agencyId,
  clientId,
  token,
  now = new Date(),
  leaseMs = CLIENT_LIFECYCLE_LEASE_MS,
  ClientModel = Client,
} = {}) => {
  if (!token) return null;
  return ClientModel.findOneAndUpdate(
    withOperationalClientScope({
      _id: clientId,
      agency_id: agencyId,
      "lifecycle_lock.token": token,
    }),
    {
      $set: {
        "lifecycle_lock.expires_at": new Date(now.getTime() + leaseMs),
      },
    },
    { new: true }
  );
};

export const requireClientLifecycleLeaseOwnership = async (options = {}) => {
  const client = await renewClientLifecycleLease(options);
  if (!client) throw createClientLifecycleError("client_lifecycle_operation_in_progress");
  return client;
};

export const fenceClientLifecycleLeaseInTransaction = async ({
  agencyId,
  clientId,
  token,
  session,
  now = new Date(),
  leaseMs = CLIENT_LIFECYCLE_LEASE_MS,
  ClientModel = Client,
} = {}) => {
  if (!session) {
    const error = new Error("A MongoDB session is required to fence Client lifecycle ownership.");
    error.code = "client_lifecycle_transaction_session_required";
    error.status = 500;
    throw error;
  }

  const client = await ClientModel.findOneAndUpdate(
    withOperationalClientScope({
      _id: clientId,
      agency_id: agencyId,
      "lifecycle_lock.token": token,
      "lifecycle_lock.expires_at": { $gt: now },
    }),
    {
      $set: {
        "lifecycle_lock.expires_at": new Date(now.getTime() + leaseMs),
      },
    },
    { new: true, session }
  );

  if (client) return client;

  const query = ClientModel.findOne({ _id: clientId, agency_id: agencyId });
  if (typeof query?.select === "function") query.select("+lifecycle_lock is_archived");
  if (typeof query?.session === "function") query.session(session);
  const existing = await query;
  if (existing?.is_archived === true) {
    throw createClientLifecycleError("client_archived");
  }
  throw createClientLifecycleError("client_lifecycle_lease_lost");
};

export const releaseClientLifecycleLease = async ({
  agencyId,
  clientId,
  token,
  ClientModel = Client,
} = {}) => {
  if (!token) return false;
  const result = await ClientModel.updateOne(
    {
      _id: clientId,
      agency_id: agencyId,
      "lifecycle_lock.token": token,
    },
    { $unset: { lifecycle_lock: 1 } }
  );
  return result.modifiedCount === 1;
};

export const startClientLifecycleLeaseHeartbeat = ({
  agencyId,
  clientId,
  token,
  ClientModel = Client,
  intervalMs = CLIENT_LIFECYCLE_HEARTBEAT_MS,
} = {}) => {
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();

  const timer = setInterval(() => {
    renewal = renewal
      .then(async () => {
        if (stopped) return;
        const client = await renewClientLifecycleLease({
          agencyId,
          clientId,
          token,
          ClientModel,
        });
        if (!client) lost = true;
      })
      .catch(() => {
        lost = true;
      });
  }, intervalMs);
  timer.unref?.();

  return {
    assertOwned() {
      if (!lost) return;
      throw createClientLifecycleError("client_lifecycle_operation_in_progress");
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewal;
    },
  };
};
