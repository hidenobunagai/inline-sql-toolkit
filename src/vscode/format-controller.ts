import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type {
  FormatMode,
  FormatOptions,
  FormatSuccess,
  FormatTarget,
  Position,
  ReasonCode,
  TextRange,
} from "../protocol.js";
import { allocateNonce, formatDocument, MAX_DOCUMENT_BYTES } from "../python-analysis/engine.js";
import { PositionMappingError } from "../python-analysis/positions.js";
import { readFormatOptions } from "./configuration.js";
import {
  resolveActiveEditorTarget,
  resolveEditorTarget,
  type TargetResolution,
} from "./document-target.js";
import {
  DefaultEditApplicator,
  type DocumentSnapshot,
  type EditApplicator,
} from "./edit-applicator.js";
import {
  createNotifications,
  type NotificationSink,
  type TargetReasonCode,
} from "./notifications.js";
import { formatProtectedSql } from "./sql-formatter.js";
import type { IntegrationTestHooks } from "./test-hooks.js";

export interface FormatInvocation {
  readonly documentUri?: vscode.Uri;
  readonly range?: vscode.Range;
}

export interface FormatController {
  execute(mode: FormatMode, invocation?: FormatInvocation): Promise<void>;
}

export interface FormatControllerDependencies {
  readonly applicator?: EditApplicator;
  readonly hooks: IntegrationTestHooks;
  readonly notifications?: NotificationSink;
  readonly debugChannel?: vscode.OutputChannel;
}

export type InvocationTargetResolution = TargetResolution;

function isPositionWithinDocument(
  document: vscode.TextDocument,
  position: vscode.Position,
): boolean {
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.character < 0 ||
    position.line >= document.lineCount
  ) {
    return false;
  }
  try {
    return position.character <= document.lineAt(position.line).text.length;
  } catch {
    return false;
  }
}

function invocationRangeBelongsToDocument(
  document: vscode.TextDocument,
  range: vscode.Range,
): boolean {
  if (
    !isPositionWithinDocument(document, range.start) ||
    !isPositionWithinDocument(document, range.end)
  ) {
    return false;
  }
  return !range.start.isAfter(range.end);
}

/** Resolve a routed command without ever falling back to another editor. */
export function resolveInvocationOrActiveTarget(
  invocation?: FormatInvocation,
): InvocationTargetResolution {
  if (invocation?.documentUri === undefined) return resolveActiveEditorTarget();
  let editors: readonly vscode.TextEditor[];
  try {
    editors = vscode.window.visibleTextEditors;
  } catch {
    return { ok: false, reason: "NO_ACTIVE_EDITOR" };
  }
  const editor = editors.find(
    (candidate) => candidate.document.uri.toString() === invocation.documentUri?.toString(),
  );
  if (editor === undefined) return { ok: false, reason: "NO_ACTIVE_EDITOR" };
  if (
    invocation.range !== undefined &&
    !invocationRangeBelongsToDocument(editor.document, invocation.range)
  ) {
    return { ok: false, reason: "UNSUPPORTED_DOCUMENT" };
  }
  return resolveEditorTarget(editor);
}

function toProtocolPosition(position: vscode.Position): Position {
  return { line: position.line, character: position.character };
}

/** Build the helper target independently from execution and editor state. */
export function protocolTarget(
  mode: FormatMode,
  editor: vscode.TextEditor,
  invocation?: FormatInvocation,
): FormatTarget | undefined {
  if (mode === "all") return { mode: "all" };
  if (mode === "cursor") {
    const cursor = invocation?.range?.start ?? editor.selection.active;
    return { mode: "cursor", cursor: toProtocolPosition(cursor) };
  }
  const selected = invocation?.range ?? editor.selection;
  if (selected.isEmpty) return undefined;
  return {
    mode: "selection",
    selection: {
      start: toProtocolPosition(selected.start),
      end: toProtocolPosition(selected.end),
    },
  };
}

function toVscodeRange(range: TextRange): vscode.Range {
  return new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character),
  );
}

