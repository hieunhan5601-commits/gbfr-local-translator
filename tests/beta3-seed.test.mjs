import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = path.join(ROOT, "tests", "fixtures", "seed-policy.json");

async function rows() {
  return JSON.parse(await fs.readFile(INPUT, "utf8"));
}

test("fixture chính sách không chứa TECHNICAL_ERROR", async () => {
  const data = await rows();
  assert.ok(data.length > 0);
  assert.equal(data.filter((row) => row["Local Status"] === "TECHNICAL_ERROR").length, 0);
});

test("fixture chính sách giữ riêng dòng đã duyệt v0.15", async () => {
  const data = await rows();
  const approved = data.filter((row) => row["Local Status"] === "APPROVED_EXISTING");
  assert.equal(approved.length, 1);
  assert.equal(approved[0]["Local Source"], "BETA3_APPROVED_V015");
});

test("fixture Sigil Fatebreaker giữ English", async () => {
  const data = (await rows()).filter((row) => /^TXT_GEEN_/u.test(row.ID));
  assert.ok(data.length > 0);
  assert.ok(data.every((row) => row.Vietnamese === row.English && row["Local Status"] === "KEEP_ENGLISH"));
});

test("fixture khóa Miasma Hands bằng English", async () => {
  const data = await rows();
  const row = data.find((item) => item.ID === "TXT_US_PL2900_02");
  assert.ok(row);
  assert.equal(row.Vietnamese, "Miasma Hands");
  assert.equal(row["Local Status"], "KEEP_ENGLISH");
});

test("fixture dòng dấu hai chấm là review ngữ nghĩa", async () => {
  const data = await rows();
  const row = data.find((item) => item.ID === "TXT_CMDLIST_PL2700_INFO");
  assert.ok(row);
  assert.equal(row["Local Status"], "REVIEW");
  assert.match(row["Local Source"], /TECHNICAL_FALSE_POSITIVE/u);
});

test("fixture tên đã khóa luôn giữ nguyên English", async () => {
  const data = (await rows()).filter((row) => row["Local Source"] === "BETA3_PROTECTED_NAME_ID");
  assert.ok(data.length > 0);
  assert.ok(data.every((row) => row.Vietnamese === row.English && row["Local Status"] === "KEEP_ENGLISH"));
});

test("fixture hàng chờ không gồm bản đã duyệt và tên đã khóa", async () => {
  const data = await rows();
  const review = data.filter((row) => ["REVIEW", "REVIEW_MANDATORY"].includes(row["Local Status"]));
  assert.ok(review.length > 0);
  assert.ok(review.every((row) => !["BETA3_APPROVED_V015", "BETA3_PROTECTED_NAME_ID"].includes(row["Local Source"])));
});
