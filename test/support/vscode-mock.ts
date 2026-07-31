/* A deliberately small, resettable Extension Host surface for Node unit tests. */
import type * as vscode from "vscode";

type Listener<T> = (value: T) => unknown;

class MockUri implements vscode.Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  private constructor(
    scheme: string,
    authority: string,
    path: string,
    query = "",
    fragment = "",
  ) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  static parse(value: string): MockUri {
    const match = /^([^:]+):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (match === null) return new MockUri("", "", value);
    return new MockUri(match[1] ?? "", match[2] ?? "", match[3] ?? "", match[4] ?? "", match[5] ?? "");
  }

  static file(path: string): MockUri {
    return new MockUri("file", "", path.startsWith("/") ? path : `/${path}`);
  }

  static joinPath(uri: MockUri, ...pathSegments: string[]): MockUri {
    return new MockUri(uri.scheme, uri.authority, `${uri.path.replace(/\/$/, "")}/${pathSegments.join("/")}`);
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): MockUri {
    return new MockUri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(skipEncoding = false): string {
    void skipEncoding;
    const authority = this.authority === "" && (this.scheme === "file" || this.scheme === "vscode-notebook-cell") ? "//" : this.authority === "" ? "" : `//${this.authority}`;
    return `${this.scheme}:${authority}${this.path}${this.query === "" ? "" : `?${this.query}`}${this.fragment === "" ? "" : `#${this.fragment}`}`;
  }

  toJSON(): string {
    return this.toString();
  }

  get fsPath(): string {
    return this.path;
  }
}

export const Uri = MockUri;

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}

  isEqual(other: vscode.Position): boolean {
    return this.line === other.line && this.character === other.character;
  }
  isBefore(other: vscode.Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character);
  }
  isBeforeOrEqual(other: vscode.Position): boolean {
    return this.isBefore(other) || this.isEqual(other);
  }
  isAfter(other: vscode.Position): boolean {
    return !this.isBeforeOrEqual(other);
  }
  isAfterOrEqual(other: vscode.Position): boolean {
    return !this.isBefore(other);
  }
  compareTo(other: vscode.Position): number {
    return this.isEqual(other) ? 0 : this.isBefore(other) ? -1 : 1;
  }
  translate(lineDelta?: number, characterDelta?: number): Position;
  translate(change: { lineDelta?: number; characterDelta?: number }): Position;
  translate(lineOrChange?: number | { lineDelta?: number; characterDelta?: number }, characterDelta = 0): Position {
    if (typeof lineOrChange === "number" || lineOrChange === undefined) return new Position(this.line + (lineOrChange ?? 0), this.character + characterDelta);
    return new Position(this.line + (lineOrChange.lineDelta ?? 0), this.character + (lineOrChange.characterDelta ?? 0));
  }
  with(line?: number, character?: number): Position;
  with(change: { line?: number; character?: number }): Position;
  with(lineOrChange?: number | { line?: number; character?: number }, character?: number): Position {
    if (typeof lineOrChange === "number") return new Position(lineOrChange, character ?? this.character);
    if (lineOrChange === undefined) return new Position(this.line, this.character);
    return new Position(lineOrChange.line ?? this.line, lineOrChange.character ?? this.character);
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  readonly isEmpty: boolean;
  readonly isSingleLine: boolean;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    this.start = typeof a === "number" ? new Position(a, b as number) : a;
    this.end = typeof a === "number" ? new Position(c ?? a, d ?? (b as number)) : (b as Position);
    this.isEmpty = this.start.isEqual(this.end);
    this.isSingleLine = this.start.line === this.end.line;
  }
  contains(positionOrRange: vscode.Position | vscode.Range): boolean {
    const start = "start" in positionOrRange ? positionOrRange.start : positionOrRange;
    const end = "end" in positionOrRange ? positionOrRange.end : positionOrRange;
    return this.start.isBeforeOrEqual(start) && this.end.isAfterOrEqual(end);
  }
  isEqual(other: vscode.Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }
  intersection(other: vscode.Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    return start.isAfter(end) ? undefined : new Range(start, end);
  }
  union(other: vscode.Range): Range {
    return new Range(this.start.isBefore(other.start) ? this.start : other.start, this.end.isAfter(other.end) ? this.end : other.end);
  }
  with(start?: Position, end?: Position): Range;
  with(change: { start?: Position; end?: Position }): Range;
  with(startOrChange?: Position | { start?: Position; end?: Position }, end?: Position): Range {
    if (startOrChange === undefined) return new Range(this.start, this.end);
    if (startOrChange instanceof Position) return new Range(startOrChange, end ?? this.end);
    return new Range(startOrChange.start ?? this.start, startOrChange.end ?? this.end);
  }
}

