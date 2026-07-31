import { expect, test } from "vitest";

import {
  assertDownloadedVSCodeVersion,
  type GrammarVersion,
  loadGrammarCases,
  verifyPep701GrammarCase,
} from "../support/grammar-loader.js";

const requestedVersion = process.env.VSCODE_TEST_VERSION;
if (requestedVersion !== "1.95.0" && requestedVersion !== "stable") {
  throw new Error("VSCODE_TEST_VERSION must be 1.95.0 or stable");
}
const grammarVersion: GrammarVersion = requestedVersion;
const grammarCases = loadGrammarCases("pep701-grammar-cases.json");

test(`${grammarVersion}: stable version mismatch is rejected`, () => {
  expect(() => {
    assertDownloadedVSCodeVersion("stable", "1.95.0", "1.131.0");
  }).toThrow(/expected stable/i);
});

for (const testCase of grammarCases) {
  test(`${grammarVersion}: ${testCase.language}: ${testCase.id}`, async () => {
    await verifyPep701GrammarCase(grammarVersion, testCase);
  }, 120_000);
}
