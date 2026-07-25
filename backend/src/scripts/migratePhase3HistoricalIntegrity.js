import "dotenv/config";
import mongoose from "mongoose";

import { connectMongooseWithIndexManagementDisabled } from "../services/mongooseConnection.service.js";
import {
  applyPhase3HistoricalIntegrityMigration,
  inspectPhase3HistoricalIntegrityMigration,
} from "../services/phase3HistoricalIntegrityMigration.service.js";

const mode = process.argv[2] || "--dry-run";
if (!["--dry-run", "--apply"].includes(mode)) {
  throw new Error("Use --dry-run or --apply explicitly.");
}
if (!process.env.MONGO_URI) throw new Error("MONGO_URI is required.");

try {
  await connectMongooseWithIndexManagementDisabled({ uri: process.env.MONGO_URI });
  const inspection = await inspectPhase3HistoricalIntegrityMigration();
  const result =
    mode === "--apply"
      ? await applyPhase3HistoricalIntegrityMigration({ expected: inspection })
      : inspection;
  console.log(JSON.stringify({ mode, ...result }, null, 2));
} finally {
  await mongoose.disconnect().catch(() => {});
}

