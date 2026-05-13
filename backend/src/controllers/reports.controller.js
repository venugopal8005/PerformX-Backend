import { Report } from "../models/reports/metaReports.model.js";
export const createReport = async (req, res) => {
    try {
        console.log(req.body);
        const userId = req.user.id;
        const { ad_account_id, email, frequency } = req.body.formData;

        if (!ad_account_id || !email || !frequency) {
            return res.status(400).json({
                success: false,
                message: "All fields required",
            });
        }

        const report = await Report.create({
            user_id: userId,
            ad_account_id,
            email,
            frequency,
            is_active: false,
            last_run_at: null,
            next_run_at: null,
        });
            console.log("report saved");
        return res.status(201).json({
            success: true,
            report,
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            message: "Failed to create report",
        });
    }
};


// utility (moved out of controller)
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

export const startReport = async (req, res) => {
    try {
        console.log("start report called !!!");
        console.log("report starting");
        const userId = req.user.id;
        const { reportId } = req.body;
        console.log(reportId);

        // validate input
        if (!reportId) {
            return res.status(400).json({
                success: false,
                message: "reportId required",
            });
        }

        // fetch report
        const report = await Report.findOne({
            _id: reportId,
            user_id: userId,
        });

        // check existence FIRST
        if (!report) {
            return res.status(404).json({
                success: false,
                message: "Report not found",
            });
        }

        // prevent duplicate activation
        // if (report.is_active) {
        //     return res.status(400).json({
        //         success: false,
        //         message: "Report already active",
        //     });
        // }

        // activate
        report.is_active = true;
        report.next_run_at = getNextRun(report.frequency);

        await report.save();

        // trigger n8n (non-blocking safety)
        // try {
        //     await fetch("https://performx-v2.app.n8n.cloud/webhook-test/68991387-5464-42a6-a046-82379fb0c9c9", {
        //         method: "POST",
        //         headers: {
        //             "Content-Type": "application/json",
        //         },
        //         body: JSON.stringify({ reportId }),
        //     });
        //     console.log("n8n triggered");

        // } catch (err) {
        //     console.error("n8n trigger failed:", err);
        // }

        return res.status(200).json({
            success: true,
            message: "Report started",
        });

    } catch (err) {
        console.error("startReport error:", err);

        return res.status(500).json({
            success: false,
            message: "Failed to start report",
        });
    }
};

export const getReports = async (req, res) => {
  try {
    const userId = req.user.id; // comes from middleware

    const reports = await Report.find({ user_id: userId })
      .sort({ createdAt: -1 });

    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};




