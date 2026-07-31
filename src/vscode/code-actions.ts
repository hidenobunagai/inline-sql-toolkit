import * as vscode from "vscode";

import type { LocateResponse, TextRange } from "../protocol.js";
import { COMMANDS } from "./commands.js";
import { readFormatOptions } from "./configuration.js";
import { INLINE_SQL_SELECTOR, resolveSupportedDocument } from "./document-target.js";
import { strictPosition } from "./edit-applicator.js";
import type { DocumentSnapshot, HelperClient } from "./helper-client.js";

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

function cancellationRequested(token: vscode.CancellationToken): boolean {
  return token.isCancellationRequested;
}

export interface CodeActionDependencies {
  readonly helper: HelperClient;
  readonly isWorkspaceTrusted: () => boolean;
}

/** A bounded cache of completed locate results, keyed by URI and document version. */
export class LocateCache {
  private readonly values = new Map<string, readonly TextRange[]>();

  get(uri: vscode.Uri, version: number): readonly TextRange[] | undefined {
    return this.values.get(`${uri.toString()}\0${version}`);
  }

  set(uri: vscode.Uri, version: number, ranges: readonly TextRange[]): void {
    const key = `${uri.toString()}\0${version}`;
    this.values.delete(key);
    const frozen = ranges.map((range) =>
      Object.freeze({
        start: Object.freeze({ ...range.start }),
        end: Object.freeze({ ...range.end }),
      }),
    );
    this.values.set(key, Object.freeze(frozen));
    if (this.values.size > 32) {
      const oldest = this.values.keys().next().value;
      if (oldest !== undefined) this.values.delete(oldest);
    }
  }

  deleteUri(uri: vscode.Uri): void {
    const prefix = `${uri.toString()}\0`;
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key);
    }
  }

  clear(): void {
    this.values.clear();
  }
}

function isLocateResponse(value: unknown): value is LocateResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.protocolVersion !== 1 ||
    record.operation !== "locate" ||
    typeof record.ok !== "boolean"
  ) {
    return false;
  }
  if (record.ok) return Array.isArray(record.candidates);
  const error = record.error;
  return typeof error === "object" && error !== null && !Array.isArray(error);
}

function isCandidateShape(value: unknown): value is TextRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const start = record.start;
  const end = record.end;
  return (
    typeof start === "object" &&
    start !== null &&
    !Array.isArray(start) &&
    typeof end === "object" &&
    end !== null &&
    !Array.isArray(end)
  );
}

/**
 * Provides a lightweight refactor action. The action carries only a document
 * URI and requested range; formatting always obtains a fresh snapshot through
 * the shared command/controller pipeline when the user invokes it.
 */
export class InlineSqlCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.RefactorRewrite];

  private readonly cache: LocateCache;

  constructor(
    private readonly dependencies: CodeActionDependencies,
    cache = new LocateCache(),
  ) {
    this.cache = cache;
  }

  clearCache(uri?: vscode.Uri): void {
    if (uri === undefined) this.cache.clear();
    else this.cache.deleteUri(uri);
  }

  private async locateCandidates(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<readonly TextRange[] | undefined> {
    if (cancellationRequested(token) || !this.dependencies.isWorkspaceTrusted()) return undefined;

    let resource: ReturnType<typeof resolveSupportedDocument>;
    try {
      resource = resolveSupportedDocument(document, vscode.workspace.notebookDocuments);
    } catch {
      return undefined;
    }
    if (resource === undefined) return undefined;

    const options = readFormatOptions(resource.resourceUri);
    if (!options.ok) return undefined;
    const text = document.getText();
    if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) return undefined;

    const cached = this.cache.get(document.uri, document.version);
    if (cached !== undefined) return cached;

    const version = document.version;
    const snapshot: DocumentSnapshot = { uri: document.uri, version, text };
    let response: LocateResponse;
    try {
      response = await this.dependencies.helper.locate(
        snapshot,
        { mode: "all" },
        options.options,
        resource,
        token,
      );
    } catch {
      this.cache.deleteUri(document.uri);
      return undefined;
    }
    if (!isLocateResponse(response) || !response.ok) {
      this.cache.deleteUri(document.uri);
      return undefined;
    }
    if (
      cancellationRequested(token) ||
      document.version !== version ||
      !this.dependencies.isWorkspaceTrusted()
    ) {
      this.cache.deleteUri(document.uri);
      return undefined;
    }
    if (!response.candidates.every(isCandidateShape)) {
      this.cache.deleteUri(document.uri);
      return undefined;
    }
    this.cache.set(document.uri, version, response.candidates);
    return this.cache.get(document.uri, version);
  }

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    _context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[]> {
    const candidates = await this.locateCandidates(document, token);
    if (candidates === undefined) return [];

    let malformed = false;
    let intersects = false;
    for (const candidate of candidates) {
      const start = strictPosition(document, candidate.start);
      const end = strictPosition(document, candidate.end);
      if (start === undefined || end === undefined || start.isAfterOrEqual(end)) {
        malformed = true;
        continue;
      }
      const candidateRange = new vscode.Range(start, end);
      const hit = range.isEmpty
        ? !range.start.isBefore(candidateRange.start) && range.start.isBefore(candidateRange.end)
        : candidateRange.start.isBefore(range.end) && range.start.isBefore(candidateRange.end);
      if (hit) intersects = true;
    }

    if (malformed) this.cache.deleteUri(document.uri);
    if (
      malformed ||
      !intersects ||
      cancellationRequested(token) ||
      !this.dependencies.isWorkspaceTrusted()
    ) {
      return [];
    }

    const action = new vscode.CodeAction(
      "Format inline SQL",
      vscode.CodeActionKind.RefactorRewrite,
    );
    action.command = {
      title: "Format inline SQL",
      command: range.isEmpty ? COMMANDS.cursor : COMMANDS.selection,
      arguments: [{ documentUri: document.uri, range }],
    };
    return [action];
  }
}

export { INLINE_SQL_SELECTOR };
