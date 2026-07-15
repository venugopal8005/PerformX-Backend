import { Report } from "../models/Report.js";
import { ReportRun } from "../models/ReportRun.js";
import { Signal } from "../models/Signal.js";
import { recordActivity } from "../services/activityRecorder.service.js";
import { archiveReportLifecycle } from "../services/archiveLifecycle.service.js";
import {
  acquireRequiredClientLifecycleLease,
  fenceClientLifecycleLeaseInTransaction,
  releaseClientLifecycleLease,
  startClientLifecycleLeaseHeartbeat,
} from "../services/clientLifecycle.service.js";
import { runRequiredTransaction } from "../services/requiredTransaction.service.js";
import { assertReportClientReparentAllowed } from "../services/reportLineage.service.js";
import { fenceMetaAccountBindingInTransaction } from "../services/metaAccountBinding.service.js";
import { logAction, logError } from "../utils/controllerLogger.js";
import { getNextRunAt, normalizeReportSchedule } from "../utils/reportSchedule.js";
import {
  normalizeClientDeliveryMode,
  normalizeEmailList,
  normalizeSafetySettings,
} from "../services/reportDelivery.service.js";
import {
  getAssignedMetaAccountForClient,
  metaErrorResponse,
  resolveMetaContextForReport,
  resolveValidatedMetaContextForReport,
  validateCampaignsForMetaAccount,
} from "../services/metaContext.service.js";
import { withOperationalReportScope } from "../utils/archiveScope.js";

const SCOPE = "Reports";
const DEFAULT_REPORT_NAME = "Meta Ads Monitor";

const normalizeReportName = (value) => {
  const name = String(value || "").trim();
  return name || DEFAULT_REPORT_NAME;
};

const normalizeRecipients = (value, fallbackEmail) => {
  const recipients = Array.isArray(value) ? value : fallbackEmail ? [fallbackEmail] : [];

  return recipients
    .map((email) => String(email || "").trim().toLowerCase())
    .filter(Boolean);
};

const readBool = (value, fallback) =>
  value === undefined || value === null ? fallback : Boolean(value);

const normalizeStatus = (value) => {
  const status = String(value || "").trim().toLowerCase();

  if (["active", "true", "1", "yes", "on"].includes(status)) return "active";
  if (["paused", "inactive", "false", "0", "no", "off"].includes(status)) {
    return "paused";
  }

  return "paused";
};

const normalizeCampaigns = (campaigns = []) => {
  if (!Array.isArray(campaigns)) return [];

  return campaigns
    .map((campaign) => ({
      campaign_id: String(campaign.campaign_id || campaign.campaignId || "").trim(),
      campaign_name: String(campaign.campaign_name || campaign.campaignName || "").trim(),
    }))
    .filter((campaign) => campaign.campaign_id && campaign.campaign_name);
};

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

const resolveReportAccountForClient = async ({
  agencyId,
  clientId,
  requestedMetaAdAccountId,
  campaigns,
}) => {
  const { client, metaAdAccount } = await getAssignedMetaAccountForClient({
    agencyId,
    clientId,
  });

  if (
    requestedMetaAdAccountId &&
    String(requestedMetaAdAccountId) !== String(metaAdAccount._id)
  ) {
    const error = new Error("The selected Meta ad account is not assigned to this client.");
    error.code = "META_ACCOUNT_MISMATCH";
    error.status = 400;
    throw error;
  }

  const context = await resolveValidatedMetaContextForReport({
    agency_id: agencyId,
    client_id: clientId,
    meta_ad_account_id: metaAdAccount._id,
  });
  await validateCampaignsForMetaAccount({
    accessToken: context.accessToken,
    externalAdAccountId: context.externalAdAccountId,
    campaigns,
  });

  return { client, metaAdAccount, context };
};

const requireFinalMetaAccountBinding = async ({
  agencyId,
  clientId,
  metaAdAccountId,
  session,
}) => {
  const { account } = await fenceMetaAccountBindingInTransaction({
    accountId: metaAdAccountId,
    agencyId,
    clientId,
    session,
  });
  return account;
};

