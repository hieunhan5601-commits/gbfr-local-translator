import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { csvToObjects, objectsToCsv } from "./csv.mjs";
import {
  listRestModels,
  loadModel,
  loadedInstances,
  runQwenStage,
  selectModel,
  unloadInstance,
} from "./hybrid.mjs";
import { checkTranslation } from "./qa.mjs";
import { appendNote, classifyRow, normalizeText } from "./rules.mjs";

const TARGET_STATUSES = new Set(["REVIEW", "REVIEW_MANDATORY"]);
const ACCEPTED_STATUSES = new Set(["LOCAL_OK", "APPROVED_EXISTING", "KEEP_ENGLISH"]);
const GENERIC_DYNAMIC_TERMS = new Set(["cat"]);

const BUILD_TERMS = [
  "Stackable DEF↓",
  "Stun Resistance↓",
  "Critical Hit Rate",
  "Summons Gauge",
  "Skybound Arts",
  "Primal Burst",
  "Full Burst",
  "Link Attack",
  "Link Chance",
  "Link Level",
  "Link Time",
  "Equip Bonus",
  "Master Trait",
  "Summon Cost",
  "Invincibility",
  "Paralysis",
  "Glaciate",
  "Dispel",
  "Poison",
  "Burn",
  "Slow",
  "Stun",
  "AoE",
  "SBA",
  "MSP",
  "DMG Cap",
  "DMG",
  "ATK",
  "DEF",
  "HP",
  "CP",
  "RP",
];

function normalizedPhrase(value) {
  return normalizeText(value).replace(/\s+/gu, " ").trim();
}

function safeStem(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "beta3";
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
    if (row["Local Source"] !== "BETA3_PROTECTED_NAME_ID") continue;
    const phrase = normalizedPhrase(row.English)
      .replace(/\s+(?:I|II|III|IV|V|VI|VII|VIII|IX|X)\+?$/u, "")
      .trim();
    if (phrase.length < 3 || GENERIC_DYNAMIC_TERMS.has(phrase.toLowerCase())) continue;
    terms.add(phrase);
  }
  return [...terms].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function mergedGlossary(base, rows) {
  return {
    keepExact: [...new Set([...(base.keepExact || []), ...dynamicTerms(rows)])],
    translateAs: { ...(base.translateAs || {}) },
  };
}

function candidateRisk(row) {
  const english = normalizeText(row.English).trim();
  const vietnamese = normalizeText(row.Vietnamese).trim();
  const qa = String(row["Local QA"] || "");
  let score = 0;
  if (!vietnamese || vietnamese === english) score += 10000;
  if (/FALLBACK_SOURCE_ENGLISH|UNCHANGED_ENGLISH|POSSIBLE_ENGLISH_LEAK/iu.test(qa)) score += 2000;
  if (/MODEL_EXPLANATION|TRUNCATED_OR_ENGLISH_FRAGMENT/iu.test(qa)) score += 1500;
  if (/SOURCE_ENGLISH/iu.test(String(row["Local Source"]))) score += 1000;
  score += qa.split("|").filter((item) => item.trim()).length * 10;
  if (english.length >= 12) {
    const ratio = vietnamese.length / Math.max(english.length, 1);
    if (ratio < 0.3 || ratio > 2.5) score += 500;
  }
  return score;
}

