import { assertExecutionIntegrityReady } from "../services/executionIntegrityIndexes.service.js";

export const requireReportExecutionIntegrity = (_req, res, next) => {
  try {
    assertExecutionIntegrityReady();
    return next();
  } catch (error) {
    return res.status(error.status || 503).json({
      success: false,
      code: error.code || "report_execution_integrity_unavailable",
      message: error.message,
    });
  }
};
