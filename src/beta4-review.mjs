import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { csvToObjects, objectsToCsv } from "./csv.mjs";
import {
  applyKnownSurfaceRules,
  fitLineStructure,
  listRestModels,
  loadModel,
  loadedInstances,
  runQwenStage,
  selectModel,
  unloadInstance,
} from "./hybrid.mjs";
import { checkTranslation, technicalTokens } from "./qa.mjs";
import {
  appendNote,
  classifyRow,
  normalizeText,
  relevantGlossary,
  shouldKeepEnglish,
} from "./rules.mjs";

const REVIEW_STATUSES = new Set(["REVIEW", "REVIEW_MANDATORY"]);
const ACCEPTED_STATUSES = new Set(["LOCAL_OK", "APPROVED_EXISTING", "KEEP_ENGLISH"]);
const GENERIC_DYNAMIC_TERMS = new Set(["cat"]);

const BUILD_TERMS = [
  "Stackable DEF↓", "Stun Resistance↓", "Critical Hit Rate", "Summons Gauge",
  "Skybound Arts", "Primal Burst", "Full Burst", "Link Attack", "Link Chance",
  "Link Level", "Link Time", "Equip Bonus", "Master Trait", "Summon Cost",
  "Invincibility", "Paralysis", "Glaciate", "Dispel", "Poison", "Burn",
  "Slow", "Stun", "AoE", "SBA", "MSP", "DMG Cap", "DMG", "ATK", "DEF",
  "HP", "CP", "RP",
];

function normalizedPhrase(value) {
  return normalizeText(value).replace(/\s+/gu, " ").trim();
}

function folded(value) {
  return normalizedPhrase(value).toLocaleLowerCase("en-US");
}

function safeStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "beta4";
}

function usageBucket() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function addUsage(target, usage) {
  if (!usage) return;
  target.promptTokens += usage.prompt_tokens || 0;
  target.completionTokens += usage.completion_tokens || 0;
  target.totalTokens += usage.total_tokens || 0;
}

function dynamicTerms(rows) {
  const terms = new Set(BUILD_TERMS);
  for (const row of rows) {
    if (row["Local Source"] !== "BETA3_PROTECTED_NAME_ID" && row["Local Status"] !== "KEEP_ENGLISH") continue;
    const phrase = normalizedPhrase(row.English)
      .replace(/\s+(?:I|II|III|IV|V|VI|VII|VIII|IX|X)\+?$/u, "")
      .trim();
    if (phrase.length < 2 || GENERIC_DYNAMIC_TERMS.has(phrase.toLowerCase())) continue;
    terms.add(phrase);
  }
  return [...terms];
}

export function mergedBeta4Glossary(base, rows) {
  const translateAs = { ...(base.translateAs || {}) };
  const translated = new Map(
    Object.entries(translateAs).map(([source, target]) => [folded(source), folded(target)]),
  );
  const candidates = [...new Set([...(base.keepExact || []), ...dynamicTerms(rows)])];
  const conflictsRemoved = [];
  const keepExact = candidates.filter((term) => {
    const target = translated.get(folded(term));
    if (target && target !== folded(term)) {
      conflictsRemoved.push(term);
      return false;
    }
    return true;
  }).sort((left, right) => right.length - left.length || left.localeCompare(right));
  return { keepExact, translateAs, conflictsRemoved };
}

function inconsistentSources(rows) {
  const variants = new Map();
  for (const row of rows) {
    const source = normalizedPhrase(row.English);
    if (!source) continue;
    if (!variants.has(source)) variants.set(source, new Set());
    variants.get(source).add(normalizedPhrase(row.Vietnamese));
  }
  return new Set([...variants].filter(([, values]) => values.size > 1).map(([source]) => source));
}