/** Collapse single-line literal output so Python syntax stays intact. */
function collapseReplacement(literalText: string, replacement: string): string {
  if (literalText.includes("\n")) return replacement;
  return replacement.replace(/\s*\n\s*/g, " ").trim();
}

export class DefaultFormatController implements FormatController {
  private readonly applicator: EditApplicator;
  private readonly notifications: NotificationSink;
  private readonly logger: ((message: string) => void) | undefined;

  constructor(private readonly dependencies: FormatControllerDependencies) {
    this.applicator =
      dependencies.applicator ??
      new DefaultEditApplicator({
        applyWorkspaceEdit: dependencies.hooks.applyWorkspaceEdit,
      });
    this.notifications = dependencies.notifications ?? createNotifications();
    const channel = dependencies.debugChannel;
    this.logger =
      channel === undefined
        ? undefined
        : (message) => {
            channel.appendLine(message);
          };
  }

  private complete(outcome: {
    readonly changed: number;
    readonly skipped: number;
    readonly reason?: ReasonCode;
  }): void {
    this.dependencies.hooks.operationCompleted(outcome);
  }

  private notifyReason(code: ReasonCode): void {
    this.complete({ changed: 0, skipped: 0, reason: code });
    this.notifications.reason(code);
  }

  private notifyTarget(code: TargetReasonCode): void {
    this.complete({ changed: 0, skipped: 0 });
    this.notifications.target(code);
  }

