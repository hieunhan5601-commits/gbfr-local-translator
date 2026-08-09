import { normalizeText } from "./rules.mjs";

const TOKEN_PATTERNS = [
  /\{[^{}\r\n]*\}/gu,
  /<[^<>\r\n]*>/gu,
  /(?<!\d)%(?:\d+\$)?[-+#0 ']*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlLzjt]*[diuoxXfFeEgGaAcspn%]/gu,
  /\\[nrt"\\]/gu,
  /[\uE000-\uF8FF]/gu,
  /https?:\/\/[^\s]+/gu,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu,
];

function sortedMatches(text, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    for (const match of String(text).matchAll(pattern)) matches.push(match[0]);
  }
  return matches.sort();
}

export function technicalTokens(text) {
  return sortedMatches(text, TOKEN_PATTERNS);
}

export function numericTokens(text) {
  return sortedMatches(text, [/(?<![\p{L}\p{N}_])[-+]?\d+(?:[.,]\d+)*(?:%|x)?(?![\p{L}\p{N}_])/gu]);
}

function count(text, expression) {
  return (String(text).match(expression) || []).length;
}

function termPattern(term) {
  const escaped = normalizeText(term)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,
    "giu"
  );
}

function countFoldedTerm(text, term) {
  return [...normalizeText(text).matchAll(termPattern(term))].length;
}

function edgeWhitespace(text) {
  const value = String(text);
  return {
    leading: value.match(/^\s*/u)?.[0] ?? "",
    trailing: value.match(/\s*$/u)?.[0] ?? "",
  };
}

function englishLeakRatio(text, keepTerms) {
  let cleaned = String(text);
  for (const term of keepTerms) cleaned = cleaned.replaceAll(term, " ");
  cleaned = cleaned.replace(/\{[^{}]*\}|<[^<>]*>|https?:\/\/\S+/gu, " ");
  const words = cleaned.match(/(?<![\p{L}\p{N}_])[A-Za-z]{3,}(?![\p{L}\p{N}_])/gu) || [];
  const allWords = cleaned.match(/[\p{L}]{2,}/gu) || [];
  return allWords.length ? words.length / allWords.length : 0;
}

const ENGLISH_LEAK_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "than",
  "as", "at", "by", "for", "from", "in", "into", "of", "on", "to",
  "with", "without", "during", "while", "within", "after", "before",
  "this", "that", "these", "those", "it", "its", "they", "their", "them",
  "you", "your", "he", "his", "she", "her", "we", "our",
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had",
  "can", "could", "will", "would", "may", "might", "must", "should",
  "not", "no", "now", "when", "once", "each", "all", "any", "some",
  "cost", "close", "near", "yourself",
]);

