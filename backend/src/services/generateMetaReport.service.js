import { runReport } from "./reportRunner.service.js";

export const generateMetaReport = async (reportId, options = {}) => {
  const result = await runReport(reportId, {
    ...options,
    force: options.force ?? true,
  });

  return {
    reportId: result.report._id,
    reportName: result.report.name,
    agencyId: result.report.agency_id,
    clientId: result.report.client_id,
    clientName: result.clientName,
    recipients: result.internalReport?.recipients?.map((recipient) => recipient.email) || result.recipients,
    email: result.internalReport?.recipients?.[0]?.email || result.recipients?.[0] || null,
    adAccountId: result.connection.ad_account_id,
    adAccountName: result.connection.ad_account_name,
    narrative: result.narrative,
    reportRun: result.reportRun,
    signals: result.signals,
    activities: result.activities,
    emailSubject: result.emailSubject,
    emailHtml: result.emailHtml,
    internalReport: result.internalReport,
    clientReport: result.clientReport,
    comparison: result.comparison,
  };
};