export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  readonly isReversed: boolean;
  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorCharacter: number, activeLine: number, activeCharacter: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const anchor = typeof a === "number" ? new Position(a, b as number) : a;
    const active = typeof a === "number" ? new Position(c ?? a, d ?? (b as number)) : (b as Position);
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
    this.isReversed = active.isBefore(anchor);
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  readonly event: vscode.Event<T> = (listener, thisArgs, disposables) => {
    const callback = thisArgs === undefined ? listener : listener.bind(thisArgs);
    this.listeners.add(callback);
    const disposable = { dispose: () => this.listeners.delete(callback) };
    disposables?.push(disposable);
    return disposable;
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  private readonly cancellationState = { cancelled: false };
  readonly token: vscode.CancellationToken;
  constructor() {
    const cancellationState = this.cancellationState;
    this.token = {
      get isCancellationRequested() { return cancellationState.cancelled; },
      onCancellationRequested: this.emitter.event,
    };
  }
  cancel(): void {
    if (!this.cancellationState.cancelled) {
      this.cancellationState.cancelled = true;
      this.emitter.fire(undefined);
    }
  }
  dispose(): void { this.emitter.dispose(); }
}

export class WorkspaceEdit {
  private readonly edits: vscode.TextEdit[] = [];
  replace(uri: vscode.Uri, range: vscode.Range, newText: string): boolean {
    this.edits.push({ range, newText });
    void uri;
    return true;
  }
  insert(uri: vscode.Uri, position: vscode.Position, newText: string): boolean { return this.replace(uri, new Range(position, position), newText); }
  delete(uri: vscode.Uri, range: vscode.Range): boolean { return this.replace(uri, range, ""); }
  set(uri: vscode.Uri, edits: readonly vscode.TextEdit[]): void { this.edits.push(...edits); void uri; }
  get(uri: vscode.Uri): vscode.TextEdit[] { void uri; return this.edits; }
  has(uri: vscode.Uri): boolean { void uri; return this.edits.length > 0; }
  entries(): [vscode.Uri, vscode.TextEdit[]][] { return []; }
  createFile(): never { return failUnimplemented("WorkspaceEdit.createFile"); }
  deleteFile(): never { return failUnimplemented("WorkspaceEdit.deleteFile"); }
  renameFile(): never { return failUnimplemented("WorkspaceEdit.renameFile"); }
}

export class CodeAction {
  isPreferred?: boolean;
  disabled?: { readonly reason: string };
  edit?: WorkspaceEdit;
  command?: vscode.Command;
  constructor(
    readonly title: string,
    readonly kind: CodeActionKind,
  ) {}
}

export class CodeActionKind {
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite");
  constructor(readonly value: string) {}
  contains(other: CodeActionKind): boolean { return other.value === this.value || other.value.startsWith(`${this.value}.`); }
  intersects(other: CodeActionKind): boolean { return this.contains(other) || other.contains(this); }
}

type MockTextDocument = vscode.TextDocument;

const state: {
  activeEditor: vscode.TextEditor | undefined;
  activeNotebook: vscode.NotebookEditor | undefined;
  notebooks: readonly vscode.NotebookDocument[];
  trusted: boolean;
  configurations: Map<string, Map<string, unknown>>;
  reads: Map<string, number>;
} = {
  activeEditor: undefined,
  activeNotebook: undefined,
  notebooks: [],
  trusted: true,
  configurations: new Map(),
  reads: new Map(),
};

function failUnimplemented(name: string): never {
  throw new Error(`vscode mock member is not implemented: ${name}`);
}

function uriKey(resource: vscode.Uri | undefined): string {
  return resource?.toString() ?? "";
}

