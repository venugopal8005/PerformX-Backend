import {
  deauthorizeMetaUser,
  getMetaDataDeletionStatus,
  requestMetaDataDeletion,
} from "../services/metaCompliance.service.js";
import {
  hashMetaUserId,
  MetaSignedRequestError,
  verifyMetaSignedRequest,
} from "../utils/metaSignedRequest.js";
import { logAction } from "../utils/controllerLogger.js";

const SCOPE = "MetaCompliance";
const CONFIRMATION_CODE_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

class MetaComplianceConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MetaComplianceConfigurationError";
    this.code = "META_COMPLIANCE_CONFIGURATION_MISSING";
    this.status = 503;
  }
}

const getPublicApiOrigin = () => {
  const configured = process.env.API_ORIGIN;
  if (!configured) {
    throw new MetaComplianceConfigurationError(
      "Public API origin is not configured for Meta compliance callbacks."
    );
  }

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new MetaComplianceConfigurationError(
      "Public API origin is invalid for Meta compliance callbacks."
    );
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (process.env.NODE_ENV === "production" && url.protocol !== "https:")
  ) {
    throw new MetaComplianceConfigurationError(
      "Public API origin is invalid for Meta compliance callbacks."
    );
  }

  return url.origin;
};

const callbackErrorResponse = (res, error, event) => {
  const expected =
    error instanceof MetaSignedRequestError ||
    error instanceof MetaComplianceConfigurationError;
  const status = expected ? error.status : 500;

  logAction(
    SCOPE,
    event,
    {
      success: false,
      httpStatus: status,
      errorCategory: expected ? error.code : "META_COMPLIANCE_INTERNAL_ERROR",
    },
    "red"
  );

  if (error instanceof MetaSignedRequestError) {
    return res.status(status).json({
      success: false,
      code: error.code,
      message: error.message,
    });
  }

  if (error instanceof MetaComplianceConfigurationError) {
    return res.status(status).json({
      success: false,
      code: error.code,
      message: "Meta compliance callback configuration is unavailable.",
    });
  }

  return res.status(500).json({
    success: false,
    code: "META_COMPLIANCE_CALLBACK_FAILED",
    message: "Meta compliance request could not be completed.",
  });
};

const safeDate = (value) => (value instanceof Date ? value.toISOString() : value || null);

export const createMetaComplianceHandlers = ({
  verifySignedRequest = verifyMetaSignedRequest,
  hashUserId = hashMetaUserId,
  service = {
    deauthorizeMetaUser,
    getDataDeletionStatus: getMetaDataDeletionStatus,
    requestDataDeletion: requestMetaDataDeletion,
  },
  publicApiOrigin = getPublicApiOrigin,
} = {}) => ({
  deauthorize: async (req, res) => {
    try {
      const payload = verifySignedRequest(req.body?.signed_request);
      await service.deauthorizeMetaUser(payload.user_id);
      logAction(SCOPE, "META_DEAUTHORIZATION_COMPLETED", { success: true }, "green");
      return res.status(200).json({ success: true });
    } catch (error) {
      return callbackErrorResponse(res, error, "META_DEAUTHORIZATION_FAILED");
    }
  },

  requestDataDeletion: async (req, res) => {
    try {
      const payload = verifySignedRequest(req.body?.signed_request);
      const origin = publicApiOrigin();
      const metaUserHash = hashUserId(payload.user_id);
      const deletionRequest = await service.requestDataDeletion({
        metaUserId: payload.user_id,
        metaUserHash,
      });
      const confirmationCode = deletionRequest.confirmation_code;
      const statusUrl = `${origin}/api/meta/data-deletion/status/${encodeURIComponent(
        confirmationCode
      )}`;

      logAction(
        SCOPE,
        "META_DATA_DELETION_COMPLETED",
        { success: true, status: deletionRequest.status },
        "green"
      );
      return res.status(200).json({
        url: statusUrl,
        confirmation_code: confirmationCode,
      });
    } catch (error) {
      return callbackErrorResponse(res, error, "META_DATA_DELETION_FAILED");
    }
  },

  getDataDeletionStatus: async (req, res) => {
    const confirmationCode = String(req.params.confirmationCode || "");
    if (!CONFIRMATION_CODE_PATTERN.test(confirmationCode)) {
      return res.status(404).json({
        success: false,
        message: "Deletion request not found.",
      });
    }

    try {
      const deletionRequest = await service.getDataDeletionStatus(confirmationCode);
      if (!deletionRequest) {
        return res.status(404).json({
          success: false,
          message: "Deletion request not found.",
        });
      }

      return res.json({
        confirmation_code: deletionRequest.confirmation_code,
        status: deletionRequest.status,
        requested_at: safeDate(deletionRequest.requested_at),
        completed_at: safeDate(deletionRequest.completed_at),
        ...(deletionRequest.status === "failed"
          ? { failed_at: safeDate(deletionRequest.failed_at) }
          : {}),
      });
    } catch (error) {
      return callbackErrorResponse(res, error, "META_DATA_DELETION_STATUS_FAILED");
    }
  },
});

const defaultHandlers = createMetaComplianceHandlers();

export const deauthorize = defaultHandlers.deauthorize;
export const requestDataDeletion = defaultHandlers.requestDataDeletion;
export const getDataDeletionStatus = defaultHandlers.getDataDeletionStatus;