export function beta4RiskReasons(row, inconsistent = new Set()) {
  const reasons = [];
  const file = String(row.File || "").toLowerCase();
  const english = normalizeText(row.English);
  const vietnamese = normalizeText(row.Vietnamese);
  if (REVIEW_STATUSES.has(row["Local Status"])) reasons.push("BETA3_REVIEW_QUEUE");
  if (inconsistent.has(normalizedPhrase(english))) reasons.push("INCONSISTENT_DUPLICATE_SOURCE");
  if (["text_story.msg", "text_fate_episode.msg", "text_dialog.msg", "text_note.msg"].includes(file)) {
    reasons.push("NARRATIVE_OR_LORE_REAUDIT");
  }
  if (file === "text_tips.msg") reasons.push("GAMEPLAY_TIP_REAUDIT");
  if (/\b(?:skyfarers?|stomp\s+attack|renew(?:al|als|ed|ing)?|summons?|wedges?|ragnalian|Primeval Acolytes)\b/iu.test(english)) {
    reasons.push("KNOWN_TERM_OR_MEANING_RISK");
  }
  if (english.length >= 220 && row["Local Source"] === "BETA3_QWEN_REVIEW") reasons.push("LONG_QWEN_LOCAL_OK_REAUDIT");
  if (/phi\s+hành\s+gia|GBFR(?:KEEP|GAP|TRANSLATION)|Chỉ đặt bản dịch|không JSON|không Markdown/iu.test(vietnamese)) {
    reasons.push("KNOWN_BAD_SURFACE");
  }
  return [...new Set(reasons)];
}

export function requiresManualReview(row) {
  if (row["Local Status"] === "REVIEW_MANDATORY") return true;
  const file = String(row.File || "").toLowerCase();
  const english = normalizeText(row.English);
  const id = String(row.ID || "").toUpperCase();
  if (file === "text_story.msg" || file === "text_fate_episode.msg") return true;
  if (file === "text_dialog.msg" && english.length >= 120) return true;
  if (file === "text_note.msg" && english.length >= 180) return true;
  if (/^TXT_WEP_EXPLAIN_/u.test(id) && english.length >= 180) return true;
  if (file === "text_tips.msg" && english.length >= 220) return true;
  return false;
}

function termPattern(term) {
  const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
}

function exactPattern(value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "gu");
}

function numericMatches(text) {
  return [...String(text).matchAll(/(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:%|x)?(?![\p{L}\p{N}_])/gu)];
}

export function beta4PlaceholderContract(source, current, glossary) {
  const sourceText = String(source);
  const candidates = [];
  for (const token of technicalTokens(sourceText)) {
    for (const match of sourceText.matchAll(exactPattern(token))) {
      candidates.push({ start: match.index, end: match.index + match[0].length, canonical: match[0], priority: 3 });
    }
  }
  for (const term of relevantGlossary([sourceText], glossary).keepExact) {
    for (const match of sourceText.matchAll(termPattern(term))) {
      candidates.push({ start: match.index, end: match.index + match[0].length, canonical: term, priority: 2 });
    }
  }
  for (const match of numericMatches(sourceText)) {
    candidates.push({ start: match.index, end: match.index + match[0].length, canonical: match[0], priority: 1 });
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end || right.priority - left.priority);
  const spans = [];
  for (const candidate of candidates) {
    if (spans.some((span) => candidate.start < span.end && candidate.end > span.start)) continue;
    spans.push(candidate);
  }
  spans.sort((left, right) => left.start - right.start);
  const entries = spans.map((span, index) => ({
    ...span,
    marker: `GBFRKEEP${String(index).padStart(4, "0")}ZXQ`,
    value: span.canonical,
  }));
  let promptEnglish = "";
  let cursor = 0;
  for (const entry of entries) {
    promptEnglish += sourceText.slice(cursor, entry.start) + entry.marker;
    cursor = entry.end;
  }
  promptEnglish += sourceText.slice(cursor);

  let promptCurrent = String(current || "");
  for (const entry of entries) {
    const pattern = termPattern(entry.value);
    let replaced = false;
    promptCurrent = promptCurrent.replace(pattern, (match) => {
      if (replaced) return match;
      replaced = true;
      return entry.marker;
    });
  }
  return {
    promptEnglish,
    promptCurrent,
    entries: entries.map(({ marker, value }) => ({ marker, value })),
  };
}

