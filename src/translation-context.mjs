import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { formatContextBlock, loadDatabase, retrieveContext } from "./context-store.mjs";

export async function loadOptionalContextDatabase(projectRoot, config) {
  if (!config.contextDatabaseFile) return null;
  const file = path.resolve(projectRoot, config.contextDatabaseFile);
  try {
    return await loadDatabase(file);
  } catch (error) {
    if (error?.code === "ENOENT" && config.contextDatabaseRequired !== true) return null;
    throw error;
  }
}

function sourceQualityStatus(result) {
  return result?.line?.sourceQuality?.status || "UNKNOWN";
}

export function attachTranslationContext(row, database) {
  if (!database) {
    return {
      ...row,
      ContextPrompt: "",
      ContextKey: "",
      "Context Status": "DISABLED",
      "Context Line Key": "",
      _contextResult: null,
    };
  }
  const result = retrieveContext(database, {
    file: row.File,
    row: row.Row === "" || row.Row === undefined ? undefined : Number(row.Row),
    id: row.ID,
    subId: row.SubID ?? "",
  });
  if (!result) {
    return {
      ...row,
      ContextPrompt: "",
      ContextKey: "",
      "Context Status": "NOT_MAPPED",
      "Context Line Key": "",
      _contextResult: null,
    };
  }
  const prompt = result.queueDecision.allowed ? formatContextBlock(result) : "";
  const status = result.queueDecision.allowed
    ? "MAPPED_AI_ELIGIBLE"
    : `MAPPED_BLOCKED_${result.queueDecision.reason}`;
  return {
    ...row,
    ContextPrompt: prompt,
    ContextKey: result.line.lineKey,
    "Context Status": sourceQualityStatus(result) === "PASS" ? status : `${status}_${sourceQualityStatus(result)}`,
    "Context Line Key": result.line.lineKey,
    _contextResult: result,
  };
}

export function contextFingerprint(row) {
  if (!row.ContextKey && !row.ContextPrompt) return "NO_CONTEXT";
  return crypto.createHash("sha256")
    .update(`${row.ContextKey || ""}\u001f${row.ContextPrompt || ""}`)
    .digest("hex");
}

export function contextBlockedResult(row) {
  const result = row._contextResult;
  if (!result || result.queueDecision.allowed) return null;
  const preserved = String(row.Vietnamese || result.line.currentVietnamese || row.English || "");
  const locked = result.line.translationPolicy?.locked === true;
  return {
    vietnamese: preserved,
    status: locked ? "APPROVED_CONTEXT_LOCK" : "REVIEW_MANDATORY",
    source: locked ? "CONTEXT_LOCKED_DO_NOT_RETRANSLATE" : `CONTEXT_BLOCKED_${result.queueDecision.reason}`,
    qa: { errors: [], warnings: locked ? [] : [result.queueDecision.reason] },
    note: locked
      ? "Context Layer chặn AI và giữ nguyên bản dịch đã khóa."
      : "Context Layer chặn AI; cần xử lý nguồn hoặc bằng chứng trước khi mở lại.",
  };
}

export async function contextDatabaseExists(projectRoot, config) {
  if (!config.contextDatabaseFile) return false;
  try {
    await fs.access(path.resolve(projectRoot, config.contextDatabaseFile));
    return true;
  } catch {
    return false;
  }
}
