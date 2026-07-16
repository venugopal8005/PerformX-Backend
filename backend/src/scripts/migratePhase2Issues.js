import "dotenv/config";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";

import { connectMongooseWithIndexManagementDisabled } from "../services/mongooseConnection.service.js";
import { initializePhase2IssueIntegrity } from "../services/phase2IssueIndexes.service.js";
import { runPhase2IssueMigration } from "../services/phase2IssueMigration.service.js";
import { Issue, Signal } from "../models/index.js";

const expectedNames = Object.freeze({
  "--expected-eligible": "eligible",
  "--expected-groups": "issueGroups",
  "--expected-legacy-ungrouped": "legacyUngrouped",
});

const parseCount = (value) => {
  if (!/^\d+$/.test(value || "")) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
};

export const parsePhase2IssueMigrationArgs = (argv = []) => {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "--dry-run")) {
    return { apply: false, expected: null };
  }
  const applyFlags = argv.filter((argument) => argument === "--apply");
  const expected = {};
  const seen = new Set();
  for (const argument of argv.filter((item) => item !== "--apply")) {
    const [name, value, ...extra] = argument.split("=");
    const field = expectedNames[name];
    const count = parseCount(value);
    if (!field || extra.length || count === null || seen.has(field)) {
      const error = new Error("Invalid Phase 2 migration arguments.");
      error.code = "PHASE2_ISSUE_MIGRATION_CLI_INVALID";
      throw error;
    }
    seen.add(field);
    expected[field] = count;
  }
  if (applyFlags.length !== 1 || seen.size !== Object.keys(expectedNames).length) {
    const error = new Error("Apply requires all explicit expected counts.");
    error.code = "PHASE2_ISSUE_MIGRATION_CLI_INVALID";
    throw error;
  }
  return { apply: true, expected };
};

export const runPhase2IssueMigrationCommand = async ({
  argv = process.argv.slice(2),
  env = process.env,
  mongooseInstance = mongoose,
  logger = console,
} = {}) => {
  const options = parsePhase2IssueMigrationArgs(argv);
  if (!env.MONGO_URI) {
    const error = new Error("MONGO_URI is required.");
    error.code = "PHASE2_ISSUE_MONGO_URI_REQUIRED";
    throw error;
  }
  await connectMongooseWithIndexManagementDisabled({ mongooseInstance, uri: env.MONGO_URI });
  try {
    if (options.apply) {
      await initializePhase2IssueIntegrity({
        collections: { issues: Issue.collection, signals: Signal.collection },
      });
    }
    const result = await runPhase2IssueMigration(options);
    logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    await mongooseInstance.disconnect();
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runPhase2IssueMigrationCommand().catch((error) => {
    console.error(`Phase 2 Issue migration failed: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
