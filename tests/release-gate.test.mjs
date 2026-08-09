import assert from "node:assert/strict";
import test from "node:test";

import { evaluateReleaseGate, REQUIRED_P0_CHECKS } from "../src/release-gate.mjs";

function passingEvidence() {
  return {
    humanReview: { approved: true, evidence: "review.csv" },
    p0: Object.fromEntries(REQUIRED_P0_CHECKS.map((name) => [name, { status: "PASS", evidence: `${name}.png` }])),
  };
}

test("release gate chặn khi chưa có P0 và QA", () => {
  const result = evaluateReleaseGate({ productionReport: { technicalErrorRows: 0 }, evidence: {} });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.includes("DATASET_CONTRACT_NOT_PASS"));
  assert.ok(result.blockers.includes("HUMAN_REVIEW_NOT_APPROVED"));
  assert.ok(result.blockers.includes("HUMAN_REVIEW_EVIDENCE_MISSING"));
});

test("release gate chỉ PASS khi contract, người duyệt và đủ P0", () => {
  const result = evaluateReleaseGate({
    productionReport: { technicalErrorRows: 0, datasetContract: { status: "PASS" } },
    evidence: passingEvidence(),
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.blockers, []);
});
