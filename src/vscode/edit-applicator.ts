import * as vscode from "vscode";

import type { FormatEdit, FormatSuccess } from "../protocol.js";
import type { DocumentSnapshot } from "./helper-client.js";

export type ApplyOutcome =
  | { readonly ok: true; readonly applied: number }
  | {
      readonly ok: false;
      readonly reason:
        | "DOCUMENT_CHANGED"
        | "APPLY_EDIT_FAILED"
        | "PROTOCOL_ERROR"
        | "PROCESS_CANCELLED"
        | "WORKSPACE_UNTRUSTED";
    };

export interface ApplyGuard {
  readonly token: vscode.CancellationToken;
  readonly isWorkspaceTrusted: () => boolean;
}

export interface EditApplicator {
  apply(
    document: vscode.TextDocument,
    snapshot: DocumentSnapshot,
    response: FormatSuccess,
    guard: ApplyGuard,
  ): Promise<ApplyOutcome>;
}

export interface EditApplicatorDependencies {
  readonly applyWorkspaceEdit?: (edit: vscode.WorkspaceEdit) => Thenable<boolean>;
}

interface ValidatedEdit {
  readonly range: vscode.Range;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly newText: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Convert a protocol position without using VS Code's clamping behavior.
 * Protocol positions are UTF-16 offsets, as required by the LSP/VS Code APIs.
 */
export function strictPosition(
  document: vscode.TextDocument,
  value: unknown,
): vscode.Position | undefined {
  const candidate = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(candidate.line) ||
    !Number.isSafeInteger(candidate.character) ||
    (candidate.line as number) < 0 ||
    (candidate.character as number) < 0 ||
    (candidate.line as number) >= document.lineCount
  ) {
    return undefined;
  }
  const lineNumber = candidate.line as number;
  const character = candidate.character as number;
  let line: vscode.TextLine;
  try {
    line = document.lineAt(lineNumber);
  } catch {
    return undefined;
  }
  if (character > line.text.length) return undefined;
  if (
    character > 0 &&
    character < line.text.length &&
    isHighSurrogate(line.text.charCodeAt(character - 1)) &&
    isLowSurrogate(line.text.charCodeAt(character))
  ) {
    return undefined;
  }
  return new vscode.Position(lineNumber, character);
}

function protocolEdit(value: unknown): value is FormatEdit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  if (typeof edit.expectedText !== "string" || edit.expectedText.length === 0) return false;
  if (typeof edit.newText !== "string") return false;
  const range = edit.range;
  if (typeof range !== "object" || range === null || Array.isArray(range)) return false;
  const rangeRecord = range as Record<string, unknown>;
  const start = rangeRecord.start;
  const end = rangeRecord.end;
  if (typeof start !== "object" || start === null || Array.isArray(start)) return false;
  if (typeof end !== "object" || end === null || Array.isArray(end)) return false;
  const position = (candidate: object): boolean => {
    const record = candidate as Record<string, unknown>;
    return (
      Number.isSafeInteger(record.line) &&
      Number.isSafeInteger(record.character) &&
      (record.line as number) >= 0 &&
      (record.character as number) >= 0
    );
  };
  return position(start) && position(end);
}

function validateEdits(
  document: vscode.TextDocument,
  snapshot: DocumentSnapshot,
  response: FormatSuccess,
): readonly ValidatedEdit[] | undefined {
  if (
    document.uri.toString() !== snapshot.uri.toString() ||
    document.version !== snapshot.version ||
    document.getText() !== snapshot.text
  ) {
    return undefined;
  }
  if (!Array.isArray(response.edits)) return undefined;
  const seen = new Set<string>();
  const validated: ValidatedEdit[] = [];
  for (const candidate of response.edits) {
    if (!protocolEdit(candidate)) return undefined;
    const edit = candidate;
    const start = strictPosition(document, edit.range.start);
    const end = strictPosition(document, edit.range.end);
    if (start === undefined || end === undefined || start.isAfterOrEqual(end)) {
      return undefined;
    }
    const range = new vscode.Range(start, end);
    const key = `${start.line}:${start.character}-${end.line}:${end.character}`;
    if (seen.has(key) || document.getText(range) !== edit.expectedText) return undefined;
    seen.add(key);
    validated.push({
      range,
      startOffset: document.offsetAt(start),
      endOffset: document.offsetAt(end),
      newText: edit.newText,
    });
  }
  validated.sort((left, right) => {
    const byStart = left.startOffset - right.startOffset;
    return byStart === 0 ? left.endOffset - right.endOffset : byStart;
  });
  for (let index = 1; index < validated.length; index += 1) {
    const previous = validated[index - 1];
    const current = validated[index];
    if (previous === undefined || current === undefined) return undefined;
    if (current.startOffset < previous.endOffset) return undefined;
  }
  return validated;
}

export class DefaultEditApplicator implements EditApplicator {
  private readonly applyWorkspaceEdit: (edit: vscode.WorkspaceEdit) => Thenable<boolean>;

  constructor(dependencies: EditApplicatorDependencies = {}) {
    this.applyWorkspaceEdit =
      dependencies.applyWorkspaceEdit ?? ((edit) => vscode.workspace.applyEdit(edit));
  }

  async apply(
    document: vscode.TextDocument,
    snapshot: DocumentSnapshot,
    response: FormatSuccess,
    guard: ApplyGuard,
  ): Promise<ApplyOutcome> {
    if (
      document.uri.toString() !== snapshot.uri.toString() ||
      document.version !== snapshot.version ||
      document.getText() !== snapshot.text
    ) {
      return { ok: false, reason: "DOCUMENT_CHANGED" };
    }
    const edits = validateEdits(document, snapshot, response);
    if (edits === undefined) return { ok: false, reason: "PROTOCOL_ERROR" };

    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      workspaceEdit.replace(snapshot.uri, edit.range, edit.newText);
    }
    // These checks intentionally sit immediately before applyWorkspaceEdit.  The
    // controller's barrier can cancel or revoke trust during all prior work.
    if (guard.token.isCancellationRequested) {
      return { ok: false, reason: "PROCESS_CANCELLED" };
    }
    if (!guard.isWorkspaceTrusted()) {
      return { ok: false, reason: "WORKSPACE_UNTRUSTED" };
    }
    try {
      const applied = await this.applyWorkspaceEdit(workspaceEdit);
      return applied
        ? { ok: true, applied: edits.length }
        : { ok: false, reason: "APPLY_EDIT_FAILED" };
    } catch {
      return { ok: false, reason: "APPLY_EDIT_FAILED" };
    }
  }
}

export function createEditApplicator(
  dependencies: EditApplicatorDependencies = {},
): EditApplicator {
  return new DefaultEditApplicator(dependencies);
}
