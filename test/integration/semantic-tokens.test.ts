import { strict as assert } from "node:assert";

import * as vscode from "vscode";

import {
  assertNoSemanticSqlOverlap,
  decodeSemanticTokens,
  openStandaloneFixture,
  physicalSqlRange,
  preserveFinalNewline,
  provideFullSemanticTokens,
  replaceWholeDocument,
} from "../support/vscode-harness.js";

export async function testSemanticTokenIsolation(): Promise<void> {
  const document = await openStandaloneFixture("python");
  const probe = vscode.extensions.getExtension("inline-sql-tests.inline-sql-semantic-probe");
  if (probe === undefined) throw new Error("semantic probe extension was not loaded");
  await probe.activate();
  await replaceWholeDocument(document, preserveFinalNewline(document, 'query = "SELECT 1"'));
  await vscode.window.showTextDocument(document);
  const sqlRanges = [physicalSqlRange(document)];
  await vscode.commands.executeCommand("inlineSql.semanticProbe.setMode", "overlap");
  const overlapping = decodeSemanticTokens(document, await provideFullSemanticTokens(document));
  assert.throws(() => {
    assertNoSemanticSqlOverlap(overlapping, sqlRanges);
  });
  await vscode.commands.executeCommand("inlineSql.semanticProbe.setMode", "safe");
  const safe = decodeSemanticTokens(document, await provideFullSemanticTokens(document));
  assertNoSemanticSqlOverlap(safe, sqlRanges);
}
