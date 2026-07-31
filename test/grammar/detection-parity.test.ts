import { test } from "vitest";

import { runDetectionParityForVersion } from "../support/detection-parity.js";
import type { GrammarVersion } from "../support/grammar-loader.js";

const requestedVersion = process.env.VSCODE_TEST_VERSION;
if (requestedVersion !== "1.95.0" && requestedVersion !== "stable") {
  throw new Error("VSCODE_TEST_VERSION must be 1.95.0 or stable");
}
const grammarVersion: GrammarVersion = requestedVersion;

test(`${grammarVersion}: detection fixture matches grammar behavior`, async () => {
  await runDetectionParityForVersion(grammarVersion);
}, 120_000);
