import { strict as assert } from "node:assert";

import * as vscode from "vscode";

import { type HookSnapshot, TEST_HOOK_COMMANDS } from "../../src/vscode/test-hooks.js";
import { openStandaloneFixture, selectNeedle } from "../support/vscode-harness.js";

export async function testUntrustedHighlightOnly(): Promise<void> {
  assert.equal(vscode.workspace.isTrusted, false);
  const document = await openStandaloneFixture("python");
  const editor = await vscode.window.showTextDocument(document);
  selectNeedle(document, editor, false);
  const before = document.getText();
  const actions = await vscode.commands.executeCommand<readonly vscode.CodeAction[] | undefined>(
    "vscode.executeCodeActionProvider",
    document.uri,
    editor.selection,
    vscode.CodeActionKind.RefactorRewrite.value,
  );
  assert.equal(actions?.some((action) => action.title === "Format inline SQL") ?? false, false);
  await vscode.commands.executeCommand("inlineSql.formatAtCursor");
  assert.equal(document.getText(), before);
  const hooks = await vscode.commands.executeCommand<HookSnapshot>(TEST_HOOK_COMMANDS.read);
  assert.deepEqual(hooks.spawnCounts, { version: 0, helper: 0 });
}
