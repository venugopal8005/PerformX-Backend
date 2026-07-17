import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

import {
  PHASE3_INTERVENTION_INDEXES,
  managePhase3InterventionIndexes,
} from "../services/phase3InterventionIndexes.service.js";
import { connectMongooseWithIndexManagementDisabled } from "../services/mongooseConnection.service.js";

export const parsePhase3InterventionIndexMode = (argv = []) => {
  if (!argv.length || (argv.length === 1 && argv[0] === "--inspect")) return "inspect";
  if (argv.length === 1 && argv[0] === "--apply") return "apply";
  const error = new Error("Use no flag or --inspect, or use --apply explicitly.");
  error.code = "PHASE3_INTERVENTION_INDEX_CLI_INVALID";
  throw error;
};

const redact = (value) =>
  String(value || "Phase 3 Intervention index command failed.")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]")
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//[REDACTED_CREDENTIALS]@");

export const runPhase3InterventionIndexCommand = async ({
  argv = process.argv.slice(2),
  env = process.env,
  mongooseInstance = mongoose,
  manage = managePhase3InterventionIndexes,
  logger = console,
} = {}) => {
  const mode = parsePhase3InterventionIndexMode(argv);
  try {
    if (!env.MONGO_URI) {
      const error = new Error("MONGO_URI is required.");
      error.code = "PHASE3_INTERVENTION_MONGO_URI_REQUIRED";
      throw error;
    }
    await connectMongooseWithIndexManagementDisabled({
      mongooseInstance,
      uri: env.MONGO_URI,
    });
    const collection = mongooseInstance.connection?.db?.collection(
      PHASE3_INTERVENTION_INDEXES[0].collection
    );
    const outcome = await manage({ mode, collection, logger });
    for (const result of outcome.results) {
      logger.log?.(
        `[phase3-intervention-indexes] ${result.expectedName} ${result.classification}`
      );
    }
    return outcome.results.some((item) => item.applicationRequired) ? 2 : 0;
  } catch (error) {
    logger.error?.(`[phase3-intervention-indexes] ${error.code || "FAILED"}: ${redact(error.message)}`);
    return 1;
  } finally {
    if (mongooseInstance.connection?.readyState) {
      await mongooseInstance.disconnect().catch(() => {});
    }
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    process.exitCode = await runPhase3InterventionIndexCommand();
  } catch (error) {
    console.error(`[phase3-intervention-indexes] ${error.code || "FAILED"}: ${redact(error.message)}`);
    process.exitCode = 1;
  }
}