function groupRows(rows) {
  const grouped = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!TARGET_STATUSES.has(row["Local Status"])) continue;
    const category = classifyRow(row);
    const mandatory = row["Local Status"] === "REVIEW_MANDATORY";
    const signature = [category, row.English, row.Japanese, mandatory ? "1" : "0"].join("\u001e");
    let group = grouped.get(signature);
    if (!group) {
      group = { category, mandatory, members: [], candidates: [] };
      grouped.set(signature, group);
    }
    group.members.push(index);
    group.candidates.push(row);
  }
  return [...grouped.values()].map((group, index) => {
    const representative = [...group.candidates].sort((left, right) => candidateRisk(left) - candidateRisk(right))[0];
    const key = `b3${String(index + 1).padStart(5, "0")}`;
    const sourceHash = crypto.createHash("sha256")
      .update([
        representative.ID,
        representative.English,
        representative.Japanese,
        representative.Vietnamese,
        group.category,
        group.mandatory ? "1" : "0",
      ].join("\u001f"))
      .digest("hex");
    return {
      ...representative,
      key,
      sourceHash,
      Category: group.category,
      mandatoryReview: group.mandatory,
      members: group.members,
      currentVietnamese: representative.Vietnamese,
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
      // Bỏ qua riêng dòng checkpoint chưa ghi xong nếu Windows tắt đột ngột.
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

function qaItems(qa, critic) {
  return [...new Set([
    ...(qa.errors || []),
    ...(qa.warnings || []),
    ...(critic?.issue_codes || []),
  ])];
}

function isSafe(qa, critic, editor) {
  return !editor.protocolFallback
    && !(qa.errors || []).length
    && !(qa.warnings || []).length
    && critic?.meaning === "PASS"
    && critic?.naturalness === "PASS"
    && critic?.verdict === "SAFE"
    && !(critic?.issue_codes || []).length
    && !critic?.protocolFallback;
}

export async function runBeta3Review({ projectRoot, config, inputPath, onProgress = () => {} }) {
  const startedAt = new Date().toISOString();
  const root = path.resolve(projectRoot);
  const resolvedInput = path.resolve(inputPath);
  const [bytes, baseGlossary] = await Promise.all([
    fs.readFile(resolvedInput),
    fs.readFile(path.join(root, config.glossaryFile), "utf8").then(JSON.parse),
  ]);
  const parsed = csvToObjects(bytes.toString("utf8"));
  const rows = parsed.rows.map((row) => ({ ...row }));
  const glossary = mergedGlossary(baseGlossary, rows);
  const units = groupRows(rows);
  const unitsByKey = new Map(units.map((unit) => [unit.key, unit]));
  const runHash = crypto.createHash("sha256")
    .update(bytes)
    .update(config.pipelineVersion)
    .update(JSON.stringify(glossary.keepExact))
    .digest("hex");
  const runDir = path.join(root, config.outputRoot, `beta3-review-${safeStem(path.basename(resolvedInput, path.extname(resolvedInput)))}-${runHash.slice(0, 10)}`);
  const checkpoints = {
    editor: path.join(runDir, "beta3_editor.jsonl"),
    critic: path.join(runDir, "beta3_critic.jsonl"),
  };
  const [editorMap, criticMap] = await Promise.all([
    loadCheckpoint(checkpoints.editor, unitsByKey),
    loadCheckpoint(checkpoints.critic, unitsByKey),
  ]);
  const usagePath = path.join(runDir, "beta3_usage.json");
  let usage;
  try {
    usage = JSON.parse(await fs.readFile(usagePath, "utf8"));
  } catch {
    usage = { qwenEditor: usageBucket(), qwenCritic: usageBucket() };
  }
  onProgress({ stage: "beta3-start", rows: rows.length, units: units.length, editorReused: editorMap.size, criticReused: criticMap.size, runDir });

  const model = await readyQwen(config);
  onProgress({ stage: "beta3-model", model });

  const pendingEditor = units.filter((unit) => !editorMap.has(unit.key));
  for (let index = 0; index < pendingEditor.length; index += 1) {
    const unit = pendingEditor[index];
    const item = {
      ...unit,
      TranslateGemma: unit.currentVietnamese,
      QwenV015: "",
    };
    const response = await runQwenStage({ items: [item], config, glossary, model, stage: "editor" });
    addUsage(usage.qwenEditor, response.usage);
    const candidate = response.output.get(unit.key);
    const record = {
      key: unit.key,
      sourceHash: unit.sourceHash,
      vietnamese: candidate.vietnamese,
      protocolFallback: Boolean(candidate.protocolFallback),
      protocolIssue: candidate.protocolIssue || "",
    };
    editorMap.set(unit.key, record);
    await appendJsonl(checkpoints.editor, record);
    await writeJson(usagePath, usage);
    onProgress({ stage: "beta3-editor", current: index + 1, total: pendingEditor.length, id: unit.ID });
  }

  const pendingCritic = units.filter((unit) => !criticMap.has(unit.key));
  for (let index = 0; index < pendingCritic.length; index += 1) {
    const unit = pendingCritic[index];
    const editor = editorMap.get(unit.key);
    const qa = checkTranslation({ english: unit.English, vietnamese: editor.vietnamese, glossary });
    const item = {
      ...unit,
      TranslateGemma: unit.currentVietnamese,
      EditorDraft: editor.vietnamese,
      Hybrid: editor.vietnamese,
      auditVietnamese: editor.vietnamese,
      qaIssues: [...qa.errors, ...qa.warnings],
    };
    const response = await runQwenStage({ items: [item], config, glossary, model, stage: "critic" });
    addUsage(usage.qwenCritic, response.usage);
    const record = {
      key: unit.key,
      sourceHash: unit.sourceHash,
      critic: response.output.get(unit.key),
    };
    criticMap.set(unit.key, record);
    await appendJsonl(checkpoints.critic, record);
    await writeJson(usagePath, usage);
    onProgress({ stage: "beta3-critic", current: index + 1, total: pendingCritic.length, id: unit.ID });
  }

  for (const unit of units) {
    const editor = editorMap.get(unit.key);
    const critic = criticMap.get(unit.key)?.critic || null;
    const qa = checkTranslation({ english: unit.English, vietnamese: editor.vietnamese, glossary });
    const safe = isSafe(qa, critic, editor);
    for (const member of unit.members) {
      const row = rows[member];
      row.Vietnamese = editor.vietnamese;
      row["Local Status"] = unit.mandatoryReview ? "REVIEW_MANDATORY" : safe ? "LOCAL_OK" : "REVIEW";
      row["Local Source"] = editor.protocolFallback ? "BETA3_EDITOR_PROTOCOL_FALLBACK" : "BETA3_QWEN_REVIEW";
      row["Local QA"] = qaItems(qa, critic).join(" | ");
      row["Local Updated At"] = new Date().toISOString();
      row.Notes = appendNote(row.Notes, safe ? "Beta.3 Qwen biên tập + critic đạt." : "Beta.3 đã biên tập; vẫn cần kiểm tra trong review_queue_beta3.csv.");
    }
  }

  const statusCounts = {};
  for (const row of rows) statusCounts[row["Local Status"]] = (statusCounts[row["Local Status"]] || 0) + 1;
  const reviewRows = rows.filter((row) => TARGET_STATUSES.has(row["Local Status"]));
  const acceptedRows = rows.filter((row) => ACCEPTED_STATUSES.has(row["Local Status"]));
  const technicalErrorRows = rows.filter((row) => row["Local Status"] === "TECHNICAL_ERROR").length;
  const report = {
    decision: technicalErrorRows
      ? "HOÀN TẤT CÓ LỖI KỸ THUẬT — CHƯA ĐÓNG GÓI MSG"
      : "BETA.3 HOÀN TẤT BIÊN TẬP NHÓM RỦI RO — KIỂM TOÁN REVIEW TRƯỚC KHI ĐÓNG GÓI MSG",
    pipelineVersion: config.pipelineVersion,
    totalRows: rows.length,
    reviewedUnits: units.length,
    statusCounts,
    reviewRows: reviewRows.length,
    acceptedRows: acceptedRows.length,
    technicalErrorRows,
    protectedTerms: glossary.keepExact.length,
    usage,
    startedAt,
    finishedAt: new Date().toISOString(),
    runDir,
  };
  await Promise.all([
    writeCsv(path.join(runDir, "translated_working_beta3.csv"), rows, parsed.headers),
    writeCsv(path.join(runDir, "review_queue_beta3.csv"), reviewRows, parsed.headers),
    writeCsv(path.join(runDir, "local_ok_audit_beta3.csv"), acceptedRows, parsed.headers),
    writeJson(path.join(runDir, "beta3_review_report.json"), report),
    fs.mkdir(path.join(root, config.outputRoot), { recursive: true })
      .then(() => fs.writeFile(path.join(root, config.outputRoot, "last_beta3_review_run.txt"), runDir, "utf8")),
  ]);
  onProgress({ stage: "beta3-done", report, runDir });
  return { report, runDir };
}
