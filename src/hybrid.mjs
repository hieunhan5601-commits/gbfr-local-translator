import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { csvToObjects, objectsToCsv } from "./csv.mjs";
import { assertImmutableDataset, assertInputContract } from "./contracts.mjs";
import { checkTranslation, technicalTokens } from "./qa.mjs";
import { appendNote, classifyRow, normalizeText, relevantGlossary, semanticReviewReasons, shouldKeepEnglish } from "./rules.mjs";
import {
  attachTranslationContext,
  contextBlockedResult,
  contextFingerprint,
  loadOptionalContextDatabase,
} from "./translation-context.mjs";

async function writeJsonFile(outputPath, value) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeCsvFile(outputPath, rows, headers) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, objectsToCsv(rows, headers), "utf8");
}

function assertLocalEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error(`Endpoint bị từ chối vì không phải máy local: ${url.hostname}`);
  }
  if (!/^https?:$/u.test(url.protocol)) throw new Error(`Giao thức endpoint không hợp lệ: ${url.protocol}`);
  return url.toString().replace(/\/$/u, "");
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`LM Studio trả HTTP ${response.status}: ${text.slice(0, 800)}`);
    try { return JSON.parse(text); } catch { throw new Error(`LM Studio trả dữ liệu không phải JSON: ${text.slice(0, 800)}`); }
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base, suffix) {
  return `${assertLocalEndpoint(base)}/${String(suffix).replace(/^\//u, "")}`;
}

export async function listRestModels(config) {
  const body = await fetchJson(joinUrl(config.restEndpoint, "models"), {}, Math.min(config.timeoutMs, 30000));
  if (!Array.isArray(body.models)) throw new Error("LM Studio /api/v1/models không trả array models.");
  return body.models;
}

function modelText(model) {
  return `${model.key || ""} ${model.display_name || ""} ${model.selected_variant || ""}`.toLowerCase();
}

export function selectModel(models, preferences, label) {
  const parts = preferences.map((value) => String(value).toLowerCase());
  const matches = models.filter((model) => parts.every((part) => modelText(model).includes(part)));
  if (!matches.length) throw new Error(`Không tìm thấy ${label}. Từ khóa: ${preferences.join(" + ")}.`);
  if (matches.length > 1) {
    const exactQuant = matches.find((model) => /q5_k_m/iu.test(modelText(model))) || matches[0];
    return exactQuant;
  }
  return matches[0];
}

function loadedInstances(model) {
  return Array.isArray(model.loaded_instances) ? model.loaded_instances : [];
}

async function unloadInstance(config, instanceId) {
  return fetchJson(joinUrl(config.restEndpoint, "models/unload"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instance_id: instanceId }),
  }, config.timeoutMs);
}

async function loadModel(config, modelKey, contextLength) {
  return fetchJson(joinUrl(config.restEndpoint, "models/load"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelKey,
      context_length: contextLength,
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      echo_load_config: true,
    }),
  }, config.timeoutMs);
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => part?.text || "").join("");
  return "";
}

async function chatCompletion(config, payload, timeoutMs = config.timeoutMs) {
  return fetchJson(joinUrl(config.endpoint, "chat/completions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, stream: false }),
  }, timeoutMs);
}

function restoreLineEdges(source, translated) {
  const sourceLines = String(source).split("\n");
  const targetLines = String(translated).split("\n");
  if (sourceLines.length !== targetLines.length) return String(translated);
  return targetLines.map((targetLine, index) => {
    const sourceLine = sourceLines[index];
    if (/^[ \t]*$/u.test(sourceLine)) return sourceLine;
    const leading = sourceLine.match(/^[ \t]*/u)?.[0] ?? "";
    const trailing = sourceLine.match(/[ \t]*$/u)?.[0] ?? "";
    return `${leading}${targetLine.trim()}${trailing}`;
  }).join("\n");
}

function protectForTranslateGemma(source, glossary) {
  const sourceText = String(source);
  let protectedText = sourceText;
  const replacements = [];
  const protectExact = (term, pattern = null) => {
    const marker = `GBFRKEEP${String(replacements.length).padStart(3, "0")}ZXQ`;
    const next = pattern ? protectedText.replace(pattern, marker) : protectedText.replaceAll(term, marker);
    if (next === protectedText) return;
    protectedText = next;
    replacements.push({ marker, term });
  };
  for (const token of [...new Set(technicalTokens(sourceText))].sort((left, right) => right.length - left.length)) {
    protectExact(token);
  }
  const protectedTerms = relevantGlossary([sourceText], glossary || { keepExact: [], translateAs: {} }).keepExact
    .sort((left, right) => right.length - left.length);
  for (const term of protectedTerms) {
    const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    protectExact(term, new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"));
  }
  return {
    text: protectedText,
    restore(value) {
      let restored = String(value);
      for (const replacement of replacements) {
        restored = restored.replace(new RegExp(replacement.marker, "giu"), replacement.term);
      }
      return restored;
    },
    markers: replacements.map((replacement) => replacement.marker),
  };
}

async function translateWithGemma({ row, config, model, glossary = null }) {
  const protectedInput = protectForTranslateGemma(row.English, glossary);
  const retries = Math.max(0, Number(config.translateGemmaRequestRetries ?? 2));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const body = await chatCompletion(config, {
        model,
        messages: [{ role: "user", content: protectedInput.text }],
        temperature: config.temperature,
        top_p: config.topP,
        top_k: config.topK,
        seed: (config.seed || 137) + attempt,
        max_tokens: config.translateGemmaMaxTokens,
      });
      const candidate = protectedInput.restore(messageText(body?.choices?.[0]?.message).trim());
      if (!candidate) throw new Error(`TranslateGemma không trả bản dịch cho ${row.ID}.`);
      return { vietnamese: restoreLineEdges(row.English, candidate), usage: body.usage || null, protectedMarkers: protectedInput.markers };
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !retryableQwenError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
  }
  throw lastError;
}

function formatContract(source) {
  const replacements = [];
  const lines = String(source).split("\n").map((line) => line.replace(/[ \t]{2,}/gu, (whitespace) => {
    const marker = `<GBFRGAP${String(replacements.length).padStart(3, "0")}ZXQ>`;
    replacements.push({ marker, whitespace });
    return marker;
  }));
  return {
    lines,
    markers: replacements.map((replacement) => replacement.marker),
    restore(candidateLines) {
      let value = (Array.isArray(candidateLines) ? candidateLines : [String(candidateLines ?? "")])
        .map((line) => String(line))
        .join("\n");
      for (const replacement of replacements) {
        value = value.replace(new RegExp(replacement.marker, "giu"), replacement.whitespace);
      }
      return restoreLineEdges(source, value);
    },
  };
}

function sourceIsShortLabel(text) {
  const value = String(text).trim();
  if (!value || value.length > 100 || /[.!?;:]/u.test(value)) return false;
  return value.split("\n").every((line) => line.trim().length <= 60);
}

function normalizeSurface(source, translated) {
  const value = String(translated);
  if (!sourceIsShortLabel(source)) return value;
  return value.split("\n").map((line) => line.replace(/[.!?;:]+(?=[ \t]*$)/u, "")).join("\n");
}

const TRANSLATION_BEGIN = "<<<GBFR_TRANSLATION>>>";
const TRANSLATION_END = "<<<END_GBFR_TRANSLATION>>>";
const AUDIT_BEGIN = "<<<GBFR_AUDIT>>>";
const AUDIT_END = "<<<END_GBFR_AUDIT>>>";

