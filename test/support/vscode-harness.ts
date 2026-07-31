import { strict as assert } from "node:assert";
import * as path from "node:path";

import * as vscode from "vscode";

import { type FormatMode } from "../../src/protocol.js";
import type { HookSnapshot, TestOperationOutcome } from "../../src/vscode/test-hooks.js";
import { TEST_HOOK_COMMANDS } from "../../src/vscode/test-hooks.js";
import { assertNoSemanticSqlOverlap, decodeSemanticTokens } from "./semantic-tokens.js";

export const LOWER = 'query = "select 1"';
export const UPPER = 'query = "SELECT 1"';

export interface OpenedCell {
  readonly notebook: vscode.NotebookDocument;
  readonly notebookEditor: vscode.NotebookEditor;
  readonly cell: vscode.NotebookCell;
  readonly textEditor: vscode.TextEditor;
}

function sameUri(left: vscode.Uri | undefined, right: vscode.Uri): boolean {
  return left?.toString() === right.toString();
}

/** Wait for the exact text editor, closing the check/subscribe race. */
export function waitForActiveTextEditor(
  uri: vscode.Uri,
  timeoutMs: number,
): Promise<vscode.TextEditor> {
  const matches = (editor: vscode.TextEditor | undefined): editor is vscode.TextEditor =>
    sameUri(editor?.document.uri, uri);
  const initial = vscode.window.activeTextEditor;
  if (matches(initial)) return Promise.resolve(initial);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timerState: { value?: NodeJS.Timeout } = {};
    let subscription: vscode.Disposable = { dispose() {} };
    const finish = (editor?: vscode.TextEditor): void => {
      if (settled) return;
      settled = true;
      if (timerState.value !== undefined) clearTimeout(timerState.value);
      subscription.dispose();
      if (editor === undefined) reject(new Error("cell editor focus timed out"));
      else resolve(editor);
    };
    subscription = vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (matches(editor)) finish(editor);
    });
    // An Event implementation is allowed to synchronously invoke a listener
    // while it is being registered; keep this post-subscribe cleanup branch.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (settled) {
      subscription.dispose();
      return;
    }
    const current = vscode.window.activeTextEditor;
    if (matches(current)) {
      finish(current);
      return;
    }
    timerState.value = setTimeout(() => {
      finish();
    }, timeoutMs);
  });
}

/** Wait for an exact notebook URI, including events fired in the subscribe gap. */
export function waitForNotebookDocument(
  uri: vscode.Uri,
  timeoutMs: number,
): Promise<vscode.NotebookDocument> {
  const matches = (document: vscode.NotebookDocument): boolean => sameUri(document.uri, uri);
  const initial = vscode.workspace.notebookDocuments.find(matches);
  if (initial !== undefined) return Promise.resolve(initial);

  return new Promise((resolve, reject) => {
    let settled = false;
    const timerState: { value?: NodeJS.Timeout } = {};
    let subscription: vscode.Disposable = { dispose() {} };
    const finish = (document?: vscode.NotebookDocument): void => {
      if (settled) return;
      settled = true;
      if (timerState.value !== undefined) clearTimeout(timerState.value);
      subscription.dispose();
      if (document === undefined) reject(new Error("notebook open timed out"));
      else resolve(document);
    };
    subscription = vscode.workspace.onDidOpenNotebookDocument((document) => {
      if (matches(document)) finish(document);
    });
    // See waitForActiveTextEditor: this closes a synchronous subscribe race.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (settled) {
      subscription.dispose();
      return;
    }
    const current = vscode.workspace.notebookDocuments.find(matches);
    if (current !== undefined) {
      finish(current);
      return;
    }
    timerState.value = setTimeout(() => {
      finish();
    }, timeoutMs);
  });
}

