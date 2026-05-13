import { Report } from "../models/reports/metaReports.model.js";
import { MetaConnection } from "../models/meta/metaConnection.model.js";

const getNextRun = (frequency) => {
  const now = new Date();

  switch (frequency) {
    case "15-min":
      return new Date(now.getTime() + 15 * 60 * 1000);

    case "hourly":
      return new Date(now.getTime() + 60 * 60 * 1000);

    case "daily":
      return new Date(now.setDate(now.getDate() + 1));

    case "weekly":
      return new Date(now.setDate(now.getDate() + 7));

    case "monthly":
      return new Date(now.setMonth(now.getMonth() + 1));

    default:
      return now;
  }
};

export const runAllReports = async (req, res) => {
  try {
    const now = new Date();

    const reports = await Report.find({ is_active: true });

    const results = [];

    for (const report of reports) {
      // ⛔ skip if not time
      if (report.next_run_at && now < report.next_run_at) continue;

      const connection = await MetaConnection.findOne({
        user_id: report.user_id,
      });

      if (!connection) continue;

      const { access_token } = connection;

      const response = await fetch(
        `https://graph.facebook.com/v19.0/${report.ad_account_id}/insights?fields=campaign_name,impressions,clicks,ctr,cpc,spend&date_preset=maximum&level=ad&access_token=${access_token}`
      );

      const data = await response.json();

      if (data.error) {
        console.error("Meta error:", data.error);
        continue;
      }

      const r = data.data?.[0];

      if (!r) continue;

      const html = `
        <h2>Meta Ads Report</h2>
        <p><b>Campaign:</b> ${r.campaign_name}</p>
        <p><b>Impressions:</b> ${r.impressions}</p>
        <p><b>Clicks:</b> ${r.clicks}</p>
        <p><b>CTR:</b> ${r.ctr}</p>
        <p><b>CPC:</b> ${r.cpc}</p>
        <p><b>Spend:</b> ${r.spend}</p>
      `;

      // collect result instead of sending
      results.push({
        email: report.email,
        html,
      });

      // update schedule
      report.last_run_at = now;
      report.next_run_at = getNextRun(report.frequency);

      await report.save();
    }

    return res.json({
      success: true,
      count: results.length,
      results,
    });

  } catch (err) {
    console.error("run-all error:", err);

    return res.status(500).json({
      success: false,
      message: "run-all failed",
    });
  }
};