import * as vscode from "vscode";

import { type IntegrationScenario, parseScenario } from "../support/integration-scenario.js";
import { registerMarimoTestSerializer, withTimeout } from "../support/vscode-harness.js";
import { testOfficialExtensionCompatibility } from "./compatibility.test.js";
import { testApplyRaces, testStandaloneFormatting } from "./extension.test.js";
import { testNotebookFormatting } from "./notebooks.test.js";
import { testSemanticTokenIsolation } from "./semantic-tokens.test.js";
import { testUntrustedHighlightOnly } from "./untrusted.test.js";

function assertNeverScenario(value: never): never {
  void value;
  throw new Error("unreachable integration scenario");
}

export const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

export function runIntegrationTest(
  test: () => Promise<void>,
  timeoutMs = INTEGRATION_TEST_TIMEOUT_MS,
): Promise<void> {
  return withTimeout(test(), timeoutMs);
}

export function scenarioTests(scenario: IntegrationScenario): readonly (() => Promise<void>)[] {
  switch (scenario) {
    case "trusted":
      return [
        testStandaloneFormatting,
        testNotebookFormatting,
        testSemanticTokenIsolation,
        testApplyRaces,
      ];
    case "untrusted":
      return [testUntrustedHighlightOnly];
    case "compatibility":
      return [testOfficialExtensionCompatibility];
    default:
      return assertNeverScenario(scenario);
  }
}

export async function run(): Promise<void> {
  const scenario = parseScenario(process.env.INLINE_SQL_TEST_SCENARIO);
  const product = vscode.extensions.getExtension("hidenobunagai.inline-sql-toolkit");
  if (product === undefined) throw new Error("product extension was not loaded");
  await product.activate();
  const tests = scenarioTests(scenario);
  const failures: unknown[] = [];
  const serializer = scenario === "compatibility" ? undefined : registerMarimoTestSerializer();
  try {
    for (const test of tests) {
      try {
        await runIntegrationTest(test);
      } catch (error) {
        failures.push(error);
        if (error instanceof Error && error.message === "integration assertion timed out") break;
      }
    }
  } finally {
    serializer?.dispose();
  }
  if (failures.length > 0) {
    const detail = failures
      .map(
        (failure, index) =>
          `${index + 1}: ${failure instanceof Error ? (failure.stack ?? failure.message) : String(failure)}`,
      )
      .join("\n");
    throw new AggregateError(failures, `Inline SQL integration tests failed\n${detail}`);
  }
}
