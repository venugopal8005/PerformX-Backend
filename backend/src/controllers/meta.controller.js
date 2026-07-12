import { MetaAdAccount } from "../models/index.js";
import {
  findWorkspaceMetaConnection,
  metaErrorResponse,
} from "../services/metaContext.service.js";
import { logError } from "../utils/controllerLogger.js";

const SCOPE = "Meta";

const requireAgency = (req, res) => {
  const agencyId = req.user?.agencyId;
  if (agencyId) return agencyId;

  res.status(401).json({
    success: false,
    message: "Workspace context missing from authentication.",
  });
  return null;
};

export const meta = async (_req, res) =>
  res.status(410).json({
    success: false,
    code: "LEGACY_META_FLOW_REMOVED",
    message: "Connect Meta once from Workspace Settings.",
    redirect_url: "/settings?tab=meta-connections",
  });

export const metaCallback = async (_req, res) => {
  const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
  return res.redirect(
    `${clientOrigin}/settings?tab=meta-connections&meta=legacy-flow-removed`
  );
};

export const ConnectionStatus = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const clientId = req.query.client_id || req.query.clientId;
    const connection = await findWorkspaceMetaConnection(agencyId);
    const assignedAccount = clientId
      ? await MetaAdAccount.findOne({
          agency_id: agencyId,
          client_id: clientId,
          is_active: true,
        })
      : null;

    return res.json({
      connected: Boolean(connection),
      workspace_connected: Boolean(connection),
      account_assigned: Boolean(assignedAccount),
      meta_ad_account_id: assignedAccount?._id || null,
      ad_account_id: assignedAccount?.ad_account_id || null,
      ad_account_name: assignedAccount?.name || null,
      is_accessible: assignedAccount?.is_accessible !== false,
    });
  } catch (error) {
    logError(SCOPE, "META_STATUS_FAILED", error, {
      agencyId: req.user?.agencyId,
    });
    return res
      .status(error.status || 500)
      .json(metaErrorResponse(error, "Failed to check Meta connection."));
  }
};
