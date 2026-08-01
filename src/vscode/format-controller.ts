import * as vscode from "vscode";

import { REASON_CODES } from "../constants.js";
import type {
  ErrorResponse,
  FinalizeItem,
  FormatMode,
  FormatResponse,
  FormatTarget,
  Position,
  ProtectResponse,
  ReasonCode,
} from "../protocol.js";
import { readFormatOptions } from "./configuration.js";
import {
  resolveActiveEditorTarget,
  resolveEditorTarget,
  type TargetResolution,
} from "./document-target.js";
import { DefaultEditApplicator, type EditApplicator } from "./edit-applicator.js";
import type { DocumentSnapshot, HelperClient } from "./helper-client.js";
import {
  createNotifications,
  type NotificationSink,
  type TargetReasonCode,
} from "./notifications.js";
import { formatProtectedSql } from "./sql-formatter.js";
import type { IntegrationTestHooks } from "./test-hooks.js";

function isFormatResponse(value: unknown): value is FormatResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.protocolVersion !== 1 ||
    record.operation !== "format" ||
    typeof record.ok !== "boolean"
  )
    return false;
  if (!record.ok) {
    const error = record.error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" && REASON_CODES.includes(code as ReasonCode);
  }
  if (!Array.isArray(record.edits) || !Array.isArray(record.skips)) return false;
  if (
    typeof record.summary !== "object" ||
    record.summary === null ||
    Array.isArray(record.summary)
  )
    return false;
  const summary = record.summary as Record<string, unknown>;
  return ["discovered", "selected", "changed", "unchanged", "skipped"].every(
    (key) => Number.isSafeInteger(summary[key]) && (summary[key] as number) >= 0,
  );
}

function isFinalizeResponse(value: unknown): value is FormatResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== 1 || typeof record.ok !== "boolean") return false;
  if (record.operation !== "finalize" && record.operation !== "format") return false;
  return isFormatResponse({ ...record, operation: "format" });
}

function isProtectResponse(value: unknown): value is ProtectResponse | ErrorResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== 1 || record.operation !== "protect") return false;
  if (record.ok === false) {
    const error = record.error;
    if (typeof error !== "object" || error === null || Array.isArray(error)) return false;
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" && REASON_CODES.includes(code as ReasonCode);
  }
  return record.ok === true && typeof record.nonce === "string" && Array.isArray(record.candidates);
}

export interface FormatInvocation {
  readonly documentUri?: vscode.Uri;
  readonly range?: vscode.Range;
}

export interface FormatController {
  execute(mode: FormatMode, invocation?: FormatInvocation): Promise<void>;
}

export interface FormatControllerDependencies {
  readonly helper: HelperClient;
  readonly applicator?: EditApplicator;
  readonly hooks: IntegrationTestHooks;
  readonly notifications?: NotificationSink;
}

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

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

export class DefaultFormatController implements FormatController {
  private readonly applicator: EditApplicator;
  private readonly notifications: NotificationSink;

  constructor(private readonly dependencies: FormatControllerDependencies) {
    this.applicator =
      dependencies.applicator ??
      new DefaultEditApplicator({
        applyWorkspaceEdit: dependencies.hooks.applyWorkspaceEdit,
      });
    this.notifications = dependencies.notifications ?? createNotifications();
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

    let protectResponse: unknown;
    try {
      protectResponse = await this.dependencies.helper.protect(
        snapshot,
        protocol,
        options.options,
        resource,
        token,
      );
    } catch {
      this.notifyReason("PROCESS_FAILED");
      return;
    }
    await this.dependencies.hooks.afterHelperResponse(cancelOperation);
    if (!isProtectResponse(protectResponse)) {
      this.notifyReason("PROTOCOL_ERROR");
      return;
    }
    if (!protectResponse.ok) {
      this.notifyReason(protectResponse.error.code);
      return;
    }
    const formatted: FinalizeItem[] = [];
    for (const candidate of protectResponse.candidates) {
      if (token.isCancellationRequested) {
        this.notifyReason("PROCESS_CANCELLED");
        return;
      }
      const first = formatProtectedSql(candidate.sql, options.options);
      const collapsed = candidate.singleLine ? first.replace(/\s*\n\s*/g, " ").trim() : first;
      const second = formatProtectedSql(collapsed, options.options);
      const secondCollapsed = candidate.singleLine
        ? second.replace(/\s*\n\s*/g, " ").trim()
        : second;
      if (collapsed !== secondCollapsed) {
        this.complete({ changed: 0, skipped: 1 });
        continue;
      }
      formatted.push({ range: candidate.range, sql: collapsed });
    }

    let response: unknown;
    try {
      response = await this.dependencies.helper.finalize(
        snapshot,
        protectResponse.nonce,
        formatted,
        options.options,
        resource,
        token,
      );
    } catch {
      this.notifyReason("PROCESS_FAILED");
      return;
    }
    await this.dependencies.hooks.afterHelperResponse(cancelOperation);
    if (!isFinalizeResponse(response)) {
      this.notifyReason("PROTOCOL_ERROR");
      return;
    }
    if (!response.ok) {
      this.notifyReason(response.error.code);
      return;
    }
    const totalSkipped = protectResponse.skipped + response.summary.skipped;
    if (response.edits.length === 0) {
      this.complete({
        changed: response.summary.changed,
        skipped: totalSkipped,
      });
      this.notifications.summary(response.summary, totalSkipped);
      return;
    }
    const outcome = await this.applicator.apply(resource.document, snapshot, response, {
      token,
      isWorkspaceTrusted: () =>
        this.dependencies.hooks.isWorkspaceTrusted(vscode.workspace.isTrusted),
    });
    if (!outcome.ok) {
      this.notifyReason(outcome.reason);
      return;
    }
    this.complete({
      changed: response.summary.changed,
      skipped: totalSkipped,
    });
    if (totalSkipped > 0) {
      this.notifications.summary(response.summary, totalSkipped);
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
      windowWithProgress = (
        vscode.window as unknown as {
          withProgress?: typeof vscode.window.withProgress;
        }
      ).withProgress;
    } catch {
      // The unit-test host intentionally omits optional progress UI members.
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

export function createFormatController(
  dependencies: FormatControllerDependencies,
): FormatController {
  return new DefaultFormatController(dependencies);
}