function makeDocument(input: { uri: string; languageId: string; text?: string; version?: number }): vscode.TextDocument {
  const uri = MockUri.parse(input.uri);
  const text = input.text ?? "";
  const lines = text.split(/\r?\n/);
  const lineOffset = (line: number): number => lines.slice(0, line).reduce((sum, value) => sum + value.length + 1, 0);
  const document: MockTextDocument = {
    uri,
    fileName: uri.fsPath,
    isUntitled: false,
    version: input.version ?? 1,
    isDirty: false,
    isClosed: false,
    save: () => Promise.resolve(true),
    eol: 1,
    lineCount: lines.length,
    getText: (range?: vscode.Range) => range === undefined ? text : text.slice(offsetAt(range.start), offsetAt(range.end)),
    getWordRangeAtPosition: () => undefined,
    lineAt: (lineOrPosition: number | vscode.Position) => {
      const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
      const value = lines[line] ?? "";
      return { lineNumber: line, text: value, range: new Range(new Position(line, 0), new Position(line, value.length)), rangeIncludingLineBreak: new Range(new Position(line, 0), new Position(line + 1, 0)), firstNonWhitespaceCharacterIndex: value.search(/\S|$/), isEmptyOrWhitespace: /^\s*$/.test(value) };
    },
    offsetAt,
    positionAt,
    languageId: input.languageId,
  } as unknown as MockTextDocument;
  function offsetAt(position: vscode.Position): number {
    return lineOffset(position.line) + position.character;
  }
  function positionAt(offset: number): vscode.Position {
    let remaining = offset;
    for (let line = 0; line < lines.length; line += 1) {
      const length = lines[line]?.length ?? 0;
      if (remaining <= length) return new Position(line, Math.max(0, remaining));
      remaining -= length + 1;
    }
    return new Position(lines.length - 1, lines.at(-1)?.length ?? 0);
  }
  return document;
}

function getMockConfiguration(section: string, resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  const values = state.configurations.get(`${uriKey(resource)}\0${section}`);
  return {
    get(name: string): unknown {
      const key = `${section}.${name}`;
      state.reads.set(name, (state.reads.get(name) ?? 0) + 1);
      if (values?.has(name) === true) return values.get(name);
      return values?.get(key);
    },
    has(name: string): boolean { return values?.has(name) === true || values?.has(`${section}.${name}`) === true; },
    inspect: () => undefined,
    update: () => Promise.reject(new Error("vscode mock member is not implemented: WorkspaceConfiguration.update")),
  } as vscode.WorkspaceConfiguration;
}

const windowState = {
  onDidChangeActiveTextEditor: new EventEmitter<vscode.TextEditor | undefined>(),
};
const workspaceState = {
  onDidGrantWorkspaceTrust: new EventEmitter<void>(),
  onDidChangeConfiguration: new EventEmitter<vscode.ConfigurationChangeEvent>(),
};

export const window = new Proxy({}, {
  get(_target, property: string | symbol) {
    if (property === "activeTextEditor") return state.activeEditor;
    if (property === "activeNotebookEditor") return state.activeNotebook;
    if (property === "visibleTextEditors") return state.activeEditor === undefined ? [] : [state.activeEditor];
    if (property === "onDidChangeActiveTextEditor") return windowState.onDidChangeActiveTextEditor.event;
    return failUnimplemented(`window.${String(property)}`);
  },
}) as typeof vscode.window;

export const workspace = new Proxy({}, {
  get(_target, property: string | symbol) {
    if (property === "isTrusted") return state.trusted;
    if (property === "notebookDocuments") return state.notebooks;
    if (property === "getConfiguration") return getMockConfiguration;
    if (property === "onDidGrantWorkspaceTrust") return workspaceState.onDidGrantWorkspaceTrust.event;
    if (property === "onDidChangeConfiguration") return workspaceState.onDidChangeConfiguration.event;
    if (property === "applyEdit") return () => Promise.resolve(true);
    return failUnimplemented(`workspace.${String(property)}`);
  },
}) as typeof vscode.workspace;

export const languages = new Proxy({}, {
  get(_target, property: string | symbol) {
    if (property === "registerCodeActionsProvider") return () => ({ dispose() {} });
    return failUnimplemented(`languages.${String(property)}`);
  },
}) as typeof vscode.languages;

