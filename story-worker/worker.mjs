import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const JOB_FILE = path.join(ROOT, "data/story_job.json");
const CONFIG_FILE = path.join(ROOT, "config.json");
const GLOSSARY_FILE = path.join(ROOT, "glossary.json");
const PROGRESS_DIR = path.join(ROOT, "progress");
const CHECKPOINT = path.join(PROGRESS_DIR, "story_translations.jsonl");
const REPORT_FILE = path.join(PROGRESS_DIR, "story_translation_report.json");
const REQUEST_LOG = path.join(PROGRESS_DIR, "story_request_log.jsonl");
const FAILURE_LOG = path.join(PROGRESS_DIR, "story_failed_responses.jsonl");
const RESULT_ZIP = path.join(ROOT, "GBFR_Story_Translation_Result_v1.zip");
const WORKER_VERSION = "1.8";
let stopRequested = false;

process.on("SIGINT", () => {
  if (stopRequested) {
    console.error("\nThoát ngay theo yêu cầu lần hai. Checkpoint của các batch trước vẫn an toàn.");
    process.exit(130);
  }
  stopRequested = true;
  console.error("\nĐã nhận Ctrl+C. Worker sẽ lưu xong request đang chạy rồi dừng an toàn.");
  console.error("Nhấn Ctrl+C lần hai chỉ khi cần thoát ngay.");
});

function norm(value) {
  return String(value ?? "").normalize("NFC").replace(/\r\n?/gu, "\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/u, "")}/${String(suffix).replace(/^\/+/, "")}`;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function modelText(model) {
  return `${model.key || ""} ${model.display_name || ""} ${model.selected_variant || ""}`.toLowerCase();
}

function loadedInstances(model) {
  return Array.isArray(model?.loaded_instances) ? model.loaded_instances : [];
}

async function prepareModel(config) {
  const body = await fetchJson(joinUrl(config.restEndpoint, "models"), {}, 30000);
  const models = Array.isArray(body.models) ? body.models : [];
  const wanted = models.find((model) => config.modelPreference.every((part) => modelText(model).includes(part.toLowerCase())));
  if (!wanted) throw new Error(`Không tìm thấy model ${config.modelPreference.join(" ")} trong LM Studio.`);
  let ready = loadedInstances(wanted).find((instance) => (
    instance.config?.context_length === config.contextLength
    && instance.config?.flash_attention === true
    && instance.config?.offload_kv_cache_to_gpu === true
  )) || null;
  for (const model of models) {
    for (const instance of loadedInstances(model)) {
      if (instance.id === ready?.id) continue;
      await fetchJson(joinUrl(config.restEndpoint, "models/unload"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instance_id: instance.id }),
      }, 120000);
    }
  }
  if (!ready) {
    const loaded = await fetchJson(joinUrl(config.restEndpoint, "models/load"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: wanted.key,
        context_length: config.contextLength,
        eval_batch_size: config.evalBatchSize,
        flash_attention: true,
        offload_kv_cache_to_gpu: true,
        echo_load_config: true,
      }),
    }, config.timeoutMs);
    const instanceId = loaded.instance_id || loaded.id;
    if (!instanceId) throw new Error("LM Studio không trả instance_id khi load Qwen.");
    ready = { id: instanceId, config: loaded.load_config || { context_length: config.contextLength } };
  }
  return { id: ready.id, loadConfig: ready.config || {} };
}

