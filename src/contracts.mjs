import crypto from "node:crypto";

export const IMMUTABLE_COLUMNS = Object.freeze([
  "File",
  "Row",
  "ID",
  "SubID",
  "English",
  "Japanese",
]);

function value(row, column) {
  return String(row?.[column] ?? "");
}

export function lineIdentity(row) {
  return ["File", "Row", "ID", "SubID"].map((column) => value(row, column)).join("\u001f");
}

export function immutableSnapshot(rows) {
  const hash = crypto.createHash("sha256");
  for (const row of rows) {
    hash.update(IMMUTABLE_COLUMNS.map((column) => value(row, column)).join("\u001e"));
    hash.update("\u001d");
  }
  return { rowCount: rows.length, sha256: hash.digest("hex") };
}

export function assertInputContract(rows) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    const identity = lineIdentity(row);
    if (seen.has(identity)) throw new Error(`DATASET_CONTRACT_DUPLICATE_LINE:${index + 1}:${identity}`);
    seen.add(identity);
  }
  return immutableSnapshot(rows);
}

export function assertImmutableDataset(sourceRows, outputRows) {
  if (sourceRows.length !== outputRows.length) {
    throw new Error(`DATASET_CONTRACT_ROW_COUNT:${sourceRows.length}:${outputRows.length}`);
  }
  for (let index = 0; index < sourceRows.length; index += 1) {
    for (const column of IMMUTABLE_COLUMNS) {
      if (value(sourceRows[index], column) !== value(outputRows[index], column)) {
        throw new Error(`DATASET_CONTRACT_MUTATION:${index + 1}:${column}`);
      }
    }
  }
  const source = immutableSnapshot(sourceRows);
  const output = immutableSnapshot(outputRows);
  if (source.sha256 !== output.sha256) throw new Error("DATASET_CONTRACT_HASH_MISMATCH");
  return { status: "PASS", immutableColumns: IMMUTABLE_COLUMNS, source, output };
}
