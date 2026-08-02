import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";

import {
  findNotebookCell,
  INLINE_SQL_SELECTOR,
  resolveActiveEditorTarget,
  resolveEditorTarget,
  resolveSupportedDocument,
} from "../../src/vscode/document-target.js";
import { __mock } from "../support/vscode-mock.js";

beforeEach(() => {
  __mock.reset();
});

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
      { scheme: "vscode-notebook-cell", language: "sql" },
      { notebookType: "jupyter-notebook", language: "python" },
      { notebookType: "marimo-notebook", language: "python" },
      { notebookType: "marimo-notebook", language: "mo-python" },
    ]);
  });
});

describe("VS Code unit-test mock fidelity", () => {
  it("preserves CRLF and lone-CR line offsets", () => {
    const crlf = __mock.document({ uri: "file:///crlf.py", languageId: "python", text: "a\r\nb" });
    expect(crlf.eol).toBe(vscode.EndOfLine.CRLF);
    expect(crlf.lineCount).toBe(2);
    expect(crlf.lineAt(0).rangeIncludingLineBreak.end).toEqual(new vscode.Position(1, 0));
    expect(crlf.offsetAt(new vscode.Position(1, 0))).toBe(3);
    expect(crlf.positionAt(3)).toEqual(new vscode.Position(1, 0));
    expect(crlf.positionAt(2)).toEqual(new vscode.Position(0, 1));
    expect(
      crlf.getText(new vscode.Range(new vscode.Position(0, 1), new vscode.Position(1, 1))),
    ).toBe("\r\nb");

    const loneCr = __mock.document({ uri: "file:///cr.py", languageId: "python", text: "a\rb" });
    expect(loneCr.lineCount).toBe(2);
    expect(loneCr.offsetAt(new vscode.Position(1, 0))).toBe(2);
    expect(loneCr.positionAt(2)).toEqual(new vscode.Position(1, 0));
  });

  it("keeps WorkspaceEdit entries scoped to their requested URI", () => {
    const first = vscode.Uri.parse("file:///first.py");
    const second = vscode.Uri.parse("file:///second.py");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      first,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
      "x",
    );
    edit.replace(
      second,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
      "y",
    );
    expect(edit.has(first)).toBe(true);
    expect(edit.has(second)).toBe(true);
    expect(edit.get(first)).toHaveLength(1);
    expect(edit.get(first)[0]?.newText).toBe("x");
    edit.set(first, [
      {
        range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
        newText: "z",
      },
    ]);
    expect(edit.get(first)).toHaveLength(1);
    expect(edit.get(first)[0]?.newText).toBe("z");
    expect(edit.size).toBe(2);
    expect(edit.entries().map(([uri]) => uri.toString())).toEqual([
      first.toString(),
      second.toString(),
    ]);
  });

  it("routes registered commands and tracks code-action providers", async () => {
    const command = vscode.commands.registerCommand(
      "inlineSql.test.mock",
      (value: unknown) => value,
    );
    expect(__mock.commandRegistrations().map((item) => item.command)).toContain(
      "inlineSql.test.mock",
    );
    await expect(vscode.commands.executeCommand("inlineSql.test.mock", "ok")).resolves.toBe("ok");
    const provider = {} as vscode.CodeActionProvider;
    const providerRegistration = vscode.languages.registerCodeActionsProvider(
      [{ language: "python" }],
      provider,
    );
    expect(__mock.codeActionRegistrations()).toHaveLength(1);
    providerRegistration.dispose();
    command.dispose();
    expect(__mock.commandRegistrations()).toHaveLength(0);
  });

  it("fires and resets document lifecycle events", () => {
    const document = __mock.document({ uri: "file:///events.py", languageId: "python" });
    let changed = 0;
    let closed = 0;
    vscode.workspace.onDidChangeTextDocument(() => {
      changed += 1;
    });
    vscode.workspace.onDidCloseTextDocument(() => {
      closed += 1;
    });
    __mock.fireTextDocumentChange(document);
    __mock.fireTextDocumentClose(document);
    expect({ changed, closed }).toEqual({ changed: 1, closed: 1 });
    __mock.reset();
    __mock.fireTextDocumentChange(document);
    __mock.fireTextDocumentClose(document);
    expect({ changed, closed }).toEqual({ changed: 1, closed: 1 });
  });
});