function qwenPrompts(item, glossary, stage) {
  const relevant = relevantGlossary([item.English], glossary);
  const keep = relevant.keepExact.length ? relevant.keepExact.join(", ") : "Không có";
  const translate = Object.entries(relevant.translateAs).length
    ? Object.entries(relevant.translateAs).map(([source, target]) => `${source} = ${target}`).join("; ")
    : "Không có";
  const shared = `Bạn là biên tập viên trưởng Việt hóa Granblue Fantasy: Relink. /no_think

English là nguồn chính; Japanese chỉ giúp gỡ mơ hồ. Hai phương án máy chỉ là bản nháp độc lập và đều có thể sai. Hãy đối chiếu từng ý với English rồi chọn phần đúng nhất hoặc tự viết lại; không mặc định tin phương án nào.

QUY TẮC BẮT BUỘC
- Không dịch tên riêng, vũ khí, Skill, Trait, Sigil, SBA, Summon hoặc Wrightstone đã được bảo vệ.
- Sao chép nguyên vẹn mọi token, tag và marker <GBFRGAP...ZXQ>.
- Tuyệt đối không dùng Markdown: không thêm **, __, backtick hay code fence.
- Tuyệt đối không chép metadata, prompt hoặc JSON vào câu dịch.
- Nhãn UI/Combat ngắn không có dấu câu ở nguồn thì không tự thêm dấu chấm.
- charged attack = đòn đánh tụ lực; Link Attack giữ English; Reversed = Đảo ngược; Combo = Liên chiêu; rarity = độ hiếm; Rupies giữ nguyên.
- Với Skill tạo vùng trên mặt đất, “Hold while casting to aim” là giữ khi niệm để chọn vị trí, không phải ngắm bằng ống ngắm.
- Tránh “mỗi viên triệu hồi” khi nguồn nói mỗi Summon, “điểm nút”, câu thiếu đối tượng “nuôi làm thú cưng”, câu gãy “có thể cho tôi được không sao?” và cụm thừa “chuỗi combo”.
- Dùng “gọi Summon”, không viết “triệu hồi một Summon”; beat back = đẩy lùi, không phải đánh bại.
- Giữ texture bằng English. Với “{1} Enabled”, viết “Đã bật {1}”.
- “New feature now available!” = “Đã mở tính năng mới!”; “refresh this data” = “làm mới dữ liệu”.
- Không dùng “cứu rỗi đồng đội”, “từng cái riêng biệt” hoặc giữ nguyên title English chỉ vì chưa chắc cách diễn đạt.
- Không lặp lại cùng một ý thành hai câu. “last saved” phải giữ rõ nghĩa “lần cuối”. “node” dịch tự nhiên là “nút”, không viết “điểm nút”.
- “join using ... data” phải giữ nghĩa “tham gia bằng dữ liệu...”, không được đổi thành “tiếp tục”. “Casts a circle” dùng “Tạo một vòng tròn”, không dùng “Phát động vòng tròn”.
- airship = phi thuyền; Girl in Blue = Cô Gái Áo Xanh; saga = thiên truyện; online giữ English.
- trophies = danh hiệu, không dùng “huy chương”. summon stone = Summon tương ứng, không dùng “viên đá triệu hồi”.
- “Casts a spell” dùng “Thi triển phép”; “Grants” dùng “Ban/Cấp/Nhận hiệu ứng” theo chủ thể, không dùng “Tặng hiệu ứng”.
- Mỗi lần thuật ngữ bảo vệ xuất hiện trong English phải xuất hiện đủ số lần trong bản Việt; không ngắt đôi thuật ngữ ghép qua xuống dòng.
- Không giải nghĩa tên riêng trong ngoặc và không viết chú thích kiểu “tên loài”, “không có nghĩa cụ thể”, “có thể là một từ...”.
- Không để sót mảnh English như “elude”, “le.” hoặc một nửa câu. Mọi từ không nằm trong danh sách GIỮ NGUYÊN phải được Việt hóa đầy đủ.
- Dùng “một mẩu xương” hoặc “một đoạn xương”, không viết “một xương”. Với Shield là chủ thể nhận hiệu ứng, viết tự nhiên như “Nhận một Shield mới”, không viết “Ban một lá chắn”.
- Tên Skill/Trait/Sigil/Summon và tên riêng đã bảo vệ phải giữ English ở mọi biến thể I/II/III và trong cả mô tả liên quan.

GIỮ NGUYÊN: ${keep}
THUẬT NGỮ DỊCH: ${translate}`;
  const promptEnglish = item.PromptEnglish || item.English;
  const contract = formatContract(promptEnglish);
  const source = contract.lines.join("\n");
  const lineCount = String(item.English).split("\n").length;
  const retrievedContext = item.ContextPrompt
    ? `\n\nCONTEXT_RETRIEVED_BEGIN\n${item.ContextPrompt}\nCONTEXT_RETRIEVED_END`
    : "";
  const context = `ID: ${item.ID}\nNHÓM: ${item.Category}\nSCRIPT SẼ TỰ DÀN LẠI ${lineCount} DÒNG: tập trung vào nghĩa và câu Việt tự nhiên; không tự thêm hoặc xóa token.\nTOKEN KỸ THUẬT: ${technicalTokens(item.English).join(", ") || "Không có"}\n\nENGLISH_BEGIN\n${source}\nENGLISH_END\n\nJAPANESE_BEGIN\n${item.Japanese || ""}\nJAPANESE_END${retrievedContext}`;

  if (stage === "beta4-repair") {
    const issues = (item.qaIssues || []).join(" | ") || "Cần kiểm tra lại toàn bộ nghĩa và độ tự nhiên";
    return {
      system: `${shared}\n\nĐây là lượt sửa cuối trước QA thủ công. Trong English, các chuỗi GBFRKEEP####ZXQ là dữ liệu bất biến: mỗi marker phải xuất hiện đúng một lần trong kết quả, không đổi chữ, không dịch và không giải thích. Sửa mọi lỗi đã nêu nhưng vẫn đối chiếu toàn câu với English; ưu tiên tiếng Việt tự nhiên, gọn và đúng ngữ cảnh game.`,
      user: `/no_think\n${context}\n\nBẢN_HIỆN_TẠI_BEGIN\n${item.PromptCurrent ?? item.previousVietnamese ?? item.Hybrid ?? item.TranslateGemma ?? ""}\nBẢN_HIỆN_TẠI_END\n\nLỖI/RỦI RO PHẢI SỬA: ${issues}\n\nChỉ đặt bản dịch hoàn chỉnh vào giữa hai marker; không giải thích, không JSON, không Markdown:\n${TRANSLATION_BEGIN}\n${TRANSLATION_END}\n/no_think`,
    };
  }

  if (stage === "critic") {
    const audited = String(item.auditVietnamese ?? item.Hybrid ?? item.EditorDraft ?? "");
    const issues = (item.qaIssues || []).join(" | ") || "Không có";
    return {
      system: `${shared}\n\nChỉ kiểm định, không viết lại bản dịch. Chấp nhận mọi cách diễn đạt tiếng Việt tự nhiên và đúng nghĩa, không đòi giống một đáp án mẫu. meaning=PASS khi đủ chủ thể, hành động, đối tượng, điều kiện và sắc thái quan trọng. naturalness=PASS khi câu có thể đưa thẳng vào game, dù vẫn còn cách viết hay hơn. Chỉ REVIEW khi chỉ ra được một lỗi cụ thể ảnh hưởng nghĩa, thuật ngữ hoặc độ tự nhiên. verdict=SAFE chỉ khi cả hai đều PASS, lỗi QA xác định rỗng và ISSUES=NONE. Title/lore/chơi chữ hoặc dòng bắt buộc duyệt luôn REVIEW.`,
      user: `/no_think\n${context}\n\nVIETNAMESE_AUDIT_BEGIN\n${audited}\nVIETNAMESE_AUDIT_END\n\nLỖI QA XÁC ĐỊNH: ${issues}\nBẮT BUỘC DUYỆT: ${item.mandatoryReview ? "CÓ" : "KHÔNG"}\n\nChỉ trả đúng khối 6 dòng sau, thay nội dung trong dấu <> bằng phán quyết; không giải thích:\n${AUDIT_BEGIN}\nMEANING=<PASS|UNCERTAIN|FAIL>\nNATURALNESS=<PASS|FAIL>\nVERDICT=<SAFE|REVIEW>\nISSUES=<NONE hoặc mã lỗi ngăn cách bằng dấu ;>\n${AUDIT_END}\n/no_think`,
    };
  }

  const candidateReferences = item.QwenV015
    ? `\n\nPHƯƠNG ÁN_QWEN_CŨ_BEGIN\n${item.QwenV015}\nPHƯƠNG ÁN_QWEN_CŨ_END\n\nPHƯƠNG ÁN_TRANSLATEGEMMA_BEGIN\n${item.TranslateGemma || ""}\nPHƯƠNG ÁN_TRANSLATEGEMMA_END`
    : `\n\nPHƯƠNG ÁN_TRANSLATEGEMMA_BEGIN\n${item.TranslateGemma || ""}\nPHƯƠNG ÁN_TRANSLATEGEMMA_END`;
  const previous = stage === "repair"
    ? `${candidateReferences}\n\nBẢN CẦN SỬA_BEGIN\n${item.previousVietnamese ?? item.Hybrid ?? ""}\nBẢN CẦN SỬA_END\nLỖI PHẢI SỬA: ${(item.qaIssues || []).join(" | ") || "Không có"}`
    : candidateReferences;
  const task = stage === "repair"
    ? "Sửa đúng các lỗi đã nêu. Không trả lại nguyên lỗi."
    : item.QwenV015
      ? "Đối chiếu hai phương án với English, giữ phần đúng và sửa mọi lỗi; kết quả phải ít nhất chính xác và tự nhiên bằng phương án tốt hơn."
      : "Biên tập phương án TranslateGemma theo English và Japanese; giữ phần đúng, sửa mọi lỗi và viết lại khi cần.";
  return {
    system: `${shared}\n\n${task} Kiểm tra đủ chủ thể, hành động, đối tượng, điều kiện, phủ định và quan hệ nguyên nhân-kết quả. Script sẽ tự dàn dòng theo nguồn, nên không hy sinh nghĩa hoặc tiếng Việt tự nhiên để canh dòng.`,
    user: `/no_think\n${context}${previous}\n\nChỉ đặt bản dịch vào giữa hai marker dưới đây; không giải thích, không JSON, không Markdown:\n${TRANSLATION_BEGIN}\n${TRANSLATION_END}\n/no_think`,
  };
}

function qwenStageTokenLimit(config, stage) {
  const configured = stage === "critic"
    ? config.qwenCriticMaxTokens
    : stage === "repair" || stage === "beta4-repair"
      ? config.qwenRepairMaxTokens
      : config.qwenEditorMaxTokens;
  return Math.min(config.qwenMaxTokens || 3072, configured || (stage === "critic" ? 256 : 768));
}

function responseTexts(message) {
  return [messageText(message), message?.reasoning_content, message?.reasoning]
    .filter((value) => typeof value === "string" && value.trim());
}