const TECHNICAL_PATTERNS = [
  /\{[^{}\r\n]*\}/gu,
  /<[^<>\r\n]*>/gu,
  // A whitespace printf flag is deliberately excluded. The Story Complete
  // corpus contains no such source token, while Vietnamese prose such as
  // "{0:100}% dựa trên..." would otherwise create a false token "% d".
  /(?<!\d)%(?:\d+\$)?[-+#0']*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlLzjt]*[diuoxXfFeEgGaAcspn%]/gu,
  /\\[nrt"\\]/gu,
  /[\uE000-\uF8FF]/gu,
];

function technicalTokens(text) {
  const output = [];
  for (const pattern of TECHNICAL_PATTERNS) for (const match of norm(text).matchAll(pattern)) output.push(match[0]);
  return output.sort();
}

function canonicalNumberToken(token) {
  const match = norm(token).match(/^([-+]?)(\d+(?:[.,]\d+)*)(%|x)?$/iu);
  if (!match) return norm(token);
  const [, sign, rawCore, rawSuffix = ""] = match;
  let core = rawCore;
  if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(core)) {
    core = core.replace(/[.,]/gu, "");
  } else {
    const lastComma = core.lastIndexOf(",");
    const lastDot = core.lastIndexOf(".");
    const decimalIndex = Math.max(lastComma, lastDot);
    if (decimalIndex >= 0) {
      const integerPart = core.slice(0, decimalIndex).replace(/[.,]/gu, "");
      const decimalPart = core.slice(decimalIndex + 1).replace(/[.,]/gu, "");
      core = `${integerPart}.${decimalPart}`;
    }
  }
  let [integerPart, decimalPart = ""] = core.split(".");
  integerPart = integerPart.replace(/^0+(?=\d)/u, "");
  decimalPart = decimalPart.replace(/0+$/u, "");
  core = decimalPart ? `${integerPart}.${decimalPart}` : integerPart;
  return `${sign}${core}${rawSuffix.toLowerCase()}`;
}

function numericTokens(text) {
  return [...norm(text).matchAll(/(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:%|x)?(?![\p{L}\p{N}_])/gu)]
    .map((match) => canonicalNumberToken(match[0]))
    .sort();
}

function looseNumericTokens(text) {
  return [...norm(text).matchAll(/[-+]?\d+(?:[.,]\d+)*/gu)]
    .map((match) => canonicalNumberToken(match[0]))
    .sort();
}

function termPattern(term, caseSensitive = false) {
  const escaped = norm(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, caseSensitive ? "gu" : "giu");
}

function keepTermPattern(term) {
  return termPattern(term, true);
}

const PROTECTED_TERM_ALIASES = new Map([
  ["Grandcypher", [/(?<![\p{L}\p{N}_])Gran(?:d)?\s+Cypher(?![\p{L}\p{N}_])/giu, /(?<![\p{L}\p{N}_])GranCypher(?![\p{L}\p{N}_])/giu]],
]);

function canonicalizeProtectedTermAliases(item, candidate, glossary) {
  let value = norm(candidate);
  const warnings = [];
  for (const [term, aliases] of PROTECTED_TERM_ALIASES) {
    if (!(glossary.keepExact || []).includes(term)) continue;
    const required = [...norm(item.english).matchAll(keepTermPattern(term))].length;
    let missing = required - [...value.matchAll(keepTermPattern(term))].length;
    if (missing <= 0) continue;
    for (const alias of aliases) {
      value = value.replace(alias, (matched) => {
        if (missing <= 0) return matched;
        missing -= 1;
        warnings.push(`CANONICALIZED_PROTECTED_ALIAS:${matched}->${term}`);
        return term;
      });
      if (missing <= 0) break;
    }
  }
  return { value, warnings };
}

function protectText(source, glossary, markerState) {
  let text = norm(source);
  const replacements = [];
  const replacePattern = (pattern) => {
    text = text.replace(pattern, (matched) => {
      const marker = `GBFRKEEP${String(markerState.next++).padStart(6, "0")}ZXQ`;
      replacements.push({ marker, value: matched });
      return marker;
    });
  };
  for (const token of [...new Set(technicalTokens(text))].sort((a, b) => b.length - a.length)) {
    replacePattern(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gu"));
  }
  const relevantTerms = (glossary.keepExact || [])
    .filter((term) => keepTermPattern(term).test(text))
    .sort((a, b) => b.length - a.length);
  for (const term of relevantTerms) replacePattern(keepTermPattern(term));
  return {
    text,
    replacements,
    restore(candidate) {
      let output = norm(candidate);
      for (const replacement of replacements) output = output.replaceAll(replacement.marker, replacement.value);
      return output;
    },
  };
}

function relevantTerms(items, glossary) {
  const english = items.map((item) => item.english).join("\n");
  const keep = (glossary.keepExact || []).filter((term) => keepTermPattern(term).test(english));
  const translate = Object.entries(glossary.translateAs || {})
    .filter(([term]) => termPattern(term).test(english));
  return { keep, translate };
}

function makeBatches(items, config) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const nextChars = item.english.length + item.japanese.length + 200;
    if (current.length && (current.length >= config.maxBatchItems || chars + nextChars > config.maxBatchSourceChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += nextChars;
  }
  if (current.length) batches.push(current);
  return batches;
}

function buildPrompt(items, glossary, options = {}) {
  const markerState = { next: 0 };
  const protectedItems = items.map((item) => {
    const en = protectText(item.english, glossary, markerState);
    const jp = protectText(item.japanese, glossary, markerState);
    return { item, en, jp };
  });
  const terms = relevantTerms(items, glossary);
  const repairMode = options.repairHints instanceof Map;
  const repairRules = repairMode ? `

ĐÂY LÀ LƯỢT SỬA CÂU BỊ QA TỪ CHỐI
- Đọc lỗi QA và bản dịch trước của từng mục; viết lại toàn bộ câu, không chỉ vá một từ.
- UNEXPECTED_CJK: chỉ dùng tiếng Việt; tuyệt đối không để chữ Hán, kana hoặc hangul.
- Với mục có UNEXPECTED_CJK, Worker chỉ gửi English; dịch lại hoàn toàn từ English và không tự chèn chữ CJK.
- PROTECTED_TERM_MISSING: giữ nguyên chính xác thuật ngữ được nêu, đúng chính tả và hoa thường.
- NUMBER_MISMATCH: giữ nguyên giá trị số từ nguồn; có thể viết bằng chữ hoặc chữ số nếu giá trị không đổi.
- UNCHANGED_ENGLISH/POSSIBLE_ENGLISH_LEAK: dịch phần tiếng Anh sang tiếng Việt, chỉ giữ thuật ngữ được bảo vệ.
- Nếu previousVietnamese trống, hãy dịch lại hoàn toàn từ English/Japanese; đừng tự điền tiếng Anh làm đáp án.
- Không sao chép lại bản dịch trước nếu nó còn chứa lỗi QA.` : "";
  const rules = `Bạn là biên tập viên trưởng Việt hóa Granblue Fantasy: Relink. Dịch từng mục sang tiếng Việt tự nhiên, đúng tính cách hội thoại JRPG.

QUY TẮC BẮT BUỘC
- English là nguồn chính; Japanese chỉ dùng để gỡ mơ hồ.
- Không dịch tên nhân vật, địa danh, Item, vũ khí, Skill, Trait, Sigil, SBA, Summon, Wrightstone và các chuỗi GBFRKEEP...ZXQ.
- Mỗi marker GBFRKEEP...ZXQ phải xuất hiện đúng một lần trong đúng mục của nó.
- Không thêm tên người chơi. Nếu English bị khuyết tên động, hãy viết lại câu tự nhiên bằng “Thuyền trưởng”, “cả đoàn”, “mọi người” hoặc bỏ sở hữu tùy ngữ cảnh.
- Quest Counter = Quầy nhiệm vụ; Yes = Có; No = Không; Level = Cấp độ.
- Giữ sắc thái câu hỏi, phủ định, mỉa mai, cảm xúc và quan hệ nhân quả.
- Không chú thích, không giải nghĩa tên riêng, không dùng Markdown và không để sót mảnh English ngoài thuật ngữ được giữ.
- Giữ nguyên số và token kỹ thuật. Không tự thêm hoặc bớt ý.
- Ưu tiên câu gọn để không tràn phụ đề; có thể thay vị trí xuống dòng nhưng không dồn nhiều ý thành câu khó đọc.

GIỮ NGUYÊN TRONG BATCH: ${terms.keep.join(", ") || "Không có"}
THUẬT NGỮ: ${terms.translate.map(([a, b]) => `${a} = ${b}`).join("; ") || "Không có"}${repairRules}`;
  const sources = protectedItems.map(({ item, en, jp }) => {
    const hint = repairMode ? options.repairHints.get(item.key) || {} : {};
    const errors = hint.errors || [];
    const englishOnlyRepair = errors.some((error) => error === "UNEXPECTED_CJK");
    const contaminating = errors.some((error) => (
      /^(?:UNEXPECTED_CJK|UNCHANGED_ENGLISH|POSSIBLE_ENGLISH_LEAK|PROTECTED_TERM_MISSING:|UNRESTORED_MARKER|MODEL_META_LEAK|EMPTY|MISSING_STRUCTURED_KEY)/u.test(error)
    ));
    return {
      key: item.key,
      type: item.type,
      english: en.text,
      ...(!englishOnlyRepair ? { japanese: jp.text } : {}),
      ...(repairMode ? {
        previousVietnamese: contaminating ? "" : hint.candidate || "",
        qaProblems: errors.length ? errors : ["RETRANSLATE_REQUIRED"],
        ...(englishOnlyRepair ? { repairSource: "ENGLISH_ONLY" } : {}),
      } : {}),
    };
  });
  const keys = protectedItems.map(({ item }) => item.key);
  const properties = Object.fromEntries(keys.map((key) => [key, { type: "string" }]));
  return {
    protectedItems,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "gbfr_translation_batch",
        strict: true,
        schema: {
          type: "object",
          properties,
          required: keys,
          additionalProperties: false,
        },
      },
    },
    messages: [
      { role: "system", content: rules },
      {
        role: "user",
        content: `/no_think\n${repairMode ? "Sửa" : "Dịch"} đúng ${items.length} mục trong mảng JSON sau. Trả bản dịch vào đúng key theo JSON Schema bắt buộc; không thêm văn bản ngoài JSON.\n${JSON.stringify(sources)}\n/no_think`,
      },
    ],
  };
}

