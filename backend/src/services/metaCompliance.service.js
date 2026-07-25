import crypto from "crypto";

import {
  Activity,
  MetaAdAccount,
  MetaConnection,
  MetaDataDeletionRequest,
} from "../models/index.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const GENERIC_DISCONNECT_REASON = "Meta authorization was revoked by the account owner.";

const defaultConfirmationCode = () => crypto.randomBytes(24).toString("base64url");

const uniqueValues = (values = []) => [
  ...new Map(values.filter(Boolean).map((value) => [String(value), value])).values(),
];

export const createMetaComplianceService = ({
  MetaConnectionModel = MetaConnection,
  MetaAdAccountModel = MetaAdAccount,
  ActivityModel = Activity,
  DeletionRequestModel = MetaDataDeletionRequest,
  confirmationCodeFactory = defaultConfirmationCode,
} = {}) => {
  const findConnections = async (metaUserId) =>
    MetaConnectionModel.find(
      { meta_user_id: metaUserId },
      { _id: 1, agency_id: 1 }
    ).lean();

  const revokeConnections = async (connections, now) => {
    const connectionIds = uniqueValues(connections.map((connection) => connection._id));
    if (!connectionIds.length) return;

    const agencyIds = uniqueValues(connections.map((connection) => connection.agency_id));
    await MetaConnectionModel.updateMany(
      { _id: { $in: connectionIds } },
      {
        $set: {
          status: "revoked",
          is_active: false,
          disconnected_at: now,
          last_error: GENERIC_DISCONNECT_REASON,
        },
        $unset: {
          access_token: "",
          access_token_encrypted: "",
        },
      }
    );

    await MetaAdAccountModel.updateMany(
      {
        meta_connection_id: { $in: connectionIds },
        ...(agencyIds.length ? { agency_id: { $in: agencyIds } } : {}),
      },
      { $set: { is_accessible: false } }
    );
  };

  const deauthorizeMetaUser = async (metaUserId, { now = new Date() } = {}) => {
    const connections = await findConnections(metaUserId);
    await revokeConnections(connections, now);
    return { success: true };
  };

  const beginDeletionRequest = async (metaUserHash, now) => {
    const updates = {
      $set: {
        status: "processing",
        requested_at: now,
        completed_at: null,
        failed_at: null,
        failure_reason: null,
        expires_at: new Date(now.getTime() + RETENTION_MS),
      },
      $setOnInsert: {
        meta_user_hash: metaUserHash,
        confirmation_code: confirmationCodeFactory(),
      },
    };

    try {
      return await DeletionRequestModel.findOneAndUpdate(
        { meta_user_hash: metaUserHash },
        updates,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).select("+meta_user_hash");
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return DeletionRequestModel.findOneAndUpdate(
        { meta_user_hash: metaUserHash },
        { $set: updates.$set },
        { new: true }
      ).select("+meta_user_hash");
    }
  };

  const requestDataDeletion = async ({ metaUserId, metaUserHash, now = new Date() }) => {
    const deletionRequest = await beginDeletionRequest(metaUserHash, now);

    try {
      const connections = await findConnections(metaUserId);
      await revokeConnections(connections, now);

      await ActivityModel.updateMany(
        { "metadata.meta_user_id": metaUserId },
        { $unset: { "metadata.meta_user_id": "" } }
      );

      const connectionIds = uniqueValues(connections.map((connection) => connection._id));
      if (connectionIds.length) {
        await MetaConnectionModel.updateMany(
          { _id: { $in: connectionIds }, meta_user_id: metaUserId },
          {
            $set: {
              status: "revoked",
              is_active: false,
              permissions: [],
              disconnected_at: now,
              last_error: "Meta data deletion request completed.",
            },
            $unset: {
              meta_user_id: "",
              meta_user_name: "",
              business_id: "",
              ad_account_id: "",
              ad_account_name: "",
              access_token: "",
              access_token_encrypted: "",
              token_expires_at: "",
            },
          }
        );
      }

      const completed = await DeletionRequestModel.findOneAndUpdate(
        { _id: deletionRequest._id },
        {
          $set: {
            status: "completed",
            completed_at: now,
            failed_at: null,
            failure_reason: null,
          },
        },
        { new: true }
      );

      return completed || deletionRequest;
    } catch (error) {
      await DeletionRequestModel.updateOne(
        { _id: deletionRequest?._id },
        {
          $set: {
            status: "failed",
            failed_at: now,
            completed_at: null,
            failure_reason: "cleanup_failed",
          },
        }
      ).catch(() => null);
      throw error;
    }
  };

  const getDataDeletionStatus = async (confirmationCode, { now = new Date() } = {}) =>
    DeletionRequestModel.findOne({
      confirmation_code: confirmationCode,
      expires_at: { $gt: now },
    }).select("confirmation_code status requested_at completed_at failed_at");

  return {
    deauthorizeMetaUser,
    getDataDeletionStatus,
    requestDataDeletion,
  };
};

const defaultService = createMetaComplianceService();

export const deauthorizeMetaUser = defaultService.deauthorizeMetaUser;
export const getMetaDataDeletionStatus = defaultService.getDataDeletionStatus;
export const requestMetaDataDeletion = defaultService.requestDataDeletion;
