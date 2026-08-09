import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  beta4PlaceholderContract,
  mergedBeta4Glossary,
  runBeta4Review,
} from "../src/beta4-review.mjs";
import { csvToObjects, objectsToCsv } from "../src/csv.mjs";
import { parsePlainTranslation } from "../src/hybrid.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fixture seed bao phủ đủ trạng thái ổn định mà không commit corpus", async () => {
  const rows = JSON.parse(await fs.readFile(path.join(ROOT, "tests", "fixtures", "seed-policy.json"), "utf8"));
  assert.deepEqual(new Set(rows.map((row) => row["Local Status"])), new Set([
    "KEEP_ENGLISH",
    "REVIEW",
    "LOCAL_OK",
    "REVIEW_MANDATORY",
    "APPROVED_EXISTING",
    "SKIP_EMPTY",
  ]));
});

test("parser No-JSON nhận marker cùng dòng và từ chối prompt bị vọng lại", () => {
  const sameLine = parsePlainTranslation({ content: "<<<GBFR_TRANSLATION>>>Bản dịch sạch<<<END_GBFR_TRANSLATION>>>" }, 1);
  assert.deepEqual(sameLine, ["Bản dịch sạch"]);
  const leaked = parsePlainTranslation({ content: "Chỉ đặt bản dịch vào giữa hai marker; không JSON, không Markdown" }, 1);
  assert.equal(leaked, null);
});

test("glossary Beta.4 bỏ xung đột Critical Hit Rate và placeholder giữ đủ từng lần xuất hiện", async () => {
  const base = JSON.parse(await fs.readFile(path.join(ROOT, "config", "glossary.json"), "utf8"));
  const glossary = mergedBeta4Glossary(base, []);
  assert.ok(!glossary.keepExact.includes("Critical Hit Rate"));
  assert.equal(glossary.translateAs["Critical Hit Rate"], "Tỷ lệ chí mạng");
  const contract = beta4PlaceholderContract(
    "Miasma Hands deals DMG +{0}% and DMG +{1}%.",
    "Miasma Hands gây sát thương +{0}% và sát thương +{1}%.",
    { keepExact: ["Miasma Hands", "DMG"], translateAs: {} },
  );
  assert.equal(contract.entries.filter((entry) => entry.value === "DMG").length, 2);
  assert.equal(contract.entries.filter((entry) => entry.value === "Miasma Hands").length, 1);
  assert.equal(contract.entries.filter((entry) => /^\{[01]\}$/u.test(entry.value)).length, 2);
});