function responseText(body) {
  const message = body?.choices?.[0]?.message;
  const content = message?.content || message?.reasoning_content || message?.reasoning || "";
  if (Array.isArray(content)) {
    return norm(content.map((part) => typeof part === "string" ? part : part?.text || "").join("\n"));
  }
  return norm(content);
}

function parseTranslations(text, protectedItems) {
  const output = new Map();
  let parsed;
  try {
    const cleaned = norm(text).trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return { output, parseError: `INVALID_JSON:${error.message}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { output, parseError: "JSON_ROOT_NOT_OBJECT" };
  }
  for (const entry of protectedItems) {
    const candidate = parsed[entry.item.key];
    if (typeof candidate !== "string") continue;
    let vietnamese = entry.en.restore(candidate.trim());
    vietnamese = entry.jp.restore(vietnamese);
    output.set(entry.item.key, vietnamese);
  }
  return { output, parseError: null };
}

function isPunctuationOnlySource(text) {
  const value = norm(text).trim();
  return Boolean(value) && !/[\p{L}\p{N}]/u.test(value);
}

function isNonLexicalVocalization(text, glossary) {
  let value = norm(text);
  for (const term of [...(glossary.keepExact || [])].sort((a, b) => b.length - a.length)) {
    value = value.replace(keepTermPattern(term), " ");
  }
  const words = value.match(/[A-Za-z]+/gu) || [];
  if (!words.length) return false;
  const vocalization = /^(?:a+h+|g+r+a+h+|g+r+o+a+r+|g+r+|r+a+h+|r+o+a+r+|u+g+h+|h+m+|m+|s+h+|h+m+p+h+)$/iu;
  return words.every((word) => vocalization.test(word));
}

function isDeterministicKeepEnglishItem(item) {
  return /^TXT_CV_/u.test(norm(item?.id).trim());
}

function qaItem(item, vietnamese, glossary) {
  const errors = [];
  const warnings = [];
  const value = norm(vietnamese).trim();
  if (!value) errors.push("EMPTY");
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) errors.push("UNEXPECTED_CJK");
  if (/GBFRKEEP\d+ZXQ/u.test(value)) errors.push("UNRESTORED_MARKER");
  if (/```|<\/?think>|\/no_think|SOURCE_BEGIN|VIETNAMESE_BEGIN/iu.test(value)) errors.push("MODEL_META_LEAK");
  if (JSON.stringify(technicalTokens(item.english)) !== JSON.stringify(technicalTokens(value))) errors.push("TECHNICAL_TOKEN_MISMATCH");
  const englishNumbers = numericTokens(item.english);
  const targetNumbers = numericTokens(value);
  const japaneseNumbers = looseNumericTokens(item.japanese);
  const exactEnglishNumbers = JSON.stringify(englishNumbers) === JSON.stringify(targetNumbers);
  const exactJapaneseNumbers = !englishNumbers.length
    && japaneseNumbers.length > 0
    && JSON.stringify(japaneseNumbers) === JSON.stringify(targetNumbers);
  if (!exactEnglishNumbers && !exactJapaneseNumbers) errors.push("NUMBER_MISMATCH");
  for (const term of glossary.keepExact || []) {
    const sourceCount = [...item.english.matchAll(keepTermPattern(term))].length;
    if (!sourceCount) continue;
    const targetCount = [...value.matchAll(keepTermPattern(term))].length;
    if (targetCount < sourceCount) errors.push(`PROTECTED_TERM_MISSING:${term}`);
  }
  const comparableEnglish = norm(item.english).replace(/\s+/gu, " ").trim();
  const comparableTarget = value.replace(/\s+/gu, " ").trim();
  const latinWords = comparableEnglish.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/gu) || [];
  const sourceIsProtectedOnly = (glossary.keepExact || []).some((term) => comparableEnglish === term);
  const sourceIsNonLexical = isNonLexicalVocalization(comparableEnglish, glossary);
  const deterministicKeepEnglish = isDeterministicKeepEnglishItem(item);
  if (deterministicKeepEnglish) {
    if (comparableTarget !== comparableEnglish) errors.push("KEEP_ENGLISH_SOURCE_MISMATCH");
    else warnings.push("DETERMINISTIC_KEEP_ENGLISH_ID:TXT_CV");
  }
  if (!deterministicKeepEnglish && !sourceIsProtectedOnly && !sourceIsNonLexical && latinWords.length >= 2 && comparableTarget.toLocaleLowerCase("en") === comparableEnglish.toLocaleLowerCase("en")) {
    errors.push("UNCHANGED_ENGLISH");
  }
  const englishWords = value.match(/(?<![\p{L}\p{N}_])(?:the|and|but|with|from|this|that|have|will|would|could|should|your|their|into|before|after)(?![\p{L}\p{N}_])/giu) || [];
  if (englishWords.length >= 2) warnings.push("POSSIBLE_ENGLISH_LEAK");
  if (item.english.includes("\n") && !value.includes("\n")) warnings.push("LINE_BREAKS_COLLAPSED");
  if (item.english.length >= 20 && (value.length / item.english.length > 2.5 || value.length / item.english.length < 0.22)) warnings.push("SUSPICIOUS_LENGTH_RATIO");
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function responseTokenBudget(items, config) {
  const sourceChars = items.reduce((sum, item) => sum + item.english.length, 0);
  return Math.min(config.maxTokens, Math.max(384, Math.ceil(sourceChars * 0.72) + items.length * 24 + 128));
}

let logWriteQueue = Promise.resolve();
async function appendJsonl(file, value) {
  logWriteQueue = logWriteQueue.then(() => fsp.appendFile(file, `${JSON.stringify(value)}\n`, "utf8"));
  await logWriteQueue;
}

async function chat(config, model, messages, responseFormat, maxTokens, seedOffset = 0) {
  const started = performance.now();
  const body = await fetchJson(joinUrl(config.endpoint, "chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      temperature: config.temperature,
      top_p: config.topP,
      top_k: config.topK,
      seed: config.seed + seedOffset,
      max_tokens: maxTokens,
      response_format: responseFormat,
      chat_template_kwargs: { enable_thinking: false },
      enable_thinking: false,
    }),
  }, config.timeoutMs);
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000);
  const usage = body.usage || {};
  const completionTokens = Number(usage.completion_tokens || 0);
  return {
    text: responseText(body),
    usage,
    elapsedSeconds,
    tokensPerSecond: completionTokens ? completionTokens / elapsedSeconds : 0,
    finishReason: body?.choices?.[0]?.finish_reason || "unknown",
  };
}

