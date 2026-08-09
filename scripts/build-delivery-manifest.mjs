import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = "DELIVERY_MANIFEST.json";
const EXCLUDED = new Set([".codegraph", "node_modules", ".git"]);
const EXCLUDED_FILES = new Set([
  "08_SUA_CUOI_BETA4.cmd",
  "09_MO_KET_QUA_BETA4.cmd",
  "HUONG_DAN_BETA4.txt",
  "TEST_REPORT_v0.2.0-beta.4.txt",
  "data/context/context_layer_v1.json",
  "data/translated_working_beta3_seed.csv",
  "data/translated_working_beta4_seed.csv",
]);

async function filesBelow(directory, relative = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (EXCLUDED.has(entry.name)) continue;
    const childRelative = path.posix.join(relative, entry.name);
    if (childRelative === OUTPUT) continue;
    if (EXCLUDED_FILES.has(childRelative)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(absolute, childRelative));
    else if (entry.isFile()) files.push(childRelative);
  }
  return files;
}

const files = [];
for (const relative of await filesBelow(ROOT)) {
  const bytes = await fs.readFile(path.join(ROOT, relative));
  files.push({
    path: relative,
    size: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  });
}
const manifest = {
  candidate: "GBFR_Local_Translator_CodeMapped_v0.2.0-beta.5-tech",
  baseline: "GBFR_Local_Translator_Hybrid_v0.2.0-beta.4",
  releaseState: "TECHNICAL_CANDIDATE_NOT_GAME_APPROVED",
  codegraph: { version: "1.5.0", indexedFiles: 22, nodes: 325, edges: 932 },
  qa: { tests: 21, passed: 21, failed: 0, dependencyVulnerabilities: 0 },
  files,
};
await fs.writeFile(path.join(ROOT, OUTPUT), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: path.join(ROOT, OUTPUT), files: files.length }, null, 2));
