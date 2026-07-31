import { test } from "vitest";

import {
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

for (const testCase of grammarCases) {
  test(`${grammarVersion}: ${testCase.language}: ${testCase.id}`, async () => {
    await verifyPep701GrammarCase(grammarVersion, testCase);
  }, 120_000);
}