function candidateRisk(row) {
  const english = normalizedPhrase(row.English);
  const vietnamese = normalizedPhrase(row.Vietnamese);
  const qa = String(row["Local QA"] || "");
  let score = 0;
  if (!vietnamese || vietnamese === english) score += 10000;
  if (/GBFR(?:KEEP|GAP|TRANSLATION)|Chỉ đặt bản dịch/iu.test(vietnamese)) score += 9000;
  if (/TECHNICAL_TOKEN_MISMATCH|NUMBER_MISMATCH|PROTECTED_TERM_MISSING/iu.test(qa)) score += 2000;
  score += qa.split("|").filter((item) => item.trim()).length * 10;
  return score;
}

function groupTargetRows(rows) {
  const grouped = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.__beta4Target) continue;
    const category = classifyRow(row);
    const signature = [category, normalizedPhrase(row.English), normalizedPhrase(row.Japanese)].join("\u001e");
    if (!grouped.has(signature)) grouped.set(signature, { category, members: [], candidates: [] });
    const group = grouped.get(signature);
    group.members.push(index);
    group.candidates.push(row);
  }
  return [...grouped.values()].map((group, index) => {
    const representative = [...group.candidates].sort((left, right) => candidateRisk(left) - candidateRisk(right))[0];
    const key = `b4${String(index + 1).padStart(5, "0")}`;
    const sourceHash = crypto.createHash("sha256")
      .update([representative.ID, representative.English, representative.Japanese, representative.Vietnamese, group.category].join("\u001f"))
      .digest("hex");
    return {
      ...representative,
      key,
      sourceHash,
      Category: group.category,
      members: group.members,
      currentVietnamese: representative.Vietnamese,
      riskReasons: [...new Set(group.candidates.flatMap((row) => row.__beta4Reasons || []))],
    };
  });
}

async function appendJsonl(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function loadCheckpoint(filePath, unitsByKey) {
  const result = new Map();
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return result;
  }
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const unit = unitsByKey.get(record.key);
      if (unit && record.sourceHash === unit.sourceHash) result.set(record.key, record);
    } catch {
      // Bỏ qua riêng dòng checkpoint chưa ghi xong.
    }
  }
  return result;
}

async function writeCsv(filePath, rows, headers) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, objectsToCsv(rows, headers), "utf8");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readyQwen(config) {
  const models = await listRestModels(config);
  const qwen = selectModel(models, config.qwenPreference, "Qwen3.5 9B");
  const ready = loadedInstances(qwen).find((instance) => instance.config?.context_length === config.qwenContextLength) || null;
  for (const model of models) {
    for (const instance of loadedInstances(model)) {
      if (instance.id !== ready?.id) await unloadInstance(config, instance.id);
    }
  }
  if (ready) return ready.id;
  const loaded = await loadModel(config, qwen.key, config.qwenContextLength);
  return loaded.instance_id;
}

function qaItems(qa, protocolIssue = "") {
  return [...new Set([...(qa.errors || []), ...(qa.warnings || []), ...(protocolIssue ? [protocolIssue] : [])])];
}

function cleanQa(qa, protocolFallback) {
  return !protocolFallback && !(qa.errors || []).length && !(qa.warnings || []).length;
}

function refitForMember(row, vietnamese, glossary) {
  const protectedTerms = relevantGlossary([row.English], glossary).keepExact;
  const fitted = fitLineStructure(row.English, String(vietnamese).split("\n"), protectedTerms).join("\n");
  return applyKnownSurfaceRules(row.English, fitted);
}

function applyExactKeep(rows, glossary) {
  let changed = 0;
  for (const row of rows) {
    if (row["Local Status"] === "APPROVED_EXISTING" || row["Local Status"] === "SKIP_EMPTY") continue;
    const decision = shouldKeepEnglish(row, glossary);
    if (!decision.keep || !normalizeText(row.English).trim()) continue;
    if (decision.reason === "PROTECTED_TERM") {
      if (row["Local Status"] === "KEEP_ENGLISH" && normalizeText(row.Vietnamese) === normalizeText(row.English)) continue;
      row.Vietnamese = row.English;
      row["Local Status"] = "KEEP_ENGLISH";
      row["Local Source"] = "BETA4_EXACT_PROTECTED_TERM";
      row["Local QA"] = "";
      row.Notes = appendNote(row.Notes, "Beta.4 giữ English nhất quán cho tên/thuật ngữ bảo vệ.");
      changed += 1;
    }
  }
  return changed;
}

