import { strict as assert } from "node:assert";

import * as vscode from "vscode";

import {
  assertThreeCommandsAndCodeAction,
  focusNotebookCell,
  openJupyterCell,
  openMarimoCell,
  workspaceRoot,
} from "../support/vscode-harness.js";

function jupyterFixtureUri(): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot(), "jupyter.ipynb");
}

export async function testNotebookFormatting(): Promise<void> {
  const notebooks: vscode.NotebookDocument[] = [];
  try {
    const jupyter = await openJupyterCell(jupyterFixtureUri(), 0);
    notebooks.push(jupyter.notebook);
    assert.equal(jupyter.cell.document.languageId, "python");
    await assertThreeCommandsAndCodeAction(jupyter);
    for (const language of ["python", "mo-python"] as const) {
      const marimo = await openMarimoCell(language, 'query = "select 1"');
      notebooks.push(marimo.notebook);
      assert.equal(marimo.cell.document.languageId, language);
      await assertThreeCommandsAndCodeAction(marimo);
    }
  } finally {
    for (const notebook of notebooks.reverse()) {
      try {
        await vscode.window.showNotebookDocument(notebook);
        await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      } catch {
        // The temporary host may already have closed the notebook editor.
      }
      if (notebook.uri.scheme === "file" && notebook.uri.path.endsWith(".marimo-test")) {
        try {
          await vscode.workspace.fs.delete(notebook.uri, { useTrash: false });
        } catch {
          // The scenario root is disposable even when the editor is already gone.
        }
      }
    }
    await vscode.window.showTextDocument(vscode.Uri.joinPath(workspaceRoot(), "queries.py"));
  }
}

export { focusNotebookCell };
