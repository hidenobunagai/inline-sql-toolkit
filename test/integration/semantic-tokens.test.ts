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

function overlapsSql(ranges: readonly vscode.Range[], sqlRanges: readonly vscode.Range[]): boolean {
  return ranges.some((range) =>
    sqlRanges.some((sql) => range.start.isBefore(sql.end) && sql.start.isBefore(range.end)),
  );
}

export async function testSemanticTokenIsolation(): Promise<void> {
  // This extension disables semantic highlighting for Python by default via
  // configurationDefaults. Enable it in the test workspace so the provider
  // and the editor-level token stream can be exercised.
  await vscode.workspace
    .getConfiguration("editor", { languageId: "python" })
    .update("semanticHighlighting.enabled", true, vscode.ConfigurationTarget.Workspace);

  const document = await openStandaloneFixture("python");
  await vscode.window.showTextDocument(document);
  await replaceWholeDocument(document, preserveFinalNewline(document, 'query = "SELECT 1"'));
  const sqlRanges = [physicalSqlRange(document)];

  // While the probe extension is not yet activated, this extension is the
  // only semantic token provider; the editor-level stream must cover the SQL
  // range with its own tokens.
  const beforeProbe = decodeSemanticTokens(document, await provideFullSemanticTokens(document));
  assert.ok(
    overlapsSql(beforeProbe, sqlRanges),
    "extension tokens should be served while it is the only semantic token provider",
  );

  // VS Code serves semantic tokens from the last-registered provider. Once
  // the probe activates, its provider is registered after this extension and
  // the editor-level stream switches to the probe's tokens.
  const probe = vscode.extensions.getExtension("inline-sql-tests.inline-sql-semantic-probe");
  if (probe === undefined) throw new Error("semantic probe extension was not loaded");
  await probe.activate();
  await vscode.commands.executeCommand("inlineSql.semanticProbe.setMode", "safe");
  const afterProbe = decodeSemanticTokens(document, await provideFullSemanticTokens(document));
  assert.ok(
    !overlapsSql(afterProbe, sqlRanges),
    "probe-safe mode should leave the SQL range untouched",
  );
}
