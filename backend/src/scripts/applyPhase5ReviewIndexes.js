import mongoose from "mongoose";
import "dotenv/config";
import { ReviewAction, ReviewItem, ReviewReconciliationCheckpoint } from "../models/index.js";
import { connectMongooseWithIndexManagementDisabled } from "../services/mongooseConnection.service.js";
import { managePhase5ReviewIndexes } from "../services/phase5ReviewIndexes.service.js";

export const parsePhase5ReviewIndexMode = (argv = process.argv.slice(2)) => {
  const modes = argv.filter((value) => ["--inspect", "--apply"].includes(value));
  if (modes.length !== 1) throw Object.assign(new Error("Specify exactly one of --inspect or --apply."), { code: "PHASE5_REVIEW_INDEX_MODE_INVALID" });
  return modes[0] === "--apply" ? "apply" : "inspect";
};
export const runPhase5ReviewIndexCommand = async ({ mode, collections, logger = console } = {}) => {
  const result = await managePhase5ReviewIndexes({ mode, collections, logger });
  logger.log?.(JSON.stringify({ mode, created: result.created, indexes: result.results.map(({ collection, expectedName, classification }) => ({ collection, name: expectedName, classification })) }, null, 2));
  return result;
};
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let exitCode = 0;
  try {
    const mode = parsePhase5ReviewIndexMode();
    await connectMongooseWithIndexManagementDisabled({ mongooseInstance: mongoose, uri: process.env.MONGO_URI });
    await runPhase5ReviewIndexCommand({ mode, collections: { review_items: ReviewItem.collection, review_actions: ReviewAction.collection, review_reconciliation_checkpoints: ReviewReconciliationCheckpoint.collection } });
  } catch (error) { exitCode = 1; console.error(error?.message || "Phase 5 Review index command failed."); }
  finally { await mongoose.disconnect().catch(() => undefined); process.exitCode = exitCode; }
}