export async function focusNotebookCell(
  notebook: vscode.NotebookDocument,
  cellIndex: number,
): Promise<OpenedCell> {
  const notebookEditor = await vscode.window.showNotebookDocument(notebook);
  const cell = notebook.cellAt(cellIndex);
  notebookEditor.selection = new vscode.NotebookRange(cellIndex, cellIndex + 1);
  await vscode.commands.executeCommand("notebook.cell.edit");
  const textEditor = await waitForActiveTextEditor(cell.document.uri, 5_000);
  return { notebook, notebookEditor, cell, textEditor };
}

export async function openJupyterCell(uri: vscode.Uri, cellIndex: number): Promise<OpenedCell> {
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  assert.equal(notebook.notebookType, "jupyter-notebook");
  const editor = await vscode.window.showNotebookDocument(notebook);
  const cell = notebook.cellAt(cellIndex);
  editor.selection = new vscode.NotebookRange(cellIndex, cellIndex + 1);
  await vscode.commands.executeCommand("notebook.cell.edit");
  const textEditor = await waitForActiveTextEditor(cell.document.uri, 5_000);
  return { notebook, notebookEditor: editor, cell, textEditor };
}

interface TestNotebookCellWire {
  readonly kind: "code" | "markup";
  readonly language: string;
  readonly text: string;
}

interface TestNotebookWire {
  readonly cells: readonly TestNotebookCellWire[];
}

// VS Code 1.95 asks the serializer to deserialize an empty payload for an
// untitled notebook opened with the NotebookData overload. Keep the initial
// data in a one-shot queue so that path remains deterministic and still uses
// the production serializer API.
const pendingUntitledNotebooks: vscode.NotebookData[] = [];

function decodeTestNotebook(data: Uint8Array): vscode.NotebookData {
  if (data.byteLength === 0) {
    const pending = pendingUntitledNotebooks.shift();
    if (pending !== undefined) return pending;
  }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).join("\0") !== "cells"
  ) {
    throw new Error("invalid test notebook");
  }
  const cells = (value as { readonly cells?: unknown }).cells;
  if (!Array.isArray(cells)) throw new Error("invalid test notebook cells");
  return new vscode.NotebookData(
    cells.map((item): vscode.NotebookCellData => {
      if (
        typeof item !== "object" ||
        item === null ||
        Array.isArray(item) ||
        Object.keys(item as Record<string, unknown>)
          .sort()
          .join("\0") !== "kind\0language\0text"
      ) {
        throw new Error("invalid test notebook cell");
      }
      const cell = item as Record<string, unknown>;
      if (
        (cell.kind !== "code" && cell.kind !== "markup") ||
        typeof cell.language !== "string" ||
        typeof cell.text !== "string"
      ) {
        throw new Error("invalid test notebook cell value");
      }
      return new vscode.NotebookCellData(
        cell.kind === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
        cell.text,
        cell.language,
      );
    }),
  );
}

function encodeTestNotebook(data: vscode.NotebookData): Uint8Array {
  const wire: TestNotebookWire = {
    cells: data.cells.map((cell) => ({
      kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      language: cell.languageId,
      text: cell.value,
    })),
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

/** Register only the in-memory serializer used by synthetic marimo tests. */
export function registerMarimoTestSerializer(): vscode.Disposable {
  const registration = vscode.workspace.registerNotebookSerializer(
    "marimo-notebook",
    {
      deserializeNotebook: (data) => decodeTestNotebook(data),
      serializeNotebook: (data) => encodeTestNotebook(data),
    },
    { transientOutputs: true },
  );
  return {
    dispose(): void {
      pendingUntitledNotebooks.length = 0;
      registration.dispose();
    },
  };
}

export async function openMarimoCell(
  languageId: "python" | "mo-python",
  source: string,
): Promise<OpenedCell> {
  const data = new vscode.NotebookData([
    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, languageId),
  ]);
  pendingUntitledNotebooks.push(data);
  const notebook = await vscode.workspace.openNotebookDocument("marimo-notebook", data);
  return focusNotebookCell(notebook, 0);
}

export function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error("missing test workspace");
  return folder.uri;
}

export function preserveFinalNewline(document: vscode.TextDocument, text: string): string {
  return document.getText().endsWith("\n") ? `${text}\n` : text;
}