async function translateBatchOnce(items, config, glossary, model, phase, seedOffset = 0, options = {}) {
  const completed = new Map();
  const unresolved = [];
  const prompt = buildPrompt(items, glossary, options);
  const maxTokens = responseTokenBudget(items, config);
  const response = await chat(config, model, prompt.messages, prompt.responseFormat, maxTokens, seedOffset);
  const parsedResult = parseTranslations(response.text, prompt.protectedItems);
  const parsed = parsedResult.output;
  for (const item of items) {
    const hasStructuredKey = parsed.has(item.key);
    let vietnamese = parsed.get(item.key);
    const deterministicWarnings = [];
    if (hasStructuredKey) {
      const canonicalized = canonicalizeProtectedTermAliases(item, vietnamese, glossary);
      vietnamese = canonicalized.value;
      deterministicWarnings.push(...canonicalized.warnings);
    }
    if (hasStructuredKey && !norm(vietnamese).trim() && isPunctuationOnlySource(item.english)) {
      vietnamese = item.english;
      deterministicWarnings.push("DETERMINISTIC_PUNCTUATION_COPY");
    }
    const qa = qaItem(item, vietnamese, glossary);
    qa.warnings = [...new Set([...(qa.warnings || []), ...deterministicWarnings])];
    if (hasStructuredKey && qa.ok) completed.set(item.key, { vietnamese, qa, attempts: 1 });
    else unresolved.push({
      item,
      candidate: vietnamese || "",
      errors: hasStructuredKey ? qa.errors : [parsedResult.parseError || "MISSING_STRUCTURED_KEY"],
    });
  }
  const requestRecord = {
    at: new Date().toISOString(),
    phase,
    itemCount: items.length,
    accepted: completed.size,
    rejected: unresolved.length,
    elapsedSeconds: Number(response.elapsedSeconds.toFixed(3)),
    tokensPerSecond: Number(response.tokensPerSecond.toFixed(2)),
    finishReason: response.finishReason,
    parseError: parsedResult.parseError,
    maxTokens,
    usage: response.usage,
  };
  await appendJsonl(REQUEST_LOG, requestRecord);
  if (unresolved.length) {
    await appendJsonl(FAILURE_LOG, {
      ...requestRecord,
      keys: unresolved.map((entry) => entry.item.key),
      reasons: Object.fromEntries(unresolved.map((entry) => [entry.item.key, entry.errors])),
      responsePreview: response.text.slice(0, 12000),
    });
  }
  return { completed, unresolved, request: requestRecord };
}

