import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hybridDoctor, runHybridAdversarial, runHybridProduction } from "./hybrid.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConfig() {
  return JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "config", "default.json"), "utf8"));
}

function progress(event) {
  if (event.stage === "resume") console.log(`\nTIẾP TỤC LƯỢT CHẠY DỞ — dùng lại đủ 30 phương án TranslateGemma`);
  else if (event.stage === "reuse-gemma") console.log(`\nLƯỢT QWEN MỚI — dùng lại đủ 30 phương án TranslateGemma, bỏ toàn bộ editor/critic cũ`);
  else if (event.stage === "gemma-seed") console.log(`\nĐã lấy lại ${event.count} phương án TranslateGemma từ cổng 30 dòng.`);
  else if (event.stage === "gemma-start") console.log(`\nGIAI ĐOẠN 1/4 — TranslateGemma tạo phương án cho ${event.total} dòng`);
  else if (event.stage === "gemma-item") console.log(`[TG ${event.current}/${event.total}] ${event.id}${event.bypassed ? " — giữ English bằng script" : event.reused ? " — dùng lại checkpoint 30 dòng" : ""}`);
  else if (event.stage === "switch-start") console.log("\nGIAI ĐOẠN 2/4 — Gỡ TranslateGemma và nạp Qwen tuần tự...");
  else if (event.stage === "switch-done") console.log(`Qwen READY: ${event.model}`);
  else if (event.stage === "qwen-resume") console.log(`Đã dùng lại checkpoint Qwen: editor ${event.editor}, critic ${event.critic}`);
  else if (event.stage === "editor-start") console.log(`\nGIAI ĐOẠN 3/4 — Qwen biên tập độc lập ${event.total} batch`);
  else if (event.stage === "editor-batch") console.log(`[EDITOR ${event.current}/${event.total}] Đã biên tập ${event.items} dòng`);
  else if (event.stage === "critic-start") console.log(`\nGIAI ĐOẠN 4/4 — Qwen kiểm định độc lập ${event.total} batch`);
  else if (event.stage === "critic-batch") console.log(`[CRITIC ${event.current}/${event.total}] Đã kiểm định ${event.items} dòng`);
  else if (event.stage === "production-start") console.log(`\nDỊCH DỮ LIỆU THẬT — ${event.totalRows} dòng, ${event.units} nhóm cần model; đã có ${event.resumedFinal} checkpoint hoàn tất.`);
  else if (event.stage === "production-gemma-start") console.log(`\nGIAI ĐOẠN 1/4 — TranslateGemma: ${event.total} nhóm còn lại, dùng lại ${event.reused}.`);
  else if (event.stage === "production-gemma-item") console.log(`[TG ${event.current}/${event.total}] ${event.id}`);
  else if (event.stage === "production-switch-start") console.log("\nGIAI ĐOẠN 2/4 — Chuyển sang Qwen...");
  else if (event.stage === "production-switch-done") console.log(`Qwen READY: ${event.model}`);
  else if (event.stage === "production-editor-start") console.log(`\nGIAI ĐOẠN 3/4 — Qwen biên tập: ${event.total} nhóm còn lại, dùng lại ${event.reused}.`);
  else if (event.stage === "production-editor-item") console.log(`[EDITOR ${event.current}/${event.total}] ${event.id}`);
  else if (event.stage === "production-critic-start") console.log(`\nGIAI ĐOẠN 4/4 — Qwen kiểm định: ${event.total} nhóm còn lại, dùng lại ${event.reused}.`);
  else if (event.stage === "production-critic-item") console.log(`[CRITIC ${event.current}/${event.total}] ${event.id}`);
  else if (event.stage === "production-resolve-start") console.log(`\nHẬU KIỂM CUỐI — ${event.total} nhóm còn lại, dùng lại ${event.reused}.`);
  else if (event.stage === "production-resolve-item") console.log(`[QA ${event.current}/${event.total}] ${event.id} — ${event.status}`);
  else if (event.stage === "production-done") console.log(`\nHOÀN TẤT: ${event.runDir}`);
}

