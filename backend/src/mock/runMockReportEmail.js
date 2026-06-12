import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePerformanceNarrative } from "../../performanceNarratorEngine.js";
import {
  formatPerformanceEmail,
  formatPerformanceEmailSubject,
} from "../utils/performanceEmailFormatter.js";
import scenarios from "./narrativeMockMetaScenarios.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SCENARIO = "veryBadSignal";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positionalArgs = args.filter((arg) => !arg.startsWith("--"));

const valueForFlag = (name) => {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
};

const resolveOutputPath = (value, fallbackName) => {
  const target = value || path.join(__dirname, "generated", fallbackName);
  return path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
};

const campaignFromRows = (rows = []) => {
  const firstRow = rows.find((row) => row?.campaign_name || row?.campaign_id) || {};

  return {
    id: firstRow.campaign_id || "mock-campaign",
    name: firstRow.campaign_name || "Mock Meta Ads Campaign",
    adAccountId: firstRow.account_id || "act_mock",
  };
};

const listScenarios = () => {
  console.log("Available mock scenarios:");
  Object.entries(scenarios).forEach(([key, scenario]) => {
    console.log(`- ${key}: ${scenario.label || scenario.description || "Mock scenario"}`);
  });
};

const postToWebhook = async (webhookUrl, payload) => {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Mock email webhook failed: ${response.status} ${body}`.trim());
  }

  return response.text().catch(() => "");
};

if (flags.has("--list")) {
  listScenarios();
  process.exit(0);
}

const scenarioKey = positionalArgs[0] || process.env.MOCK_REPORT_SCENARIO || DEFAULT_SCENARIO;
const scenario = scenarios[scenarioKey];

if (!scenario) {
  listScenarios();
  throw new Error(`Unknown mock scenario "${scenarioKey}".`);
}

const campaign = campaignFromRows(scenario.rows);
const generatedAt = new Date().toLocaleString("en-IN", {
  timeZone: scenario.options?.timeZone || "Asia/Kolkata",
});
const recipient =
  valueForFlag("--to") ||
  process.env.MOCK_REPORT_RECIPIENT ||
  process.env.MOCK_EMAIL_TO ||
  "";
const webhookUrl = valueForFlag("--webhook") || process.env.MOCK_REPORT_WEBHOOK_URL || "";
const shouldSend = flags.has("--send");

const narrative = generatePerformanceNarrative(
  {
    rows: scenario.rows,
    reportGoal: scenario.options?.reportGoal || null,
    context: {
      campaignId: campaign.id,
      campaignName: campaign.name,
      reportName: scenario.label,
    },
  },
  scenario.options || {}
);
const emailSubject = formatPerformanceEmailSubject(narrative, {
  campaignName: campaign.name,
});
const emailHtml = formatPerformanceEmail(narrative, {
  title: "Sample report",
  subject: emailSubject,
  campaignName: campaign.name,
  generatedAt,
  sampleMode: true,
  isSampleReport: true,
});
const recipients = recipient ? [recipient] : [];
const payload = {
  mock: true,
  scenarioKey,
  reportId: `mock-${scenarioKey}`,
  reportName: scenario.label || scenarioKey,
  agencyId: "mock-agency",
  clientId: "mock-client",
  recipients,
  email: recipient || null,
  adAccountId: campaign.adAccountId,
  adAccountName: "Mock Meta Ad Account",
  narrative,
  reportRun: null,
  signals: [],
  activities: [],
  emailSubject,
  emailHtml,
  comparison: {
    mode: "mock_daily_rows",
    period: narrative.period,
    rowCount: scenario.rows.length,
  },
};
const htmlPath = resolveOutputPath(
  valueForFlag("--out"),
  `${scenarioKey}-report.html`
);
const jsonPath = resolveOutputPath(
  valueForFlag("--json-out"),
  `${scenarioKey}-payload.json`
);

await fs.mkdir(path.dirname(htmlPath), { recursive: true });
await fs.writeFile(htmlPath, emailHtml, "utf8");

if (!flags.has("--no-json")) {
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
}

if (shouldSend) {
  if (!webhookUrl) {
    throw new Error(
      "Set MOCK_REPORT_WEBHOOK_URL or pass --webhook=https://... before using --send."
    );
  }

  if (!recipient) {
    throw new Error(
      "Set MOCK_REPORT_RECIPIENT or pass --to=email@example.com before using --send."
    );
  }

  await postToWebhook(webhookUrl, payload);
}

console.log(`Mock scenario: ${scenarioKey}`);
console.log(`Subject: ${emailSubject}`);
console.log(`HTML preview: ${htmlPath}`);
if (!flags.has("--no-json")) console.log(`Payload JSON: ${jsonPath}`);
console.log(
  shouldSend
    ? `Sent mock payload to webhook for ${recipient}.`
    : "Email was not sent. Use --send with MOCK_REPORT_WEBHOOK_URL and MOCK_REPORT_RECIPIENT to deliver it."
);
