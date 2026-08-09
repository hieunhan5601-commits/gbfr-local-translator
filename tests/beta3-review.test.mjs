import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runBeta3Review } from "../src/beta3-review.mjs";
import { csvToObjects, objectsToCsv } from "../src/csv.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("beta.3 chỉ biên tập review, giữ tên và checkpoint kết quả", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gbfr-beta3-review-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tempRoot, "config"), { recursive: true });
  await fs.copyFile(path.join(ROOT, "config", "glossary.json"), path.join(tempRoot, "config", "glossary.json"));
  const headers = ["File", "Row", "ID", "SubID", "English", "Japanese", "Vietnamese", "Notes", "Priority", "Local Status", "Local Source", "Local QA", "Local Updated At"];
  const inputRows = [
    {
      File: "text.msg", Row: "1", ID: "TXT_US_PL2900_02", SubID: "", English: "Miasma Hands", Japanese: "", Vietnamese: "Miasma Hands",
      Notes: "", Priority: "P3 - Hệ thống/Thuật ngữ", "Local Status": "KEEP_ENGLISH", "Local Source": "BETA3_PROTECTED_NAME_ID", "Local QA": "", "Local Updated At": "",
    },
    {
      File: "text.msg", Row: "2", ID: "TXT_TEST_SKILL", SubID: "", English: "Uses Miasma Hands.", Japanese: "", Vietnamese: "Dùng Tay Hôi.",
      Notes: "", Priority: "P3 - Hệ thống/Thuật ngữ", "Local Status": "REVIEW", "Local Source": "EDITOR_DRAFT", "Local QA": "PROTECTED_NAME_MISSING", "Local Updated At": "",
    },
    {
      File: "text.msg", Row: "3", ID: "TXT_TEST_BONE", SubID: "", English: "A bone from the beast.", Japanese: "", Vietnamese: "Một xương của quái vật.",
      Notes: "", Priority: "P3 - Hệ thống/Thuật ngữ", "Local Status": "REVIEW", "Local Source": "EDITOR_DRAFT", "Local QA": "BETA3_LONG_TEXT_REVIEW", "Local Updated At": "",
    },
    {
      File: "story.msg", Row: "4", ID: "TXT_TEST_STORY", SubID: "", English: "The journey begins.", Japanese: "", Vietnamese: "Hành trình bắt đầu.",
      Notes: "", Priority: "P1 - Cốt truyện", "Local Status": "REVIEW_MANDATORY", "Local Source": "EDITOR_DRAFT", "Local QA": "BETA3_STORY_REVIEW", "Local Updated At": "",
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
        key: "qwen/qwen3.5-9b",
        display_name: "Qwen3.5 9B",
        quantization: { name: "Q4_K_M" },
        loaded_instances: [{ id: "qwen-ready", config: { context_length: 8192 } }],
      }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      chatCalls += 1;
      const prompt = body.messages.at(-1).content;
      let content;
      if (/VIETNAMESE_AUDIT_BEGIN/u.test(prompt)) {
        content = "<<<GBFR_AUDIT>>>\nMEANING=PASS\nNATURALNESS=PASS\nVERDICT=SAFE\nISSUES=NONE\n<<<END_GBFR_AUDIT>>>";
      } else if (/Uses Miasma Hands\./u.test(prompt)) {
        content = "<<<GBFR_TRANSLATION>>>\nSử dụng Miasma Hands.\n<<<END_GBFR_TRANSLATION>>>";
      } else if (/A bone from the beast\./u.test(prompt)) {
        content = "<<<GBFR_TRANSLATION>>>\nMột mẩu xương của quái vật.\n<<<END_GBFR_TRANSLATION>>>";
      } else {
        content = "<<<GBFR_TRANSLATION>>>\nHành trình bắt đầu.\n<<<END_GBFR_TRANSLATION>>>";
      }
      response.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
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
    pipelineVersion: "beta3-test",
    endpoint: `${base}/v1`,
    restEndpoint: `${base}/api/v1`,
    qwenPreference: ["qwen3.5", "9b"],
    qwenContextLength: 8192,
    qwenMaxTokens: 768,
    qwenEditorMaxTokens: 512,
    qwenCriticMaxTokens: 192,
    qwenRequestRetries: 0,
    qwenTimeoutMs: 5000,
    timeoutMs: 5000,
    temperature: 0.15,
    topP: 0.85,
    topK: 40,
    seed: 137,
    glossaryFile: "config/glossary.json",
    outputRoot: "runs_hybrid",
  };
  const first = await runBeta3Review({ projectRoot: tempRoot, config, inputPath });
  assert.equal(first.report.reviewedUnits, 3);
  assert.equal(chatCalls, 6);
  assert.equal(first.report.technicalErrorRows, 0);
  const output = csvToObjects(await fs.readFile(path.join(first.runDir, "translated_working_beta3.csv"), "utf8")).rows;
  assert.equal(output[0].Vietnamese, "Miasma Hands");
  assert.equal(output[0]["Local Status"], "KEEP_ENGLISH");
  assert.equal(output[1].Vietnamese, "Sử dụng Miasma Hands.");
  assert.equal(output[1]["Local Status"], "LOCAL_OK");
  assert.equal(output[2].Vietnamese, "Một mẩu xương của quái vật.");
  assert.equal(output[2]["Local Status"], "LOCAL_OK");
  assert.equal(output[3]["Local Status"], "REVIEW_MANDATORY");

  await runBeta3Review({ projectRoot: tempRoot, config, inputPath });
  assert.equal(chatCalls, 6, "lần chạy lại phải dùng checkpoint editor và critic");
});
