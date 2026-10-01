import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type {
  FormatEdit,
  FormatMode,
  FormatOptions,
  FormatSuccess,
  FormatSummary,
  FormatTarget,
  Position,
  ReasonCode,
} from "../protocol.js";
import {
  allocateNonce,
  formatDocument,
  MAX_DOCUMENT_BYTES,
  ResourceLimitError,
} from "../python-analysis/engine.js";
import { PositionMappingError } from "../python-analysis/positions.js";
import { formatProtectedSql } from "../sql-formatter.js";
import { readFormatOptions } from "./configuration.js";
import {
  resolveActiveEditorTarget,
  resolveEditorTarget,
  type TargetResolution,
} from "./document-target.js";
import {
  DefaultEditApplicator,
  type DocumentEdits,
  type DocumentSnapshot,
  type EditApplicator,
} from "./edit-applicator.js";
import {
  createNotifications,
  type NotificationSink,
  type TargetReasonCode,
} from "./notifications.js";
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

/** Format one source text behind the shared safety checks. */
function formatText(
  text: string,
  options: FormatOptions,
  target: FormatTarget,
  logger: ((message: string) => void) | undefined,
): {
  readonly edits: readonly FormatEdit[];
  readonly summary: FormatSummary;
  readonly skipReasons: readonly ReasonCode[];
} {
  const nonce = allocateNonce(text, () => randomBytes(16).toString("hex"));
  const result = formatDocument(
    text,
    options,
    target,
    nonce,
    (sql, formatterOptions) => formatProtectedSql(sql, formatterOptions.options),
    logger,
  );
  return {
    edits: result.edits.map((edit) => ({
      range: result.sourceMap.vscodeRange(edit.sourceSpan),
      expectedText: edit.expectedText,
      newText: edit.replacementText,
    })),
    summary: result.summary,
    skipReasons: [...result.skipReasons],
  };
}

export class DefaultFormatController implements FormatController {
  private readonly applicator: EditApplicator;
  private readonly notifications: NotificationSink;
  private readonly logger: ((message: string) => void) | undefined;

  constructor(private readonly dependencies: FormatControllerDependencies) {
    this.applicator =
      dependencies.applicator ??
      new DefaultEditApplicator({
        applyWorkspaceEdit: (edit) => dependencies.hooks.applyWorkspaceEdit(edit),
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
    cancelOperation: () => void,
  ): Promise<void> {
    const entries: DocumentEdits[] = [];
    const totals = { discovered: 0, selected: 0, changed: 0, unchanged: 0, skipped: 0 };
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
      const document = cell.document;
      const text = document.getText();
      let formatted: ReturnType<typeof formatText>;
      try {
        formatted = formatText(text, options, { mode: "all" }, this.logger);
      } catch (error) {
        if (error instanceof PositionMappingError) {
          this.notifyReason("PROTOCOL_ERROR");
          return;
        }
        totals.skipped++;
        skipReasons.push(
          error instanceof ResourceLimitError ? "RESOURCE_LIMIT_EXCEEDED" : "PROCESS_FAILED",
        );
        continue;
      }
      totals.discovered += formatted.summary.discovered;
      totals.selected += formatted.summary.selected;
      totals.changed += formatted.summary.changed;
      totals.unchanged += formatted.summary.unchanged;
      totals.skipped += formatted.summary.skipped;
      skipReasons.push(...formatted.skipReasons);
      if (formatted.edits.length > 0) {
        entries.push({
          document,
          snapshot: { uri: document.uri, version: document.version, text },
          response: { edits: formatted.edits, summary: formatted.summary },
        });
      }
    }
    await this.dependencies.hooks.afterHelperResponse(cancelOperation);
    if (totals.selected === 0 && totals.skipped === 0) {
      this.notifyReason("NO_SQL_CANDIDATE");
      return;
    }
    if (entries.length === 0) {
      this.complete({ changed: 0, skipped: totals.skipped });
      this.notifications.summary(totals, totals.skipped, skipReasons);
      return;
    }
    // Same guarded path as a single document: every cell is re-checked against
    // its snapshot, then cancellation and trust right before one WorkspaceEdit.
    const outcome = await this.applicator.applyAll(entries, {
      token,
      isWorkspaceTrusted: () =>
        this.dependencies.hooks.isWorkspaceTrusted(vscode.workspace.isTrusted),
    });
    if (!outcome.ok) {
      this.notifyReason(outcome.reason);
      return;
    }
    this.complete({ changed: totals.changed, skipped: totals.skipped });
    if (totals.skipped > 0) {
      this.notifications.summary(totals, totals.skipped, skipReasons);
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
      await this.formatAllCells(resource.notebook, options.options, token, cancelOperation);
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
      const result = formatText(text, options.options, protocol, this.logger);
      skipReasons = result.skipReasons;
      formatted = { edits: result.edits, summary: result.summary };
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        this.notifyReason("RESOURCE_LIMIT_EXCEEDED");
        return;
      }
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