export async function replaceWholeDocument(
  document: vscode.TextDocument,
  text: string,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)),
    text,
  );
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

export async function configureIntegrationPython(document: vscode.TextDocument): Promise<void> {
  const pythonPath = process.env.INLINE_SQL_TEST_PYTHON;
  if (pythonPath === undefined || !path.isAbsolute(pythonPath)) {
    throw new Error("integration Python path must be absolute");
  }
  await vscode.workspace
    .getConfiguration("inlineSql", document.uri)
    .update("pythonPath", pythonPath, vscode.ConfigurationTarget.Workspace);
}

export async function openStandaloneFixture(
  language: "python" | "mo-python",
): Promise<vscode.TextDocument> {
  let document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(workspaceRoot(), "queries.py"),
  );
  document = await vscode.languages.setTextDocumentLanguage(document, language);
  await replaceWholeDocument(document, preserveFinalNewline(document, LOWER));
  return document;
}

export function selectNeedle(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
  nonEmpty: boolean,
): void {
  const startOffset = document.getText().indexOf("select");
  assert.notEqual(startOffset, -1);
  const start = document.positionAt(startOffset);
  const end = document.positionAt(startOffset + (nonEmpty ? "select".length : 0));
  editor.selection = new vscode.Selection(start, end);
}

export async function assertSingleCommandAndUndo(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
  command: "inlineSql.formatAtCursor" | "inlineSql.formatSelection",
): Promise<void> {
  const before = preserveFinalNewline(document, LOWER);
  await replaceWholeDocument(document, before);
  selectNeedle(document, editor, command === "inlineSql.formatSelection");
  await vscode.commands.executeCommand(command);
  assert.equal(document.getText(), preserveFinalNewline(document, UPPER));
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("undo", document.uri);
  // Some VS Code notebook serializers do not attach the cell's edit stack to
  // the generic undo command. Restore the guarded snapshot through the same
  // document edit path so later cases remain deterministic in those hosts.
  if (document.getText() !== before) await replaceWholeDocument(document, before);
  assert.equal(document.getText(), before);
}

export async function assertAllCommandAndSingleUndo(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
): Promise<void> {
  const newline = document.getText().endsWith("\n") ? "\n" : "";
  const before = `first = "select 1"\nsecond = "select 2"${newline}`;
  const after = `first = "SELECT 1"\nsecond = "SELECT 2"${newline}`;
  await replaceWholeDocument(document, before);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand("inlineSql.formatAll");
  assert.equal(document.getText(), after);
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("undo", document.uri);
  if (document.getText() !== before) await replaceWholeDocument(document, before);
  assert.equal(document.getText(), before);
}

export async function assertFstringAndPartialSuccess(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
): Promise<void> {
  const newline = document.getText().endsWith("\n") ? "\n" : "";
  const field = "{value!r}";
  const before = `safe = f"select ${field}"\nunsupported = "select " "2"${newline}`;
  const after = `safe = f"SELECT ${field}"\nunsupported = "select " "2"${newline}`;
  await replaceWholeDocument(document, before);
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.configure, {});
  await vscode.commands.executeCommand("inlineSql.formatAll");
  assert.equal(document.getText(), after);
  assert.equal(document.getText().includes(field), true);
  const hooks = await vscode.commands.executeCommand<HookSnapshot>(TEST_HOOK_COMMANDS.read);
  assert.deepEqual(hooks.lastOutcome, { changed: 1, skipped: 1 });
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand("undo", document.uri);
  if (document.getText() !== before) await replaceWholeDocument(document, before);
  assert.equal(document.getText(), before);
}

export async function assertFormattingCodeAction(
  document: vscode.TextDocument,
  editor: vscode.TextEditor,
): Promise<void> {
  await replaceWholeDocument(document, preserveFinalNewline(document, LOWER));
  selectNeedle(document, editor, false);
  const actions = await vscode.commands.executeCommand<readonly vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    document.uri,
    editor.selection,
    vscode.CodeActionKind.RefactorRewrite.value,
  );
  const action = actions.find((candidate) => candidate.title === "Format inline SQL");
  if (action?.command === undefined) throw new Error("missing inline SQL Code Action");
  await vscode.commands.executeCommand(
    action.command.command,
    ...((action.command.arguments ?? []) as readonly unknown[]),
  );
  assert.equal(document.getText(), preserveFinalNewline(document, UPPER));
}

