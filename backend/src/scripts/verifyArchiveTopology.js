import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

import {
  getMongoTopologyType,
  supportsRequiredTransactions,
} from "../services/requiredTransaction.service.js";

export const runArchiveTopologyVerificationCommand = async ({
  mongooseInstance = mongoose,
  mongoUri = process.env.MONGO_URI,
  logger = console,
} = {}) => {
  try {
    if (!mongoUri) throw new Error("MONGO_URI is required");
    await mongooseInstance.connect(mongoUri);
    const topology = getMongoTopologyType(mongooseInstance);
    const supported = supportsRequiredTransactions(mongooseInstance);
    logger.log(`[archive-topology] topology: ${topology}`);
    logger.log(
      `[archive-topology] transaction-capable: ${supported ? "yes" : "no"}`
    );
    logger.log(
      `[archive-topology] ${supported ? "verified" : "verification failed"}`
    );
    return supported ? 0 : 1;
  } catch (error) {
    logger.error(
      `[archive-topology] verification failed: ${
        error.code || "ARCHIVE_TOPOLOGY_VERIFICATION_FAILED"
      }: ${error.message}`
    );
    return 1;
  } finally {
    if (mongooseInstance.connection?.readyState) {
      await mongooseInstance.disconnect();
    }
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runArchiveTopologyVerificationCommand();
}
