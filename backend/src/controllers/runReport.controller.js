import { Report } from "../models/reports/metaReports.model.js";
import { MetaConnection } from "../models/meta/metaConnection.model.js";

// clean utility (no mutation bugs)
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

export const runReport = async (req, res) => {
  try {
    const { reportId } = req.query;

    console.log("RunReport triggered:", reportId);

    // 1. validate input
    if (!reportId) {
      return res.status(400).json({
        success: false,
        message: "reportId required",
      });
    }

    // 2. fetch report
    const report = await Report.findById(reportId);

    if (!report) {
      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    // 3. check active
    if (!report.is_active) {
      return res.status(200).json({
        success: false,
        message: "Report is inactive",
      });
    }

    // 4. check schedule
    if (report.next_run_at && new Date() < report.next_run_at) {
      console.log("Skipping - not time yet:", reportId);

      return res.status(200).json({
        success: true,
        message: "Not time to run yet",
      });
    }

    console.log("Executing report:", reportId);

    // 5. get Meta connection
    const connection = await MetaConnection.findOne({
      user_id: report.user_id,
    });

    if (!connection) {
      return res.status(404).json({
        success: false,
        message: "Meta not connected",
      });
    }

    const { access_token } = connection;
    console.log("access token : ",access_token);

    // 6. call Meta insights
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${report.ad_account_id}/insights?fields=campaign_name,adset_name,ad_name,impressions,clicks,ctr,cpc,spend&date_preset=maximum&level=ad&access_token=${access_token}`
    );

    const data = await response.json();

    if (data.error) {
      console.error("Meta API Error:", data.error);

      return res.status(400).json({
        success: false,
        message: data.error.message,
      });
    }

    if (!data.data || data.data.length === 0) {
      console.log("No insights data for report:", reportId);
    } else {
      console.log("Fetched insights count:", data.data.length);
    }

    // 7. update schedule
    report.last_run_at = new Date();
    report.next_run_at = getNextRun(report.frequency);

    await report.save();

    console.log("Report updated:", reportId);

    // 8. return result for n8n
    return res.status(200).json({
      success: true,
      email: report.email,
      reportData: data.data || [],
    });

  } catch (err) {
    console.error("runReport error:", err);

    return res.status(500).json({
      success: false,
      message: "Failed to run report",
    });
  }
};