import { Client } from "../models/Client.js";
import { MetaAdAccount } from "../models/index.js";
import { recordActivity } from "../services/activityRecorder.service.js";
import { archiveClientLifecycle } from "../services/archiveLifecycle.service.js";
import { withOperationalClientScope } from "../utils/archiveScope.js";

const requireAgency = (req, res) => {
  const agencyId = req.user?.agencyId;

  if (!agencyId) {
    res.status(401).json({
      success: false,
      message: "Agency context missing from auth token",
    });
    return null;
  }

  return agencyId;
};

export const createClient = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const { name, industry, notes, status = "stable" } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "name is required",
      });
    }

    const client = await Client.create({
      agency_id: agencyId,
      name,
      industry,
      notes,
      status,
      created_by: req.user.id,
    });

    await recordActivity({
      agency_id: agencyId,
      client_id: client._id,
      user_id: req.user.id,
      type: "client_created",
      title: `${client.name} client created`,
      description: "Client workspace was created.",
      severity: client.status,
    }).catch(() => null);

    return res.status(201).json({
      success: true,
      client,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to create client",
    });
  }
};

export const getClients = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const clients = await Client.find(
      withOperationalClientScope({ agency_id: agencyId })
    ).sort({ createdAt: -1 });
    const accounts = await MetaAdAccount.find({
      agency_id: agencyId,
      client_id: { $in: clients.map((client) => client._id) },
      is_active: true,
    }).lean();
    const accountByClientId = new Map(
      accounts.map((account) => [String(account.client_id), account])
    );

    return res.json({
      success: true,
      clients: clients.map((client) => ({
        ...client.toObject(),
        meta_ad_account: accountByClientId.get(String(client._id)) || null,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch clients",
    });
  }
};

export const getClient = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const client = await Client.findOne(
      withOperationalClientScope({
        _id: req.params.clientId,
        agency_id: agencyId,
      })
    );

    if (!client) {
      const archivedClient = await Client.exists({
        _id: req.params.clientId,
        agency_id: agencyId,
        is_archived: true,
      });
      if (archivedClient) {
        return res.status(409).json({
          success: false,
          code: "CLIENT_ARCHIVED",
          message: "Archived clients are not available in the active workspace.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    const metaAdAccount = await MetaAdAccount.findOne({
      agency_id: agencyId,
      client_id: client._id,
      is_active: true,
    }).lean();

    return res.json({
      success: true,
      client: {
        ...client.toObject(),
        meta_ad_account: metaAdAccount || null,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch client",
    });
  }
};

export const updateClient = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const updates = (({ name, industry, notes, status }) => ({
      ...(name !== undefined ? { name } : {}),
      ...(industry !== undefined ? { industry } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...(status !== undefined ? { status } : {}),
    }))(req.body);
    const client = await Client.findOneAndUpdate(
      withOperationalClientScope({
        _id: req.params.clientId,
        agency_id: agencyId,
      }),
      updates,
      { new: true, runValidators: true }
    );

    if (!client) {
      const archivedClient = await Client.exists({
        _id: req.params.clientId,
        agency_id: agencyId,
        is_archived: true,
      });
      if (archivedClient) {
        return res.status(409).json({
          success: false,
          code: "CLIENT_ARCHIVED",
          message: "Archived clients cannot be updated.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    await recordActivity({
      agency_id: agencyId,
      client_id: client._id,
      user_id: req.user.id,
      type: "client_updated",
      title: `${client.name} client updated`,
      description: "Client workspace details were updated.",
      severity: client.status,
      metadata: {
        updated_fields: Object.keys(updates),
      },
    }).catch(() => null);

    return res.json({
      success: true,
      client,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to update client",
    });
  }
};

export const deleteClient = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const result = await archiveClientLifecycle({
      agencyId,
      clientId: req.params.clientId,
      userId: req.user.id || req.user.userId || req.user._id,
    });

    if (result.outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    if (result.outcome === "execution_in_progress") {
      return res.status(409).json({
        success: false,
        code: "client_report_execution_in_progress",
        message: "A report is currently running. Try archiving the client again after it finishes.",
        reportIds: result.reportIds,
        reportCount: result.reportIds.length,
      });
    }

    if (result.outcome === "dispatch_in_progress") {
      return res.status(409).json({
        success: false,
        code: "client_report_dispatch_in_progress",
        message: "A client report is currently being delivered. Try again after delivery finishes.",
        reportIds: result.reportIds,
      });
    }

    if (result.outcome === "lifecycle_in_progress") {
      return res.status(409).json({
        success: false,
        code: "client_lifecycle_operation_in_progress",
        message: "Another client lifecycle operation is in progress. Try again shortly.",
      });
    }

    return res.json({
      success: true,
      message: "Client archived",
      archived: true,
      alreadyArchived: result.outcome === "already_archived",
      clientId: result.client._id,
      archivedReportCount: result.archivedReportCount || 0,
    });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      code: err.code,
      message: err.message || "Failed to archive client",
    });
  }
};