async function loadCheckpoint(itemsByKey, glossary) {
  const output = new Map();
  const historicalFailures = new Set();
  const requeuedByQa = new Map();
  const latest = new Map();
  if (fs.existsSync(CHECKPOINT)) {
    for (const line of (await fsp.readFile(CHECKPOINT, "utf8")).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const item = itemsByKey.get(record.key);
        if (!item || record.sourceHash !== item.sourceHash) continue;
        latest.set(record.key, record);
      } catch (_) {
        // Ignore a partially written final line after forced shutdown.
      }
    }
  }
  for (const [key, record] of latest) {
    const item = itemsByKey.get(key);
    if (record.vietnamese) {
      if (record.status === "INHERITED_R3") {
        output.set(key, record);
        continue;
      }
      const currentQa = qaItem(item, record.vietnamese, glossary);
      if (currentQa.ok) {
        output.set(key, { ...record, qa: currentQa });
      } else {
        historicalFailures.add(key);
        requeuedByQa.set(key, currentQa.errors);
      }
    } else if (record.status === "TECHNICAL_ERROR") {
      historicalFailures.add(key);
    }
  }
  const failureLogBacklog = new Set();
  if (fs.existsSync(FAILURE_LOG)) {
    for (const line of (await fsp.readFile(FAILURE_LOG, "utf8")).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const failure = JSON.parse(line);
        for (const key of Array.isArray(failure.keys) ? failure.keys : []) {
          if (itemsByKey.has(key) && !output.has(key)) failureLogBacklog.add(key);
        }
      } catch (_) {
        // Ignore a partially written final line after forced shutdown.
      }
    }
  }
  for (const key of failureLogBacklog) historicalFailures.add(key);
  return { output, historicalFailures, requeuedByQa, failureLogBacklog };
}

async function appendRecord(record) {
  await fsp.appendFile(CHECKPOINT, `${JSON.stringify(record)}\n`, "utf8");
}

