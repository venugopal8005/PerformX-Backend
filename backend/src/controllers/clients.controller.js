import { Client } from "../models/Client.js";
import {
  Activity,
  MetaAdAccount,
  MetaConnection,
  Report,
  ReportRun,
  Signal,
} from "../models/index.js";
import { recordActivity } from "../services/activityRecorder.service.js";

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

    const clients = await Client.find({ agency_id: agencyId }).sort({ createdAt: -1 });
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

    const client = await Client.findOne({
      _id: req.params.clientId,
      agency_id: agencyId,
    });

    if (!client) {
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
      {
        _id: req.params.clientId,
        agency_id: agencyId,
      },
      updates,
      { new: true, runValidators: true }
    );

    if (!client) {
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

    const client = await Client.findOne({
      _id: req.params.clientId,
      agency_id: agencyId,
    });

    if (!client) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    const reports = await Report.find({
      agency_id: agencyId,
      client_id: client._id,
    }).select("_id");
    const reportIds = reports.map((report) => report._id);

    const [reportRuns, signals, metaConnections, activities] = await Promise.all([
      ReportRun.deleteMany({ agency_id: agencyId, client_id: client._id }),
      Signal.deleteMany({ agency_id: agencyId, client_id: client._id }),
      MetaConnection.deleteMany({ agency_id: agencyId, client_id: client._id }),
      Activity.deleteMany({
        agency_id: agencyId,
        $or: [
          { client_id: client._id },
          ...(reportIds.length ? [{ report_id: { $in: reportIds } }] : []),
        ],
      }),
    ]);

    await MetaAdAccount.updateMany(
      { agency_id: agencyId, client_id: client._id },
      { $set: { client_id: null, assignment_scope: null } }
    );

    const deletedReports = await Report.deleteMany({
      agency_id: agencyId,
      client_id: client._id,
    });
    await Client.deleteOne({ _id: client._id, agency_id: agencyId });

    await recordActivity({
      agency_id: agencyId,
      user_id: req.user.id,
      type: "client_deleted",
      title: `${client.name} client deleted`,
      description: "Client workspace and related monitoring data were deleted.",
      severity: "critical",
      metadata: {
        deleted_client_id: client._id,
        deleted_client_name: client.name,
        deleted_reports: deletedReports.deletedCount,
        deleted_report_runs: reportRuns.deletedCount,
        deleted_signals: signals.deletedCount,
        deleted_meta_connections: metaConnections.deletedCount,
        deleted_activities: activities.deletedCount,
      },
    }).catch(() => null);

    return res.json({
      success: true,
      message: "Client deleted",
      deleted: {
        client_id: client._id,
        reports: deletedReports.deletedCount,
        report_runs: reportRuns.deletedCount,
        signals: signals.deletedCount,
        meta_connections: metaConnections.deletedCount,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to delete client",
    });
  }
};
