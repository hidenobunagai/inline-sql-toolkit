import * as vscode from "vscode";

export interface SupportedDocument {
  readonly document: vscode.TextDocument;
  readonly documentUri: vscode.Uri;
  readonly resourceUri: vscode.Uri;
  readonly notebook?: vscode.NotebookDocument;
  readonly cell?: vscode.NotebookCell;
}

export type TargetResolution =
  | { readonly ok: true; readonly target: SupportedDocument; readonly editor: vscode.TextEditor }
  | {
      readonly ok: false;
      readonly reason: "NO_ACTIVE_EDITOR" | "NOTEBOOK_CELL_FOCUS_REQUIRED" | "UNSUPPORTED_DOCUMENT";
    };

export const INLINE_SQL_SELECTOR: vscode.DocumentSelector = [
  { language: "python" },
  { language: "mo-python" },
  { scheme: "vscode-notebook-cell", language: "sql" },
  { notebookType: "jupyter-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "python" },
  { notebookType: "marimo-notebook", language: "mo-python" },
];

const standaloneLanguages = new Set(["python", "mo-python"]);
const notebookPairs = new Set([
  "jupyter-notebook\0python",
  "marimo-notebook\0python",
  "marimo-notebook\0mo-python",
  "marimo-notebook\0sql",
]);

export function findNotebookCell(
  document: vscode.TextDocument,
  notebooks: readonly vscode.NotebookDocument[],
): { notebook: vscode.NotebookDocument; cell: vscode.NotebookCell } | undefined {
  for (const notebook of notebooks) {
    const cell = notebook
      .getCells()
      .find((item) => item.document.uri.toString() === document.uri.toString());
    if (cell !== undefined) return { notebook, cell };
  }
  return undefined;
}

export function resolveSupportedDocument(
  document: vscode.TextDocument,
  notebooks: readonly vscode.NotebookDocument[],
): SupportedDocument | undefined {
  const member = findNotebookCell(document, notebooks);
  if (member !== undefined) {
    if (!notebookPairs.has(`${member.notebook.notebookType}\0${document.languageId}`))
      return undefined;
    return {
      document,
      documentUri: document.uri,
      resourceUri: member.notebook.uri,
      notebook: member.notebook,
      cell: member.cell,
    };
  }
  if (!standaloneLanguages.has(document.languageId)) return undefined;
  return { document, documentUri: document.uri, resourceUri: document.uri };
}

export function resolveEditorTarget(editor: vscode.TextEditor): TargetResolution {
  const target = resolveSupportedDocument(editor.document, vscode.workspace.notebookDocuments);
  return target === undefined
    ? { ok: false, reason: "UNSUPPORTED_DOCUMENT" }
    : { ok: true, target, editor };
}

export function resolveActiveEditorTarget(): TargetResolution {
  const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
  const editor = vscode.window.activeTextEditor;
  if (activeNotebook !== undefined) {
    if (editor === undefined || findNotebookCell(editor.document, [activeNotebook]) === undefined) {
      return { ok: false, reason: "NOTEBOOK_CELL_FOCUS_REQUIRED" };
    }
    return resolveEditorTarget(editor);
  }
  return editor === undefined
    ? { ok: false, reason: "NO_ACTIVE_EDITOR" }
    : resolveEditorTarget(editor);
}