test("Beta.4 sửa hàng review, tái kiểm toán local ok rủi ro, giữ narrative để QA tay và dùng checkpoint", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gbfr-beta4-review-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tempRoot, "config"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "config", "glossary.json"), path.join(tempRoot, "config", "glossary.json"));
  const headers = ["File", "Row", "ID", "SubID", "English", "Japanese", "Vietnamese", "Notes", "Priority", "Local Status", "Local Source", "Local QA", "Local Updated At"];
  const inputRows = [
    {
      File: "text_uskill.msg", Row: "1", ID: "TXT_US_PL2900_02", SubID: "", English: "Miasma Hands", Japanese: "", Vietnamese: "Miasma Hands",
      Notes: "", Priority: "P3", "Local Status": "KEEP_ENGLISH", "Local Source": "BETA3_PROTECTED_NAME_ID", "Local QA": "", "Local Updated At": "",
    },
    {
      File: "text_skillboard.msg", Row: "2", ID: "TXT_TEST_SKILL", SubID: "", English: "Uses Miasma Hands to deal DMG +{0}%.", Japanese: "", Vietnamese: "Dùng Tay Hôi để gây sát thương +{0}%.",
      Notes: "", Priority: "P3", "Local Status": "REVIEW", "Local Source": "BETA3_QWEN_REVIEW", "Local QA": "PROTECTED_TERM_MISSING", "Local Updated At": "",
    },
    {
      File: "text_story.msg", Row: "3", ID: "TXT_TEST_SKYFARER", SubID: "", English: "A skyfarer arrives.", Japanese: "", Vietnamese: "Một phi hành gia đến.",
      Notes: "", Priority: "P1", "Local Status": "LOCAL_OK", "Local Source": "BETA3_QWEN_REVIEW", "Local QA": "", "Local Updated At": "",
    },
    {
      File: "text_ui.msg", Row: "4", ID: "TXT_TEST_SUMMONS", SubID: "", English: "Summons", Japanese: "", Vietnamese: "Triệu hồi",
      Notes: "", Priority: "P3", "Local Status": "LOCAL_OK", "Local Source": "BETA3_QWEN_REVIEW", "Local QA": "", "Local Updated At": "",
    },
    {
      File: "text_story.msg", Row: "5", ID: "TXT_TEST_STORY", SubID: "", English: "The journey begins.", Japanese: "", Vietnamese: "Hành trình bắt đầu.",
      Notes: "", Priority: "P1", "Local Status": "REVIEW_MANDATORY", "Local Source": "BETA3_QWEN_REVIEW", "Local QA": "", "Local Updated At": "",
    },
  ];
  const inputPath = path.join(tempRoot, "seed.csv");
  await fs.writeFile(inputPath, objectsToCsv(inputRows, headers), "utf8");

  let chatCalls = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/v1/models") {
      response.end(JSON.stringify({ models: [{
        key: "qwen/qwen3.5-9b", display_name: "Qwen3.5 9B",
        loaded_instances: [{ id: "qwen-ready", config: { context_length: 8192 } }],
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      chatCalls += 1;
      const prompt = body.messages.at(-1).content;
      const sourceBlock = prompt.match(/ENGLISH_BEGIN\n([\s\S]*?)\nENGLISH_END/u)?.[1] || "";
      const markers = [...sourceBlock.matchAll(/GBFRKEEP\d{4}ZXQ/gu)].map((match) => match[0]);
      let translation;
      if (/ID: TXT_TEST_SKILL/u.test(prompt)) {
        translation = `Sử dụng ${markers[0]} để gây ${markers[1]} +${markers[2]}%.`;
      } else if (/ID: TXT_TEST_SKYFARER/u.test(prompt)) {
        translation = "Một Kỵ Không Sĩ xuất hiện.";
      } else if (/ID: TXT_TEST_SUMMONS/u.test(prompt)) {
        translation = "Summon";
      } else {
        translation = "Hành trình bắt đầu.";
      }
      response.end(JSON.stringify({
        choices: [{ message: { content: `<<<GBFR_TRANSLATION>>>${translation}<<<END_GBFR_TRANSLATION>>>` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const config = {
    pipelineVersion: "beta4-test", endpoint: `${base}/v1`, restEndpoint: `${base}/api/v1`,
    qwenPreference: ["qwen3.5", "9b"], qwenContextLength: 8192,
    qwenMaxTokens: 768, qwenEditorMaxTokens: 512, qwenRepairMaxTokens: 640,
    qwenRequestRetries: 0, beta4MaxRepairAttempts: 0, qwenTimeoutMs: 5000, timeoutMs: 5000,
    temperature: 0.15, topP: 0.85, topK: 40, seed: 137,
    glossaryFile: "config/glossary.json", outputRoot: "runs_hybrid",
  };
  const first = await runBeta4Review({ projectRoot: tempRoot, config, inputPath });
  assert.equal(first.report.reviewedUnits, 4);
  assert.equal(chatCalls, 4);
  const output = csvToObjects(await fs.readFile(path.join(first.runDir, "translated_working_beta4.csv"), "utf8")).rows;
  assert.equal(output[0].Vietnamese, "Miasma Hands");
  assert.equal(output[0]["Local Status"], "KEEP_ENGLISH");
  assert.equal(output[1].Vietnamese, "Sử dụng Miasma Hands để gây DMG +{0}%.");
  assert.equal(output[1]["Local Status"], "LOCAL_OK");
  assert.equal(output[2].Vietnamese, "Một Kỵ Không Sĩ xuất hiện.");
  assert.equal(output[2]["Local Status"], "REVIEW_MANDATORY");
  assert.equal(output[3].Vietnamese, "Summon");
  assert.equal(output[3]["Local Status"], "LOCAL_OK");
  assert.equal(output[4]["Local Status"], "REVIEW_MANDATORY");

  await runBeta4Review({ projectRoot: tempRoot, config, inputPath });
  assert.equal(chatCalls, 4, "lần chạy lại phải dùng checkpoint Beta.4");
});