export async function runBeta4Review({ projectRoot, config, inputPath, onProgress = () => {} }) {
  const startedAt = new Date().toISOString();
  const root = path.resolve(projectRoot);
  const resolvedInput = path.resolve(inputPath);
  const [bytes, baseGlossary] = await Promise.all([
    fs.readFile(resolvedInput),
    fs.readFile(path.join(root, config.glossaryFile), "utf8").then(JSON.parse),
  ]);
  const parsed = csvToObjects(bytes.toString("utf8"));
  const rows = parsed.rows.map((row) => ({ ...row }));
  const glossary = mergedBeta4Glossary(baseGlossary, rows);
  const exactKeepsApplied = applyExactKeep(rows, glossary);
  const inconsistent = inconsistentSources(rows);

  let targetedRows = 0;
  for (const row of rows) {
    if (row["Local Status"] === "APPROVED_EXISTING" || row["Local Status"] === "KEEP_ENGLISH" || row["Local Status"] === "SKIP_EMPTY") continue;
    const reasons = beta4RiskReasons(row, inconsistent);
    if (!reasons.length) continue;
    row.__beta4Target = true;
    row.__beta4Reasons = reasons;
    targetedRows += 1;
  }
  const units = groupTargetRows(rows);
  const unitsByKey = new Map(units.map((unit) => [unit.key, unit]));
  const runHash = crypto.createHash("sha256")
    .update(bytes)
    .update(config.pipelineVersion)
    .update(JSON.stringify(glossary.keepExact))
    .digest("hex");
  const runDir = path.join(root, config.outputRoot, `beta4-final-repair-${safeStem(path.basename(resolvedInput, path.extname(resolvedInput)))}-${runHash.slice(0, 10)}`);
  const checkpointPath = path.join(runDir, "beta4_repair.jsonl");
  const checkpoint = await loadCheckpoint(checkpointPath, unitsByKey);
  const usagePath = path.join(runDir, "beta4_usage.json");
  let usage;
  try {
    usage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  } catch {
    usage = { qwenRepair: usageBucket() };
  }
  onProgress({
    stage: "beta4-start", rows: rows.length, targetedRows, units: units.length,
    reused: checkpoint.size, exactKeepsApplied, runDir,
  });

  const model = await readyQwen(config);
  onProgress({ stage: "beta4-model", model });

  const pending = units.filter((unit) => !checkpoint.has(unit.key));
  for (let index = 0; index < pending.length; index += 1) {
    const unit = pending[index];
    let previous = unit.currentVietnamese;
    let finalCandidate = null;
    let finalQa = null;
    let protocolFallback = false;
    let protocolIssue = "";
    const maxRepairs = Math.max(0, Number(config.beta4MaxRepairAttempts ?? 1));
    for (let repairAttempt = 0; repairAttempt <= maxRepairs; repairAttempt += 1) {
      const contract = beta4PlaceholderContract(unit.English, previous, glossary);
      const currentQa = checkTranslation({ english: unit.English, vietnamese: previous, glossary });
      const item = {
        ...unit,
        PromptEnglish: contract.promptEnglish,
        PromptCurrent: contract.promptCurrent,
        Beta4Placeholders: contract.entries,
        previousVietnamese: previous,
        Hybrid: previous,
        TranslateGemma: previous,
        qaIssues: repairAttempt
          ? qaItems(currentQa, protocolIssue)
          : [...new Set([...(unit.riskReasons || []), ...qaItems(currentQa)])],
      };
      const response = await runQwenStage({ items: [item], config, glossary, model, stage: "beta4-repair" });
      addUsage(usage.qwenRepair, response.usage);
      const candidate = response.output.get(unit.key);
      finalCandidate = candidate.vietnamese;
      protocolFallback = Boolean(candidate.protocolFallback);
      protocolIssue = candidate.protocolIssue || "";
      finalQa = checkTranslation({ english: unit.English, vietnamese: finalCandidate, glossary });
      previous = finalCandidate;
      if (cleanQa(finalQa, protocolFallback)) break;
    }
    const record = {
      key: unit.key,
      sourceHash: unit.sourceHash,
      vietnamese: finalCandidate,
      protocolFallback,
      protocolIssue,
      qa: qaItems(finalQa, protocolIssue),
    };
    checkpoint.set(unit.key, record);
    await appendJsonl(checkpointPath, record);
    await writeJson(usagePath, usage);
    onProgress({ stage: "beta4-repair", current: index + 1, total: pending.length, id: unit.ID, clean: cleanQa(finalQa, protocolFallback) });
  }

  for (const unit of units) {
    const record = checkpoint.get(unit.key);
    for (const member of unit.members) {
      const row = rows[member];
      const vietnamese = refitForMember(row, record.vietnamese, glossary);
      const qa = checkTranslation({ english: row.English, vietnamese, glossary });
      const clean = cleanQa(qa, record.protocolFallback);
      const mandatory = requiresManualReview(row);
      row.Vietnamese = vietnamese;
      row["Local Status"] = mandatory ? "REVIEW_MANDATORY" : clean ? "LOCAL_OK" : "REVIEW";
      row["Local Source"] = record.protocolFallback ? "BETA4_PROTOCOL_FALLBACK" : "BETA4_QWEN_FINAL_REPAIR";
      row["Local QA"] = qaItems(qa, record.protocolIssue).join(" | ");
      row["Local Updated At"] = new Date().toISOString();
      row.Notes = appendNote(
        row.Notes,
        mandatory
          ? "Beta.4 đã sửa bằng Qwen; văn bản cốt truyện/lore vẫn giữ để QA thủ công cuối."
          : clean
            ? "Beta.4 final repair đạt toàn bộ QA xác định."
            : "Beta.4 đã sửa nhưng còn lỗi xác định; giữ trong review_queue_beta4.csv.",
      );
    }
  }

  for (const row of rows) {
    delete row.__beta4Target;
    delete row.__beta4Reasons;
  }
  const statusCounts = {};
  for (const row of rows) statusCounts[row["Local Status"]] = (statusCounts[row["Local Status"]] || 0) + 1;
  const reviewRows = rows.filter((row) => REVIEW_STATUSES.has(row["Local Status"]));
  const acceptedRows = rows.filter((row) => ACCEPTED_STATUSES.has(row["Local Status"]));
  const deterministicErrorRows = reviewRows.filter((row) => String(row["Local QA"] || "").trim()).length;
  const report = {
    decision: deterministicErrorRows
      ? "BETA.4 HOÀN TẤT — QA THỦ CÔNG HÀNG REVIEW TRƯỚC KHI ĐÓNG GÓI MSG"
      : "BETA.4 HOÀN TẤT — CHỈ CÒN QA NGỮ NGHĨA BẮT BUỘC TRƯỚC KHI ĐÓNG GÓI MSG",
    pipelineVersion: config.pipelineVersion,
    totalRows: rows.length,
    targetedRows,
    reviewedUnits: units.length,
    exactKeepsApplied,
    glossaryConflictsRemoved: glossary.conflictsRemoved,
    statusCounts,
    reviewRows: reviewRows.length,
    acceptedRows: acceptedRows.length,
    deterministicErrorRows,
    technicalErrorRows: 0,
    protectedTerms: glossary.keepExact.length,
    usage,
    startedAt,
    finishedAt: new Date().toISOString(),
    runDir,
  };
  await Promise.all([
    writeCsv(path.join(runDir, "translated_working_beta4.csv"), rows, parsed.headers),
    writeCsv(path.join(runDir, "review_queue_beta4.csv"), reviewRows, parsed.headers),
    writeCsv(path.join(runDir, "local_ok_audit_beta4.csv"), acceptedRows, parsed.headers),
    writeJson(path.join(runDir, "beta4_review_report.json"), report),
    fs.mkdir(path.join(root, config.outputRoot), { recursive: true })
      .then(() => fs.writeFile(path.join(root, config.outputRoot, "last_beta4_review_run.txt"), runDir, "utf8")),
  ]);
  onProgress({ stage: "beta4-done", report, runDir });
  return { report, runDir };
}
