#!/usr/bin/env node
import fs from "node:fs/promises";

import { evaluateReleaseGate, loadJson } from "./release-gate.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const reportPath = option("--report");
const evidencePath = option("--evidence");
const outputPath = option("--output");
if (!reportPath || !evidencePath) {
  console.error("Dùng: node src/release-gate-cli.mjs --report production_report.json --evidence P0_EVIDENCE.json [--output RELEASE_GATE_REPORT.json]");
  process.exit(2);
}

const gate = evaluateReleaseGate({
  productionReport: await loadJson(reportPath),
  evidence: await loadJson(evidencePath),
});
const rendered = `${JSON.stringify(gate, null, 2)}\n`;
if (outputPath) await fs.writeFile(outputPath, rendered, "utf8");
console.log(rendered);
process.exit(gate.status === "PASS" ? 0 : 1);
