import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("scheduler triggers run-all and does not contain an email or Gmail delivery path", async () => {
  const schedulerSource = await readFile(
    new URL("../src/jobs/n8nScheduler.js", import.meta.url),
    "utf8"
  );
  const runAllSource = await readFile(
    new URL("../src/controllers/runAll.controller.js", import.meta.url),
    "utf8"
  );

  assert.match(schedulerSource, /N8N_SCHEDULER_WEBHOOK_URL/);
  assert.doesNotMatch(schedulerSource, /REPORT_EMAIL_WEBHOOK_URL|gmail/i);
  assert.match(runAllSource, /runDueReports/);
  assert.doesNotMatch(runAllSource, /sendReportEmail|gmail/i);
});
