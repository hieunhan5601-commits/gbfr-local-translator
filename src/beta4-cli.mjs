import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBeta4Review } from "./beta4-review.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConfig() {
  return JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "config", "default.json"), "utf8"));
}

function progress(event) {
  if (event.stage === "beta4-start") {
    console.log(`\nBETA.4 — ${event.rows} dòng; ${event.targetedRows} dòng / ${event.units} nhóm sửa cuối.`);
    console.log(`Checkpoint dùng lại: ${event.reused}. Tên/thuật ngữ khóa thêm: ${event.exactKeepsApplied}.`);
  } else if (event.stage === "beta4-model") {
    console.log(`Qwen READY: ${event.model}\n`);
  } else if (event.stage === "beta4-repair") {
    console.log(`[SỬA CUỐI ${event.current}/${event.total}] ${event.id}${event.clean ? " — QA OK" : " — giữ REVIEW"}`);
  } else if (event.stage === "beta4-done") {
    console.log(`\nHOÀN TẤT: ${event.runDir}`);
  }
}

async function main() {
  const config = await loadConfig();
  const input = path.join(PROJECT_ROOT, "data", "translated_working_beta4_seed.csv");
  const result = await runBeta4Review({ projectRoot: PROJECT_ROOT, config, inputPath: input, onProgress: progress });
  console.log(`\n${result.report.decision}`);
  console.log(`Đã xử lý: ${result.report.reviewedUnits} nhóm`);
  console.log(`LOCAL_OK/đã khóa: ${result.report.acceptedRows}`);
  console.log(`Cần QA cuối: ${result.report.reviewRows}`);
  console.log(`Dòng còn lỗi xác định: ${result.report.deterministicErrorRows}`);
}

main().catch((error) => {
  console.error(`\nLỖI: ${error.message}`);
  if (/fetch failed|ECONNREFUSED|aborted|timeout/iu.test(error.message)) {
    console.error("Hãy mở LM Studio > Developer, bật Local Server ở cổng 1234 rồi chạy lại. Checkpoint vẫn được giữ.");
  }
  process.exitCode = 1;
});