const reportUpdateState = (report) => {
  const source = report.toObject({ depopulate: true });
  return {
    client_id: source.client_id,
    meta_ad_account_id: source.meta_ad_account_id,
    meta_account_external_id_snapshot: source.meta_account_external_id_snapshot,
    meta_account_name_snapshot: source.meta_account_name_snapshot,
    monitored_campaigns: source.monitored_campaigns,
    name: source.name,
    recipients: source.recipients,
    internal_recipients: source.internal_recipients,
    client_recipients: source.client_recipients,
    generate_client_report: source.generate_client_report,
    generate_internal_report: source.generate_internal_report,
    client_delivery_mode: source.client_delivery_mode,
    safety_settings: source.safety_settings,
    severity: source.severity,
    type: source.type,
    schedule: source.schedule,
    status: source.status,
    next_run_at: source.next_run_at,
  };
};

export const createReport = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const userId = req.user.id;
    const formData = req.body.formData || req.body || {};
    const clientId = formData.client_id || formData.clientId;
    const recipients = normalizeRecipients(formData.recipients, formData.email);
    const internalRecipients = normalizeEmailList(
      formData.internal_recipients || formData.internalRecipients || recipients
    );
    const clientRecipients = normalizeEmailList(
      formData.client_recipients || formData.clientRecipients || []
    );
    const type = formData.type || formData.frequency || "daily";
    const name = normalizeReportName(formData.name);
    let scheduleConfig;

    logAction(SCOPE, "CREATE_REPORT_REQUEST", {
      agencyId,
      userId,
      clientId,
      formData,
    }, "blue");

    if (!clientId || internalRecipients.length === 0) {
      return res.status(400).json({
        success: false,
        message: "client_id and at least one internal recipient are required",
      });
    }

    try {
      scheduleConfig = normalizeReportSchedule({
        ...formData,
        type,
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err.message,
      });
    }

    const monitoredCampaigns = normalizeCampaigns(formData.monitored_campaigns);
    if (!monitoredCampaigns.length) {
      return res.status(400).json({
        success: false,
        code: "INVALID_META_CAMPAIGNS",
        message: "Select at least one campaign from the assigned Meta ad account.",
        invalidCampaignIds: [],
      });
    }
    const lifecycleLease = await acquireRequiredClientLifecycleLease({
      agencyId,
      clientId,
      operation: "report_create",
    });
    const lifecycleHeartbeat = startClientLifecycleLeaseHeartbeat({
      agencyId,
      clientId,
      token: lifecycleLease.token,
    });
    let report;

    try {
      const { metaAdAccount } = await resolveReportAccountForClient({
        agencyId,
        clientId,
        requestedMetaAdAccountId:
          formData.meta_ad_account_id || formData.metaAdAccountId,
        campaigns: monitoredCampaigns,
      });
      const reportPayload = {
        agency_id: agencyId,
        client_id: clientId,
        meta_ad_account_id: metaAdAccount._id,
        meta_account_external_id_snapshot: metaAdAccount.ad_account_id,
        meta_account_name_snapshot: metaAdAccount.name,
        created_by: userId,
        name,
        type: scheduleConfig.type,
        status: normalizeStatus(formData.status),
        severity: formData.severity || "low",
        recipients,
        internal_recipients: internalRecipients,
        client_recipients: clientRecipients,
        generate_client_report: readBool(
          formData.generate_client_report ?? formData.generateClientReport,
          true
        ),
        generate_internal_report: readBool(
          formData.generate_internal_report ?? formData.generateInternalReport,
          true
        ),
        client_delivery_mode: normalizeClientDeliveryMode(
          formData.client_delivery_mode || formData.clientDeliveryMode
        ),
        safety_settings: normalizeSafetySettings(
          formData.safety_settings || formData.safetySettings
        ),
        monitored_campaigns: monitoredCampaigns,
        schedule: scheduleConfig.schedule,
        last_summary: null,
        last_signal_at: null,
        last_run_at: null,
        next_run_at: null,
      };

      lifecycleHeartbeat.assertOwned();
      report = await runRequiredTransaction({
        unavailableCode: "lifecycle_transaction_unavailable",
        unavailableMessage:
          "Report creation requires a transaction-capable database deployment.",
        work: async (session) => {
          await fenceClientLifecycleLeaseInTransaction({
            agencyId,
            clientId,
            token: lifecycleLease.token,
            session,
          });
          const finalMetaAdAccount = await requireFinalMetaAccountBinding({
            agencyId,
            clientId,
            metaAdAccountId: metaAdAccount._id,
            session,
          });
          reportPayload.meta_account_external_id_snapshot =
            finalMetaAdAccount.ad_account_id;
          reportPayload.meta_account_name_snapshot = finalMetaAdAccount.name;
          const [createdReport] = await Report.create([reportPayload], { session });
          return createdReport;
        },
      });

      await recordActivity({
        agency_id: agencyId,
        client_id: clientId,
        report_id: report._id,
        user_id: userId,
        type: "report_created",
        title: `${report.name} created`,
        description: "Operational monitor created.",
        severity: "stable",
        metadata: {
          report_type: report.type,
          recipients,
          internal_recipients: internalRecipients,
          client_recipients: clientRecipients,
          client_delivery_mode: report.client_delivery_mode,
        },
      });
    } finally {
      await lifecycleHeartbeat.stop();
      await releaseClientLifecycleLease({
        agencyId,
        clientId,
        token: lifecycleLease.token,
      }).catch(() => null);
    }

    logAction(SCOPE, "CREATE_REPORT_SUCCESS", {
      agencyId,
      userId,
      reportId: report._id,
      clientId,
      name: report.name,
      type: report.type,
      status: report.status,
      clientDeliveryMode: report.client_delivery_mode,
      internalRecipientCount: internalRecipients.length,
      clientRecipientCount: clientRecipients.length,
      safetySettings: report.safety_settings,
    }, "green");

    return res.status(201).json({
      success: true,
      report,
    });
  } catch (err) {
    logError(SCOPE, "CREATE_REPORT_FAILED", err);

    return res
      .status(err.status || 500)
      .json(metaErrorResponse(err, "Failed to create report"));
  }
};