function unexpectedEnglishWords(text, allowedTerms) {
  let cleaned = normalizeText(text);
  for (const term of allowedTerms) cleaned = cleaned.replace(termPattern(term), " ");
  const words = cleaned.match(/(?<![\p{L}\p{N}_])[A-Za-z]{2,}(?:'[A-Za-z]+)?(?![\p{L}\p{N}_])/gu) || [];
  return [...new Set(words.map((word) => word.toLowerCase()).filter((word) => ENGLISH_LEAK_WORDS.has(word)))];
}

function lineShape(text) {
  return String(text).split("\n").map((line) => (/^[ \t]*$/u.test(line) ? "EMPTY" : "TEXT"));
}

function lineEdges(text) {
  return String(text).split("\n").map((line) => ({
    leading: line.match(/^[ \t]*/u)?.[0] ?? "",
    trailing: line.match(/[ \t]*$/u)?.[0] ?? "",
  }));
}

function shortLabelBlock(text) {
  const value = String(text).trim();
  if (!value || value.length > 100 || /[.!?;:]/u.test(value)) return false;
  return value.split("\n").every((line) => line.trim().length <= 60);
}

export function checkTranslation({ english, vietnamese, glossary, keepEnglish = false }) {
  const source = normalizeText(english);
  const target = normalizeText(vietnamese);
  const errors = [];
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(target)) {
    errors.push("UNEXPECTED_CJK");
  }
  const warnings = [];

  if (!/[`*_]{2,}/u.test(source) && /(?:```|`[^`]+`|\*\*|__)/u.test(target)) {
    errors.push("UNEXPECTED_MARKDOWN");
  }
  if (/(?:^|[\s,{])(?:meaning|naturalness|verdict|review_notes|semantic_review_notes|qa_issues|deterministic_qa_issues|mandatory_semantic_review|gap_markers_preserved|line_count_match_check_passed|technical_tokens|required_gap_markers|vietnamese_lines|english_lines)["']?\s*[:=]/iu.test(target)
    || /\/?no_think/iu.test(target)
    || /(?:^|\s)(?:assistant|system|developer)\s*:/iu.test(target)) {
    errors.push("MODEL_META_LEAK");
  }
  if (/GBFR(?:KEEP|GAP|TRANSLATION)|Chỉ đặt bản dịch|không JSON|không Markdown/iu.test(target)) {
    errors.push("MODEL_PROTOCOL_LEAK");
  }

  if (!target && source) errors.push("EMPTY_TRANSLATION");
  const sourceTokens = technicalTokens(source);
  const targetTokens = technicalTokens(target);
  if (JSON.stringify(sourceTokens) !== JSON.stringify(targetTokens)) errors.push("TECHNICAL_TOKEN_MISMATCH");
  const sourceNumbers = numericTokens(source);
  const targetNumbers = numericTokens(target);
  if (JSON.stringify(sourceNumbers) !== JSON.stringify(targetNumbers)) errors.push("NUMBER_MISMATCH");
  const sourceLineBreaks = count(source, /\n/g);
  const targetLineBreaks = count(target, /\n/g);
  if (sourceLineBreaks !== targetLineBreaks) {
    warnings.push("LINE_BREAK_MISMATCH");
  } else if (JSON.stringify(lineShape(source)) !== JSON.stringify(lineShape(target))) {
    errors.push("LINE_STRUCTURE_MISMATCH");
  } else {
    const sourceLineEdges = lineEdges(source);
    const targetLineEdges = lineEdges(target);
    for (let index = 0; index < sourceLineEdges.length; index += 1) {
      if (sourceLineEdges[index].leading !== targetLineEdges[index].leading
        || sourceLineEdges[index].trailing !== targetLineEdges[index].trailing) {
        errors.push(`LINE_EDGE_WHITESPACE_CHANGED:${index + 1}`);
      }
    }
  }
  for (const [index, line] of target.split("\n").entries()) {
    if (/^[ \t]*[.,;:!?](?:[ \t]|$)/u.test(line)) errors.push(`ORPHAN_PUNCTUATION_LINE:${index + 1}`);
  }
  if (shortLabelBlock(source)) {
    for (const [index, line] of target.split("\n").entries()) {
      if (/[.!?;:]\s*$/u.test(line)) errors.push(`SHORT_LABEL_PUNCTUATION_ADDED:${index + 1}`);
    }
  }
  if (count(source, /  /g) !== count(target, /  /g) && count(source, /  /g) > 0) errors.push("DOUBLE_SPACE_MISMATCH");
  const sourceEdges = edgeWhitespace(source);
  const targetEdges = edgeWhitespace(target);
  if (sourceEdges.leading !== targetEdges.leading || sourceEdges.trailing !== targetEdges.trailing) {
    warnings.push("EDGE_WHITESPACE_CHANGED");
  }

  const relevantProtected = (glossary.keepExact || []).filter(
    (term) => countFoldedTerm(source, term) > 0
  );
  if (!keepEnglish) {
    for (const term of relevantProtected) {
      const sourceCount = countFoldedTerm(source, term);
      const targetCount = countFoldedTerm(target, term);
      if (targetCount === 0) errors.push(`PROTECTED_TERM_MISSING:${term}`);
      const countExempt = normalizeText(term).toLowerCase() === "summon";
      if (!countExempt && targetCount < sourceCount) {
        errors.push(`PROTECTED_TERM_COUNT_MISMATCH:${term}:${sourceCount}=>${targetCount}`);
      }
    }
    for (const [sourceTerm, targetTerm] of Object.entries(glossary.translateAs || {})) {
      const sourceCount = countFoldedTerm(source, sourceTerm);
      if (sourceCount === 0) continue;

      const sameTerm =
        normalizeText(sourceTerm).toLowerCase() ===
        normalizeText(targetTerm).toLowerCase();

      if (sameTerm) continue;

      const targetCount = countFoldedTerm(target, targetTerm);

      if (targetCount < sourceCount) {
        errors.push(`GLOSSARY_TRANSLATION_MISSING:${sourceTerm}=>${targetTerm}`);
      }

      if (countFoldedTerm(target, sourceTerm) > 0) {
        errors.push(`GLOSSARY_SOURCE_LEAK:${sourceTerm}`);
      }
    }
  }

  if (!keepEnglish && source.trim() === target.trim() && /[A-Za-z]{3,}/.test(source)) warnings.push("UNCHANGED_ENGLISH");
  if (!keepEnglish && englishLeakRatio(target, relevantProtected) > 0.45 && target.length > 20) warnings.push("POSSIBLE_ENGLISH_LEAK");
  if (!keepEnglish) {
    const allowedEnglish = [
      ...relevantProtected,
      ...Object.entries(glossary.translateAs || {})
        .filter(([sourceTerm, targetTerm]) => normalizeText(sourceTerm).toLowerCase() === normalizeText(targetTerm).toLowerCase())
        .map(([, targetTerm]) => targetTerm),
    ];
    const leakedWords = unexpectedEnglishWords(target, allowedEnglish);
    if (leakedWords.length) warnings.push(`ENGLISH_WORD_LEAK:${leakedWords.join(",")}`);
  }
  if (/can I have them\?/iu.test(source) && /không\s+sao\??/iu.test(target)) {
    warnings.push("SEMANTIC_BROKEN_REQUEST_PHRASE");
  }
  if (/dwells? within/iu.test(source) && /ngôi/iu.test(target)) {
    warnings.push("SEMANTIC_DWELLS_WITHIN_MISTRANSLATED");
  }
  if (/\brarity\b/iu.test(source) && /hiếm\s+hoi/iu.test(target)) {
    warnings.push("SEMANTIC_RARITY_MISTRANSLATED");
  }
  if (/\bcharg(?:e|ed)\s+attack\b/iu.test(source) && !/tụ\s+lực/iu.test(target)) {
    warnings.push("SEMANTIC_CHARGED_ATTACK_TERM_MISSING");
  }
  if (/\bcombo\b/iu.test(source) && /chuỗi\s+combo/iu.test(target)) {
    warnings.push("SEMANTIC_REDUNDANT_COMBO");
  }
  if (/\bbeat\s+back\b/iu.test(source) && !/đẩy\s+lùi/iu.test(target)) {
    warnings.push("SEMANTIC_BEAT_BACK_MISTRANSLATED");
  }
  if (/\bcall\s+a\s+summon\b/iu.test(source) && /triệu\s+hồi\s+(?:một\s+)?Summon/u.test(target)) {
    warnings.push("SEMANTIC_MIXED_SUMMON_VERB");
  }
  if (/casts?\s+a\s+circle[\s\S]*hold\s+while\s+casting\s+to\s+aim/iu.test(source)
    && /ngắm/iu.test(target)) {
    warnings.push("SEMANTIC_GROUND_TARGET_AIM_MISTRANSLATED");
  }
  if (/each\s+summon\s+has\s+its\s+own\s+cost/iu.test(source)
    && /mỗi\s+viên\s+triệu\s+hồi/iu.test(target)) {
    warnings.push("SEMANTIC_SUMMON_AS_STONE_MISTRANSLATED");
  }
  if (/passive\s+effects?[\s\S]*rarity/iu.test(source)
    && /tăng\s+cường\s+theo\s+độ\s+hiếm/iu.test(target)) {
    warnings.push("SEMANTIC_AWKWARD_RARITY_SENTENCE");
  }
  if (/passive\s+effects?[\s\S]*rarity/iu.test(source)
    && (target.match(/độ\s+hiếm/giu) || []).length > 1) {
    warnings.push("SEMANTIC_RARITY_IDEA_REPEATED");
  }
  if (/always\s+wanted\s+pet\s+crabs/iu.test(source)
    && /luôn\s+muốn\s+nuôi\s+làm\s+thú\s+cưng/iu.test(target)) {
    warnings.push("SEMANTIC_MISSING_PET_OBJECT");
  }
  if (/\bnode\b/iu.test(source) && /điểm\s+nút/iu.test(target)) {
    warnings.push("SEMANTIC_REDUNDANT_NODE_WORDING");
  }
  if (/\brescues?\s+allies\b/iu.test(source) && /cứu\s+rỗi\s+đồng\s+(?:đội|minh)/iu.test(target)) {
    warnings.push("SEMANTIC_AWKWARD_RESCUE_WORDING");
  }
  if (/customize\s+each\s+individually/iu.test(source) && /từng\s+cái/iu.test(target)) {
    warnings.push("SEMANTIC_AWKWARD_EACH_ITEM_WORDING");
  }
  if (/new\s+feature\s+now\s+available/iu.test(source) && /sẵn\s+sàng/iu.test(target)) {
    warnings.push("SEMANTIC_FEATURE_AVAILABILITY_WORDING");
  }
  if (/refresh\s+this\s+data/iu.test(source) && /tải\s+lại\s+dữ\s+liệu/iu.test(target)) {
    warnings.push("SEMANTIC_REFRESH_DATA_WORDING");
  }
  if (/<d>\{1\}\s+Enabled/u.test(source) && !/<d>Đã\s+bật\s+\{1\}/u.test(target)) {
    warnings.push("SEMANTIC_ENABLED_PLACEHOLDER_ORDER");
  }
  if (/last\s+saved/iu.test(source) && !/lần\s+cuối/iu.test(target)) {
    warnings.push("SEMANTIC_LAST_SAVED_TIME_MISSING");
  }
  if (/\bjoin\s+using\b/iu.test(source) && !/\btham\s+gia\b/iu.test(target)) {
    warnings.push("SEMANTIC_JOIN_USING_MISTRANSLATED");
  }
  if (/\bcasts?\s+a\s+circle\b/iu.test(source) && /\bphát\s+động\s+vòng\s+tròn\b/iu.test(target)) {
    warnings.push("SEMANTIC_AWKWARD_CASTS_CIRCLE");
  }
  if (/\bsummon\s+stones?\b/iu.test(source) && /(?:viên\s+)?đá\s+triệu\s+hồi/iu.test(target)) {
    warnings.push("SEMANTIC_SUMMON_STONE_LITERAL");
  }
  if (/\btroph(?:y|ies)\b/iu.test(source) && /huy\s+chương/iu.test(target)) {
    warnings.push("SEMANTIC_TROPHY_AS_MEDAL");
  }
  if (/\bcasts?\s+a\s+spell\b/iu.test(source) && /\btạo\s+(?:ra\s+)?một\s+phép\s+thuật\b/iu.test(target)) {
    warnings.push("SEMANTIC_AWKWARD_CASTS_SPELL");
  }
  if (/\bgrants?\b/iu.test(source) && /\btặng\s+(?:hiệu\s+ứng\s+)?/iu.test(target)) {
    warnings.push("SEMANTIC_AWKWARD_GRANTS_VERB");
  }
  if (/\beffect\s+strength\b/iu.test(source) && /\bmức\s+độ\s+hiệu\s+ứng\b/iu.test(target)) {
    warnings.push("SEMANTIC_AWKWARD_EFFECT_STRENGTH");
  }
  if (/\bfinisher\b/iu.test(source) && /\bkỹ\s+năng\s+kết\s+thúc\b/iu.test(target)) {
    warnings.push("SEMANTIC_FINISHER_AS_SKILL");
  }
  if (/\bskyfarers?\b/iu.test(source) && /phi\s+hành\s+gia/iu.test(target)) {
    warnings.push("SEMANTIC_SKYFARER_AS_ASTRONAUT");
  }
  if (/\bstomp\s+attack\b/iu.test(source)
    && !/(?:dậm|giậm|dẫm|giẫm|đạp)(?:\s+chân)?/iu.test(target)) {
    warnings.push("SEMANTIC_STOMP_ATTACK_MISTRANSLATED");
  }
  if (/\brenew(?:ed|ing)?\b/iu.test(source) && /gia\s+hạn/iu.test(target)) {
    warnings.push("SEMANTIC_RENEW_AS_EXTENSION");
  }
  if (/\bDMG\s+Dealt\b/u.test(source) && /sát\s+thương\s+nhận\s+được/iu.test(target)) {
    warnings.push("SEMANTIC_DMG_DEALT_REVERSED");
  }
  if (/shortens?[\s\S]{0,100}\bby\s+\{\d+\}%/iu.test(source)
    && /(?:xuống|còn)\s+\{\d+\}%/iu.test(target)) {
    warnings.push("SEMANTIC_BY_PERCENT_AS_FINAL_VALUE");
  }
  if (source.length >= 12 && (target.length / source.length > 2.8 || target.length / source.length < 0.22)) {
    warnings.push("SUSPICIOUS_LENGTH_RATIO");
  }
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sourceTokens,
    targetTokens,
    sourceNumbers,
    targetNumbers,
  };
}
