import mongoose from "mongoose";

import { Client } from "../models/Client.js";
import { Activity, MetaAdAccount, Report, ReportRun, Signal } from "../models/index.js";
import { recordActivity } from "../services/activityRecorder.service.js";
import { archiveClientLifecycle } from "../services/archiveLifecycle.service.js";
import {
  withAllLifecycleClientScope,
  withArchivedClientScope,
  withHistoricalEvidenceScope,
  withOperationalClientScope,
  withOperationalReportScope,
} from "../utils/archiveScope.js";
import {
  finalizeHistoryPage,
  historyNotFound,
  historyRequestError,
  isValidObjectId,
  parseHistoryLimit,
  withCursorScope,
} from "../utils/historyPagination.js";
import { loadHistoricalActorMap } from "../utils/historicalActors.js";
import {
  serializeArchivedClientSummary,
  serializeClientHistorySummary,
  serializeHistoricalActivity,
} from "../utils/historicalSerializers.js";

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
    const clientIds = clients.map((client) => client._id);
    const persistedAgencyId = clients[0]?.agency_id || agencyId;
    const [accounts, reportSummaryRows] = clientIds.length
      ? await Promise.all([
          MetaAdAccount.find({
            agency_id: agencyId,
            client_id: { $in: clientIds },
            is_active: true,
          }).lean(),
          Report.aggregate([
            {
              $match: withOperationalReportScope({
                agency_id: persistedAgencyId,
                client_id: { $in: clientIds },
              }),
            },
            {
              $facet: {
                activeReports: [
                  { $match: { status: "active" } },
                  { $group: { _id: "$client_id", count: { $sum: 1 } } },
                ],
                monitoredCampaigns: [
                  { $unwind: "$monitored_campaigns" },
                  {
                    $match: {
                      "monitored_campaigns.campaign_id": { $type: "string" },
                    },
                  },
                  {
                    $project: {
                      client_id: 1,
                      campaign_id: {
                        $trim: { input: "$monitored_campaigns.campaign_id" },
                      },
                    },
                  },
                  { $match: { campaign_id: { $ne: "" } } },
                  {
                    $group: {
                      _id: { client_id: "$client_id", campaign_id: "$campaign_id" },
                    },
                  },
                  { $group: { _id: "$_id.client_id", count: { $sum: 1 } } },
                ],
              },
            },
          ]),
        ])
      : [[], []];
    const accountByClientId = new Map(
      accounts.map((account) => [String(account.client_id), account])
    );
    const reportSummary = reportSummaryRows[0] || {};
    const activeReportCountByClientId = new Map(
      (reportSummary.activeReports || []).map((row) => [String(row._id), row.count])
    );
    const monitoredCampaignCountByClientId = new Map(
      (reportSummary.monitoredCampaigns || []).map((row) => [String(row._id), row.count])
    );

    return res.json({
      success: true,
      clients: clients.map((client) => ({
        ...client.toObject(),
        meta_ad_account: accountByClientId.get(String(client._id)) || null,
        activeReportCount: activeReportCountByClientId.get(String(client._id)) || 0,
        monitoredCampaignCount:
          monitoredCampaignCountByClientId.get(String(client._id)) || 0,
      })),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch clients",
    });
  }
};