export const startReport = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const userId = req.user.id;
    const { reportId } = req.body;

    if (!reportId) {
      return res.status(400).json({
        success: false,
        message: "reportId required",
      });
    }

    logAction(SCOPE, "START_REPORT_REQUEST", {
      agencyId,
      userId,
      reportId,
    }, "blue");

    let report = await Report.findOne(
      withOperationalReportScope({
        _id: reportId,
        agency_id: agencyId,
      })
    );

    if (!report) {
      const archivedReport = await Report.exists({
        _id: reportId,
        agency_id: agencyId,
        is_archived: true,
      });
      if (archivedReport) {
        return res.status(409).json({
          success: false,
          code: "REPORT_ARCHIVED",
          message: "Archived reports cannot be started.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    await resolveMetaContextForReport(report);

    report.status = "active";
    report.next_run_at = getNextRunAt(report);
    await report.save();

    await recordActivity({
      agency_id: agencyId,
      client_id: report.client_id,
      report_id: report._id,
      user_id: userId,
      type: "report_started",
      title: `${report.name} started`,
      description: "Operational monitor is now active.",
      severity: "stable",
      metadata: {
        next_run_at: report.next_run_at,
      },
    });

    logAction(SCOPE, "START_REPORT_SUCCESS", {
      agencyId,
      userId,
      reportId: report._id,
      clientId: report.client_id,
      nextRunAt: report.next_run_at,
      status: report.status,
    }, "green");

    return res.status(200).json({
      success: true,
      message: "Report started",
      report,
    });
  } catch (err) {
    logError(SCOPE, "START_REPORT_FAILED", err);

    return res
      .status(err.status || 500)
      .json(metaErrorResponse(err, "Failed to start report"));
  }
};

export const getReports = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const clientId = req.query.client_id || req.query.clientId;
    const query = {
      agency_id: agencyId,
      ...(clientId ? { client_id: clientId } : {}),
    };

    const reports = await Report.find(withOperationalReportScope(query))
      .populate("meta_ad_account_id", "name ad_account_id is_accessible is_active")
      .sort({ createdAt: -1 });
    const latestRuns = await ReportRun.find({
      agency_id: agencyId,
      report_id: { $in: reports.map((report) => report._id) },
    })
      .sort({ ran_at: -1 })
      .lean();
    const latestRunByReportId = new Map();

    latestRuns.forEach((run) => {
      const reportId = run.report_id?.toString?.() || String(run.report_id);
      if (!latestRunByReportId.has(reportId)) {
        latestRunByReportId.set(reportId, run);
      }
    });

    return res.json(
      reports.map((report) => ({
        ...report.toObject(),
        latest_run: latestRunByReportId.get(report._id.toString()) || null,
      }))
    );
  } catch (err) {
    logError(SCOPE, "GET_REPORTS_FAILED", err);

    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

export const getReport = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    let report = await Report.findOne(
      withOperationalReportScope({
        _id: req.params.reportId,
        agency_id: agencyId,
      })
    ).populate("meta_ad_account_id", "name ad_account_id is_accessible is_active");

    if (!report) {
      const archivedReport = await Report.exists({
        _id: req.params.reportId,
        agency_id: agencyId,
        is_archived: true,
      });
      if (archivedReport) {
        return res.status(409).json({
          success: false,
          code: "REPORT_ARCHIVED",
          message: "Archived reports are not available in the active workspace.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    return res.json({
      success: true,
      report,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch report",
    });
  }
};

export const getReportHistory = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const report = await Report.findOne(
      withOperationalReportScope({
        _id: req.params.reportId,
        agency_id: agencyId,
      })
    )
      .populate("client_id", "name status")
      .populate("meta_ad_account_id", "name ad_account_id is_accessible is_active");

    if (!report) {
      const archivedReport = await Report.exists({
        _id: req.params.reportId,
        agency_id: agencyId,
        is_archived: true,
      });
      if (archivedReport) {
        return res.status(409).json({
          success: false,
          code: "REPORT_ARCHIVED",
          message: "Archived report history is not available in this phase.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    const [runs, signals] = await Promise.all([
      ReportRun.find({
        agency_id: agencyId,
        report_id: report._id,
      })
        .sort({ ran_at: -1 })
        .limit(limit)
        .lean(),
      Signal.find({
        agency_id: agencyId,
        report_id: report._id,
      })
        .sort({ detected_at: -1 })
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      success: true,
      report,
      runs,
      signals,
    });
  } catch (err) {
    logError(SCOPE, "GET_REPORT_HISTORY_FAILED", err, {
      reportId: req.params?.reportId,
    });

    return res.status(500).json({
      success: false,
      message: err.message || "Failed to fetch report history",
    });
  }
};

export const updateReport = async (req, res) => {
  let destinationLease = null;
  let destinationHeartbeat = null;
  let destinationAgencyId = null;
  let destinationClientId = null;

  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const userId = req.user.id;
    const { reportId } = req.body;
    const updates = req.body.updates || req.body;

    if (!reportId) {
      return res.status(400).json({
        success: false,
        message: "reportId required",
      });
    }

    logAction(SCOPE, "UPDATE_REPORT_REQUEST", {
      agencyId,
      userId,
      reportId,
      updateKeys: Object.keys(updates || {}),
      clientDeliveryMode: updates.client_delivery_mode || updates.clientDeliveryMode,
      internalRecipientCount: normalizeEmailList(
        updates.internal_recipients || updates.internalRecipients || []
      ).length,
      clientRecipientCount: normalizeEmailList(
        updates.client_recipients || updates.clientRecipients || []
      ).length,
    }, "blue");

    let report = await Report.findOne(
      withOperationalReportScope({
        _id: reportId,
        agency_id: agencyId,
      })
    );

    if (!report) {
      const archivedReport = await Report.exists({
        _id: reportId,
        agency_id: agencyId,
        is_archived: true,
      });
      if (archivedReport) {
        return res.status(409).json({
          success: false,
          code: "REPORT_ARCHIVED",
          message: "Archived reports cannot be updated.",
        });
      }
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    const wasActive = report.status === "active";
    const requestedClientId = updates.client_id || updates.clientId;
    const clientChanged =
      requestedClientId && String(requestedClientId) !== String(report.client_id);

    if (clientChanged) {
      destinationAgencyId = agencyId;
      destinationClientId = requestedClientId;
      destinationLease = await acquireRequiredClientLifecycleLease({
        agencyId,
        clientId: requestedClientId,
        operation: "report_reparent",
      });
      destinationHeartbeat = startClientLifecycleLeaseHeartbeat({
        agencyId,
        clientId: requestedClientId,
        token: destinationLease.token,
      });
      const replacementCampaigns = normalizeCampaigns(updates.monitored_campaigns || []);
      const { metaAdAccount } = await resolveReportAccountForClient({
        agencyId,
        clientId: requestedClientId,
        requestedMetaAdAccountId:
          updates.meta_ad_account_id || updates.metaAdAccountId,
        campaigns: replacementCampaigns,
      });

      report.client_id = requestedClientId;
      report.meta_ad_account_id = metaAdAccount._id;
      report.meta_account_external_id_snapshot = metaAdAccount.ad_account_id;
      report.meta_account_name_snapshot = metaAdAccount.name;
      report.monitored_campaigns = replacementCampaigns;
    } else if (
      (updates.meta_ad_account_id || updates.metaAdAccountId) &&
      String(updates.meta_ad_account_id || updates.metaAdAccountId) !==
        String(report.meta_ad_account_id)
    ) {
      const error = new Error("The report's Meta ad account cannot be changed implicitly.");
      error.code = "META_ACCOUNT_MISMATCH";
      error.status = 400;
      throw error;
    } else if (updates.monitored_campaigns !== undefined) {
      const replacementCampaigns = normalizeCampaigns(updates.monitored_campaigns);
      const context = await resolveMetaContextForReport(report);
      await validateCampaignsForMetaAccount({
        accessToken: context.accessToken,
        externalAdAccountId: context.externalAdAccountId,
        campaigns: replacementCampaigns,
      });
      report.monitored_campaigns = replacementCampaigns;
    }

    if (updates.name !== undefined) {
      report.name = normalizeReportName(updates.name);
    }

    if (updates.recipients !== undefined || updates.email !== undefined) {
      report.recipients = normalizeRecipients(updates.recipients, updates.email);
      if (updates.internal_recipients === undefined && updates.internalRecipients === undefined) {
        report.internal_recipients = report.recipients;
      }
    }

    if (updates.internal_recipients !== undefined || updates.internalRecipients !== undefined) {
      report.internal_recipients = normalizeEmailList(
        updates.internal_recipients || updates.internalRecipients
      );
      report.recipients = report.internal_recipients;
    }

    if (updates.client_recipients !== undefined || updates.clientRecipients !== undefined) {
      report.client_recipients = normalizeEmailList(
        updates.client_recipients || updates.clientRecipients
      );
    }

    if (
      updates.generate_client_report !== undefined ||
      updates.generateClientReport !== undefined
    ) {
      report.generate_client_report = readBool(
        updates.generate_client_report ?? updates.generateClientReport,
        true
      );
    }

    if (
      updates.generate_internal_report !== undefined ||
      updates.generateInternalReport !== undefined
    ) {
      report.generate_internal_report = readBool(
        updates.generate_internal_report ?? updates.generateInternalReport,
        true
      );
    }

    if (updates.client_delivery_mode !== undefined || updates.clientDeliveryMode !== undefined) {
      report.client_delivery_mode = normalizeClientDeliveryMode(
        updates.client_delivery_mode || updates.clientDeliveryMode
      );
    }

    if (updates.safety_settings !== undefined || updates.safetySettings !== undefined) {
      report.safety_settings = normalizeSafetySettings(
        updates.safety_settings || updates.safetySettings
      );
    }

    if (updates.severity !== undefined) {
      report.severity = updates.severity;
    }

    const type = updates.type || updates.frequency || report.type;
    const currentSchedule = report.schedule?.toObject?.() || report.schedule || {};
    const scheduleInput = {
      type,
      schedule: {
        ...currentSchedule,
        ...(updates.schedule || {}),
      },
    };
    const scheduleConfig = normalizeReportSchedule(scheduleInput);

    report.type = scheduleConfig.type;
    report.schedule = scheduleConfig.schedule;

    if (updates.status !== undefined || updates.is_active !== undefined) {
      report.status = normalizeStatus(updates.status ?? updates.is_active);
    }

    if (report.status === "active") {
      report.next_run_at = getNextRunAt(report);
    } else {
      report.next_run_at = null;
    }

    if (!destinationLease && !wasActive && report.status === "active") {
      await resolveMetaContextForReport(report);
    }

    if (destinationLease) {
      destinationHeartbeat.assertOwned();
      const desiredState = reportUpdateState(report);
      const committedReportId = await runRequiredTransaction({
        unavailableCode: "lifecycle_transaction_unavailable",
        unavailableMessage:
          "Report reparenting requires a transaction-capable database deployment.",
        work: async (session) => {
          await fenceClientLifecycleLeaseInTransaction({
            agencyId,
            clientId: destinationClientId,
            token: destinationLease.token,
            session,
          });
          const transactionalReport = await Report.findOne(
            withOperationalReportScope({
              _id: reportId,
              agency_id: agencyId,
            })
          )
            .select("+execution_lock")
            .session(session);
          if (!transactionalReport) {
            const error = new Error("Report is no longer available for update.");
            error.code = "REPORT_ARCHIVED";
            error.status = 409;
            throw error;
          }
          const transactionChangesClient =
            String(transactionalReport.client_id) !==
            String(desiredState.client_id);
          if (transactionChangesClient) {
            await assertReportClientReparentAllowed({
              agencyId,
              report: transactionalReport,
              session,
            });
          }
          const finalMetaAdAccount = await requireFinalMetaAccountBinding({
            agencyId,
            clientId: destinationClientId,
            metaAdAccountId: desiredState.meta_ad_account_id,
            session,
          });
          transactionalReport.set({
            ...desiredState,
            meta_account_external_id_snapshot: finalMetaAdAccount.ad_account_id,
            meta_account_name_snapshot: finalMetaAdAccount.name,
          });
          await transactionalReport.save({ session });
          return transactionalReport._id;
        },
      });
      report = await Report.findOne({
        _id: committedReportId,
        agency_id: agencyId,
      });
    } else {
      await report.save();
    }

    if (wasActive && report.status === "paused") {
      await recordActivity({
        agency_id: agencyId,
        client_id: report.client_id,
        report_id: report._id,
        user_id: userId,
        type: "report_paused",
        title: `${report.name} paused`,
        description: "Operational monitor was paused.",
        severity: "stable",
      });
    }

    logAction(SCOPE, "UPDATE_REPORT_SUCCESS", {
      agencyId,
      userId,
      reportId: report._id,
      clientId: report.client_id,
      name: report.name,
      type: report.type,
      status: report.status,
      clientDeliveryMode: report.client_delivery_mode,
      internalRecipientCount: report.internal_recipients?.length || 0,
      clientRecipientCount: report.client_recipients?.length || 0,
      nextRunAt: report.next_run_at,
      safetySettings: report.safety_settings,
    }, "green");

    return res.status(200).json({
      success: true,
      message: "Report updated",
      report,
    });
  } catch (err) {
    logError(SCOPE, "UPDATE_REPORT_FAILED", err);

    return res
      .status(err.status || 500)
      .json(metaErrorResponse(err, "Failed to update report"));
  } finally {
    if (destinationHeartbeat) await destinationHeartbeat.stop();
    if (destinationLease) {
      await releaseClientLifecycleLease({
        agencyId: destinationAgencyId,
        clientId: destinationClientId,
        token: destinationLease.token,
      }).catch(() => null);
    }
  }
};

export const deleteReport = async (req, res) => {
  try {
    const agencyId = requireAgency(req, res);
    if (!agencyId) return;

    const reportId = req.body?.reportId || req.params.reportId;

    if (!reportId) {
      return res.status(400).json({
        success: false,
        message: "reportId required",
      });
    }

    const result = await archiveReportLifecycle({
      agencyId,
      reportId,
      userId: req.user.id || req.user.userId || req.user._id,
    });

    if (result.outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    if (result.outcome === "execution_in_progress") {
      return res.status(409).json({
        success: false,
        code: "report_execution_in_progress",
        message: "This report is currently running. Try archiving it again after it finishes.",
        reportIds: result.reportIds,
      });
    }

    if (result.outcome === "dispatch_in_progress") {
      return res.status(409).json({
        success: false,
        code: "client_report_dispatch_in_progress",
        message: "This report is currently being delivered. Try again after delivery finishes.",
        reportIds: result.reportIds,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Report archived",
      archived: true,
      alreadyArchived: result.outcome === "already_archived",
      reportId: result.report._id,
    });
  } catch (err) {
    logError(SCOPE, "DELETE_REPORT_FAILED", err);

    return res.status(err.status || 500).json({
      success: false,
      code: err.code,
      message: err.message || "Failed to archive report",
    });
  }
};
