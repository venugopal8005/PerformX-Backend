import { Report } from "../models/reports/metaReports.model.js";
import { MetaConnection } from "../models/meta/metaConnection.model.js";
import { generatePerformanceNarrative } from "../../performanceNarratorEngine.js";
import {
  formatPerformanceEmail,
  formatPerformanceEmailSubject,
} from "../utils/performanceEmailFormatter.js";

const META_INSIGHT_FIELDS = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "spend",
  "reach",
  "frequency",
  "cpm",
  "actions",
  "cost_per_action_type",
].join(",");

const formatAdAccountId = (adAccountId) => {
  const value = String(adAccountId || "").trim();
  return value.startsWith("act_") ? value : `act_${value}`;
};

export const manualSendReport = async (req, res) => {
  try {
    console.log("manual send called !!!");
    const { reportId } = req.body;
    console.log(reportId);

    if (!reportId) {
      console.log("reportId not found");
      return res.status(400).json({
        success: false,
        message: "reportId required",
      });
    }

    const report = await Report.findById(reportId);

    if (!report) {
      console.log("report not found");

      return res.status(404).json({
        success: false,
        message: "Report not found",
      });
    }

    const connection = await MetaConnection.findOne({
      user_id: report.user_id,
    });

    if (!connection) {
      console.log("connection not found");

      return res.status(404).json({
        success: false,
        message: "Meta not connected",
      });
    }

    const { access_token } = connection;
    const params = new URLSearchParams({
      fields: META_INSIGHT_FIELDS,
      time_increment: "1",
      date_preset: "maximum",
      level: "ad",
      
      access_token,
    });

    const response = await fetch(
      `https://graph.facebook.com/v25.0/${formatAdAccountId(report.ad_account_id)}/insights?${params.toString()}`
    );
    console.log(response);

    const data = await response.json();

    if (data.error) {
      return res.status(400).json({
        success: false,
        message: data.error.message,
      });
    }

    const narrative = generatePerformanceNarrative({
      data: data.data || [],
      context: {
        campaignId: report.ad_account_id,
        campaignName: "Meta Ads Account Report",
      },
    }, {
      currency: "INR",
      currencySymbol: "INR ",
      excludeToday: true,
    });
    const emailSubject = formatPerformanceEmailSubject(narrative, {
      campaignName: "Meta Ads Account Report",
    });
    const emailHtml = formatPerformanceEmail(narrative, {
      title: "Meta Ads Performance Report",
      subject: emailSubject,
      campaignName: "Meta Ads Account Report",
      generatedAt: new Date().toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
      }),
    });

    // send to n8n
    const n8nResponse = await fetch("https://performx-v2.app.n8n.cloud/webhook-test/68991387-5464-42a6-a046-82379fb0c9c9", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: report.email,
        reportId: report._id,
        adAccountId: report.ad_account_id,
        metaData: data,
        narrative,
        userInsight: narrative.userInsight,
        emailSubject,
        emailHtml,
      }),
    });

    if (!n8nResponse.ok) {
      const n8nError = await n8nResponse.text();
      console.error("n8n webhook failed:", n8nResponse.status, n8nError);

      return res.status(502).json({
        success: false,
        message: "Report generated, but n8n webhook failed",
      });
    }

    return res.json({
      success: true,
      message: "Report sent to n8n",
      narrative,
      emailSubject,
      emailHtml,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: "Manual send failed",
    });
  }
};
