import "dotenv/config";
import mongoose from "mongoose";

import { auditReportClientLineage } from "../services/reportLineageAudit.service.js";

const run = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required for the report lineage audit.");
  }

  await mongoose.connect(process.env.MONGO_URI);
  const result = await auditReportClientLineage();
  console.log(JSON.stringify(result, null, 2));
};

run()
  .catch((error) => {
    console.error(`Report lineage audit failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });

