import cron from "node-cron";
import { logAction, logError } from "../utils/controllerLogger.js";

const SCOPE = "Scheduler";
const SCHEDULE = "* * * * *";

export function startN8NScheduler() {
  const webhookUrl = process.env.N8N_SCHEDULER_WEBHOOK_URL;

  if (!webhookUrl) {
    logAction(
      SCOPE,
      "N8N_SCHEDULER_DISABLED",
      { reason: "N8N_SCHEDULER_WEBHOOK_URL is not configured" },
      "yellow"
    );
    return;
  }

  let isTriggerRunning = false;

  logAction(SCOPE, "N8N_SCHEDULER_STARTED", { schedule: SCHEDULE }, "green");

  cron.schedule(SCHEDULE, async () => {
    if (isTriggerRunning) {
      logAction(
        SCOPE,
        "N8N_SCHEDULER_TICK_SKIPPED",
        { reason: "Previous scheduler webhook request is still running" },
        "yellow"
      );
      return;
    }

    isTriggerRunning = true;
    logAction(SCOPE, "N8N_SCHEDULER_TRIGGER_STARTED", undefined, "blue");

    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new Error(`Webhook failed with status ${response.status}`);
      }

      logAction(
        SCOPE,
        "N8N_SCHEDULER_TRIGGER_SUCCEEDED",
        { status: response.status },
        "green"
      );
    } catch (error) {
      logError(SCOPE, "N8N_SCHEDULER_TRIGGER_FAILED", error);
    } finally {
      isTriggerRunning = false;
    }
  });
}
