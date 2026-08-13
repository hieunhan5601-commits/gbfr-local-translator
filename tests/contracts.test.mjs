import assert from "node:assert/strict";
import test from "node:test";

import { assertImmutableDataset, assertInputContract } from "../src/contracts.mjs";

const source = [{
  File: "text.msg", Row: "1", ID: "TXT_TEST", SubID: "", English: "DMG +{0}%", Japanese: "", Vietnamese: "",
}];

test("dataset contract chấp nhận khi chỉ Vietnamese thay đổi", () => {
  const snapshot = assertInputContract(source);
  assert.equal(snapshot.rowCount, 1);
  const result = assertImmutableDataset(source, [{ ...source[0], Vietnamese: "DMG +{0}%" }]);
  assert.equal(result.status, "PASS");
});

test("dataset contract chặn đổi ID, nguồn hoặc số dòng", () => {
  assert.throws(() => assertImmutableDataset(source, [{ ...source[0], ID: "TXT_OTHER" }]), /DATASET_CONTRACT_MUTATION/);
  assert.throws(() => assertImmutableDataset(source, []), /DATASET_CONTRACT_ROW_COUNT/);
});

test("input contract chặn exact line key trùng", () => {
  assert.throws(() => assertInputContract([source[0], { ...source[0] }]), /DATASET_CONTRACT_DUPLICATE_LINE/);
});
