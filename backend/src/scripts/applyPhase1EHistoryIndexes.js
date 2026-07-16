import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

import {
  PHASE1E_HISTORY_INDEXES,
  managePhase1EHistoryIndexes,
} from "../services/phase1eHistoryIndexes.service.js";
import { connectMongooseWithIndexManagementDisabled } from "../services/mongooseConnection.service.js";

export const parsePhase1EHistoryIndexMode = (argv = []) => {
  if (!argv.length || (argv.length === 1 && argv[0] === "--inspect")) {
    return "inspect";
  }
  if (argv.length === 1 && argv[0] === "--apply") return "apply";

  const error = new Error(
    "Unknown arguments. Use no flag or --inspect for read-only inspection, or --apply to create missing indexes."
  );
  error.code = "PHASE1E_HISTORY_INDEX_ARGUMENTS_INVALID";
  throw error;
};

const redactErrorMessage = (value) =>
  String(value || "Phase 1E history index command failed.")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]")
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//[REDACTED_CREDENTIALS]@");

const collectionsFromConnection = (mongooseInstance) => {
  const db = mongooseInstance.connection?.db;
  if (!db) {
    const error = new Error("MongoDB connection is unavailable.");
    error.code = "PHASE1E_HISTORY_DATABASE_UNAVAILABLE";
    throw error;
  }
  return Object.fromEntries(
    [...new Set(PHASE1E_HISTORY_INDEXES.map((spec) => spec.collection))].map(
      (name) => [name, db.collection(name)]
    )
  );
};

const logInspectionResults = (logger, results) => {
  for (const result of results) {
    logger.log(
      `[phase1e-history-indexes] ${result.collection}.${result.expectedName} ` +
        `${result.classification} application_required=${result.applicationRequired ? "yes" : "no"}`
    );
    logger.log(
      `[phase1e-history-indexes] expected_keys=${JSON.stringify(result.expectedKey)} ` +
        `expected_options=${JSON.stringify(result.expectedOptions)}`
    );
    logger.log(
      `[phase1e-history-indexes] current_name=${result.matchingIndexName || "none"} ` +
        `current_keys=${JSON.stringify(result.currentKey)} ` +
        `current_options=${JSON.stringify(result.currentOptions)}`
    );
  }
};

export const runPhase1EHistoryIndexCommand = async ({
  argv = process.argv.slice(2),
  env = process.env,
  mongooseInstance = mongoose,
  manage = managePhase1EHistoryIndexes,
  logger = console,
} = {}) => {
  let mode;
  try {
    mode = parsePhase1EHistoryIndexMode(argv);
  } catch (error) {
    logger.error(`[phase1e-history-indexes] ${error.code}: ${error.message}`);
    return 1;
  }

  try {
    if (!env.MONGO_URI) {
      const error = new Error("MONGO_URI is required.");
      error.code = "PHASE1E_HISTORY_MONGO_URI_REQUIRED";
      throw error;
    }

    await connectMongooseWithIndexManagementDisabled({
      mongooseInstance,
      uri: env.MONGO_URI,
    });
    logger.log(`[phase1e-history-indexes] connected mode=${mode}`);

    const outcome = await manage({
      mode,
      collections: collectionsFromConnection(mongooseInstance),
      logger,
    });
    logInspectionResults(logger, outcome.results);
    logger.log(
      `[phase1e-history-indexes] complete mode=${mode} created=${outcome.created.length}`
    );
    return outcome.results.some((result) => result.applicationRequired) ? 2 : 0;
  } catch (error) {
    logger.error(
      `[phase1e-history-indexes] ${error.code || "PHASE1E_HISTORY_INDEX_FAILED"}: ` +
        redactErrorMessage(error.message)
    );
    return 1;
  } finally {
    if (mongooseInstance.connection?.readyState) {
      await mongooseInstance.disconnect().catch(() => {});
    }
  }
};

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await runPhase1EHistoryIndexCommand();
}
