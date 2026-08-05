import * as vscode from "vscode";

import type { TextRange } from "../protocol.js";
import { discover, MAX_DOCUMENT_BYTES } from "../python-analysis/engine.js";
import { analyzeDocument } from "../python-analysis/literals.js";
import { COMMANDS } from "./commands.js";
import { readFormatOptions } from "./configuration.js";
import { INLINE_SQL_SELECTOR, resolveSupportedDocument } from "./document-target.js";
import { strictPosition } from "./edit-applicator.js";

export interface CodeActionDependencies {
  readonly isWorkspaceTrusted: () => boolean;
}

/**
 * Provides a lightweight refactor action. The action carries only a document
 * URI and requested range; formatting always obtains a fresh snapshot through
 * the shared command/controller pipeline when the user invokes it.
 */
export class InlineSqlCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.RefactorRewrite];

  constructor(private readonly dependencies: CodeActionDependencies) {}

  private locateCandidates(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): readonly TextRange[] | undefined {
    if (token.isCancellationRequested || !this.dependencies.isWorkspaceTrusted()) return undefined;

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

    const analysis = analyzeDocument(text);
    return discover(analysis).map((unit) => analysis.sourceMap.vscodeRange(unit.literal.span));
  }

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    _context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    const candidates = this.locateCandidates(document, token);
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

    if (malformed || !intersects || token.isCancellationRequested) {
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
