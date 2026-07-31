import { strict as assert } from "node:assert";

import * as vscode from "vscode";

import {
  decodeSemanticTokens,
  openStandaloneFixture,
  physicalSqlRange,
  preserveFinalNewline,
  provideFullSemanticTokens,
  replaceWholeDocument,
} from "../support/vscode-harness.js";

function overlapsSql(
  ranges: readonly vscode.Range[],
  sqlRanges: readonly vscode.Range[],
): boolean {
  return ranges.some((range) =>
    sqlRanges.some(
      (sql) => range.start.isBefore(sql.end) && sql.start.isBefore(range.end),
    ),
  );
}

export async function testSemanticTokenIsolation(): Promise<void> {
  const document = await openStandaloneFixture("python");
  await vscode.window.showTextDocument(document);
  await replaceWholeDocument(document, preserveFinalNewline(document, 'query = "SELECT 1"'));
  const sqlRanges = [physicalSqlRange(document)];

  const { createInlineSqlSemanticTokensProvider } = await import(
    "../../src/vscode/semantic-tokens.js"
  );
  const { provider } = createInlineSqlSemanticTokensProvider();
  const token = new vscode.CancellationTokenSource().token;
  const direct = await provider.provideDocumentSemanticTokens(document, token);
  if (direct === null || direct === undefined) {
    throw new Error("extension semantic provider returned no tokens");
  }
  assert.ok(
    overlapsSql(decodeSemanticTokens(document, direct), sqlRanges),
    "extension semantic provider should cover the SQL range",
  );

  const probe = vscode.extensions.getExtension("inline-sql-tests.inline-sql-semantic-probe");
  if (probe === undefined) throw new Error("semantic probe extension was not loaded");

  const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
    "vscode.provideDocumentSemanticTokensLegend",
    document.uri,
  );
  assert.ok(
    legend?.tokenTypes.includes("inlineSqlKeyword"),
    "semantic token provider should match the python document",
  );

  const beforeProbe = decodeSemanticTokens(
    document,
    await provideFullSemanticTokens(document),
  );
  assert.ok(
    overlapsSql(beforeProbe, sqlRanges),
    "extension tokens should be served while it is the only semantic token provider",
  );

  await probe.activate();
  await vscode.commands.executeCommand("inlineSql.semanticProbe.setMode", "safe");
  const served = decodeSemanticTokens(document, await provideFullSemanticTokens(document));
  assert.ok(
    !overlapsSql(served, sqlRanges),
    "editor-level tokens belong to the first provider (the probe), not to this extension",
  );
}