  private async formatAllCells(
    notebook: vscode.NotebookDocument,
    options: FormatOptions,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const edits = new vscode.WorkspaceEdit();
    let changed = 0;
    let skipped = 0;
    const skipReasons: ReasonCode[] = [];
    for (const cell of notebook.getCells()) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      if (cell.document.languageId !== "python" && cell.document.languageId !== "mo-python") {
        continue;
      }
      if (token.isCancellationRequested) {
        this.notifyReason("PROCESS_CANCELLED");
        return;
      }
      const text = cell.document.getText();
      if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
        skipped++;
        continue;
      }
      try {
        const nonce = allocateNonce(text, () => randomBytes(16).toString("hex"));
        const result = formatDocument(
          text,
          options,
          { mode: "all" },
          nonce,
          (sql, formatterOptions) => formatProtectedSql(sql, formatterOptions.options),
          this.logger,
        );
        for (const edit of result.edits) {
          const literalText = text.slice(edit.sourceSpan.start, edit.sourceSpan.end);
          edits.replace(
            cell.document.uri,
            toVscodeRange(result.sourceMap.vscodeRange(edit.sourceSpan)),
            collapseReplacement(literalText, edit.replacementText),
          );
        }
        changed += result.summary.changed;
        skipped += result.summary.skipped;
        skipReasons.push(...result.skipReasons);
      } catch (error) {
        if (error instanceof PositionMappingError) {
          this.notifyReason("PROTOCOL_ERROR");
          return;
        }
        skipped++;
      }
    }
    await this.dependencies.hooks.afterHelperResponse(() => {});
    if (changed === 0) {
      this.complete({ changed: 0, skipped });
      this.notifications.summary(
        { discovered: 0, selected: 0, changed: 0, unchanged: 0, skipped },
        skipped,
        skipReasons,
      );
      return;
    }
    const applied = await this.dependencies.hooks.applyWorkspaceEdit(edits);
    if (!applied) {
      this.notifyReason("APPLY_EDIT_FAILED");
      return;
    }
    this.complete({ changed, skipped });
    if (skipped > 0) {
      this.notifications.summary(
        { discovered: 0, selected: 0, changed, unchanged: 0, skipped },
        skipped,
        skipReasons,
      );
    }
  }

  private async runFormatting(
    mode: FormatMode,
    invocation: FormatInvocation | undefined,
    token: vscode.CancellationToken,
    cancelOperation: () => void,
  ): Promise<void> {
    if (!this.dependencies.hooks.isWorkspaceTrusted(vscode.workspace.isTrusted)) {
      this.notifyReason("WORKSPACE_UNTRUSTED");
      return;
    }
    const resolution = resolveInvocationOrActiveTarget(invocation);
    if (!resolution.ok) {
      this.notifyTarget(resolution.reason);
      return;
    }
    const { target: resource, editor } = resolution;
    const options = readFormatOptions(resource.resourceUri);
    if (!options.ok) {
      this.notifyReason(options.reason);
      return;
    }
    const protocol = protocolTarget(mode, editor, invocation);
    if (protocol === undefined) {
      this.complete({ changed: 0, skipped: 0 });
      this.notifications.emptySelection();
      return;
    }
    if (mode === "all" && resource.notebook !== undefined) {
      await this.formatAllCells(resource.notebook, options.options, token);
      return;
    }
    const text = resource.document.getText();
    if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) {
      this.notifyReason("RESOURCE_LIMIT_EXCEEDED");
      return;
    }
    const snapshot: DocumentSnapshot = {
      uri: resource.documentUri,
      version: resource.document.version,
      text,
    };

    let formatted: FormatSuccess;
    // eslint-disable-next-line no-useless-assignment
    let skipReasons: readonly ReasonCode[] = [];
    try {
      const nonce = allocateNonce(text, () => randomBytes(16).toString("hex"));
      const result = formatDocument(
        text,
        options.options,
        protocol,
        nonce,
        (sql, formatterOptions) => formatProtectedSql(sql, formatterOptions.options),
        this.logger,
      );
      skipReasons = result.skipReasons;
      formatted = {
        protocolVersion: 1,
        operation: "format",
        ok: true,
        edits: result.edits.map((edit) => {
          const literalText = text.slice(edit.sourceSpan.start, edit.sourceSpan.end);
          return {
            range: result.sourceMap.vscodeRange(edit.sourceSpan),
            expectedText: edit.expectedText,
            newText: collapseReplacement(literalText, edit.replacementText),
          };
        }),
        skips: [],
        summary: result.summary,
      };
    } catch (error) {
      if (error instanceof PositionMappingError) {
        this.notifyReason("PROTOCOL_ERROR");
        return;
      }
      this.notifyReason("PROCESS_FAILED");
      return;
    }
    await this.dependencies.hooks.afterHelperResponse(cancelOperation);

    if (formatted.summary.selected === 0) {
      this.notifyReason("NO_SQL_CANDIDATE");
      return;
    }
    const totalSkipped = formatted.summary.skipped;
    if (formatted.edits.length === 0) {
      this.complete({
        changed: formatted.summary.changed,
        skipped: totalSkipped,
      });
      this.notifications.summary(formatted.summary, totalSkipped, skipReasons);
      return;
    }
    const outcome = await this.applicator.apply(resource.document, snapshot, formatted, {
      token,
      isWorkspaceTrusted: () =>
        this.dependencies.hooks.isWorkspaceTrusted(vscode.workspace.isTrusted),
    });
    if (!outcome.ok) {
      this.notifyReason(outcome.reason);
      return;
    }
    this.complete({
      changed: formatted.summary.changed,
      skipped: totalSkipped,
    });
    if (totalSkipped > 0) {
      this.notifications.summary(formatted.summary, totalSkipped, skipReasons);
    }
  }

  async execute(mode: FormatMode, invocation?: FormatInvocation): Promise<void> {
    const run = async (progressToken?: vscode.CancellationToken): Promise<void> => {
      const operation = new vscode.CancellationTokenSource();
      const cancellation = progressToken?.onCancellationRequested(() => {
        operation.cancel();
      });
      try {
        await this.runFormatting(mode, invocation, operation.token, () => {
          operation.cancel();
        });
      } finally {
        cancellation?.dispose();
        operation.dispose();
      }
    };

    let windowWithProgress: typeof vscode.window.withProgress | undefined;
    try {
      windowWithProgress = (vscode.window as Partial<typeof vscode.window>).withProgress;
    } catch {
      // The unit-test host throws for optional progress UI members.
      windowWithProgress = undefined;
    }
    if (windowWithProgress === undefined) {
      await run();
      return;
    }
    await windowWithProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Formatting inline SQL",
        cancellable: true,
      },
      async (_progress, progressToken) => run(progressToken),
    );
  }
}
