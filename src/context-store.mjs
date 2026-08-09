import fs from "node:fs/promises";

const ALLOWED_AI_ACTIONS = new Set(["TRANSLATE", "REOPEN_WITH_EVIDENCE"]);

function normalized(value) {
  return String(value ?? "").normalize("NFC");
}

export function makeLineKey({ file, row, id, subId = "" }) {
  return [normalized(file), Number(row), normalized(id), normalized(subId)].join("\u001f");
}

function uniqueBy(items, keyName, errors) {
  const map = new Map();
  for (const item of items || []) {
    const key = item?.[keyName];
    if (!key) {
      errors.push(`MISSING_KEY:${keyName}`);
      continue;
    }
    if (map.has(key)) errors.push(`DUPLICATE:${keyName}:${key}`);
    map.set(key, item);
  }
  return map;
}

function refExists(map, key, label, owner, errors, nullable = false) {
  if ((key === null || key === "") && nullable) return;
  if (!map.has(key)) errors.push(`MISSING_REF:${label}:${owner}:${key}`);
}

function refsExist(map, keys, label, owner, errors) {
  for (const key of keys || []) refExists(map, key, label, owner, errors);
}

export function validateDatabase(database) {
  const errors = [];
  const warnings = [];
  if (database?.metadata?.schemaVersion !== "1.0.0") errors.push("SCHEMA_VERSION_MUST_BE_1.0.0");
  const sourceMap = uniqueBy(database.sources, "sourceId", errors);
  const characterMap = uniqueBy(database.characters, "characterId", errors);
  const relationshipMap = uniqueBy(database.relationships, "relationshipId", errors);
  const glossaryMap = uniqueBy(database.glossary, "glossaryId", errors);
  const sceneMap = uniqueBy(database.scenes, "sceneId", errors);
  const lineMap = uniqueBy(database.lineContexts, "lineKey", errors);

  for (const character of database.characters || []) refsExist(sourceMap, character.sourceIds, "SOURCE", character.characterId, errors);
  for (const glossary of database.glossary || []) refsExist(sourceMap, glossary.sourceIds, "SOURCE", glossary.glossaryId, errors);
  for (const relationship of database.relationships || []) {
    refExists(characterMap, relationship.characterAId, "CHARACTER_A", relationship.relationshipId, errors);
    refExists(characterMap, relationship.characterBId, "CHARACTER_B", relationship.relationshipId, errors);
    refsExist(sourceMap, relationship.sourceIds, "SOURCE", relationship.relationshipId, errors);
    if (relationship.sceneOrderEnd !== null && relationship.sceneOrderEnd < relationship.sceneOrderStart) {
      errors.push(`INVALID_RELATIONSHIP_RANGE:${relationship.relationshipId}`);
    }
  }
  for (const scene of database.scenes || []) {
    refsExist(characterMap, scene.participants, "SCENE_PARTICIPANT", scene.sceneId, errors);
    refsExist(relationshipMap, scene.relationshipIds, "SCENE_RELATIONSHIP", scene.sceneId, errors);
    refsExist(sourceMap, scene.sourceIds, "SOURCE", scene.sceneId, errors);
    if (scene.videoEvidence?.sourceId) {
      refExists(sourceMap, scene.videoEvidence.sourceId, "VIDEO_SOURCE", scene.sceneId, errors);
      const source = sourceMap.get(scene.videoEvidence.sourceId);
      if (source && source.type !== "VIDEO") errors.push(`VIDEO_EVIDENCE_NOT_VIDEO:${scene.sceneId}`);
      if ((scene.videoEvidence.timestampStart || scene.videoEvidence.timestampEnd) && source?.status !== "VERIFIED") {
        errors.push(`UNVERIFIED_VIDEO_TIMESTAMP:${scene.sceneId}`);
      }
    }
  }
  for (const line of database.lineContexts || []) {
    const expectedKey = makeLineKey(line);
    if (line.lineKey !== expectedKey) errors.push(`LINE_KEY_MISMATCH:${line.id}`);
    refExists(sceneMap, line.sceneId, "LINE_SCENE", line.lineKey, errors);
    refExists(characterMap, line.speakerId, "LINE_SPEAKER", line.lineKey, errors, true);
    refsExist(characterMap, line.addresseeIds, "LINE_ADDRESSEE", line.lineKey, errors);
    refsExist(characterMap, line.focusCharacterIds, "LINE_FOCUS_CHARACTER", line.lineKey, errors);
    refsExist(glossaryMap, line.glossaryIds, "LINE_GLOSSARY", line.lineKey, errors);
    refsExist(relationshipMap, line.relationshipIds, "LINE_RELATIONSHIP", line.lineKey, errors);
    refsExist(sourceMap, line.sourceIds, "SOURCE", line.lineKey, errors);
    for (const neighborKey of line.neighborKeys || []) {
      refExists(lineMap, neighborKey, "LINE_NEIGHBOR", line.lineKey, errors);
      const neighbor = lineMap.get(neighborKey);
      if (neighbor && neighbor.sceneId !== line.sceneId) errors.push(`CROSS_SCENE_NEIGHBOR:${line.lineKey}:${neighborKey}`);
    }
    const scene = sceneMap.get(line.sceneId);
    for (const relationshipId of line.relationshipIds || []) {
      const relationship = relationshipMap.get(relationshipId);
      if (!scene || !relationship) continue;
      const end = relationship.sceneOrderEnd ?? Number.POSITIVE_INFINITY;
      if (scene.order < relationship.sceneOrderStart || scene.order > end) {
        errors.push(`FUTURE_OR_EXPIRED_RELATIONSHIP:${line.lineKey}:${relationshipId}`);
      }
    }
    if (line.translationPolicy?.locked && line.translationPolicy.action !== "DO_NOT_RETRANSLATE") {
      errors.push(`LOCKED_ACTION_INVALID:${line.lineKey}:${line.translationPolicy.action}`);
    }
    if (!line.translationPolicy?.locked && line.translationPolicy?.action === "DO_NOT_RETRANSLATE") {
      warnings.push(`UNLOCKED_BUT_BLOCKED:${line.lineKey}`);
    }
    const videoSourceId = line.videoEvidence?.sourceId;
    if (videoSourceId) {
      const video = sourceMap.get(videoSourceId);
      if ((line.videoEvidence.timestampStart || line.videoEvidence.timestampEnd) && video?.status !== "VERIFIED") {
        errors.push(`UNVERIFIED_LINE_TIMESTAMP:${line.lineKey}`);
      }
    }
  }

  return {
    status: errors.length ? "FAIL" : "PASS",
    errors,
    warnings,
    counts: {
      sources: sourceMap.size,
      characters: characterMap.size,
      relationships: relationshipMap.size,
      glossary: glossaryMap.size,
      scenes: sceneMap.size,
      lineContexts: lineMap.size,
      lockedLines: (database.lineContexts || []).filter((line) => line.translationPolicy?.locked).length,
      sourceQualityReviewLines: (database.lineContexts || []).filter((line) => line.sourceQuality?.status !== "PASS").length,
      verifiedVideoLines: (database.lineContexts || []).filter((line) => line.videoEvidence?.status === "VERIFIED").length,
    },
  };
}

