import { beforeEach, describe, expect, it } from "vitest";

import {
  findNotebookCell,
  INLINE_SQL_SELECTOR,
  resolveActiveEditorTarget,
  resolveEditorTarget,
  resolveSupportedDocument,
} from "../../src/vscode/document-target.js";
import { __mock } from "../support/vscode-mock.js";

beforeEach(() => { __mock.reset(); });

describe("resolveSupportedDocument", () => {
  it.each(["python", "mo-python"])("resolves standalone %s", (languageId) => {
    const document = __mock.document({
      uri: `file:///query-${languageId}.py`,
      languageId,
    });
    const target = resolveSupportedDocument(document, []);
    expect(target?.documentUri.toString()).toBe(document.uri.toString());
    expect(target?.resourceUri.toString()).toBe(document.uri.toString());
    expect(target?.notebook).toBeUndefined();
  });

  it.each([
    ["file:///raw.ipynb", "json"],
    ["file:///query.sql", "sql"],
  ])("rejects unsupported %s", (uri, languageId) => {
    const document = __mock.document({ uri, languageId });
    expect(resolveSupportedDocument(document, [])).toBeUndefined();
  });

  it("resolves notebook membership before language fallback", () => {
    const document = __mock.document({
      uri: "vscode-notebook-cell:///query#0",
      languageId: "python",
    });
    const notebook = __mock.notebook({
      uri: "file:///query.ipynb",
      notebookType: "jupyter-notebook",
      cells: [document],
    });
    const target = resolveSupportedDocument(document, [notebook]);
    expect(target?.resourceUri.toString()).toBe(notebook.uri.toString());
    expect(target?.cell?.document).toBe(document);
  });

  it.each([
    ["jupyter-notebook", "python"],
    ["marimo-notebook", "python"],
    ["marimo-notebook", "mo-python"],
  ])("resolves supported %s/%s notebook cell", (notebookType, languageId) => {
    const document = __mock.document({
      uri: `vscode-notebook-cell:///query-${notebookType}-${languageId}#0`,
      languageId,
    });
    const notebook = __mock.notebook({
      uri: `file:///query-${notebookType}.ipynb`,
      notebookType,
      cells: [document],
    });
    const target = resolveSupportedDocument(document, [notebook]);
    expect(target?.resourceUri.toString()).toBe(notebook.uri.toString());
    expect(target?.cell?.document.languageId).toBe(languageId);
  });

  it.each([
    ["marimo-notebook", "sql"],
    ["jupyter-notebook", "mo-python"],
    ["custom-notebook", "python"],
  ])("rejects unsupported notebook member %s/%s", (notebookType, languageId) => {
    const document = __mock.document({
      uri: "vscode-notebook-cell:///query#0",
      languageId,
    });
    const notebook = __mock.notebook({
      uri: "file:///query.ipynb",
      notebookType,
      cells: [document],
    });
    expect(resolveSupportedDocument(document, [notebook])).toBeUndefined();
  });

  it("finds the exact cell by URI across open notebooks", () => {
    const document = __mock.document({
      uri: "vscode-notebook-cell:///query#1",
      languageId: "python",
    });
    const unrelated = __mock.document({
      uri: "vscode-notebook-cell:///other#0",
      languageId: "python",
    });
    const notebook = __mock.notebook({
      uri: "file:///query.ipynb",
      notebookType: "jupyter-notebook",
      cells: [unrelated, document],
    });
    expect(findNotebookCell(document, [notebook])?.cell.document).toBe(document);
  });
});

describe("editor targeting", () => {
  it("resolves an editor against workspace notebook membership", () => {
    const document = __mock.document({
      uri: "vscode-notebook-cell:///query#0",
      languageId: "python",
    });
    const notebook = __mock.notebook({
      uri: "file:///query.ipynb",
      notebookType: "jupyter-notebook",
      cells: [document],
    });
    __mock.setNotebookDocuments([notebook]);
    const editor = __mock.editor(document);
    const result = resolveEditorTarget(editor);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.resourceUri.toString()).toBe(notebook.uri.toString());
      expect(result.editor).toBe(editor);
    }
  });

  it("reports no active editor", () => {
    expect(resolveActiveEditorTarget()).toEqual({
      ok: false,
      reason: "NO_ACTIVE_EDITOR",
    });
  });

  it("requires a focused cell when a notebook is active", () => {
    const cell = __mock.document({
      uri: "vscode-notebook-cell:///query#0",
      languageId: "python",
    });
    const notebook = __mock.notebook({
      uri: "file:///query.ipynb",
      notebookType: "jupyter-notebook",
      cells: [cell],
    });
    __mock.setActiveNotebook(notebook);
    __mock.setActiveEditor(undefined);
    expect(resolveActiveEditorTarget()).toEqual({
      ok: false,
      reason: "NOTEBOOK_CELL_FOCUS_REQUIRED",
    });
  });

  it("rejects a non-cell editor while a notebook is focused", () => {
    const cell = __mock.document({
      uri: "vscode-notebook-cell:///query#0",
      languageId: "python",
    });
    const raw = __mock.document({ uri: "file:///query.ipynb", languageId: "json" });
    const notebook = __mock.notebook({
      uri: "file:///query.ipynb",
      notebookType: "jupyter-notebook",
      cells: [cell],
    });
    __mock.setActiveNotebook(notebook);
    __mock.setActiveEditor(__mock.editor(raw));
    expect(resolveActiveEditorTarget()).toEqual({
      ok: false,
      reason: "NOTEBOOK_CELL_FOCUS_REQUIRED",
    });
  });
});

describe("INLINE_SQL_SELECTOR", () => {
  it("contains only approved standalone and notebook pairs", () => {
    expect(INLINE_SQL_SELECTOR).toEqual([
      { language: "python" },
      { language: "mo-python" },
      { notebookType: "jupyter-notebook", language: "python" },
      { notebookType: "marimo-notebook", language: "python" },
      { notebookType: "marimo-notebook", language: "mo-python" },
    ]);
  });
});
