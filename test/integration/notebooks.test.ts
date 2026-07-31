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
  const jupyter = await openJupyterCell(jupyterFixtureUri(), 0);
  assert.equal(jupyter.cell.document.languageId, "python");
  await assertThreeCommandsAndCodeAction(jupyter);
  for (const language of ["python", "mo-python"] as const) {
    const marimo = await openMarimoCell(language, 'query = "select 1"');
    assert.equal(marimo.cell.document.languageId, language);
    await assertThreeCommandsAndCodeAction(marimo);
  }
}

export { focusNotebookCell };
