import { strict as assert } from "node:assert";

import * as vscode from "vscode";

import {
  assertThreeCommandsAndCodeAction,
  focusNotebookCell,
  openJupyterCell,
  openStandaloneFixture,
  waitForNotebookDocument,
  workspaceRoot,
} from "../support/vscode-harness.js";
import {
  assertAllCommandAndSingleUndo,
  assertFormattingCodeAction,
  assertFstringAndPartialSuccess,
  assertNoDocumentFormattingProvider,
  assertSingleCommandAndUndo,
} from "../support/vscode-harness.js";

export async function testOfficialExtensionCompatibility(): Promise<void> {
  if (vscode.extensions.getExtension("inline-sql-tests.inline-sql-semantic-probe") !== undefined) {
    throw new Error("compatibility mode must not install the semantic test fixture");
  }
  for (const id of ["ms-python.python", "ms-toolsai.jupyter", "marimo-team.vscode-marimo"]) {
    const extension = vscode.extensions.getExtension(id);
    if (extension === undefined) throw new Error(`missing ${id}`);
    await extension.activate();
  }
  for (const language of ["python", "mo-python"] as const) {
    const document = await openStandaloneFixture(language);
    const editor = await vscode.window.showTextDocument(document);
    await assertSingleCommandAndUndo(document, editor, "inlineSql.formatAtCursor");
    await assertSingleCommandAndUndo(document, editor, "inlineSql.formatSelection");
    await assertAllCommandAndSingleUndo(document, editor);
    // The official provider must still leave f-string fields and unsupported
    // candidates untouched while the safe candidate is formatted.
    await assertFstringAndPartialSuccess(document, editor);
    await assertFormattingCodeAction(document, editor);
    await assertNoDocumentFormattingProvider(document);
  }
  const jupyter = await openJupyterCell(vscode.Uri.joinPath(workspaceRoot(), "jupyter.ipynb"), 0);
  await assertThreeCommandsAndCodeAction(jupyter);

  const marimoUri = vscode.Uri.joinPath(workspaceRoot(), "marimo.py");
  const opened = waitForNotebookDocument(marimoUri, 30_000);
  await vscode.commands.executeCommand("vscode.openWith", marimoUri, "marimo-notebook");
  const notebook = await opened;
  assert.equal(notebook.notebookType, "marimo-notebook");
  const codeCellIndex = notebook
    .getCells()
    .findIndex((cell) => cell.kind === vscode.NotebookCellKind.Code);
  if (codeCellIndex < 0) throw new Error("official marimo serializer returned no code cell");
  const marimo = await focusNotebookCell(notebook, codeCellIndex);
  assert.equal(marimo.cell.document.languageId, "mo-python");
  await assertThreeCommandsAndCodeAction(marimo);
}
