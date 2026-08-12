import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function walk(directory) {
  const output = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full));
    else output.push(path.relative(ROOT, full).replaceAll(path.sep, "/"));
  }
  return output;
}

const files = await walk(ROOT);
const forbidden = files.filter((file) => (
  /(^|\/)progress\//u.test(file)
  || /(^|\/)story_job\.json$/u.test(file)
  || /(^|\/)glossary\.json$/u.test(file)
  || /\.jsonl$/u.test(file)
  || /\.msg$/u.test(file)
  || /story_translation_results\.json$/u.test(file)
));
assert.deepEqual(forbidden, [], `Public tree contains protected runtime data: ${forbidden.join(", ")}`);

const example = JSON.parse(await fsp.readFile(path.join(ROOT, "story-worker/data/story_job.example.json"), "utf8"));
assert.equal(example.source, "Synthetic example; contains no extracted game data");
assert.equal(example.items.length, 3);
assert.equal(new Set(example.items.map((entry) => entry.key)).size, example.items.length);

const archive = path.join(ROOT, "releases/GBFR_Story_Complete_Worker_v1_8_Final_Recovery_Hotfix_2026-08-12.zip");
const checksum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
assert.equal(checksum, "917339f9e2a7d7a0188710d4c409b5d832d781c9bf975bb787b29f98c536a994");