export const getArchivedClients = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const limit = parseHistoryLimit(req.query.limit);
    const query = withCursorScope(
      withArchivedClientScope({ agency_id: agencyId }),
      "archived_at",
      req.query.cursor
    );
    const documents = await Client.find(query)
      .select("_id name status is_archived archived_at archived_by")
      .sort({ archived_at: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = finalizeHistoryPage({ documents, limit, timestampField: "archived_at" });
    const clientIds = page.items.map((client) => client._id);

    const [reportCounts, runCounts, signalCounts, lastActivities] = clientIds.length
      ? await Promise.all([
          Report.aggregate([
            { $match: { agency_id: new mongoose.Types.ObjectId(agencyId), client_id: { $in: clientIds } } },
            { $group: { _id: "$client_id", count: { $sum: 1 } } },
          ]),
          ReportRun.aggregate([
            { $match: { agency_id: new mongoose.Types.ObjectId(agencyId), client_id: { $in: clientIds } } },
            { $group: { _id: "$client_id", count: { $sum: 1 } } },
          ]),
          Signal.aggregate([
            { $match: { agency_id: new mongoose.Types.ObjectId(agencyId), client_id: { $in: clientIds } } },
            { $group: { _id: "$client_id", count: { $sum: 1 } } },
          ]),
          Activity.aggregate([
            { $match: { agency_id: new mongoose.Types.ObjectId(agencyId), client_id: { $in: clientIds } } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $group: { _id: "$client_id", activity: { $first: "$$ROOT" } } },
          ]),
        ])
      : [[], [], [], []];

    const toCountMap = (rows) => new Map(rows.map((row) => [String(row._id), row.count]));
    const reportCountByClient = toCountMap(reportCounts);
    const runCountByClient = toCountMap(runCounts);
    const signalCountByClient = toCountMap(signalCounts);
    const activityByClient = new Map(
      lastActivities.map((row) => [String(row._id), row.activity])
    );
    const actorIds = [...new Set(page.items.map((client) => client.archived_by).filter(Boolean).map(String))];
    const actorById = await loadHistoricalActorMap({ agencyId, userIds: actorIds });

    return res.json({
      success: true,
      clients: page.items.map((client) =>
        serializeArchivedClientSummary({
          client,
          actor: actorById.get(String(client.archived_by)) || null,
          counts: {
            reports: reportCountByClient.get(String(client._id)) || 0,
            reportRuns: runCountByClient.get(String(client._id)) || 0,
            signals: signalCountByClient.get(String(client._id)) || 0,
          },
          lastActivity: activityByClient.get(String(client._id)) || null,
        })
      ),
      page: page.page,
    });
  } catch (err) {
    return historyRequestError(res, err, "Failed to fetch archived clients.");
  }
};

export const getClientHistory = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;
    if (!isValidObjectId(req.params.clientId)) return historyNotFound(res, "Client history");

    const client = await Client.findOne(
      withAllLifecycleClientScope({ _id: req.params.clientId, agency_id: agencyId })
    )
      .select("_id name industry notes status is_archived archived_at archived_by createdAt updatedAt")
      .lean();
    if (!client) return historyNotFound(res, "Client history");

    const evidenceScope = { agency_id: agencyId, client_id: client._id };
    const [actorById, reports, archivedReports, reportRuns, signals, activities, latestActivity] =
      await Promise.all([
        loadHistoricalActorMap({ agencyId, userIds: [client.archived_by] }),
        Report.countDocuments(evidenceScope),
        Report.countDocuments({ ...evidenceScope, is_archived: true }),
        ReportRun.countDocuments(withHistoricalEvidenceScope(agencyId, { client_id: client._id })),
        Signal.countDocuments(withHistoricalEvidenceScope(agencyId, { client_id: client._id })),
        Activity.countDocuments(withHistoricalEvidenceScope(agencyId, { client_id: client._id })),
        Activity.findOne(withHistoricalEvidenceScope(agencyId, { client_id: client._id }))
          .sort({ createdAt: -1, _id: -1 })
          .lean(),
      ]);

    return res.json({
      success: true,
      client: serializeClientHistorySummary({
        client,
        actor: actorById.get(String(client.archived_by)) || null,
      }),
      counts: { reports, archivedReports, reportRuns, signals, activities },
      latestActivity: latestActivity ? serializeHistoricalActivity(latestActivity) : null,
      capabilities: {
        reportRuns: true,
        signals: true,
        activities: true,
        liveMeta: false,
        mutable: false,
      },
    });
  } catch (err) {
    return historyRequestError(res, err, "Failed to fetch Client history.");
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
