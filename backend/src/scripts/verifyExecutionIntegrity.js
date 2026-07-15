import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

import { Activity, ReportRun, Signal } from "../models/index.js";
import { verifyExecutionIntegrityIndexes } from "../services/executionIntegrityIndexes.service.js";

export const runExecutionIntegrityVerificationCommand = async ({
  mongooseInstance = mongoose,
  models = { ReportRun, Signal, Activity },
  verify = verifyExecutionIntegrityIndexes,
  logger = console,
} = {}) => {
  try {
    await mongooseInstance.connect(process.env.MONGO_URI);
    const results = await verify({ models });
    results.forEach((result) => {
      logger.log(
        `[execution-integrity] ${result.status}: ${result.modelName}.${result.field}`
      );
    });
    logger.log("[execution-integrity] verified");
    return 0;
  } catch (error) {
    logger.error(
      `[execution-integrity] failed: ${error.code || "EXECUTION_INTEGRITY_FAILED"}: ${error.message}`
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
  process.exitCode = await runExecutionIntegrityVerificationCommand();
}
