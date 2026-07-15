import mongoose from "mongoose";

const TRANSACTION_TOPOLOGIES = new Set([
  "ReplicaSetWithPrimary",
  "Sharded",
  "LoadBalanced",
]);

export const getMongoTopologyType = (mongooseInstance = mongoose) =>
  mongooseInstance?.connection?.client?.topology?.description?.type || "Unknown";

export const supportsRequiredTransactions = (mongooseInstance = mongoose) =>
  TRANSACTION_TOPOLOGIES.has(getMongoTopologyType(mongooseInstance));

export const createTransactionUnavailableError = ({
  code = "archive_transaction_unavailable",
  message = "This operation requires a transaction-capable database deployment.",
} = {}) => {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
};

export const runRequiredTransaction = async ({
  mongooseInstance = mongoose,
  work,
  unavailableCode,
  unavailableMessage,
} = {}) => {
  if (!supportsRequiredTransactions(mongooseInstance)) {
    throw createTransactionUnavailableError({
      code: unavailableCode,
      message: unavailableMessage,
    });
  }

  const session = await mongooseInstance.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
};
