import "dotenv/config";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";

import { connectMongooseWithIndexManagementDisabled } from "../services/mongooseConnection.service.js";
import { managePhase2IssueIndexes } from "../services/phase2IssueIndexes.service.js";

export const parsePhase2IssueIndexMode = (argv = []) => {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--inspect")) {
    return "inspect";
  }
  if (argv.length === 1 && argv[0] === "--apply") return "apply";
  const error = new Error("Usage: node applyPhase2IssueIndexes.js [--inspect|--apply]");
  error.code = "PHASE2_ISSUE_INDEX_CLI_INVALID";
  throw error;
};

export const runPhase2IssueIndexCommand = async ({
  argv = process.argv.slice(2),
  env = process.env,
  mongooseInstance = mongoose,
  logger = console,
} = {}) => {
  const mode = parsePhase2IssueIndexMode(argv);
  if (!env.MONGO_URI) {
    const error = new Error("MONGO_URI is required.");
    error.code = "PHASE2_ISSUE_MONGO_URI_REQUIRED";
    throw error;
  }
  await connectMongooseWithIndexManagementDisabled({
    mongooseInstance,
    uri: env.MONGO_URI,
  });
  try {
    const db = mongooseInstance.connection.db;
    const result = await managePhase2IssueIndexes({
      mode,
      collections: {
        issues: db.collection("issues"),
        signals: db.collection("signals"),
      },
      logger,
    });
    logger.log(JSON.stringify({
      mode: result.mode,
      created: result.created,
      results: result.results.map((item) => ({
        collection: item.collection,
        name: item.expectedName,
        classification: item.classification,
        applicationRequired: item.applicationRequired,
      })),
    }, null, 2));
    return result;
  } finally {
    await mongooseInstance.disconnect();
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runPhase2IssueIndexCommand().catch((error) => {
    console.error(`Phase 2 Issue index command failed: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
