import fs from "node:fs/promises";

export const REQUIRED_P0_CHECKS = Object.freeze([
  "install",
  "boot",
  "main_menu",
  "translated_ui",
  "combat_hud",
  "uninstall",
  "rollback",
]);

export function evaluateReleaseGate({ productionReport, evidence }) {
  const blockers = [];
  if (!productionReport) blockers.push("MISSING_PRODUCTION_REPORT");
  if ((productionReport?.technicalErrorRows ?? 1) !== 0) blockers.push("TECHNICAL_ERRORS_REMAIN");
  if (productionReport?.datasetContract?.status !== "PASS") blockers.push("DATASET_CONTRACT_NOT_PASS");
  if (!evidence?.humanReview?.approved) blockers.push("HUMAN_REVIEW_NOT_APPROVED");
  if (!String(evidence?.humanReview?.evidence || "").trim()) blockers.push("HUMAN_REVIEW_EVIDENCE_MISSING");
  for (const check of REQUIRED_P0_CHECKS) {
    const item = evidence?.p0?.[check];
    if (item?.status !== "PASS") blockers.push(`P0_${check.toUpperCase()}_NOT_PASS`);
    if (!String(item?.evidence || "").trim()) blockers.push(`P0_${check.toUpperCase()}_EVIDENCE_MISSING`);
  }
  return {
    status: blockers.length ? "BLOCKED" : "PASS",
    decision: blockers.length ? "CHƯA PHÁT HÀNH" : "ĐỦ ĐIỀU KIỆN TẠO RELEASE CANDIDATE",
    blockers,
    requiredP0Checks: REQUIRED_P0_CHECKS,
  };
}

export async function loadJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
