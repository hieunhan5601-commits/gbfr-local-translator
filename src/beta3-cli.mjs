import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBeta3Review } from "./beta3-review.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConfig() {
  return JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "config", "default.json"), "utf8"));
}

function progress(event) {
  if (event.stage === "beta3-start") {
    console.log(`\nBETA.3 — ${event.rows} dòng; ${event.units} nhóm cần biên tập.`);
    console.log(`Checkpoint: editor ${event.editorReused}, critic ${event.criticReused}.`);
  } else if (event.stage === "beta3-model") {
    console.log(`Qwen READY: ${event.model}\n`);
  } else if (event.stage === "beta3-editor") {
    console.log(`[BIÊN TẬP ${event.current}/${event.total}] ${event.id}`);
  } else if (event.stage === "beta3-critic") {
    console.log(`[KIỂM ĐỊNH ${event.current}/${event.total}] ${event.id}`);
  } else if (event.stage === "beta3-done") {
    console.log(`\nHOÀN TẤT: ${event.runDir}`);
  }
}

async function main() {
  const config = await loadConfig();
  const input = path.join(PROJECT_ROOT, "data", "translated_working_beta3_seed.csv");
  const result = await runBeta3Review({ projectRoot: PROJECT_ROOT, config, inputPath: input, onProgress: progress });
  console.log(`\n${result.report.decision}`);
  console.log(`Đã biên tập: ${result.report.reviewedUnits} nhóm`);
  console.log(`LOCAL_OK/đã khóa: ${result.report.acceptedRows}`);
  console.log(`Cần duyệt: ${result.report.reviewRows}`);
  console.log(`Lỗi kỹ thuật: ${result.report.technicalErrorRows}`);
}

main().catch((error) => {
  console.error(`\nLỖI: ${error.message}`);
  if (/fetch failed|ECONNREFUSED|aborted|timeout/iu.test(error.message)) {
    console.error("Hãy mở LM Studio > Developer, bật Local Server ở cổng 1234 rồi chạy lại. Checkpoint vẫn được giữ.");
  }
  process.exitCode = 1;
});