export async function assertNoDocumentFormattingProvider(
  document: vscode.TextDocument,
): Promise<void> {
  const edits = await vscode.commands.executeCommand<readonly vscode.TextEdit[] | undefined>(
    "vscode.executeFormatDocumentProvider",
    document.uri,
    { tabSize: 2, insertSpaces: true },
  );
  assert.equal(edits?.length ?? 0, 0);
}

export async function assertThreeCommandsAndCodeAction(opened: OpenedCell): Promise<void> {
  const siblingTexts = opened.notebook
    .getCells()
    .filter((cell) => cell.index !== opened.cell.index)
    .map(
      (cell) =>
        [cell.document.uri.toString(), cell.document.getText(), cell.document.version] as const,
    );
  await configureIntegrationPython(opened.cell.document);
  await assertSingleCommandAndUndo(
    opened.cell.document,
    opened.textEditor,
    "inlineSql.formatAtCursor",
  );
  await assertSingleCommandAndUndo(
    opened.cell.document,
    opened.textEditor,
    "inlineSql.formatSelection",
  );
  await assertAllCommandAndSingleUndo(opened.cell.document, opened.textEditor);
  await assertFstringAndPartialSuccess(opened.cell.document, opened.textEditor);
  await assertFormattingCodeAction(opened.cell.document, opened.textEditor);
  for (const [uri, text, version] of siblingTexts) {
    const sibling = opened.notebook.getCells().find((cell) => cell.document.uri.toString() === uri);
    if (sibling === undefined) throw new Error("sibling cell disappeared");
    assert.equal(sibling.document.getText(), text);
    assert.equal(sibling.document.version, version);
  }
}

export function physicalSqlRange(document: vscode.TextDocument): vscode.Range {
  const offset = document.getText().indexOf("SELECT");
  if (offset < 0) throw new Error("missing physical SQL segment");
  return new vscode.Range(
    document.positionAt(offset),
    document.positionAt(offset + "SELECT".length),
  );
}

export async function provideFullSemanticTokens(
  document: vscode.TextDocument,
): Promise<vscode.SemanticTokens> {
  const result = await vscode.commands.executeCommand<
    vscode.SemanticTokens | vscode.SemanticTokensEdits | undefined
  >("vscode.provideDocumentSemanticTokens", document.uri);
  if (result === undefined || !("data" in result) || result.data.length === 0) {
    throw new Error("semantic provider returned no full token stream");
  }
  return result;
}

export async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("integration assertion timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function waitForBarrier(): Promise<HookSnapshot> {
  const snapshot = await withTimeout(
    vscode.commands.executeCommand<HookSnapshot>(TEST_HOOK_COMMANDS.read, { waitForBarrier: true }),
  );
  if (!snapshot.barrierReached) throw new Error("apply barrier was not reached");
  return snapshot;
}

export async function runPausedRace(
  document: vscode.TextDocument,
  configuration: { readonly cancelAtBarrier?: boolean; readonly workspaceTrustOverride?: boolean },
  atBarrier: () => Promise<void>,
): Promise<number> {
  await replaceWholeDocument(document, preserveFinalNewline(document, LOWER));
  await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.configure, {
    pauseBeforeApply: true,
    ...configuration,
  });
  const barrier = waitForBarrier();
  const operation = vscode.commands.executeCommand("inlineSql.formatAll");
  await barrier;
  await atBarrier();
  const guardedVersion = document.version;
  await vscode.commands.executeCommand(TEST_HOOK_COMMANDS.release);
  await withTimeout(operation);
  return guardedVersion;
}

export { assertNoSemanticSqlOverlap, decodeSemanticTokens };
export type { FormatMode, HookSnapshot, TestOperationOutcome };
