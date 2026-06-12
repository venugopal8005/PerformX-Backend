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
    recipients: result.recipients,
    email: result.recipients?.[0] || null,
    adAccountId: result.connection.ad_account_id,
    adAccountName: result.connection.ad_account_name,
    narrative: result.narrative,
    reportRun: result.reportRun,
    signals: result.signals,
    activities: result.activities,
    emailSubject: result.emailSubject,
    emailHtml: result.emailHtml,
    comparison: result.comparison,
  };
};