function optionValue(name) {
  const direct = process.argv.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function help() {
  console.log(`GBFR Local Translator Hybrid v0.2.0-beta.2 Production No-JSON

Lệnh:
  node src/hybrid-cli.mjs doctor
  node src/hybrid-cli.mjs benchmark
  node src/hybrid-cli.mjs resume
  node src/hybrid-cli.mjs reuse-gemma
  node src/hybrid-cli.mjs stress100
  node src/hybrid-cli.mjs resume100
  node src/hybrid-cli.mjs production --input <file.csv>

Chạy lại lệnh production với cùng file sẽ tự tiếp tục checkpoint.`);
}

async function main() {
  const command = process.argv[2] || "help";
  const config = await loadConfig();
  if (command === "help") help();
  else if (command === "doctor") {
    const result = await hybridDoctor({ projectRoot: PROJECT_ROOT, config });
    console.log("GBFR HYBRID — KIỂM TRA MODEL");
    console.log(`TranslateGemma: READY — ${result.gemma.key} (${result.gemma.quantization})`);
    console.log(`Qwen: ĐÃ TẢI — ${result.qwen.key} (${result.qwen.quantization})`);
    console.log(`Câu thử TranslateGemma: ${result.smoke}`);
    console.log("KẾT LUẬN: Đủ điều kiện chạy bộ 30 dòng. Chưa đánh giá chất lượng ngữ nghĩa.");
  } else if (command === "benchmark") {
    const result = await runHybridAdversarial({ projectRoot: PROJECT_ROOT, config, onProgress: progress });
    console.log(`\n${result.report.decision}`);
    console.log(`Thư mục kết quả: ${result.runDir}`);
  } else if (command === "resume") {
    const result = await runHybridAdversarial({ projectRoot: PROJECT_ROOT, config, onProgress: progress, resume: true });
    console.log(`\n${result.report.decision}`);
    console.log(`Thư mục kết quả: ${result.runDir}`);
  } else if (command === "reuse-gemma") {
    const result = await runHybridAdversarial({ projectRoot: PROJECT_ROOT, config, onProgress: progress, reuseGemma: true });
    console.log(`\n${result.report.decision}`);
    console.log(`Thư mục kết quả: ${result.runDir}`);
  } else if (command === "stress100") {
    const result = await runHybridAdversarial({ projectRoot: PROJECT_ROOT, config, onProgress: progress, stress100: true });
    console.log(`\n${result.report.decision}`);
    console.log(`Thư mục kết quả: ${result.runDir}`);
  } else if (command === "resume100") {
    const result = await runHybridAdversarial({ projectRoot: PROJECT_ROOT, config, onProgress: progress, stress100: true, resume: true });
    console.log(`\n${result.report.decision}`);
    console.log(`Thư mục kết quả: ${result.runDir}`);
  } else if (command === "production") {
    const input = optionValue("--input");
    if (!input) throw new Error("Thiếu --input <file.csv>.");
    const result = await runHybridProduction({
      projectRoot: PROJECT_ROOT,
      config,
      inputPath: input,
      limit: optionValue("--limit"),
      onProgress: progress,
    });
    console.log(`\n${result.report.decision}`);
    console.log(`LOCAL_OK: ${result.report.localOkRows}`);
    console.log(`Cần duyệt: ${result.report.reviewRows}`);
    console.log(`Lỗi kỹ thuật: ${result.report.technicalErrorRows}`);
    console.log(`Thư mục kết quả: ${result.runDir}`);
  } else throw new Error(`Lệnh không hợp lệ: ${command}`);
}

main().catch((error) => {
  console.error(`\nLỖI: ${error.message}`);
  if (/fetch failed|ECONNREFUSED|aborted/iu.test(error.message)) {
    console.error("Hãy mở LM Studio > Developer, bật Local Server ở cổng 1234 rồi chạy lại.");
  }
  process.exitCode = 1;
});
