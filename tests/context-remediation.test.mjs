import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadDatabase } from "../src/context-store.mjs";
import { productionGroupSignature } from "../src/hybrid.mjs";
import { attachTranslationContext, contextBlockedResult } from "../src/translation-context.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Context Layer exact-line chặn dòng fixture đã khóa", async () => {
  const database = await loadDatabase(path.join(ROOT, "tests", "fixtures", "context-layer-synthetic.json"));
  const line = database.lineContexts[0];
  const enriched = attachTranslationContext({
    File: line.file,
    Row: String(line.row),
    ID: line.id,
    SubID: line.subId,
    English: line.english,
    Japanese: line.japanese,
    Vietnamese: line.currentVietnamese,
    Category: "FATE_EPISODE",
  }, database);
  assert.match(enriched["Context Status"], /^MAPPED_BLOCKED_LOCKED_DO_NOT_RETRANSLATE/u);
  assert.equal(enriched.ContextPrompt, "");
  const blocked = contextBlockedResult(enriched);
  assert.equal(blocked.status, "APPROVED_CONTEXT_LOCK");
  assert.equal(blocked.vietnamese, line.currentVietnamese);
});

test("cùng English nhưng context khác không còn bị gom chung", () => {
  const row = { Category: "STORY", English: "Right.", Japanese: "", ContextKey: "scene-a", ContextPrompt: "A" };
  const other = { ...row, ContextKey: "scene-b", ContextPrompt: "B" };
  assert.notEqual(productionGroupSignature(row, false), productionGroupSignature(other, false));
});

test("context fixture tổng hợp được đóng cùng candidate", async () => {
  const stat = await fs.stat(path.join(ROOT, "tests", "fixtures", "context-layer-synthetic.json"));
  assert.ok(stat.size > 0);
});
