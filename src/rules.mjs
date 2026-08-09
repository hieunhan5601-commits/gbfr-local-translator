import crypto from "node:crypto";

export function normalizeText(value) {
  return String(value ?? "").normalize("NFC");
}

export function stableRowKey(row) {
  return [row.File, row.Row, row.ID, row.SubID].map((value) => String(value ?? "")).join("\u001f");
}

export function textHash(value) {
  return crypto.createHash("sha256").update(normalizeText(value)).digest("hex");
}

function foldedTermPattern(term) {
  const escaped = normalizeText(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

export function includesFoldedTerm(text, term) {
  return foldedTermPattern(term).test(normalizeText(text));
}

export function classifyRow(row) {
  const file = String(row.File || "").toLowerCase();
  const id = String(row.ID || "").toUpperCase();
  if (file.includes("staff")) return "Staff credits";
  if (file.includes("license") || id.startsWith("TXT_LICENSE_")) return "License";
  if (file.includes("dialog") || file.includes("demo")) return "Hội thoại";
  if (file.includes("story")) return id.endsWith("_BODY") ? "Tóm tắt cốt truyện" : "Cốt truyện";
  if (file.includes("stage")) return id.includes("_BODY") || id.includes("_INFO") ? "Mô tả nhiệm vụ" : "Nhiệm vụ";
  if (id.startsWith("TXT_ABIF_") || id.includes("SKILL_INFO") || id.includes("ABI_INFO")) return "Mô tả Skill";
  if (id.startsWith("TXT_ITEM_INFO_") || id.includes("ITEM_DESC")) return "Mô tả vật phẩm";
  if (id.startsWith("TXT_WEP_EXPLAIN_")) return "Mô tả vũ khí";
  if (id.startsWith("TXT_SKILL_EXPLAIN_") || id.startsWith("TXT_SKILL_SUMMARY_")) return "Mô tả Trait/Sigil";
  if (id.startsWith("TXT_ITEM_")) return "Vật phẩm";
  if (id.startsWith("TXT_CHAPTER_")) return "Cốt truyện";
  if (id.startsWith("CORE_AUTOTALK_") || id.startsWith("CORE_TALK_") || id.startsWith("CORE_STAMP_") || id.startsWith("CORE_EMOTE_")) return "Giao tiếp";
  if (file.includes("tutorial") || file.includes("tips")) return "Hướng dẫn";
  if (file.includes("battle") || file.includes("chara_attack") || file.includes("ogi")) return "Combat";
  if (file.includes("option") || file.includes("save") || file.includes("filter") || file.includes("ui")) return "UI/Hệ thống";
  if (file.includes("note") || file.includes("fate_episode")) return "Lore/Nhật ký";
  if (file.includes("skillboard")) return "Skill Board";
  if (file.includes("badge")) return "Badge/Danh hiệu";
  if (file.includes("limit_bonus")) return "Limit Bonus";
  if (file.includes("communication")) return "Giao tiếp";
  if (file.includes("chara")) return "Nhân vật";
  if (file.includes("status")) return "Trạng thái";
  if (file.includes("sum")) return "Summon";
  if (file.includes("uskill")) return "Skill đặc biệt";
  if (file.includes("chainburst")) return "Combat";
  if (file.includes("costume")) return "Trang phục";
  if (file.includes("pub") || file.includes("system") || file.includes("telop") || file.includes("steam") || file.includes("matching") || file.includes("session") || file.includes("phase") || file.includes("temp")) return "UI/Hệ thống";
  const supplied = String(row.Category || "");
  return /^(?:Kế thừa|Mới v|Cập nhật v)/u.test(supplied) ? "Khác" : supplied || "Khác";
}

const KEEP_ID_PATTERNS = [
  /^TXT_STAFF_(?:NAME|COM)_/,
  /^TXT_LICENSE_/,
  /^TXT_WEP_NAME_/,
  /^TXT_(?:SKILL|ABI|ABILITY)_NAME_/,
  /^TXT_AB_PL\d{4}(?:_|$)/,
  /^TXT_(?:GEEN|SIGIL|TRAIT)_NAME_/,
  /^TXT_(?:CHARA|CHARACTER)_NAME_/,
  /^TXT_NAME_(?:NP|PL)\d{4}(?:_|$)/,
  /^TXT_(?:SUM|SUMMON|SMN)_NAME_/,
  /^TXT_OGI_NAME_/,
  /^TXT_WRIGHTSTONE_NAME_/,
];

export function shouldKeepEnglish(row, glossary) {
  const english = normalizeText(row.English);
  const id = String(row.ID || "").toUpperCase();
  if (!english) return { keep: true, reason: "EMPTY_SOURCE" };
  if (!/[A-Za-z]/.test(english)) return { keep: true, reason: "NO_LATIN_TEXT" };
  if (KEEP_ID_PATTERNS.some((pattern) => pattern.test(id))) return { keep: true, reason: "PROTECTED_NAME_ID" };
  if (glossary.keepExact.includes(english)) return { keep: true, reason: "PROTECTED_TERM" };
  return { keep: false, reason: "" };
}

export function semanticReviewReasons(row) {
  const id = String(row.ID || "").toUpperCase();
  const english = normalizeText(row.English).trim();
  const reasons = [];
  const plainNumberedChapter = /^Chapter\s+(?:\d+|[IVXLCDM]+)$/iu.test(english);

  if (/^TXT_QR_/u.test(id)) reasons.push("QUEST_TITLE_ID");
  if (/(?:^|_)(?:TTL|TITLE)$/u.test(id) && !/^TXT_(?:SYS|UI)_/u.test(id)) reasons.push("TITLE_ID");
  if (!plainNumberedChapter && (/^TXT_CHAPTER_/u.test(id) || /^Chapter\b/iu.test(english))) {
    reasons.push("CHAPTER_TITLE");
  }
  if (/^TXT_DLG_BDY_EM\d+_CHAOS$/u.test(id)) reasons.push("POETIC_CHAOS_LORE");

  return [...new Set(reasons)];
}

export function translationBucket(row) {
  const category = row.Category || classifyRow(row);
  if (category !== "Combat") return category;

  const english = normalizeText(row.English).trim();
  const lineCount = english ? english.split("\n").length : 0;
  const shortLabel = english.length <= 90 && lineCount <= 2;
  return shortLabel ? "Combat/Nhãn ngắn" : "Combat/Mô tả dài";
}

export function resolveOverride(row, overrides) {
  const key = stableRowKey(row);
  if (Object.prototype.hasOwnProperty.call(overrides.byKey || {}, key)) return overrides.byKey[key];
  if (Object.prototype.hasOwnProperty.call(overrides.byId || {}, row.ID)) return overrides.byId[row.ID];
  return null;
}

export function relevantGlossary(englishTexts, glossary) {
  const sources = englishTexts.map((text) => String(text));
  const keepExact = glossary.keepExact.filter((term) => sources.some((source) => includesFoldedTerm(source, term)));
  const translateAs = Object.fromEntries(
    Object.entries(glossary.translateAs).filter(([term]) => sources.some((source) => includesFoldedTerm(source, term))),
  );
  return { keepExact, translateAs };
}

export function appendNote(existing, addition) {
  const first = String(existing || "").trim();
  const second = String(addition || "").trim();
  if (!first) return second;
  if (!second || first.includes(second)) return first;
  return `${first} | ${second}`;
}
