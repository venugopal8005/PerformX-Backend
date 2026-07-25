import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";

import { managePhase4EvaluationIndexes } from "../services/phase4EvaluationIndexes.service.js";
import { connectMongooseWithIndexManagementDisabled } from "../services/mongooseConnection.service.js";

export const parsePhase4EvaluationIndexMode = (argv = []) => {
  if (!argv.length || (argv.length === 1 && argv[0] === "--inspect")) return "inspect";
  if (argv.length === 1 && argv[0] === "--apply") return "apply";
  const error = new Error("Use no flag or --inspect, or use --apply explicitly.");
  error.code = "PHASE4_EVALUATION_INDEX_CLI_INVALID";
  throw error;
};
const redact = (value) => String(value || "Phase 4 index command failed.").replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//[REDACTED_CREDENTIALS]@");

export const runPhase4EvaluationIndexCommand = async ({ argv = process.argv.slice(2), env = process.env, mongooseInstance = mongoose, manage = managePhase4EvaluationIndexes, logger = console } = {}) => {
  const mode = parsePhase4EvaluationIndexMode(argv);
  try {
    if (!env.MONGO_URI) throw Object.assign(new Error("MONGO_URI is required."), { code: "PHASE4_EVALUATION_MONGO_URI_REQUIRED" });
    await connectMongooseWithIndexManagementDisabled({ mongooseInstance, uri: env.MONGO_URI });
    const db = mongooseInstance.connection?.db;
    const outcome = await manage({ mode, collections: { evaluations: db.collection("evaluations"), evaluation_series: db.collection("evaluation_series") }, logger });
    for (const result of outcome.results) logger.log?.(`[phase4-evaluation-indexes] ${result.expectedName} ${result.classification}`);
    return outcome.results.some((item) => item.applicationRequired) ? 2 : 0;
  } catch (error) {
    logger.error?.(`[phase4-evaluation-indexes] ${error.code || "FAILED"}: ${redact(error.message)}`);
    return 1;
  } finally {
    if (mongooseInstance.connection?.readyState) await mongooseInstance.disconnect().catch(() => {});
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = await runPhase4EvaluationIndexCommand();

