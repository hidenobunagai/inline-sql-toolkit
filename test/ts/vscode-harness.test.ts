import { strict as assert } from "node:assert";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import {
  decodeTestNotebookWire,
  encodeTestNotebookWire,
  waitForActiveTextEditor,
  waitForNotebookDocument,
} from "../support/vscode-harness.js";
import { __mock } from "../support/vscode-mock.js";

afterEach(() => {
  vi.useRealTimers();
  __mock.reset();
});

function makeDocument(uri: string): vscode.TextDocument {
  return __mock.document({ uri, languageId: "python", text: 'query = "select 1"' });
}

describe("waitForActiveTextEditor", () => {
  it("returns an already-focused matching editor without subscribing", async () => {
    const editor = __mock.editor(makeDocument("file:///target.py"));
    __mock.setActiveEditor(editor);

    await expect(waitForActiveTextEditor(editor.document.uri, 25)).resolves.toBe(editor);
    expect(__mock.activeEditorListenerCount()).toBe(0);
  });

  it("resolves when the matching event arrives after subscription", async () => {
    const editor = __mock.editor(makeDocument("file:///target.py"));
    const pending = waitForActiveTextEditor(editor.document.uri, 25);
    __mock.setActiveEditor(editor);

    await expect(pending).resolves.toBe(editor);
    expect(__mock.activeEditorListenerCount()).toBe(0);
  });

  it("closes the synchronous subscribe-gap race", async () => {
    const editor = __mock.editor(makeDocument("file:///target.py"));
    __mock.fireActiveEditorDuringNextSubscription(editor);

    await expect(waitForActiveTextEditor(editor.document.uri, 25)).resolves.toBe(editor);
    expect(__mock.activeEditorListenerCount()).toBe(0);
  });

  it("ignores a wrong target until the exact editor arrives", async () => {
    const target = __mock.editor(makeDocument("file:///target.py"));
    const other = __mock.editor(makeDocument("file:///other.py"));
    const pending = waitForActiveTextEditor(target.document.uri, 25);
    __mock.setActiveEditor(other);
    await Promise.resolve();
    expect(__mock.activeEditorListenerCount()).toBe(1);
    __mock.setActiveEditor(target);

    await expect(pending).resolves.toBe(target);
    expect(__mock.activeEditorListenerCount()).toBe(0);
  });

  it("rejects on timeout and removes its listener", async () => {
    vi.useFakeTimers();
    const target = makeDocument("file:///target.py");
    const pending = waitForActiveTextEditor(target.uri, 25);
    const rejection = expect(pending).rejects.toThrow("cell editor focus timed out");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(__mock.activeEditorListenerCount()).toBe(0);
  });
});

describe("waitForNotebookDocument", () => {
  it("returns an already-open exact notebook without subscribing", async () => {
    const notebook = __mock.notebook({
      uri: "file:///target.ipynb",
      notebookType: "jupyter-notebook",
      cells: [makeDocument("vscode-notebook-cell:///target.ipynb#0")],
    });
    __mock.setNotebookDocuments([notebook]);

    await expect(waitForNotebookDocument(notebook.uri, 25)).resolves.toBe(notebook);
    expect(__mock.notebookListenerCount()).toBe(0);
  });

  it("resolves when the matching notebook-open event arrives", async () => {
    const notebook = __mock.notebook({
      uri: "file:///target.ipynb",
      notebookType: "jupyter-notebook",
      cells: [makeDocument("vscode-notebook-cell:///target.ipynb#0")],
    });
    const pending = waitForNotebookDocument(notebook.uri, 25);
    __mock.fireNotebookDocument(notebook);

    await expect(pending).resolves.toBe(notebook);
    expect(__mock.notebookListenerCount()).toBe(0);
  });

  it("closes the synchronous notebook subscribe-gap race", async () => {
    const notebook = __mock.notebook({
      uri: "file:///target.ipynb",
      notebookType: "jupyter-notebook",
      cells: [makeDocument("vscode-notebook-cell:///target.ipynb#0")],
    });
    __mock.fireNotebookDuringNextSubscription(notebook);

    await expect(waitForNotebookDocument(notebook.uri, 25)).resolves.toBe(notebook);
    expect(__mock.notebookListenerCount()).toBe(0);
  });

  it("ignores a wrong notebook target until the exact URI arrives", async () => {
    const target = __mock.notebook({
      uri: "file:///target.ipynb",
      notebookType: "jupyter-notebook",
      cells: [makeDocument("vscode-notebook-cell:///target.ipynb#0")],
    });
    const other = __mock.notebook({
      uri: "file:///other.ipynb",
      notebookType: "jupyter-notebook",
      cells: [makeDocument("vscode-notebook-cell:///other.ipynb#0")],
    });
    const pending = waitForNotebookDocument(target.uri, 25);
    __mock.fireNotebookDocument(other);
    await Promise.resolve();
    expect(__mock.notebookListenerCount()).toBe(1);
    __mock.fireNotebookDocument(target);

    await expect(pending).resolves.toBe(target);
    expect(__mock.notebookListenerCount()).toBe(0);
  });

  it("rejects on timeout and removes its listener", async () => {
    vi.useFakeTimers();
    const target = vscode.Uri.file("/target.ipynb");
    const pending = waitForNotebookDocument(target, 25);
    const rejection = expect(pending).rejects.toThrow("notebook open timed out");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(__mock.notebookListenerCount()).toBe(0);
  });
});

describe("marimo serializer wire", () => {
  it("round-trips the exact serialize/deserialize wire payload", () => {
    const wire = {
      cells: [
        { kind: "code", language: "python", text: 'query = "select 1"' },
        { kind: "markup", language: "markdown", text: "# sibling" },
      ],
    } as const;
    const decoded = decodeTestNotebookWire(encodeTestNotebookWire(wire));
    assert.deepEqual(decoded, wire);
  });
});
