import "dotenv/config";
import mongoose from "mongoose";

import { runHistoricalSnapshotBackfill } from "../services/historicalSnapshotBackfill.service.js";

const apply = process.argv.includes("--apply");
const batchArgument = process.argv.find((argument) => argument.startsWith("--batch-size="));
const batchSize = Math.max(
  1,
  Math.min(1000, Number(batchArgument?.split("=")[1]) || 200)
);

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required for historical snapshot backfill.");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const result = await runHistoricalSnapshotBackfill({ apply, batchSize });
  console.log(JSON.stringify(result, null, 2));
};

run()
  .catch((error) => {
    console.error(`Historical snapshot backfill failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