export async function loadDatabase(file) {
  const database = JSON.parse(await fs.readFile(file, "utf8"));
  const validation = validateDatabase(database);
  if (validation.status !== "PASS") {
    throw new Error(`Context database không hợp lệ:\n${validation.errors.join("\n")}`);
  }
  return database;
}

function exactLine(database, query) {
  const candidates = (database.lineContexts || []).filter((line) => {
    if (query.file !== undefined && line.file !== query.file) return false;
    if (query.row !== undefined && Number(line.row) !== Number(query.row)) return false;
    if (query.id !== undefined && line.id !== query.id) return false;
    if (query.subId !== undefined && line.subId !== query.subId) return false;
    return true;
  });
  if (!candidates.length) return null;
  if (candidates.length > 1) throw new Error(`Query không duy nhất; cần đủ File + Row + ID + SubID (${candidates.length} kết quả).`);
  return candidates[0];
}

export function shouldSendToAi(line) {
  if (!line) return { allowed: false, reason: "LINE_NOT_FOUND" };
  if (line.translationPolicy?.locked) return { allowed: false, reason: "LOCKED_DO_NOT_RETRANSLATE" };
  if (!ALLOWED_AI_ACTIONS.has(line.translationPolicy?.action)) return { allowed: false, reason: `ACTION_${line.translationPolicy?.action || "MISSING"}` };
  if (line.sourceQuality?.status !== "PASS") return { allowed: false, reason: "SOURCE_QUALITY_NOT_PASS" };
  return { allowed: true, reason: "ELIGIBLE" };
}