function invalidTranslationSurface(value) {
  const text = String(value);
  return !text.trim()
    || /```|<\/?think>|\/no_think|GBFR_TRANSLATION|END_GBFR_TRANSLATION|Chỉ đặt bản dịch|không JSON|không Markdown|(?:^|\b)(?:results|vietnamese_lines|response_format|MEANING|NATURALNESS|VERDICT)\s*[:=]/iu.test(text)
    || /^\s*\{(?=\s*["'])/u.test(text)
    || /^\s*\[(?=\s*[\[{"'])/u.test(text)
    || /^\s*(?:bản dịch|translation)\s*[:：-]/iu.test(text)
    || /^\s*(?:dưới đây\b|here is\b|sure\b|tôi sẽ\b)/iu.test(text);
}

export function parsePlainTranslation(message, expectedLineCount) {
  const markerPattern = /<<<GBFR_TRANSLATION>>>\s*([\s\S]*?)\s*<<<END_GBFR_TRANSLATION>>>/giu;
  for (const text of responseTexts(message)) {
    const marked = [...text.matchAll(markerPattern)].map((match) => match[1]);
    const candidates = marked.length ? marked.reverse() : [text.trim()];
    for (const candidate of candidates) {
      const normalized = String(candidate).replace(/\r\n?/gu, "\n");
      const lines = normalized.split("\n");
      if (!lines.length || invalidTranslationSurface(normalized)) continue;
      return lines;
    }
  }
  return null;
}

export function parsePlainCritic(message) {
  const blockPattern = /<<<GBFR_AUDIT>>>\s*\r?\n([\s\S]*?)\r?\n<<<END_GBFR_AUDIT>>>/giu;
  for (const text of responseTexts(message)) {
    const blocks = [...text.matchAll(blockPattern)].map((match) => match[1]);
    const candidates = blocks.length ? blocks.reverse() : [text];
    for (const candidate of candidates) {
      const meaning = candidate.match(/^MEANING\s*=\s*(PASS|UNCERTAIN|FAIL)\s*$/imu)?.[1]?.toUpperCase();
      const naturalness = candidate.match(/^NATURALNESS\s*=\s*(PASS|FAIL)\s*$/imu)?.[1]?.toUpperCase();
      const verdict = candidate.match(/^VERDICT\s*=\s*(SAFE|REVIEW)\s*$/imu)?.[1]?.toUpperCase();
      const issueText = candidate.match(/^ISSUES\s*=\s*([^\r\n]*)$/imu)?.[1]?.trim();
      if (!meaning || !naturalness || !verdict || issueText === undefined) continue;
      const noIssues = !issueText || /^NONE$/iu.test(issueText);
      if (verdict === "SAFE" && (meaning !== "PASS" || naturalness !== "PASS" || !noIssues)) continue;
      return {
        meaning,
        naturalness,
        verdict,
        issue_codes: noIssues ? [] : ["MODEL_REVIEW"],
        issue_notes: noIssues ? "" : issueText.slice(0, 600),
      };
    }
  }
  return null;
}

function protectedPhraseTokenizer(value, protectedTerms = []) {
  let text = String(value);
  const replacements = [];
  const terms = [...new Set(protectedTerms)]
    .filter((term) => /\s/u.test(term))
    .sort((left, right) => right.length - left.length);
  for (const term of terms) {
    const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
    text = text.replace(pattern, (match) => {
      const marker = `GBFRPHRASE${String(replacements.length).padStart(4, "0")}ZXQ`;
      replacements.push({ marker, value: match });
      return marker;
    });
  }
  return {
    text,
    restore(candidate) {
      let restored = String(candidate);
      for (const replacement of replacements) restored = restored.replaceAll(replacement.marker, replacement.value);
      return restored;
    },
  };
}

export function fitLineStructure(source, candidateLines, protectedTerms = []) {
  const sourceLines = String(source).split("\n");
  const rawLines = (Array.isArray(candidateLines) ? candidateLines : [String(candidateLines ?? "")])
    .map((line) => String(line).replace(/\r/gu, ""));
  const sourceShape = sourceLines.map((line) => (/^[ \t]*$/u.test(line) ? "EMPTY" : "TEXT"));
  const rawShape = rawLines.map((line) => (/^[ \t]*$/u.test(line) ? "EMPTY" : "TEXT"));
  const countPhrase = (text, term) => {
    const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [...normalizeText(text).matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"))].length;
  };
  const phrasesIntact = protectedTerms.every((term) => {
    const sourceCount = countPhrase(source, term);
    const requiredCount = normalizeText(term).toLowerCase() === "summon" ? Math.min(sourceCount, 1) : sourceCount;
    return countPhrase(rawLines.join("\n"), term) >= requiredCount;
  });
  if (rawLines.length === sourceLines.length
    && JSON.stringify(rawShape) === JSON.stringify(sourceShape)
    && phrasesIntact) return rawLines;

  const textSlots = sourceLines.map((line, index) => (/^[ \t]*$/u.test(line) ? -1 : index)).filter((index) => index >= 0);
  const protectedCandidate = protectedPhraseTokenizer(rawLines.join(" ").replace(/[ \t]+/gu, " ").trim(), protectedTerms);
  const tokens = protectedCandidate.text.split(/\s+/u).filter(Boolean);
  if (!textSlots.length || !tokens.length) return rawLines;
  const result = sourceLines.map(() => "");
  const weights = textSlots.map((index) => Math.max(1, sourceLines[index].trim().length));
  let tokenIndex = 0;
  let remainingWeight = weights.reduce((sum, value) => sum + value, 0);
  for (let slotIndex = 0; slotIndex < textSlots.length; slotIndex += 1) {
    const slotsLeft = textSlots.length - slotIndex;
    const tokensLeft = tokens.length - tokenIndex;
    if (slotIndex === textSlots.length - 1) {
      result[textSlots[slotIndex]] = tokens.slice(tokenIndex).join(" ");
      break;
    }
    const maxTake = Math.max(1, tokensLeft - (slotsLeft - 1));
    const targetChars = Math.max(1, Math.round(tokens.slice(tokenIndex).join(" ").length * weights[slotIndex] / remainingWeight));
    let take = 0;
    let chars = 0;
    while (take < maxTake && (take === 0 || chars < targetChars)) {
      chars += tokens[tokenIndex + take].length + (take ? 1 : 0);
      take += 1;
    }
    result[textSlots[slotIndex]] = tokens.slice(tokenIndex, tokenIndex + take).join(" ");
    tokenIndex += take;
    remainingWeight -= weights[slotIndex];
  }
  return result.map((line) => protectedCandidate.restore(line));
}

export function applyKnownSurfaceRules(source, translated) {
  const sourceLines = String(source).split("\n");
  const targetLines = String(translated).split("\n");
  for (let index = 0; index < Math.min(sourceLines.length, targetLines.length); index += 1) {
    if (/^\s*New feature now available!\s*$/iu.test(sourceLines[index])) {
      const leading = sourceLines[index].match(/^[ \t]*/u)?.[0] ?? "";
      const trailing = sourceLines[index].match(/[ \t]*$/u)?.[0] ?? "";
      targetLines[index] = `${leading}Đã mở tính năng mới!${trailing}`;
    }
  }
  let value = targetLines.join("\n")
    .replace(/<d>\{1\}[ \t]+Đã[ \t]+bật/gu, "<d>Đã bật {1}")
    .replace(/điểm[ \t]+nút/giu, "nút");
  if (/\bjoin\s+using\b/iu.test(source)) {
    value = value.replace(/\btiếp[ \t]+tục(?=[ \t]+bằng[ \t]+dữ[ \t]+liệu\b)/iu, "tham gia");
  }
  if (/\bcasts?\s+a\s+circle\b/iu.test(source)) {
    value = value.replace(/\bphát[ \t]+động[ \t]+vòng[ \t]+tròn\b/iu, "Tạo một vòng tròn");
  }
  if (/\btroph(?:y|ies)\b/iu.test(source)) {
    value = value.replace(/\bhuy[ \t]+chương\b/giu, "danh hiệu");
  }
  if (/\bsummon\s+stones?\b/iu.test(source)) {
    value = value.replace(/\b(?:viên[ \t]+)?đá[ \t]+triệu[ \t]+hồi(?:[ \t]+của[ \t]+nó)?\b/giu, "Summon tương ứng");
    value = value.replace(/Summon[ \t]+tương[ \t]+ứng[ \t]+của[ \t]+nó/gu, "Summon tương ứng");
  }
  if (/\bcasts?\s+a\s+spell\b/iu.test(source)) {
    value = value.replace(/\btạo[ \t]+(?:ra[ \t]+)?một[ \t]+phép[ \t]+thuật\b/giu, "Thi triển phép thuật");
  }
  if (/\bgrants?\b/iu.test(source)) {
    value = value.replace(/\btặng[ \t]+hiệu[ \t]+ứng\b/giu, "Ban hiệu ứng");
  }
  if (/\beffect\s+strength\b/iu.test(source)) {
    value = value.replace(/\bmức[ \t]+độ[ \t]+hiệu[ \t]+ứng\b/giu, "Hiệu lực");
  }
  if (/\bfinisher\b/iu.test(source)) {
    value = value.replace(/\bkỹ[ \t]+năng[ \t]+kết[ \t]+thúc\b/giu, "đòn kết thúc");
  }
  return value;
}

function retryableQwenError(error) {
  return /fetch failed|channel error|ECONNRESET|ECONNREFUSED|socket|aborted|timeout|LM Studio trả HTTP 5\d\d/iu.test(String(error?.message || error));
}

function protocolFallback(item, stage, reason) {
  if (stage === "critic") {
    return {
      meaning: "UNCERTAIN",
      naturalness: "FAIL",
      verdict: "REVIEW",
      issue_codes: [reason],
      issue_notes: "Qwen không trả đúng khối kiểm định văn bản thuần.",
      protocolFallback: true,
    };
  }
  const vietnamese = stage === "repair" || stage === "beta4-repair"
    ? String(item.previousVietnamese ?? item.Hybrid ?? item.EditorDraft ?? item.TranslateGemma ?? item.English)
    : String(item.TranslateGemma ?? item.English);
  return { vietnamese, protocolFallback: true, protocolIssue: reason };
}

async function runQwenStageOnce({ item, config, glossary, model, stage, attempt = 0 }) {
  const prompts = qwenPrompts(item, glossary, stage);
  const body = await chatCompletion(config, {
    model,
    messages: [
      { role: "system", content: prompts.system },
      { role: "user", content: prompts.user },
    ],
    temperature: config.temperature,
    top_p: config.topP,
    top_k: config.topK,
    seed: (config.seed || 137) + attempt,
    max_tokens: qwenStageTokenLimit(config, stage),
    chat_template_kwargs: { enable_thinking: false },
    enable_thinking: false,
  }, config.qwenTimeoutMs || config.timeoutMs);
  const message = body?.choices?.[0]?.message;
  if (stage === "critic") {
    const critic = parsePlainCritic(message) || protocolFallback(item, stage, "PLAIN_AUDIT_INVALID");
    return { candidate: critic, usage: body.usage || null };
  }
  const expectedLineCount = String(item.English).split("\n").length;
  const lines = parsePlainTranslation(message, expectedLineCount);
  if (!lines) {
    return { candidate: protocolFallback(item, stage, "PLAIN_TRANSLATION_INVALID"), usage: body.usage || null };
  }
  const placeholderEntries = Array.isArray(item.Beta4Placeholders) ? item.Beta4Placeholders : [];
  const candidateText = lines.join("\n");
  for (const entry of placeholderEntries) {
    const escaped = String(entry.marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = [...candidateText.matchAll(new RegExp(escaped, "giu"))].length;
    if (count !== 1) {
      return {
        candidate: protocolFallback(item, stage, `PLACEHOLDER_COUNT_MISMATCH:${entry.marker}:${count}`),
        usage: body.usage || null,
      };
    }
  }
  const source = item.English;
  const contract = formatContract(source);
  const protectedTerms = placeholderEntries.length
    ? placeholderEntries.map((entry) => entry.marker)
    : relevantGlossary([source], glossary).keepExact;
  const restored = contract.restore(fitLineStructure(source, lines, protectedTerms));
  let restoredPlaceholders = restored;
  for (const entry of placeholderEntries) {
    const escaped = String(entry.marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    restoredPlaceholders = restoredPlaceholders.replace(new RegExp(escaped, "giu"), entry.value);
  }
  const surface = normalizeSurface(source, restoredPlaceholders);
  const knownPatterns = applyKnownSurfaceRules(source, surface);
  return { candidate: { vietnamese: knownPatterns, protocolFallback: false }, usage: body.usage || null };
}

async function runQwenStage(options) {
  const retries = Math.max(0, Number(options.config.qwenRequestRetries ?? 1));
  const output = new Map();
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const item of options.items) {
    let lastError;
    let result;
    const itemUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        result = await runQwenStageOnce({ ...options, item, attempt });
        itemUsage.prompt_tokens += result.usage?.prompt_tokens || 0;
        itemUsage.completion_tokens += result.usage?.completion_tokens || 0;
        itemUsage.total_tokens += result.usage?.total_tokens || 0;
        if (result.candidate?.protocolFallback && attempt < retries) continue;
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !retryableQwenError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
    if (!result) throw lastError;
    output.set(item.key, result.candidate);
    usage.prompt_tokens += itemUsage.prompt_tokens;
    usage.completion_tokens += itemUsage.completion_tokens;
    usage.total_tokens += itemUsage.total_tokens;
  }
  return { output, usage };
}

function blockingTechnicalQa(qa) {
  return [...qa.errors, ...qa.warnings.filter((warning) => /^LINE_BREAK_MISMATCH|^EDGE_WHITESPACE_CHANGED/u.test(warning))];
}

function semanticQaIssues(qa) {
  return qa.warnings.filter((warning) => /^SEMANTIC_/u.test(warning));
}

function criticRepairIssues(critic) {
  const issues = Array.isArray(critic?.issue_codes) ? critic.issue_codes.filter(Boolean) : [];
  if (critic?.issue_notes) issues.push(`GÓP Ý CRITIC: ${critic.issue_notes}`);
  if (critic?.meaning !== "PASS") issues.push(`CRITIC_MEANING_${critic?.meaning || "MISSING"}`);
  if (critic?.naturalness !== "PASS") issues.push(`CRITIC_NATURALNESS_${critic?.naturalness || "MISSING"}`);
  if (critic?.verdict !== "SAFE") issues.push(`CRITIC_VERDICT_${critic?.verdict || "MISSING"}`);
  return [...new Set(issues)];
}

function candidateState({ row, vietnamese, glossary, critic = null, origin }) {
  const qa = checkTranslation({
    english: row.English,
    vietnamese,
    glossary,
    keepEnglish: origin === "SOURCE_ENGLISH",
  });
  const blockers = blockingTechnicalQa(qa);
  const semanticIssues = semanticQaIssues(qa);
  const criticIssues = row.mandatoryReview || !critic ? [] : criticRepairIssues(critic);
  return {
    vietnamese,
    qa,
    blockers,
    semanticIssues,
    critic,
    criticIssues,
    origin,
    score: blockers.length * 1000 + semanticIssues.length * 100 + criticIssues.length * 10 + qa.warnings.length,
  };
}

function firstTechnicallySafeFallback(row, glossary) {
  const candidates = [
    ["EDITOR_DRAFT", row.EditorDraft],
    ["QWEN_V015", row.QwenV015],
    ["TRANSLATEGEMMA", row.TranslateGemma],
    ["SOURCE_ENGLISH", row.English],
  ];
  const safe = [];
  for (const [origin, vietnamese] of candidates) {
    if (typeof vietnamese !== "string" || !vietnamese) continue;
    const fitted = origin === "SOURCE_ENGLISH"
      ? vietnamese
      : applyKnownSurfaceRules(
        row.English,
        normalizeSurface(row.English, restoreLineEdges(
          row.English,
          fitLineStructure(row.English, vietnamese.split("\n"), relevantGlossary([row.English], glossary).keepExact).join("\n"),
        )),
      );
    const state = candidateState({ row, vietnamese: fitted, glossary, origin });
    if (!state.blockers.length) safe.push(state);
  }
  return safe.sort((left, right) => {
    const leftRisk = left.semanticIssues.length * 100 + left.qa.warnings.length * 10 + (left.origin === "SOURCE_ENGLISH" ? 10000 : 0);
    const rightRisk = right.semanticIssues.length * 100 + right.qa.warnings.length * 10 + (right.origin === "SOURCE_ENGLISH" ? 10000 : 0);
    return leftRisk - rightRisk;
  })[0] || null;
}

function levenshtein(leftValue, rightValue) {
  const left = [...String(leftValue)];
  const right = [...String(rightValue)];
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}

function similarity(leftValue, rightValue) {
  const left = normalizeText(leftValue).trim().toLowerCase();
  const right = normalizeText(rightValue).trim().toLowerCase();
  if (!left && !right) return 1;
  return 1 - levenshtein(left, right) / Math.max(left.length, right.length, 1);
}

function usageAdd(target, usage) {
  if (!usage) return;
  target.promptTokens += usage.prompt_tokens || 0;
  target.completionTokens += usage.completion_tokens || 0;
  target.totalTokens += usage.total_tokens || 0;
}

async function loadAdversarial(projectRoot, config) {
  const [manifest, source, baselineText, glossary] = await Promise.all([
    fs.readFile(path.join(projectRoot, config.adversarialManifest), "utf8").then(JSON.parse),
    fs.readFile(path.join(projectRoot, config.adversarialSource), "utf8").then(JSON.parse),
    fs.readFile(path.join(projectRoot, config.qwenBaseline), "utf8"),
    fs.readFile(path.join(projectRoot, config.glossaryFile), "utf8").then(JSON.parse),
  ]);
  const sourceMap = new Map(source.items.map((row) => [row.ID, row]));
  const baseline = csvToObjects(baselineText).rows;
  const baselineMap = new Map(baseline.map((row) => [row.ID, row]));
  const mandatoryIds = new Set(manifest.mandatoryReviewIds || []);
  const rows = [];
  for (const group of manifest.groups) {
    for (const id of group.ids) {
      const sourceRow = sourceMap.get(id);
      const oldRow = baselineMap.get(id);
      if (!sourceRow || !oldRow) throw new Error(`Manifest tham chiếu ID không có dữ liệu: ${id}`);
      rows.push({
        ...sourceRow,
        key: `a${String(rows.length + 1).padStart(2, "0")}`,
        testGroup: group.id,
        testGroupLabel: group.label,
        mandatoryReview: Boolean(group.mandatoryReview || mandatoryIds.has(id)),
        QwenV015: oldRow.Vietnamese,
        QwenV015Status: oldRow["Local Status"],
      });
    }
  }
  if (rows.length !== 30 || new Set(rows.map((row) => row.ID)).size !== 30) {
    throw new Error(`Bộ adversarial phải có đúng 30 ID duy nhất; hiện có ${rows.length}.`);
  }
  return { manifest, rows, glossary };
}

async function loadStress100(projectRoot, config) {
  const [source, baselineText, glossary] = await Promise.all([
    fs.readFile(path.join(projectRoot, config.adversarialSource), "utf8").then(JSON.parse),
    fs.readFile(path.join(projectRoot, config.qwenBaseline), "utf8"),
    fs.readFile(path.join(projectRoot, config.glossaryFile), "utf8").then(JSON.parse),
  ]);
  const baseline = csvToObjects(baselineText).rows;
  const baselineMap = new Map(baseline.map((row) => [row.ID, row]));
  const rows = source.items.map((sourceRow, index) => {
    const oldRow = baselineMap.get(sourceRow.ID);
    if (!oldRow) throw new Error(`Bộ 100 dòng thiếu Qwen baseline cho ID: ${sourceRow.ID}`);
    const reviewReasons = semanticReviewReasons(sourceRow);
    return {
      ...sourceRow,
      key: `s${String(index + 1).padStart(3, "0")}`,
      testGroup: "stress100",
      testGroupLabel: reviewReasons.length ? `Bắt buộc duyệt: ${reviewReasons.join("+")}` : "Kiểm định 100 dòng",
      mandatoryReview: reviewReasons.length > 0,
      mandatoryReviewReasons: reviewReasons,
      QwenV015: oldRow.Vietnamese,
      QwenV015Status: oldRow["Local Status"],
    };
  });
  if (rows.length !== 100 || new Set(rows.map((row) => row.ID)).size !== 100) {
    throw new Error(`Bộ stress phải có đúng 100 ID duy nhất; hiện có ${rows.length}.`);
  }
  return { manifest: null, rows, glossary };
}

export async function hybridDoctor({ projectRoot, config }) {
  const models = await listRestModels(config);
  const gemma = selectModel(models, config.translateGemmaPreference, "TranslateGemma 12B");
  const qwen = selectModel(models, config.qwenPreference, "Qwen3.5 9B");
  const gemmaInstances = loadedInstances(gemma);
  if (!gemmaInstances.length) {
    throw new Error("TranslateGemma chưa READY. Hãy load thủ công model Q5_K_M với Chat Template rút gọn rồi chạy lại file 02.");
  }
  if (gemmaInstances[0].config?.context_length !== config.translateGemmaContextLength) {
    throw new Error(`TranslateGemma đang dùng context ${gemmaInstances[0].config?.context_length || "không xác định"}; cần đúng ${config.translateGemmaContextLength}.`);
  }
  const otherLoaded = models.flatMap((model) => loadedInstances(model).map((instance) => ({ model, instance })))
    .filter(({ instance }) => !gemmaInstances.some((gemmaInstance) => gemmaInstance.id === instance.id));
  if (otherLoaded.length) throw new Error("Đang có model khác cùng READY. Hãy Eject model khác và chỉ giữ TranslateGemma trước khi test.");
  const smoke = await translateWithGemma({
    row: { ID: "SMOKE_TEST", English: "Hold the button to charge the attack, then follow up with a combo." },
    config,
    model: gemmaInstances[0].id,
  });
  return {
    gemma: { key: gemma.key, instanceId: gemmaInstances[0].id, quantization: gemma.quantization?.name || "" },
    qwen: { key: qwen.key, downloaded: true, quantization: qwen.quantization?.name || "" },
    smoke: smoke.vietnamese,
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findResumeCheckpoint(projectRoot, config, rows, { includeCompleted = false } = {}) {
  const outputRoot = path.join(projectRoot, config.outputRoot);
  let entries;
  try {
    entries = await fs.readdir(outputRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const expectedById = new Map(rows.map((row) => [row.ID, row]));
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  for (const directory of directories) {
    const runDir = path.join(outputRoot, directory);
    if (!includeCompleted && await pathExists(path.join(runDir, "benchmark_report.json"))) continue;
    const checkpointPath = path.join(runDir, "translategemma_candidates.json");
    if (!(await pathExists(checkpointPath))) continue;
    let checkpoint;
    try {
      checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    } catch {
      continue;
    }
    if (checkpoint?.completed !== rows.length || checkpoint?.total !== rows.length || !Array.isArray(checkpoint.items)) continue;
    const checkpointById = new Map(checkpoint.items.map((item) => [item.ID, item]));
    const valid = checkpoint.items.length === rows.length && rows.every((row) => {
      const candidate = checkpointById.get(row.ID);
      return candidate && candidate.English === expectedById.get(row.ID).English && typeof candidate.TranslateGemma === "string";
    });
    if (valid) return { runDir, checkpoint, checkpointById };
  }
  return null;
}

async function loadQwenProgress(runDir, rows) {
  const progressPath = path.join(runDir, "qwen_progress.json");
  if (!(await pathExists(progressPath))) return { editor: 0, critic: 0 };
  let progress;
  try {
    progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
  } catch {
    return { editor: 0, critic: 0 };
  }
  if (!Array.isArray(progress?.items)) return { editor: 0, critic: 0 };
  const progressById = new Map(progress.items.map((item) => [item.ID, item]));
  let editor = 0;
  let critic = 0;
  for (const row of rows) {
    const saved = progressById.get(row.ID);
    if (!saved || saved.English !== row.English) continue;
    if (typeof saved.EditorDraft === "string" && saved.EditorDraft) {
      row.EditorDraft = saved.EditorDraft;
      row.editorProtocolFallback = Boolean(saved.editorProtocolFallback);
      row.editorProtocolIssue = saved.editorProtocolIssue || "";
      editor += 1;
    }
    if (saved.critic && typeof saved.critic === "object" && !Array.isArray(saved.critic)) {
      row.critic = saved.critic;
      critic += 1;
    }
  }
  return { editor, critic };
}

async function saveQwenProgress(runDir, rows) {
  await writeJsonFile(path.join(runDir, "qwen_progress.json"), {
    updatedAt: new Date().toISOString(),
    items: rows.map((row) => ({
      ID: row.ID,
      English: row.English,
      ...(typeof row.EditorDraft === "string" && row.EditorDraft ? { EditorDraft: row.EditorDraft } : {}),
      ...(row.editorProtocolFallback ? {
        editorProtocolFallback: true,
        editorProtocolIssue: row.editorProtocolIssue || "PLAIN_TRANSLATION_INVALID",
      } : {}),
      ...(row.critic ? { critic: row.critic } : {}),
    })),
  });
}

export async function runHybridAdversarial({ projectRoot, config, onProgress = () => {}, resume = false, reuseGemma = false, stress100 = false }) {
  const startedAt = new Date().toISOString();
  const { rows, glossary } = stress100
    ? await loadStress100(projectRoot, config)
    : await loadAdversarial(projectRoot, config);
  let runDir;
  let resumeCheckpoint = null;
  if (resume || reuseGemma) {
    resumeCheckpoint = await findResumeCheckpoint(projectRoot, config, rows, { includeCompleted: reuseGemma });
    if (!resumeCheckpoint) {
      throw new Error("Không tìm thấy lượt chạy đã hoàn tất 30 phương án TranslateGemma. Hãy giữ nguyên runs_hybrid từ lượt alpha.5.");
    }
    if (reuseGemma) {
      const runName = `${startedAt.replace(/[:.]/gu, "-")}-fresh-qwen`;
      runDir = path.join(projectRoot, config.outputRoot, runName);
      await fs.mkdir(runDir, { recursive: true });
      await writeJsonFile(path.join(runDir, "translategemma_candidates.json"), resumeCheckpoint.checkpoint);
    } else {
      runDir = resumeCheckpoint.runDir;
    }
    for (const row of rows) {
      row.TranslateGemma = resumeCheckpoint.checkpointById.get(row.ID).TranslateGemma;
      const keep = shouldKeepEnglish(row, glossary);
      if (keep.keep) {
        row.keepEnglish = true;
        row.keepReason = keep.reason;
        row.TranslateGemma = row.English;
      }
    }
    onProgress({ stage: reuseGemma ? "reuse-gemma" : "resume", runDir, sourceRunDir: resumeCheckpoint.runDir });
  } else {
    const runName = startedAt.replace(/[:.]/gu, "-");
    runDir = path.join(projectRoot, config.outputRoot, runName);
    await fs.mkdir(runDir, { recursive: true });
  }
  let seededGemmaCount = 0;
  if (stress100 && !resume && !reuseGemma) {
    const adversarial = await loadAdversarial(projectRoot, config);
    const seedCheckpoint = await findResumeCheckpoint(projectRoot, config, adversarial.rows, { includeCompleted: true });
    if (seedCheckpoint) {
      for (const row of rows) {
        const cached = seedCheckpoint.checkpointById.get(row.ID);
        if (!cached || cached.English !== row.English || typeof cached.TranslateGemma !== "string") continue;
        row.TranslateGemma = cached.TranslateGemma;
        row.reusedGemma = true;
        seededGemmaCount += 1;
      }
      onProgress({ stage: "gemma-seed", count: seededGemmaCount, sourceRunDir: seedCheckpoint.runDir });
    }
  }
  const models = await listRestModels(config);
  const gemma = selectModel(models, config.translateGemmaPreference, "TranslateGemma 12B");
  const qwen = selectModel(models, config.qwenPreference, "Qwen3.5 9B");
  const gemmaInstance = loadedInstances(gemma)[0] || null;
  if (!resume && !reuseGemma && !gemmaInstance) throw new Error("TranslateGemma chưa READY. Chạy file 02 trước; chưa tự load vì cần giữ Chat Template rút gọn đã xác nhận.");
  if (!resume && !reuseGemma && gemmaInstance.config?.context_length !== config.translateGemmaContextLength) {
    throw new Error(`TranslateGemma đang dùng context ${gemmaInstance.config?.context_length || "không xác định"}; cần đúng ${config.translateGemmaContextLength}.`);
  }

  const trace = {
    startedAt,
    resumedFromTranslateGemmaCheckpoint: Boolean(resumeCheckpoint),
    freshQwenFromCompletedGemmaCheckpoint: Boolean(reuseGemma),
    translateGemmaCheckpointSource: resumeCheckpoint?.runDir || null,
    translateGemma: resumeCheckpoint?.checkpoint?.model || { key: gemma.key, instanceId: gemmaInstance?.id || null, quantization: gemma.quantization?.name || "" },
    qwen: { key: qwen.key, quantization: qwen.quantization?.name || "" },
    modelSwitch: [],
  };
  const usage = {
    translateGemma: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    qwen: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    qwenEditor: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    qwenCritic: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    qwenRepair: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  let qwenLoaded;
  if (!resume && !reuseGemma) {
    for (const model of models) {
      for (const instance of loadedInstances(model)) {
        if (instance.id !== gemmaInstance.id) await unloadInstance(config, instance.id);
      }
    }
    onProgress({ stage: "gemma-start", total: rows.length, reused: seededGemmaCount });
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const keep = shouldKeepEnglish(row, glossary);
      if (keep.keep) {
        row.TranslateGemma = row.English;
        row.keepEnglish = true;
        row.keepReason = keep.reason;
      } else if (!row.TranslateGemma) {
        const response = await translateWithGemma({ row, config, model: gemmaInstance.id, glossary });
        row.TranslateGemma = response.vietnamese;
        usageAdd(usage.translateGemma, response.usage);
      }
      onProgress({
        stage: "gemma-item",
        current: index + 1,
        total: rows.length,
        id: row.ID,
        bypassed: Boolean(row.keepEnglish),
        reused: Boolean(row.reusedGemma),
      });
      await writeJsonFile(path.join(runDir, "translategemma_candidates.json"), {
        model: trace.translateGemma,
        completed: index + 1,
        total: rows.length,
        items: rows.slice(0, index + 1).map((item) => ({ ID: item.ID, English: item.English, TranslateGemma: item.TranslateGemma })),
      });
    }

    onProgress({ stage: "switch-start" });
    await unloadInstance(config, gemmaInstance.id);
    trace.modelSwitch.push({ action: "unload", instanceId: gemmaInstance.id, at: new Date().toISOString() });
    qwenLoaded = await loadModel(config, qwen.key, config.qwenContextLength);
    trace.modelSwitch.push({ action: "load", instanceId: qwenLoaded.instance_id, at: new Date().toISOString() });
  } else {
    const qwenCandidate = loadedInstances(qwen)[0] || null;
    const readyQwen = qwenCandidate?.config?.context_length === config.qwenContextLength ? qwenCandidate : null;
    for (const model of models) {
      for (const instance of loadedInstances(model)) {
        if (instance.id !== readyQwen?.id) {
          await unloadInstance(config, instance.id);
          trace.modelSwitch.push({
            action: instance.id === qwenCandidate?.id ? "unload-wrong-context" : "unload-other",
            instanceId: instance.id,
            at: new Date().toISOString(),
          });
        }
      }
    }
    if (readyQwen) {
      qwenLoaded = { instance_id: readyQwen.id, load_config: readyQwen.config || null };
      trace.modelSwitch.push({ action: "reuse", instanceId: readyQwen.id, at: new Date().toISOString() });
    } else {
      qwenLoaded = await loadModel(config, qwen.key, config.qwenContextLength);
      trace.modelSwitch.push({ action: "load", instanceId: qwenLoaded.instance_id, at: new Date().toISOString() });
    }
  }
  trace.qwen.instanceId = qwenLoaded.instance_id;
  trace.qwen.loadConfig = qwenLoaded.load_config || null;
  await writeJsonFile(path.join(runDir, "model_trace.json"), trace);
  onProgress({ stage: "switch-done", model: qwenLoaded.instance_id });

  const editable = rows.filter((row) => !row.keepEnglish);
  const qwenProgress = resume ? await loadQwenProgress(runDir, editable) : { editor: 0, critic: 0 };
  if (resume && (qwenProgress.editor || qwenProgress.critic)) {
    onProgress({ stage: "qwen-resume", editor: qwenProgress.editor, critic: qwenProgress.critic });
  }
  const batches = [];
  const pendingEditor = editable.filter((row) => !row.EditorDraft);
  for (let index = 0; index < pendingEditor.length; index += config.editorBatchSize) batches.push(pendingEditor.slice(index, index + config.editorBatchSize));
  onProgress({ stage: "editor-start", total: batches.length });
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const response = await runQwenStage({ items: batch, config, glossary, model: qwenLoaded.instance_id, stage: "editor" });
    usageAdd(usage.qwen, response.usage);
    usageAdd(usage.qwenEditor, response.usage);
    for (const row of batch) {
      const candidate = response.output.get(row.key);
      row.EditorDraft = candidate.vietnamese;
      row.editorProtocolFallback = Boolean(candidate.protocolFallback);
      row.editorProtocolIssue = candidate.protocolIssue || "";
    }
    await saveQwenProgress(runDir, editable);
    onProgress({ stage: "editor-batch", current: index + 1, total: batches.length, items: batch.length });
  }

  for (const row of editable) {
    row.Hybrid = row.EditorDraft;
    const qa = checkTranslation({ english: row.English, vietnamese: row.Hybrid, glossary });
    row.preCriticQaIssues = [...blockingTechnicalQa(qa), ...semanticQaIssues(qa)];
  }

  const criticBatches = [];
  const criticBatchSize = config.criticBatchSize || 1;
  const pendingCritic = editable.filter((row) => !row.critic);
  for (let index = 0; index < pendingCritic.length; index += criticBatchSize) {
    criticBatches.push(pendingCritic.slice(index, index + criticBatchSize));
  }
  onProgress({ stage: "critic-start", total: criticBatches.length });
  for (let index = 0; index < criticBatches.length; index += 1) {
    const batch = criticBatches[index].map((row) => ({
      ...row,
      auditVietnamese: row.Hybrid,
      qaIssues: row.preCriticQaIssues,
    }));
    const response = await runQwenStage({ items: batch, config, glossary, model: qwenLoaded.instance_id, stage: "critic" });
    usageAdd(usage.qwen, response.usage);
    usageAdd(usage.qwenCritic, response.usage);
    for (const item of batch) {
      const row = rows.find((candidate) => candidate.key === item.key);
      row.critic = response.output.get(item.key);
      row.criticProtocolFallback = Boolean(row.critic.protocolFallback);
    }
    await saveQwenProgress(runDir, editable);
    onProgress({ stage: "critic-batch", current: index + 1, total: criticBatches.length, items: batch.length });
  }

  for (const row of rows) {
    if (row.keepEnglish) {
      row.Hybrid = row.English;
      row.critic = { meaning: "PASS", naturalness: "PASS", verdict: "SAFE", issue_codes: [], issue_notes: "" };
      row.qa = checkTranslation({ english: row.English, vietnamese: row.Hybrid, glossary, keepEnglish: true });
      row.technicalBlockers = [];
      row.semanticQaIssues = [];
      continue;
    }
    const editorOrigin = row.editorProtocolFallback ? "EDITOR_PROTOCOL_FALLBACK" : "EDITOR_DRAFT";
    let state = candidateState({ row, vietnamese: row.Hybrid, glossary, critic: row.critic, origin: editorOrigin });
    const initialCriticIssues = state.criticIssues;
    state.score = state.blockers.length * 1000 + state.semanticIssues.length * 100 + initialCriticIssues.length * 10 + state.qa.warnings.length;
    const needsRepair = state.blockers.length || state.semanticIssues.length || initialCriticIssues.length;
    if (needsRepair) {
      const maxAttempts = Math.max(1, config.maxRepairAttempts || 1);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const repairItem = {
          ...row,
          previousVietnamese: state.vietnamese,
          qaIssues: [...state.blockers, ...state.semanticIssues, ...(row.mandatoryReview ? [] : state.criticIssues)],
        };
        const repair = await runQwenStage({ items: [repairItem], config, glossary, model: qwenLoaded.instance_id, stage: "repair" });
        usageAdd(usage.qwen, repair.usage);
        usageAdd(usage.qwenRepair, repair.usage);
        row.repairAttempts = attempt;
        row.repairAttempted = true;
        const repaired = repair.output.get(row.key);
        const repairOrigin = repaired.protocolFallback ? `REPAIR_PROTOCOL_FALLBACK_${attempt}` : `REPAIR_${attempt}`;
        let repairedState = candidateState({ row, vietnamese: repaired.vietnamese, glossary, origin: repairOrigin });
        if (!repairedState.blockers.length) {
          const auditItem = {
            ...row,
            auditVietnamese: repairedState.vietnamese,
            qaIssues: [...repairedState.semanticIssues],
          };
          const recheck = await runQwenStage({ items: [auditItem], config, glossary, model: qwenLoaded.instance_id, stage: "critic" });
          usageAdd(usage.qwen, recheck.usage);
          usageAdd(usage.qwenCritic, recheck.usage);
          repairedState = candidateState({
            row,
            vietnamese: repairedState.vietnamese,
            glossary,
            critic: recheck.output.get(row.key),
            origin: `REPAIR_${attempt}`,
          });
        }
        if (repairedState.score < state.score) state = repairedState;
        if (!state.blockers.length && !state.semanticIssues.length && (row.mandatoryReview || !state.criticIssues.length)) break;
      }
    }
    if (state.blockers.length) {
      const fallback = firstTechnicallySafeFallback(row, glossary);
      if (fallback) {
        state = fallback;
        row.fallbackUsed = fallback.origin;
        row.fallbackReview = true;
      }
    }
    row.Hybrid = state.vietnamese;
    row.qa = state.qa;
    row.critic = row.fallbackUsed
      ? { meaning: "UNCERTAIN", naturalness: "FAIL", verdict: "REVIEW", issue_codes: [`FALLBACK_${row.fallbackUsed}`], issue_notes: "Dùng phương án dự phòng sạch kỹ thuật; bắt buộc kiểm tra thủ công." }
      : state.critic || row.critic;
    row.technicalBlockers = state.blockers;
    row.semanticQaIssues = state.semanticIssues;
    row.protocolFallbackReview = /PROTOCOL_FALLBACK/u.test(state.origin) || Boolean(state.critic?.protocolFallback);
  }

  for (const row of rows) {
    if (row.keepEnglish) row.hybridStatus = "KEEP_ENGLISH";
    else if (row.technicalBlockers.length) row.hybridStatus = "TECHNICAL_ERROR";
    else if (row.mandatoryReview) row.hybridStatus = "REVIEW_MANDATORY";
    else if (row.fallbackReview || row.protocolFallbackReview || row.critic.verdict !== "SAFE" || row.critic.meaning !== "PASS" || row.critic.naturalness !== "PASS" || row.qa.warnings.length) row.hybridStatus = "REVIEW";
    else row.hybridStatus = "LOCAL_OK";
    row.hybridSimilarity = row.ExpectedVietnamese ? similarity(row.ExpectedVietnamese, row.Hybrid) : null;
    row.baselineSimilarity = row.ExpectedVietnamese ? similarity(row.ExpectedVietnamese, row.QwenV015) : null;
  }

  const scored = rows.filter((row) => row.ExpectedVietnamese);
  const hybridAverage = scored.reduce((sum, row) => sum + row.hybridSimilarity, 0) / Math.max(scored.length, 1);
  const baselineAverage = scored.reduce((sum, row) => sum + row.baselineSimilarity, 0) / Math.max(scored.length, 1);
  const wins = scored.filter((row) => row.hybridSimilarity - row.baselineSimilarity >= 0.03).length;
  const losses = scored.filter((row) => row.baselineSimilarity - row.hybridSimilarity >= 0.03).length;
  const nonMandatory = rows.filter((row) => !row.mandatoryReview);
  const autoProcessed = nonMandatory.filter((row) => ["LOCAL_OK", "KEEP_ENGLISH"].includes(row.hybridStatus));
  const autoRate = autoProcessed.length / Math.max(nonMandatory.length, 1);
  const statusCounts = Object.fromEntries([...new Set(rows.map((row) => row.hybridStatus))].map((status) => [status, rows.filter((row) => row.hybridStatus === status).length]));
  const fallbackRows = rows.filter((row) => row.fallbackUsed);
  const protocolFallbackRows = rows.filter((row) => row.protocolFallbackReview || row.critic?.protocolFallback);
  const fallbackBreakdown = Object.fromEntries([...new Set(fallbackRows.map((row) => row.fallbackUsed))]
    .map((origin) => [origin, fallbackRows.filter((row) => row.fallbackUsed === origin).length]));
  const gates = {
    technical100: rows.every((row) => row.hybridStatus !== "TECHNICAL_ERROR"),
    autoAtLeast70NonMandatory: autoRate >= 0.7,
    clearlyBetterThanQwenOnly: hybridAverage >= baselineAverage + 0.03 && wins >= losses + 3,
    severeLocalOkAudit: "PENDING_MANUAL_AUDIT",
  };
  const automatedGatePassed = gates.technical100 && gates.autoAtLeast70NonMandatory && gates.clearlyBetterThanQwenOnly;
  const decision = automatedGatePassed
    ? stress100
      ? "ĐẠT CỔNG TỰ ĐỘNG 100 DÒNG — CHỜ DUYỆT LOCAL_OK"
      : "ĐẠT CỔNG TỰ ĐỘNG — CHỜ DUYỆT LOCAL_OK"
    : stress100
      ? "CHƯA ĐẠT CỔNG 100 DÒNG — CHƯA MỞ DỊCH FILE THẬT"
      : "CHƯA ĐẠT — GIỮ Ở BỘ 30 DÒNG, CHƯA CHẠY 100 DÒNG";
  const finishedAt = new Date().toISOString();
  const report = {
    decision,
    automatedGatePassed,
    gates,
    sampleCount: rows.length,
    mandatoryReviewCount: rows.filter((row) => row.mandatoryReview).length,
    nonMandatoryCount: nonMandatory.length,
    autoProcessedCount: autoProcessed.length,
    autoProcessedRate: autoRate,
    statusCounts,
    repairAttemptedCount: rows.filter((row) => row.repairAttempted).length,
    fallbackUsedCount: fallbackRows.length,
    fallbackBreakdown,
    protocolFallbackReviewCount: protocolFallbackRows.length,
    qualityComparison: { scoredCount: scored.length, hybridAverageSimilarity: hybridAverage, qwenV015AverageSimilarity: baselineAverage, wins, losses },
    usage,
    startedAt,
    finishedAt,
    dataset: stress100 ? "STRESS_100" : "ADVERSARIAL_30",
    seededTranslateGemmaCount: seededGemmaCount,
    note: stress100
      ? "Bộ 100 dòng là cổng xác nhận cuối trước khi mở lệnh dịch dữ liệu thật. LOCAL_OK vẫn phải được kiểm toán ngữ nghĩa độc lập."
      : "Similarity với Golden chỉ là chỉ số tham khảo. LOCAL_OK vẫn phải được kiểm toán ngữ nghĩa độc lập trước khi cho chạy 100 dòng.",
  };

  const headers = [
    "Test Group", "Mandatory Review", "ID", "Category", "English", "Japanese", "Expected Vietnamese",
    "Qwen v0.1.5", "TranslateGemma", "Editor Draft", "Hybrid", "Hybrid Status", "Critic Meaning", "Critic Naturalness", "Critic Verdict",
    "Critic Issues", "Critic Notes", "QA Errors", "QA Warnings", "Repair Attempted", "Repair Attempts", "Fallback Used", "Protocol Fallback", "Baseline Similarity", "Hybrid Similarity"
  ];
  const csvRows = rows.map((row) => ({
    "Test Group": row.testGroupLabel,
    "Mandatory Review": row.mandatoryReview ? "YES" : "NO",
    ID: row.ID,
    Category: row.Category,
    English: row.English,
    Japanese: row.Japanese,
    "Expected Vietnamese": row.ExpectedVietnamese,
    "Qwen v0.1.5": row.QwenV015,
    TranslateGemma: row.TranslateGemma,
    "Editor Draft": row.EditorDraft || row.Hybrid,
    Hybrid: row.Hybrid,
    "Hybrid Status": row.hybridStatus,
    "Critic Meaning": row.critic.meaning,
    "Critic Naturalness": row.critic.naturalness,
    "Critic Verdict": row.critic.verdict,
    "Critic Issues": (row.critic.issue_codes || []).join(" | "),
    "Critic Notes": row.critic.issue_notes || "",
    "QA Errors": (row.qa?.errors || []).join(" | "),
    "QA Warnings": (row.qa?.warnings || []).join(" | "),
    "Repair Attempted": row.repairAttempted ? "YES" : "NO",
    "Repair Attempts": row.repairAttempts || 0,
    "Fallback Used": row.fallbackUsed || "",
    "Protocol Fallback": row.protocolFallbackReview ? "REVIEW" : "",
    "Baseline Similarity": row.baselineSimilarity == null ? "" : row.baselineSimilarity.toFixed(4),
    "Hybrid Similarity": row.hybridSimilarity == null ? "" : row.hybridSimilarity.toFixed(4),
  }));
  const rowCount = stress100 ? "100" : "30";
  const reviewFile = `hybrid_review_${rowCount}.csv`;
  const auditFile = stress100 ? "local_ok_audit_100.csv" : "local_ok_audit.csv";
  const reportJsonFile = stress100 ? "benchmark_report_100.json" : "benchmark_report.json";
  const resultsFile = stress100 ? "hybrid_results_100.json" : "hybrid_results.json";
  await Promise.all([
    writeCsvFile(path.join(runDir, reviewFile), csvRows, headers),
    writeCsvFile(path.join(runDir, auditFile), csvRows.filter((row) => row["Hybrid Status"] === "LOCAL_OK"), headers),
    writeJsonFile(path.join(runDir, reportJsonFile), report),
    writeJsonFile(path.join(runDir, resultsFile), { report, items: rows }),
    ...(stress100 ? [writeJsonFile(path.join(runDir, "benchmark_report.json"), report)] : []),
    fs.writeFile(path.join(runDir, "benchmark_report.txt"), [
      `GBFR LOCAL TRANSLATOR HYBRID v0.2.0-beta.2 — ${stress100 ? "STRESS 100" : "ADVERSARIAL 30"}`,
      decision,
      `QA kỹ thuật đạt tuyệt đối: ${gates.technical100 ? "CÓ" : "KHÔNG"}`,
      `Tự xử lý ngoài nhóm bắt buộc duyệt: ${autoProcessed.length}/${nonMandatory.length} (${(autoRate * 100).toFixed(1)}%)`,
      `Tương đồng Golden — Hybrid: ${(hybridAverage * 100).toFixed(2)}%`,
      `Tương đồng Golden — Qwen v0.1.5: ${(baselineAverage * 100).toFixed(2)}%`,
      `Hybrid thắng/thua rõ: ${wins}/${losses}`,
      "LOCAL_OK: bắt buộc gửi để kiểm toán ngữ nghĩa độc lập.",
    ].join("\r\n") + "\r\n", "utf8"),
    fs.writeFile(path.join(projectRoot, config.outputRoot, "last_run.txt"), runDir, "utf8"),
  ]);
  return { runDir, report };
}

function safeProductionName(value) {
  return String(value)
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 80) || "gbfr_translation";
}

async function loadJsonlCheckpoint(filePath, validUnits) {
  const result = new Map();
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const line of text.split(/\r?\n/gu).filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      const unit = validUnits.get(record.key);
      if (unit && record.sourceHash === unit.sourceHash) result.set(record.key, record);
    } catch {
      // Có thể bỏ qua dòng cuối nếu Windows tắt đúng lúc đang ghi checkpoint.
    }
  }
  return result;
}

async function appendJsonlCheckpoint(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function productionUnitSourceHash(row, mandatoryReview) {
  return crypto.createHash("sha256")
    .update([
      row.ID,
      row.File,
      row.Category,
      row.English,
      row.Japanese,
      mandatoryReview ? "1" : "0",
      contextFingerprint(row),
    ].join("\u001f"))
    .digest("hex");
}

export function productionGroupSignature(row, mandatoryReview) {
  return [
    row.Category,
    row.English,
    row.Japanese,
    mandatoryReview ? "1" : "0",
    contextFingerprint(row),
  ].join("\u001e");
}

function fixedProductionResult(row, overrides, glossary) {
  const contextBlocked = contextBlockedResult(row);
  if (contextBlocked) return contextBlocked;
  const override = overrides?.byId?.[row.ID];
  if (override?.vietnamese != null) {
    return {
      vietnamese: normalizeText(override.vietnamese),
      status: "APPROVED_OVERRIDE",
      source: "FIXED_OVERRIDE",
      qa: { errors: [], warnings: [] },
      note: override.note || "Áp dụng bản dịch đã khóa.",
    };
  }
  if (normalizeText(row.Vietnamese).trim()) {
    return {
      vietnamese: normalizeText(row.Vietnamese),
      status: "APPROVED_EXISTING",
      source: "SOURCE_APPROVED",
      qa: { errors: [], warnings: [] },
      note: "Giữ nguyên bản dịch đã có trong file nguồn.",
    };
  }
  if (!normalizeText(row.English).trim()) {
    return {
      vietnamese: normalizeText(row.Vietnamese),
      status: "SKIP_EMPTY",
      source: "EMPTY_SOURCE",
      qa: { errors: [], warnings: [] },
      note: "Bỏ qua dòng nguồn rỗng.",
    };
  }
  const keep = shouldKeepEnglish(row, glossary);
  if (keep.keep) {
    return {
      vietnamese: normalizeText(row.English),
      status: "KEEP_ENGLISH",
      source: keep.reason,
      qa: checkTranslation({ english: row.English, vietnamese: row.English, glossary, keepEnglish: true }),
      note: `Giữ English: ${keep.reason}.`,
    };
  }
  return null;
}

function criticFromCheckpoint(record) {
  const critic = record?.critic;
  if (!critic || typeof critic !== "object" || Array.isArray(critic)) return null;
  return critic;
}

function productionCsvResult(row, result) {
  const qaItems = [
    ...(result.qa?.errors || []),
    ...(result.qa?.warnings || []),
    ...(result.critic?.issue_codes || []),
  ];
  const output = {
    ...row,
    Vietnamese: result.vietnamese ?? row.Vietnamese ?? "",
    Notes: appendNote(row.Notes, result.note || "Hybrid beta.2 local."),
    "Local Status": result.status,
    "Local Source": result.source || "HYBRID_BETA2",
    "Local QA": [...new Set(qaItems)].join(" | "),
    "Local Updated At": result.updatedAt || new Date().toISOString(),
  };
  for (const [column, original] of Object.entries(row._sourceImmutable || {})) output[column] = original;
  delete output._sourceImmutable;
  delete output._contextResult;
  delete output._index;
  return output;
}

export async function runHybridProduction({ projectRoot, config, inputPath, onProgress = () => {}, limit = null }) {
  const startedAt = new Date().toISOString();
  const root = path.resolve(projectRoot);
  const resolvedInput = path.resolve(inputPath);
  const [inputBytes, glossary, overrides, contextDatabase] = await Promise.all([
    fs.readFile(resolvedInput),
    fs.readFile(path.join(root, config.glossaryFile), "utf8").then(JSON.parse),
    config.overridesFile
      ? fs.readFile(path.join(root, config.overridesFile), "utf8").then(JSON.parse)
      : Promise.resolve({ byId: {}, byKey: {} }),
    loadOptionalContextDatabase(root, config),
  ]);
  const input = csvToObjects(inputBytes.toString("utf8"));
  for (const required of ["File", "Row", "ID", "English", "Japanese", "Vietnamese"]) {
    if (!input.headers.includes(required)) throw new Error(`CSV thiếu cột bắt buộc: ${required}`);
  }
  const inputContract = assertInputContract(input.rows);
  const rows = input.rows.map((sourceRow, index) => attachTranslationContext({
    ...sourceRow,
    _index: index,
    _sourceImmutable: Object.fromEntries(
      ["File", "Row", "ID", "SubID", "English", "Japanese"].map((column) => [column, sourceRow[column] ?? ""]),
    ),
    English: normalizeText(sourceRow.English),
    Japanese: normalizeText(sourceRow.Japanese),
    Vietnamese: normalizeText(sourceRow.Vietnamese),
    Category: classifyRow(sourceRow),
  }, contextDatabase));
  const fixedByIndex = new Map();
  const grouped = new Map();
  for (const row of rows) {
    const fixed = fixedProductionResult(row, overrides, glossary);
    if (fixed) {
      fixedByIndex.set(row._index, fixed);
      continue;
    }
    const mandatoryReasons = semanticReviewReasons(row);
    const mandatoryReview = mandatoryReasons.length > 0;
    const signature = productionGroupSignature(row, mandatoryReview);
    let unit = grouped.get(signature);
    if (!unit) {
      unit = {
        ...row,
        members: [],
        mandatoryReview,
        mandatoryReviewReasons: mandatoryReasons,
      };
      grouped.set(signature, unit);
    }
    unit.members.push(row._index);
  }
  let units = [...grouped.values()];
  if (limit != null) units = units.slice(0, Math.max(0, Number(limit)));
  const includedMembers = new Set(units.flatMap((unit) => unit.members));
  for (const row of rows) {
    if (!fixedByIndex.has(row._index) && !includedMembers.has(row._index)) {
      fixedByIndex.set(row._index, {
        vietnamese: row.Vietnamese,
        status: "PENDING_LIMIT",
        source: "LIMITED_TEST",
        qa: { errors: [], warnings: [] },
        note: "Chưa xử lý vì lệnh thử có giới hạn.",
      });
    }
  }
  units = units.map((unit, index) => {
    const key = `p${String(index + 1).padStart(6, "0")}`;
    return { ...unit, key, sourceHash: productionUnitSourceHash(unit, unit.mandatoryReview) };
  });
  const unitsByKey = new Map(units.map((unit) => [unit.key, unit]));
  const runHash = crypto.createHash("sha256")
    .update(inputBytes)
    .update(config.pipelineVersion)
    .update(limit == null ? "FULL" : `LIMIT:${limit}`)
    .digest("hex");
  const stem = safeProductionName(path.basename(resolvedInput, path.extname(resolvedInput)));
  const runDir = path.join(root, config.outputRoot, `production-${stem}-${runHash.slice(0, 10)}`);
  await fs.mkdir(runDir, { recursive: true });
  const checkpointPaths = {
    gemma: path.join(runDir, "production_gemma.jsonl"),
    editor: path.join(runDir, "production_editor.jsonl"),
    critic: path.join(runDir, "production_critic.jsonl"),
    final: path.join(runDir, "production_final.jsonl"),
  };
  const [gemmaMap, editorMap, criticMap, finalMap] = await Promise.all([
    loadJsonlCheckpoint(checkpointPaths.gemma, unitsByKey),
    loadJsonlCheckpoint(checkpointPaths.editor, unitsByKey),
    loadJsonlCheckpoint(checkpointPaths.critic, unitsByKey),
    loadJsonlCheckpoint(checkpointPaths.final, unitsByKey),
  ]);
  const usagePath = path.join(runDir, "production_usage.json");
  let usage;
  try {
    usage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  } catch {
    usage = {
      translateGemma: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      qwen: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      qwenEditor: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      qwenCritic: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      qwenRepair: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  const saveUsage = () => writeJsonFile(usagePath, usage);
  onProgress({
    stage: "production-start",
    totalRows: rows.length,
    units: units.length,
    fixed: fixedByIndex.size,
    resumedFinal: finalMap.size,
    runDir,
  });

  const pendingFinal = units.filter((unit) => !finalMap.has(unit.key));
  let qwenLoaded = null;
  if (pendingFinal.length) {
    const models = await listRestModels(config);
    const gemma = selectModel(models, config.translateGemmaPreference, "TranslateGemma 12B");
    const qwen = selectModel(models, config.qwenPreference, "Qwen3.5 9B");
    const pendingGemma = units.filter((unit) => !gemmaMap.has(unit.key));
    if (pendingGemma.length) {
      const gemmaInstance = loadedInstances(gemma)[0] || null;
      if (!gemmaInstance) throw new Error("TranslateGemma chưa READY. Hãy load Q5_K_M, context 2048 và giữ Chat Template hiện tại.");
      if (gemmaInstance.config?.context_length !== config.translateGemmaContextLength) {
        throw new Error(`TranslateGemma đang dùng context ${gemmaInstance.config?.context_length || "không xác định"}; cần đúng ${config.translateGemmaContextLength}.`);
      }
      for (const model of models) {
        for (const instance of loadedInstances(model)) {
          if (instance.id !== gemmaInstance.id) await unloadInstance(config, instance.id);
        }
      }
      onProgress({ stage: "production-gemma-start", total: pendingGemma.length, reused: gemmaMap.size });
      for (let index = 0; index < pendingGemma.length; index += 1) {
        const unit = pendingGemma[index];
        const response = await translateWithGemma({ row: unit, config, model: gemmaInstance.id, glossary });
        usageAdd(usage.translateGemma, response.usage);
        const record = { key: unit.key, sourceHash: unit.sourceHash, vietnamese: response.vietnamese };
        gemmaMap.set(unit.key, record);
        await appendJsonlCheckpoint(checkpointPaths.gemma, record);
        await saveUsage();
        onProgress({ stage: "production-gemma-item", current: index + 1, total: pendingGemma.length, id: unit.ID });
      }
      onProgress({ stage: "production-switch-start" });
      await unloadInstance(config, gemmaInstance.id);
      qwenLoaded = await loadModel(config, qwen.key, config.qwenContextLength);
    } else {
      const qwenCandidate = loadedInstances(qwen)[0] || null;
      const readyQwen = qwenCandidate?.config?.context_length === config.qwenContextLength ? qwenCandidate : null;
      for (const model of models) {
        for (const instance of loadedInstances(model)) {
          if (instance.id !== readyQwen?.id) await unloadInstance(config, instance.id);
        }
      }
      qwenLoaded = readyQwen
        ? { instance_id: readyQwen.id, load_config: readyQwen.config || null }
        : await loadModel(config, qwen.key, config.qwenContextLength);
    }
    onProgress({ stage: "production-switch-done", model: qwenLoaded.instance_id });

    const pendingEditor = units.filter((unit) => !editorMap.has(unit.key));
    onProgress({ stage: "production-editor-start", total: pendingEditor.length, reused: editorMap.size });
    for (let index = 0; index < pendingEditor.length; index += 1) {
      const unit = pendingEditor[index];
      const item = { ...unit, TranslateGemma: gemmaMap.get(unit.key).vietnamese, QwenV015: "" };
      const response = await runQwenStage({ items: [item], config, glossary, model: qwenLoaded.instance_id, stage: "editor" });
      usageAdd(usage.qwen, response.usage);
      usageAdd(usage.qwenEditor, response.usage);
      const candidate = response.output.get(unit.key);
      const record = {
        key: unit.key,
        sourceHash: unit.sourceHash,
        vietnamese: candidate.vietnamese,
        protocolFallback: Boolean(candidate.protocolFallback),
        protocolIssue: candidate.protocolIssue || "",
      };
      editorMap.set(unit.key, record);
      await appendJsonlCheckpoint(checkpointPaths.editor, record);
      await saveUsage();
      onProgress({ stage: "production-editor-item", current: index + 1, total: pendingEditor.length, id: unit.ID });
    }

    const pendingCritic = units.filter((unit) => !criticMap.has(unit.key));
    onProgress({ stage: "production-critic-start", total: pendingCritic.length, reused: criticMap.size });
    for (let index = 0; index < pendingCritic.length; index += 1) {
      const unit = pendingCritic[index];
      const editor = editorMap.get(unit.key);
      const qa = checkTranslation({ english: unit.English, vietnamese: editor.vietnamese, glossary });
      const item = {
        ...unit,
        TranslateGemma: gemmaMap.get(unit.key).vietnamese,
        EditorDraft: editor.vietnamese,
        Hybrid: editor.vietnamese,
        auditVietnamese: editor.vietnamese,
        qaIssues: [...blockingTechnicalQa(qa), ...semanticQaIssues(qa)],
      };
      const response = await runQwenStage({ items: [item], config, glossary, model: qwenLoaded.instance_id, stage: "critic" });
      usageAdd(usage.qwen, response.usage);
      usageAdd(usage.qwenCritic, response.usage);
      const record = { key: unit.key, sourceHash: unit.sourceHash, critic: response.output.get(unit.key) };
      criticMap.set(unit.key, record);
      await appendJsonlCheckpoint(checkpointPaths.critic, record);
      await saveUsage();
      onProgress({ stage: "production-critic-item", current: index + 1, total: pendingCritic.length, id: unit.ID });
    }

    const pendingResolve = units.filter((unit) => !finalMap.has(unit.key));
    onProgress({ stage: "production-resolve-start", total: pendingResolve.length, reused: finalMap.size });
    for (let index = 0; index < pendingResolve.length; index += 1) {
      const unit = pendingResolve[index];
      const editor = editorMap.get(unit.key);
      const gemmaCandidate = gemmaMap.get(unit.key).vietnamese;
      const critic = criticFromCheckpoint(criticMap.get(unit.key));
      const workingRow = {
        ...unit,
        TranslateGemma: gemmaCandidate,
        QwenV015: "",
        EditorDraft: editor.vietnamese,
        Hybrid: editor.vietnamese,
      };
      const editorOrigin = editor.protocolFallback ? "EDITOR_PROTOCOL_FALLBACK" : "EDITOR_DRAFT";
      let state = candidateState({ row: workingRow, vietnamese: editor.vietnamese, glossary, critic, origin: editorOrigin });
      state.score = state.blockers.length * 1000 + state.semanticIssues.length * 100 + state.criticIssues.length * 10 + state.qa.warnings.length;
      let repairAttempts = 0;
      if (state.blockers.length || state.semanticIssues.length || state.criticIssues.length) {
        const maxAttempts = Math.max(1, config.maxRepairAttempts || 1);
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const repairItem = {
            ...workingRow,
            previousVietnamese: state.vietnamese,
            qaIssues: [...state.blockers, ...state.semanticIssues, ...(unit.mandatoryReview ? [] : state.criticIssues)],
          };
          const repair = await runQwenStage({ items: [repairItem], config, glossary, model: qwenLoaded.instance_id, stage: "repair" });
          usageAdd(usage.qwen, repair.usage);
          usageAdd(usage.qwenRepair, repair.usage);
          repairAttempts = attempt;
          const repaired = repair.output.get(unit.key);
          let repairedState = candidateState({ row: workingRow, vietnamese: repaired.vietnamese, glossary, origin: repaired.protocolFallback ? `REPAIR_PROTOCOL_FALLBACK_${attempt}` : `REPAIR_${attempt}` });
          if (!repairedState.blockers.length) {
            const auditItem = {
              ...workingRow,
              auditVietnamese: repairedState.vietnamese,
              qaIssues: [...repairedState.semanticIssues],
            };
            const recheck = await runQwenStage({ items: [auditItem], config, glossary, model: qwenLoaded.instance_id, stage: "critic" });
            usageAdd(usage.qwen, recheck.usage);
            usageAdd(usage.qwenCritic, recheck.usage);
            repairedState = candidateState({
              row: workingRow,
              vietnamese: repairedState.vietnamese,
              glossary,
              critic: recheck.output.get(unit.key),
              origin: `REPAIR_${attempt}`,
            });
          }
          if (repairedState.score < state.score) state = repairedState;
          if (!state.blockers.length && !state.semanticIssues.length && (unit.mandatoryReview || !state.criticIssues.length)) break;
        }
      }
      let fallbackUsed = "";
      let fallbackReview = false;
      if (state.blockers.length) {
        const fallback = firstTechnicallySafeFallback(workingRow, glossary);
        if (fallback) {
          state = fallback;
          fallbackUsed = fallback.origin;
          fallbackReview = true;
        }
      }
      const finalCritic = fallbackUsed
        ? { meaning: "UNCERTAIN", naturalness: "FAIL", verdict: "REVIEW", issue_codes: [`FALLBACK_${fallbackUsed}`], issue_notes: "Dùng phương án dự phòng sạch kỹ thuật; bắt buộc kiểm tra thủ công." }
        : state.critic || critic;
      const protocolFallbackReview = /PROTOCOL_FALLBACK/u.test(state.origin) || Boolean(finalCritic?.protocolFallback);
      let status;
      if (state.blockers.length) status = "TECHNICAL_ERROR";
      else if (unit.mandatoryReview) status = "REVIEW_MANDATORY";
      else if (fallbackReview || protocolFallbackReview || finalCritic?.verdict !== "SAFE" || finalCritic?.meaning !== "PASS" || finalCritic?.naturalness !== "PASS" || state.qa.warnings.length) status = "REVIEW";
      else status = "LOCAL_OK";
      const record = {
        key: unit.key,
        sourceHash: unit.sourceHash,
        vietnamese: state.vietnamese,
        status,
        source: fallbackUsed || state.origin || "HYBRID_BETA2",
        qa: state.qa,
        critic: finalCritic,
        repairAttempts,
        fallbackUsed,
        mandatoryReviewReasons: unit.mandatoryReviewReasons,
        note: status === "LOCAL_OK" ? "Hybrid beta.2 + hậu kiểm xác định đạt." : "Hybrid beta.2; cần kiểm tra trong review_queue.csv.",
        updatedAt: new Date().toISOString(),
      };
      finalMap.set(unit.key, record);
      await appendJsonlCheckpoint(checkpointPaths.final, record);
      await saveUsage();
      onProgress({ stage: "production-resolve-item", current: index + 1, total: pendingResolve.length, id: unit.ID, status });
    }
  }

  const resultByIndex = new Map(fixedByIndex);
  for (const unit of units) {
    const final = finalMap.get(unit.key);
    if (!final) continue;
    for (const memberIndex of unit.members) resultByIndex.set(memberIndex, final);
  }
  const outputRows = rows.map((row) => productionCsvResult(row, resultByIndex.get(row._index)));
  const headers = [...input.headers];
  for (const header of ["Context Status", "Context Line Key", "Local Status", "Local Source", "Local QA", "Local Updated At"]) {
    if (!headers.includes(header)) headers.push(header);
  }
  const datasetContract = assertImmutableDataset(input.rows, outputRows);
  const statusCounts = {};
  for (const row of outputRows) statusCounts[row["Local Status"]] = (statusCounts[row["Local Status"]] || 0) + 1;
  const generated = outputRows.filter((row) => ["LOCAL_OK", "REVIEW", "REVIEW_MANDATORY", "TECHNICAL_ERROR"].includes(row["Local Status"]));
  const report = {
    decision: generated.some((row) => row["Local Status"] === "TECHNICAL_ERROR")
      ? "HOÀN TẤT CÓ LỖI KỸ THUẬT — CHƯA ĐÓNG GÓI MSG"
      : "HOÀN TẤT BẢN DỊCH LÀM VIỆC — DUYỆT REVIEW TRƯỚC KHI ĐÓNG GÓI MSG",
    pipelineVersion: config.pipelineVersion,
    inputPath: resolvedInput,
    inputHash: runHash,
    inputContract,
    datasetContract,
    contextLayer: {
      enabled: Boolean(contextDatabase),
      mappedRows: outputRows.filter((row) => String(row["Context Status"] || "").startsWith("MAPPED_")).length,
      aiEligibleRows: outputRows.filter((row) => row["Context Status"] === "MAPPED_AI_ELIGIBLE").length,
      blockedRows: outputRows.filter((row) => String(row["Context Status"] || "").startsWith("MAPPED_BLOCKED_")).length,
      notMappedRows: outputRows.filter((row) => row["Context Status"] === "NOT_MAPPED").length,
    },
    totalRows: rows.length,
    uniqueTranslationUnits: units.length,
    statusCounts,
    generatedRows: generated.length,
    localOkRows: generated.filter((row) => row["Local Status"] === "LOCAL_OK").length,
    reviewRows: generated.filter((row) => ["REVIEW", "REVIEW_MANDATORY"].includes(row["Local Status"])).length,
    technicalErrorRows: generated.filter((row) => row["Local Status"] === "TECHNICAL_ERROR").length,
    usage,
    startedAt,
    finishedAt: new Date().toISOString(),
    runDir,
  };
  const reviewRows = outputRows.filter((row) => ["REVIEW", "REVIEW_MANDATORY", "TECHNICAL_ERROR"].includes(row["Local Status"]));
  const localOkRows = outputRows.filter((row) => row["Local Status"] === "LOCAL_OK");
  await Promise.all([
    writeCsvFile(path.join(runDir, "translated_working.csv"), outputRows, headers),
    writeCsvFile(path.join(runDir, "review_queue.csv"), reviewRows, headers),
    writeCsvFile(path.join(runDir, "local_ok_audit.csv"), localOkRows, headers),
    writeJsonFile(path.join(runDir, "production_report.json"), report),
    writeJsonFile(path.join(runDir, "production_results.json"), { report, items: outputRows }),
    fs.writeFile(path.join(root, config.outputRoot, "last_production_run.txt"), runDir, "utf8"),
  ]);
  onProgress({ stage: "production-done", report, runDir });
  return { runDir, report };
}

export { loadedInstances, unloadInstance, loadModel, runQwenStage };
