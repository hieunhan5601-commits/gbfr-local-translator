import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { objectsToCsv, csvToObjects } from "../src/csv.mjs";
import { runHybridProduction } from "../src/hybrid.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("production bảo toàn source và không gọi model cho exact-line context đã khóa", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gbfr-production-contract-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tempRoot, "config"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "data", "context"), { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(ROOT, "config", "glossary.json"), path.join(tempRoot, "config", "glossary.json")),
    fs.copyFile(path.join(ROOT, "config", "overrides.json"), path.join(tempRoot, "config", "overrides.json")),
    fs.copyFile(path.join(ROOT, "tests", "fixtures", "context-layer-synthetic.json"), path.join(tempRoot, "data", "context", "context_layer_fixture.json")),
  ]);
  const database = JSON.parse(await fs.readFile(path.join(ROOT, "tests", "fixtures", "context-layer-synthetic.json"), "utf8"));
  const line = database.lineContexts[0];
  const headers = ["File", "Row", "ID", "SubID", "English", "Japanese", "Vietnamese", "Notes"];
  const sourceRow = {
    File: line.file,
    Row: String(line.row),
    ID: line.id,
    SubID: line.subId,
    English: line.english,
    Japanese: line.japanese,
    Vietnamese: line.currentVietnamese,
    Notes: "",
  };
  const inputPath = path.join(tempRoot, "input.csv");
  await fs.writeFile(inputPath, objectsToCsv([sourceRow], headers), "utf8");
  const config = {
    pipelineVersion: "production-contract-test",
    glossaryFile: "config/glossary.json",
    overridesFile: "config/overrides.json",
    contextDatabaseFile: "data/context/context_layer_fixture.json",
    contextDatabaseRequired: true,
    outputRoot: "runs_hybrid",
  };
  const result = await runHybridProduction({ projectRoot: tempRoot, config, inputPath });
  assert.equal(result.report.datasetContract.status, "PASS");
  assert.equal(result.report.contextLayer.blockedRows, 1);
  assert.equal(result.report.uniqueTranslationUnits, 0);
  const output = csvToObjects(await fs.readFile(path.join(result.runDir, "translated_working.csv"), "utf8")).rows[0];
  for (const column of ["File", "Row", "ID", "SubID", "English", "Japanese"]) {
    assert.equal(output[column], sourceRow[column]);
  }
  assert.equal(output["Local Status"], "APPROVED_CONTEXT_LOCK");
  assert.equal(output.Vietnamese, line.currentVietnamese);
});