async function createResultZip(job, records, report) {
  const resultDir = path.join(PROGRESS_DIR, "result");
  await fsp.rm(resultDir, { recursive: true, force: true });
  await fsp.mkdir(resultDir, { recursive: true });
  const result = {
    jobId: job.jobId,
    jobHash: sha256(JSON.stringify(job)),
    generatedAt: new Date().toISOString(),
    report,
    translations: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
  await fsp.writeFile(path.join(resultDir, "story_translation_results.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await fsp.copyFile(REPORT_FILE, path.join(resultDir, "story_translation_report.json"));
  await fsp.rm(RESULT_ZIP, { force: true });
  if (process.platform === "win32") {
    const ps = [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${resultDir.replaceAll("'", "''")}\\*' -DestinationPath '${RESULT_ZIP.replaceAll("'", "''")}' -Force`,
    ];
    await execFileAsync("powershell.exe", ps, { windowsHide: true });
  } else {
    await execFileAsync("zip", ["-q", "-r", RESULT_ZIP, "."], { cwd: resultDir });
  }
}

async function main() {
  const [job, config, glossary] = await Promise.all([
    fsp.readFile(JOB_FILE, "utf8").then(JSON.parse),
    fsp.readFile(CONFIG_FILE, "utf8").then(JSON.parse),
    fsp.readFile(GLOSSARY_FILE, "utf8").then(JSON.parse),
  ]);
  await fsp.mkdir(PROGRESS_DIR, { recursive: true });
  const itemsByKey = new Map(job.items.map((item) => [item.key, item]));
  const checkpointState = await loadCheckpoint(itemsByKey, glossary);
  const records = checkpointState.output;
  let deterministicKeepEnglishAdded = 0;
  let deterministicKeepEnglishCorrected = 0;
  for (const item of job.items.filter(isDeterministicKeepEnglishItem)) {
    const existing = records.get(item.key);
    const target = norm(item.english).trim();
    if (existing && norm(existing.vietnamese).trim() === target) continue;
    const qa = qaItem(item, target, glossary);
    if (!qa.ok) throw new Error(`Khong the khoa English metadata cho ${item.key}: ${qa.errors.join(", ")}`);
    const record = {
      key: item.key,
      sourceHash: item.sourceHash,
      vietnamese: target,
      status: "LOCAL_OK",
      qa,
      attempts: 0,
      provenance: "DETERMINISTIC_KEEP_ENGLISH_ID:TXT_CV",
      updatedAt: new Date().toISOString(),
    };
    records.set(item.key, record);
    await appendRecord(record);
    if (checkpointState.requeuedByQa.has(item.key)) deterministicKeepEnglishCorrected += 1;
    else deterministicKeepEnglishAdded += 1;
  }
  for (const item of job.items.filter((entry) => entry.inheritedR3)) {
    if (records.has(item.key)) continue;
    const record = {
      key: item.key,
      sourceHash: item.sourceHash,
      vietnamese: item.currentVietnamese,
      status: "INHERITED_R3",
      qa: qaItem(item, item.currentVietnamese, glossary),
      attempts: 0,
      updatedAt: new Date().toISOString(),
    };
    records.set(item.key, record);
    await appendRecord(record);
  }
  const startingRecordCount = records.size;
  const historicalRecovery = job.items.filter((item) => (
    !records.has(item.key) && checkpointState.historicalFailures.has(item.key)
  ));
  const freshPending = job.items.filter((item) => (
    !records.has(item.key) && !checkpointState.historicalFailures.has(item.key)
  ));
  const activeFailureLogBacklog = [...checkpointState.failureLogBacklog]
    .filter((key) => !records.has(key)).length;
  console.log(`GBFR Story Complete Worker v${WORKER_VERSION}`);
  console.log(`JOB: ${job.jobId}`);
  console.log(`Tổng mục: ${job.items.length}`);
  console.log(`Đã có checkpoint/R3: ${records.size}`);
  console.log(`Cần Qwen xử lý: ${freshPending.length + historicalRecovery.length}`);
  console.log(`Mục lỗi cũ chuyển xuống hàng cứu cuối: ${historicalRecovery.length}`);
  console.log(`Mục checkpoint được QA hiện hành đưa vào hàng sửa lại: ${checkpointState.requeuedByQa.size}`);
  console.log(`Backlog còn hiệu lực từ failure log: ${activeFailureLogBacklog}`);
  console.log(`Tên diễn viên giữ English theo metadata: thêm ${deterministicKeepEnglishAdded}; sửa checkpoint ${deterministicKeepEnglishCorrected}.`);
  if (freshPending.length || historicalRecovery.length) {
    console.log("Đang kết nối và chuẩn bị Qwen...");
    const prepared = await prepareModel(config);
    const model = prepared.id;
    const flash = prepared.loadConfig?.flash_attention === true ? "ON" : "không xác nhận";
    const kvGpu = prepared.loadConfig?.offload_kv_cache_to_gpu === true ? "ON" : "không xác nhận";
    console.log(`Qwen READY: ${model}`);
    console.log(`Tối ưu LM Studio: Flash Attention ${flash}; KV cache GPU ${kvGpu}; context ${config.contextLength}`);
    console.log("Structured Output: JSON Schema; batch tối đa 10; chạy tuần tự; lỗi QA được cứu ngay từng câu.");
    console.log(`Pilot an toàn: ít nhất ${Number(config.pilotItems || 100)} mục mới.`);
    const batches = makeBatches(freshPending, config);
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const recovery = new Map(historicalRecovery.map((item) => [item.key, item]));
    const startedAt = performance.now();
    let attemptedPrimary = 0;
    let acceptedPrimary = 0;
    let directAcceptedPrimary = 0;
    let repairedPrimary = 0;
    let primaryDone = 0;
    let rawBatchWideFailures = 0;
    let unrecoveredBatchWideFailures = 0;
    let rawStructuredFailureItems = 0;
    let rawStructuredFailureBatches = 0;
    let structuredFailureItems = 0;
    let structuredFailureBatches = 0;
    let safetyBlocked = "";
    const primaryRecovery = new Map();

    const saveAccepted = async (item, translated) => {
      const record = {
        key: item.key,
        sourceHash: item.sourceHash,
        vietnamese: translated.vietnamese,
        status: translated.qa.warnings.length ? "REVIEW" : "LOCAL_OK",
        qa: translated.qa,
        attempts: translated.attempts,
        updatedAt: new Date().toISOString(),
      };
      records.set(item.key, record);
      recovery.delete(item.key);
      primaryRecovery.delete(item.key);
      await appendRecord(record);
    };

    const addUsage = (request) => {
      for (const key of Object.keys(usage)) usage[key] += Number(request.usage?.[key] || 0);
    };

    const repairRejectedItems = async (unresolved, phase, seedBase) => {
      const repaired = new Map();
      const stillUnresolved = [];
      const attempts = Math.max(1, Number(config.immediateRepairAttempts || 2));
      for (let index = 0; index < unresolved.length && !stopRequested; index += 1) {
        const original = unresolved[index];
        let last = original;
        let accepted = null;
        let usedAttempts = 0;
        for (let attempt = 0; attempt < attempts && !accepted && !stopRequested; attempt += 1) {
          usedAttempts = attempt + 1;
          const repairHints = new Map([[original.item.key, {
            candidate: last.candidate || original.candidate || "",
            errors: last.errors?.length ? last.errors : original.errors,
          }]]);
          const result = await translateBatchOnce(
            [original.item],
            config,
            glossary,
            model,
            phase,
            seedBase + index * 10 + attempt,
            { repairHints },
          );
          addUsage(result.request);
          accepted = result.completed.get(original.item.key) || null;
          if (!accepted) last = result.unresolved[0] || last;
        }
        if (accepted) {
          accepted.attempts = 1 + usedAttempts;
          accepted.qa = {
            ...accepted.qa,
            warnings: [...new Set([...(accepted.qa.warnings || []), "RECOVERED_AFTER_QA_REJECTION"])],
          };
          repaired.set(original.item.key, accepted);
        } else {
          stillUnresolved.push(last);
        }
      }
      return { repaired, unresolved: stillUnresolved };
    };

    const writeInterimReport = async (phase) => {
      const elapsedMinutes = Math.max(1 / 60, (performance.now() - startedAt) / 60000);
      const completedThisRun = records.size - startingRecordCount;
      const interim = {
        workerVersion: WORKER_VERSION,
        jobId: job.jobId,
        status: stopRequested ? "STOPPING" : "RUNNING",
        phase,
        total: job.items.length,
        completed: records.size,
        remaining: job.items.length - records.size,
        queuedForRecovery: recovery.size,
        newPrimaryRecovery: primaryRecovery.size,
        primaryAttempted: attemptedPrimary,
        primaryAccepted: acceptedPrimary,
        primaryDirectAccepted: directAcceptedPrimary,
        primaryRepaired: repairedPrimary,
        rawBatchWideFailures,
        unrecoveredBatchWideFailures,
        rawStructuredFailureItems,
        rawStructuredFailureBatches,
        structuredFailureItems,
        structuredFailureBatches,
        safetyBlocked: safetyBlocked || null,
        effectiveItemsPerMinute: Number((completedThisRun / elapsedMinutes).toFixed(2)),
        usage,
        updatedAt: new Date().toISOString(),
      };
      await fsp.writeFile(REPORT_FILE, `${JSON.stringify(interim, null, 2)}\n`, "utf8");
    };

    const consumePrimaryResult = async (batch, result, index) => {
      addUsage(result.request);
      attemptedPrimary += batch.length;
      directAcceptedPrimary += result.completed.size;
      primaryDone += 1;
      if (result.completed.size === 0 && batch.length > 0) rawBatchWideFailures += 1;
      const structuredUnresolved = result.unresolved.filter((entry) => (
        entry.errors.some((error) => /^INVALID_JSON:|^JSON_ROOT_NOT_OBJECT$|^MISSING_STRUCTURED_KEY$/u.test(error))
      ));
      rawStructuredFailureItems += structuredUnresolved.length;
      if (structuredUnresolved.length) rawStructuredFailureBatches += 1;

      const repairedResult = result.unresolved.length
        ? await repairRejectedItems(result.unresolved, "PRIMARY_REPAIR", 300000 + index * 100)
        : { repaired: new Map(), unresolved: [] };
      const unrecoveredStructured = repairedResult.unresolved.filter((entry) => (
        entry.errors.some((error) => /^INVALID_JSON:|^JSON_ROOT_NOT_OBJECT$|^MISSING_STRUCTURED_KEY$/u.test(error))
      ));
      structuredFailureItems += unrecoveredStructured.length;
      if (unrecoveredStructured.length) structuredFailureBatches += 1;
      repairedPrimary += repairedResult.repaired.size;
      const acceptedThisBatch = new Map([...result.completed, ...repairedResult.repaired]);
      acceptedPrimary += acceptedThisBatch.size;
      if (acceptedThisBatch.size === 0 && batch.length > 0) unrecoveredBatchWideFailures += 1;
      const unresolvedKeys = new Set(repairedResult.unresolved.map((entry) => entry.item.key));

      for (const item of batch) {
        const translated = acceptedThisBatch.get(item.key);
        if (translated) await saveAccepted(item, translated);
        else if (unresolvedKeys.has(item.key)) {
          recovery.set(item.key, item);
          primaryRecovery.set(item.key, item);
        }
      }
      const elapsed = result.request.elapsedSeconds.toFixed(1);
      const speed = result.request.tokensPerSecond ? `${result.request.tokensPerSecond.toFixed(1)} tok/s` : "chưa có tok/s";
      const elapsedMinutes = Math.max(1 / 60, (performance.now() - startedAt) / 60000);
      const itemsPerMinute = (records.size - startingRecordCount) / elapsedMinutes;
      const etaMinutes = itemsPerMinute > 0 ? (job.items.length - records.size) / itemsPerMinute : 0;
      const etaText = etaMinutes > 0
        ? `ETA ~${Math.floor(etaMinutes / 60)}h${String(Math.ceil(etaMinutes % 60)).padStart(2, "0")}`
        : "ETA đang đo";
      const repairText = repairedResult.repaired.size ? `; cứu ngay ${repairedResult.repaired.size}` : "";
      const hasMorePrimaryBatches = index + 1 < batches.length;
      console.log(`[CHÍNH ${index + 1}/${batches.length}] +${acceptedThisBatch.size}/${batch.length} (trực tiếp ${result.completed.size}${repairText}) — chờ cuối ${primaryRecovery.size} — ${elapsed}s — ${speed} — ${itemsPerMinute.toFixed(1)} mục/phút — ${etaText}`);
      if (structuredFailureBatches > Number(config.maxStructuredFailureBatches ?? 1)) {
        safetyBlocked = "STRUCTURED_OUTPUT_FAILURE";
      } else if (unrecoveredBatchWideFailures > Number(config.maxUnrecoveredBatchWideFailures ?? 0)) {
        safetyBlocked = "UNRECOVERED_BATCH_WIDE_FAILURE";
      } else if (
        hasMorePrimaryBatches
        &&
        attemptedPrimary < Number(config.pilotItems || 100)
        && primaryRecovery.size > Number(config.maxPrimaryRecoveryItemsBeforeGate || 2)
      ) {
        safetyBlocked = "EARLY_RECOVERY_GROWTH";
      } else if (
        hasMorePrimaryBatches
        &&
        attemptedPrimary >= Number(config.pilotItems || 100)
        && primaryRecovery.size > Number(config.maxPrimaryRecoveryItemsBeforeGate || 2)
        && primaryRecovery.size / attemptedPrimary > Number(config.maxPrimaryRecoveryRate || 0.01)
      ) {
        safetyBlocked = "UNRESOLVED_RATE_TOO_HIGH";
      }
      await writeInterimReport("PRIMARY");
    };

    const pilotTarget = Math.max(1, Number(config.pilotItems || 100));
    let pilotCount = 0;
    let pilotPlannedItems = 0;
    while (pilotCount < batches.length && pilotPlannedItems < pilotTarget) {
      pilotPlannedItems += batches[pilotCount].length;
      pilotCount += 1;
    }
    for (let index = 0; index < pilotCount && !stopRequested; index += 1) {
      const batch = batches[index];
      const result = await translateBatchOnce(batch, config, glossary, model, "PILOT", index);
      await consumePrimaryResult(batch, result, index);
      if (safetyBlocked) break;
    }
    if (pilotCount && !stopRequested) {
      const pilotRate = acceptedPrimary / attemptedPrimary;
      const directRate = directAcceptedPrimary / attemptedPrimary;
      console.log(`Cổng an toàn: ${(pilotRate * 100).toFixed(1)}% đạt sau cứu trên ${attemptedPrimary} mục; trực tiếp ${(directRate * 100).toFixed(1)}%; đã cứu ${repairedPrimary}; còn chờ ${primaryRecovery.size}.`);
      if (pilotRate < Number(config.pilotMinPrimaryAcceptance || 0.98)) {
        safetyBlocked ||= "PILOT_ACCEPTANCE_TOO_LOW";
      }
      if (safetyBlocked) {
        await writeInterimReport("PILOT_BLOCKED");
        console.error(`\nDỪNG AN TOÀN: ${safetyBlocked}. Không tiếp tục ${job.items.length - records.size} mục còn lại.`);
        console.error(`Hãy gửi hai file progress\\story_request_log.jsonl và progress\\story_failed_responses.jsonl để phân tích.`);
        process.exitCode = 2;
        return;
      }
      console.log("PILOT ĐẠT. Worker mới tiếp tục phần còn lại.");
    }

    for (let index = pilotCount; index < batches.length && !stopRequested; index += 1) {
      const batch = batches[index];
      const result = await translateBatchOnce(batch, config, glossary, model, "PRIMARY", index);
      await consumePrimaryResult(batch, result, index);
      if (safetyBlocked) break;
    }

    if (safetyBlocked) {
      await writeInterimReport("SAFETY_BLOCKED");
      console.error(`\nDỪNG AN TOÀN: ${safetyBlocked}. Lỗi không được phép tích lũy tiếp.`);
      console.error(`Hãy gửi hai file progress\\story_request_log.jsonl và progress\\story_failed_responses.jsonl để phân tích.`);
      process.exitCode = 2;
      return;
    }

    if (stopRequested) {
      await writeInterimReport("STOPPED_SAFE");
      console.log("\nĐÃ DỪNG AN TOÀN. Chạy lại file CMD sẽ tiếp tục từ checkpoint hiện tại.");
      process.exitCode = 130;
      return;
    }

    const recoveryItems = [...recovery.values()];
    console.log(`\nBắt đầu hàng cứu kỹ thuật: ${recoveryItems.length} mục.`);
    const recoveryBatches = makeBatches(recoveryItems, {
      ...config,
      maxBatchItems: config.recoveryBatchItems,
      maxBatchSourceChars: config.recoveryBatchSourceChars,
    });
    const singleRecovery = new Map();
    for (let index = 0; index < recoveryBatches.length && !stopRequested; index += 1) {
      const batch = recoveryBatches[index];
      const result = await translateBatchOnce(batch, config, glossary, model, "RECOVERY_SMALL_BATCH", 100000 + index);
      addUsage(result.request);
      for (const item of batch) {
        const translated = result.completed.get(item.key);
        if (translated) await saveAccepted(item, translated);
        else {
          const unresolved = result.unresolved.find((entry) => entry.item.key === item.key) || {
            item,
            candidate: "",
            errors: ["RETRANSLATE_REQUIRED"],
          };
          singleRecovery.set(item.key, unresolved);
        }
      }
      console.log(`[CỨU NHÓM ${index + 1}/${recoveryBatches.length}] +${result.completed.size}/${batch.length} — còn ${singleRecovery.size + Math.max(0, recoveryItems.length - (index + 1) * config.recoveryBatchItems)} mục`);
      await writeInterimReport("RECOVERY_SMALL_BATCH");
    }

    const finalFailures = [];
    const singleItems = [...singleRecovery.values()];
    for (let index = 0; index < singleItems.length && !stopRequested; index += 1) {
      let unresolved = singleItems[index];
      const item = unresolved.item;
      let accepted = null;
      const errors = [];
      const attempts = Math.max(1, Number(config.singleItemAttempts || 2));
      for (let attempt = 0; attempt < attempts && !accepted && !stopRequested; attempt += 1) {
        const repairHints = new Map([[item.key, {
          candidate: unresolved.candidate || "",
          errors: unresolved.errors?.length ? unresolved.errors : ["RETRANSLATE_REQUIRED"],
        }]]);
        const result = await translateBatchOnce(
          [item],
          config,
          glossary,
          model,
          "RECOVERY_SINGLE",
          200000 + index * 10 + attempt,
          { repairHints },
        );
        addUsage(result.request);
        accepted = result.completed.get(item.key) || null;
        if (!accepted) {
          unresolved = result.unresolved[0] || unresolved;
          errors.push(...(unresolved.errors || ["MODEL_RETRY_EXHAUSTED"]));
        }
      }
      if (accepted) {
        accepted.qa = {
          ...accepted.qa,
          warnings: [...new Set([...(accepted.qa.warnings || []), "RECOVERED_AFTER_QA_REJECTION"])],
        };
        await saveAccepted(item, accepted);
      }
      else finalFailures.push({ item, errors: [...new Set(errors)] });
      console.log(`[CỨU LẺ ${index + 1}/${singleItems.length}] ${accepted ? "ĐẠT" : "CHƯA ĐẠT"} — tổng ${records.size}/${job.items.length}`);
      await writeInterimReport("RECOVERY_SINGLE");
    }

    if (stopRequested) {
      await writeInterimReport("STOPPED_SAFE");
      console.log("\nĐÃ DỪNG AN TOÀN. Chạy lại file CMD sẽ tiếp tục từ checkpoint hiện tại.");
      process.exitCode = 130;
      return;
    }

    for (const failure of finalFailures) {
      const item = failure.item;
      const record = {
        key: item.key,
        sourceHash: item.sourceHash,
        vietnamese: "",
        status: "TECHNICAL_ERROR",
        qa: { ok: false, errors: failure.errors.length ? failure.errors : ["MODEL_RETRY_EXHAUSTED"], warnings: [] },
        attempts: Number(config.singleItemAttempts || 2) + 1,
        updatedAt: new Date().toISOString(),
      };
      records.set(item.key, record);
      await appendRecord(record);
    }
  }
  const values = [...records.values()];
  const technicalErrors = values.filter((record) => record.status === "TECHNICAL_ERROR").length;
  const review = values.filter((record) => record.status === "REVIEW").length;
  const report = {
    workerVersion: WORKER_VERSION,
    jobId: job.jobId,
    status: records.size === job.items.length && technicalErrors === 0 ? "COMPLETE" : "COMPLETE_WITH_ERRORS",
    total: job.items.length,
    completed: records.size,
    inheritedR3: values.filter((record) => record.status === "INHERITED_R3").length,
    localOk: values.filter((record) => record.status === "LOCAL_OK").length,
    review,
    technicalErrors,
    finishedAt: new Date().toISOString(),
  };
  await fsp.writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await createResultZip(job, records, report);
  console.log("\nHOÀN TẤT.");
  console.log(`Kết quả: ${RESULT_ZIP}`);
  console.log(`Mục cần hậu kiểm: ${review}; lỗi kỹ thuật: ${technicalErrors}`);
}

const invokedAsMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedAsMain) {
  main().catch((error) => {
    console.error(`\nLỖI: ${error.message}`);
    if (/fetch|ECONNREFUSED|aborted|LM Studio/iu.test(error.message)) {
      console.error("Hãy mở LM Studio > Developer, bật Local Server ở cổng 1234 rồi chạy lại.");
    }
    process.exitCode = 1;
  });
}

export {
  buildPrompt,
  canonicalizeProtectedTermAliases,
  isDeterministicKeepEnglishItem,
  keepTermPattern,
  loadCheckpoint,
  numericTokens,
  qaItem,
  termPattern,
};
