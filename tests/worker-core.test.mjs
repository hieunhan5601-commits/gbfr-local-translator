import assert from "node:assert/strict";

import {
  buildPrompt,
  isDeterministicKeepEnglishItem,
  keepTermPattern,
  qaItem,
} from "../story-worker/worker.mjs";

const glossary = {
  keepExact: ["Captain", "Skyship"],
  translateAs: { Level: "Cấp độ" },
};

const item = (overrides = {}) => ({
  key: "DEMO-0001",
  id: "TXT_DIALOGUE_DEMO",
  type: "scenario",
  english: "Welcome aboard, Captain.",
  japanese: "",
  ...overrides,
});

assert.equal(keepTermPattern("Captain").test("Captain"), true);
assert.ok(qaItem(item(), "Chào mừng lên tàu, Captain.", glossary).ok);
assert.ok(qaItem(item(), "Chào mừng lên tàu.", glossary).errors.includes("PROTECTED_TERM_MISSING:Captain"));
assert.ok(qaItem(item(), "Welcome aboard, Captain.", glossary).errors.includes("UNCHANGED_ENGLISH"));
assert.ok(qaItem(item(), "ようこそ、Captain。", glossary).errors.includes("UNEXPECTED_CJK"));

const percentItem = item({
  key: "DEMO-PERCENT",
  id: "TXT_EFFECT_DEMO",
  english: "Gain +{0:100}% based on charge.",
});
assert.ok(qaItem(percentItem, "Tăng +{0:100}% dựa trên tích lực.", glossary).ok,
  "Vietnamese prose after a percentage must not create a false printf token");

const printfItem = item({ key: "DEMO-PRINTF", english: "Value: %d", japanese: "" });
assert.ok(qaItem(printfItem, "Giá trị: %d", glossary).ok);
assert.ok(qaItem(printfItem, "Giá trị: %s", glossary).errors.includes("TECHNICAL_TOKEN_MISMATCH"));

const metadata = item({ id: "TXT_CV_DEMO", english: "Sample Performer" });
assert.equal(isDeterministicKeepEnglishItem(metadata), true);
assert.ok(qaItem(metadata, "Sample Performer", glossary).ok);
assert.ok(qaItem(metadata, "Sample Performer (diễn viên)", glossary).errors.includes("KEEP_ENGLISH_SOURCE_MISMATCH"));

const repair = buildPrompt([item()], glossary, {
  repairHints: new Map([["DEMO-0001", {
    candidate: "ようこそ、Captain。",
    errors: ["UNEXPECTED_CJK"],
  }]]),
});
assert.match(repair.messages[0].content, /LƯỢT SỬA CÂU BỊ QA TỪ CHỐI/u);
assert.match(repair.messages[1].content, /"repairSource":"ENGLISH_ONLY"/u);
assert.doesNotMatch(repair.messages[1].content, /"japanese"/u);