export function retrieveContext(database, query) {
  const line = exactLine(database, query);
  if (!line) return null;
  const characters = new Map(database.characters.map((item) => [item.characterId, item]));
  const relationships = new Map(database.relationships.map((item) => [item.relationshipId, item]));
  const glossary = new Map(database.glossary.map((item) => [item.glossaryId, item]));
  const scenes = new Map(database.scenes.map((item) => [item.sceneId, item]));
  const lines = new Map(database.lineContexts.map((item) => [item.lineKey, item]));
  const scene = scenes.get(line.sceneId);
  const relationItems = (line.relationshipIds || [])
    .map((id) => relationships.get(id))
    .filter(Boolean)
    .filter((item) => scene && scene.order >= item.sceneOrderStart && scene.order <= (item.sceneOrderEnd ?? Number.POSITIVE_INFINITY));
  return {
    query: { file: line.file, row: line.row, id: line.id, subId: line.subId },
    line,
    queueDecision: shouldSendToAi(line),
    context: {
      scene,
      speaker: line.speakerId ? characters.get(line.speakerId) : null,
      addressees: (line.addresseeIds || []).map((id) => characters.get(id)).filter(Boolean),
      focusCharacters: (line.focusCharacterIds || []).map((id) => characters.get(id)).filter(Boolean),
      relationships: relationItems,
      glossary: (line.glossaryIds || []).map((id) => glossary.get(id)).filter(Boolean),
      neighbors: (line.neighborKeys || []).map((key) => lines.get(key)).filter(Boolean),
    },
    guardrails: {
      exactLineKey: true,
      futureContextExcluded: true,
      videoTimestampTrusted: line.videoEvidence?.status === "VERIFIED",
      lockedContentProtected: line.translationPolicy?.locked === true,
    },
  };
}

function oneLine(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function formatContextBlock(result) {
  if (!result) return "GBFR_CONTEXT_V1\nLINE_NOT_FOUND";
  const { line, context, queueDecision } = result;
  const blocks = [
    "GBFR_CONTEXT_V1",
    `LINE: ${line.file} | row=${line.row} | ID=${line.id} | SubID=${line.subId || "<empty>"}`,
    `TRANSLATION_ACTION: ${line.translationPolicy.action}`,
    `AI_QUEUE: ${queueDecision.allowed ? "ALLOW" : `BLOCK (${queueDecision.reason})`}`,
    `SOURCE_QUALITY: ${line.sourceQuality.status}${line.sourceQuality.issues?.length ? ` — ${line.sourceQuality.issues.join("; ")}` : ""}`,
    `SCENE: ${context.scene.title} | phase=${context.scene.storyPhase} | order=${context.scene.order}`,
    `SCENE_SUMMARY: ${oneLine(context.scene.summary)}`,
  ];
  if (context.speaker) blocks.push(`SPEAKER: ${context.speaker.name} — ${oneLine(context.speaker.profile.voiceStyleVi)}`);
  if (context.focusCharacters.length) {
    blocks.push(`FOCUS: ${context.focusCharacters.map((item) => `${item.name} (${oneLine(item.profile.voiceStyleVi)})`).join(" | ")}`);
  }
  if (context.relationships.length) {
    blocks.push("RELATIONSHIPS_AT_THIS_SCENE:");
    for (const item of context.relationships) {
      blocks.push(`- ${item.relationshipId}: ${item.type}; A→B ${oneLine(item.direction.aToB)}; B→A ${oneLine(item.direction.bToA)}`);
    }
  }
  if (context.neighbors.length) {
    blocks.push("NEIGHBOR_LINES:");
    for (const item of context.neighbors) blocks.push(`- ${item.id}: EN=${oneLine(item.english)} | VI=${oneLine(item.currentVietnamese)}`);
  }
  if (context.glossary.length) {
    blocks.push(`GLOSSARY: ${context.glossary.map((item) => `${item.sourceTerm} ${item.policy === "KEEP_EXACT" ? "[KEEP]" : `→ ${item.targetTerm}`}`).join("; ")}`);
  }
  blocks.push(`VIDEO_CONTEXT: ${line.videoEvidence?.status || "NONE"}; timestamp=${line.videoEvidence?.timestampStart || "UNVERIFIED"}`);
  blocks.push("GUARDRAIL: Không dùng quan hệ/cảnh sau thời điểm hiện tại. Không sửa dòng LOCKED nếu chưa có bằng chứng mở khóa.");
  return blocks.join("\n");
}
