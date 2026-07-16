import crypto from "node:crypto";

import { ISSUE_MATCHING_VERSION } from "../domain/phase2Issue.domain.js";

const dateOnly = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return text;
};

export const readIssueComparisonWindow = (reportRun = {}) => {
  const period = reportRun?.comparison?.period || reportRun?.period || {};
  const current = period?.current || {};
  const start = dateOnly(
    typeof current === "string" ? current : current.start || current.date
  );
  const end = dateOnly(
    typeof current === "string" ? current : current.end || current.date
  );
  if (!start || !end) return null;
  const startDate = new Date(`${start}T00:00:00.000Z`);
  const endDate = new Date(`${end}T23:59:59.999Z`);
  if (startDate > endDate) return null;
  return { start, end, startDate, endDate };
};

export const buildIssueObservationKey = ({ fingerprint, reportRun } = {}) => {
  const window = readIssueComparisonWindow(reportRun);
  if (!fingerprint || !window) return null;
  const input = JSON.stringify({
    v: ISSUE_MATCHING_VERSION,
    fingerprint: String(fingerprint),
    current_start: window.start,
    current_end: window.end,
  });
  return {
    key: crypto.createHash("sha256").update(input, "utf8").digest("hex"),
    window,
  };
};

const narrativeDataLevel = (reportRun) =>
  String(reportRun?.narrative?.dataQuality?.level || "").toLowerCase();

export const classifyCleanIssueObservation = ({ reportRun, issue = null } = {}) => {
  const narrative = reportRun?.narrative || {};
  const comparisonMode = reportRun?.comparison?.mode || narrative?.comparisonMode;
  const trustedBase =
    Boolean(reportRun?.meta_binding_performance_validated_at) &&
    narrative.status === "ok" &&
    comparisonMode === "scheduled_window" &&
    narrative?.trustGate?.blocked === false &&
    ["strong", "usable"].includes(narrativeDataLevel(reportRun));

  if (!trustedBase) {
    return { trustedBase: false, clean: false, reason: "untrusted_observation" };
  }

  const dataQualityRecovery = issue?.archetype === "data_quality_issue";
  const stablePerformance = narrative?.likelyCause?.id === "stable_performance";
  return {
    trustedBase: true,
    clean: dataQualityRecovery || stablePerformance,
    reason: dataQualityRecovery
      ? "data_quality_recovered"
      : stablePerformance
        ? "stable_performance"
        : "non_clean_observation",
  };
};

export const classifyIssueObservationOrder = ({ issue, observation }) => {
  if (!issue?.last_observation_end || !observation?.window?.endDate) return "newer";
  const priorEnd = new Date(issue.last_observation_end);
  if (Number.isNaN(priorEnd.getTime())) return "newer";
  if (observation.window.endDate < priorEnd) return "stale";
  if (observation.key === issue.last_observation_key) {
    return "duplicate";
  }
  return "newer";
};