export const commands = new Proxy({}, {
  get(_target, property: string | symbol) {
    if (property === "registerCommand") return () => ({ dispose() {} });
    if (property === "executeCommand") return () => Promise.resolve(undefined);
    return failUnimplemented(`commands.${String(property)}`);
  },
}) as typeof vscode.commands;

export const ProgressLocation = { Notification: 15 } as typeof vscode.ProgressLocation;
export const ExtensionMode = { Test: 3 } as typeof vscode.ExtensionMode;

export interface VscodeMockControl {
  reset(): void;
  document(input: { readonly uri: string; readonly languageId: string; readonly text?: string; readonly version?: number }): vscode.TextDocument;
  editor(document: vscode.TextDocument): vscode.TextEditor;
  notebook(input: { readonly uri: string; readonly notebookType: string; readonly cells: readonly vscode.TextDocument[] }): vscode.NotebookDocument;
  setActiveEditor(editor: vscode.TextEditor | undefined): void;
  setActiveNotebook(notebook: vscode.NotebookDocument | undefined): void;
  setNotebookDocuments(notebooks: readonly vscode.NotebookDocument[]): void;
  setConfiguration(resource: vscode.Uri, key: string, value: unknown): void;
  configurationReads(key: string): number;
  setTrusted(trusted: boolean): void;
  fireTrustGrant(): void;
}

export const __mock: VscodeMockControl = {
  reset(): void {
    state.activeEditor = undefined;
    state.activeNotebook = undefined;
    state.notebooks = [];
    state.trusted = true;
    state.configurations.clear();
    state.reads.clear();
    windowState.onDidChangeActiveTextEditor.dispose();
    workspaceState.onDidGrantWorkspaceTrust.dispose();
    workspaceState.onDidChangeConfiguration.dispose();
  },
  document: makeDocument,
  editor(document) {
    return { document, selection: new Selection(0, 0, 0, 0), selections: [new Selection(0, 0, 0, 0)], visibleRanges: [], options: {}, viewColumn: undefined, edit: () => Promise.resolve(true), insertSnippet: () => Promise.resolve(true), setDecorations: () => undefined, revealRange: () => undefined, show: () => undefined, hide: () => undefined };
  },
  notebook(input) {
    const uri = MockUri.parse(input.uri);
    const cells = input.cells.map((document, index) => ({ document, index, kind: 2, outputs: [], metadata: {}, executionSummary: undefined, notebook: undefined, isDirty: false, isResolved: true, save: () => Promise.resolve(true) } as unknown as vscode.NotebookCell));
    const notebook: vscode.NotebookDocument = { uri, notebookType: input.notebookType, isUntitled: false, isDirty: false, isClosed: false, cellCount: cells.length, metadata: {}, getCells: () => cells, cellAt: (index: number) => cells[index], save: () => Promise.resolve(true), getCellRange: () => new Range(new Position(0, 0), new Position(cells.length, 0)) } as unknown as vscode.NotebookDocument;
    for (const cell of cells) (cell as { notebook?: vscode.NotebookDocument }).notebook = notebook;
    return notebook;
  },
  setActiveEditor(editor) { state.activeEditor = editor; windowState.onDidChangeActiveTextEditor.fire(editor); },
  setActiveNotebook(notebook) { state.activeNotebook = notebook === undefined ? undefined : { notebook, selection: new (class { start = 0; end = 0; isEmpty = true; })(), visibleRanges: [] } as unknown as vscode.NotebookEditor; },
  setNotebookDocuments(notebooks) { state.notebooks = notebooks; },
  setConfiguration(resource, key, value) {
    const configKey = `${uriKey(resource)}\0inlineSql`;
    let values = state.configurations.get(configKey);
    if (values === undefined) { values = new Map(); state.configurations.set(configKey, values); }
    values.set(key, value);
  },
  configurationReads(key) { return state.reads.get(key) ?? 0; },
  setTrusted(trusted) { state.trusted = trusted; },
  fireTrustGrant() { state.trusted = true; workspaceState.onDidGrantWorkspaceTrust.fire(undefined); },
};
