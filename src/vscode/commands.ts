import * as vscode from "vscode";

import type { FormatController, FormatInvocation } from "./format-controller.js";

export const COMMANDS = {
  cursor: "inlineSql.formatAtCursor",
  selection: "inlineSql.formatSelection",
  all: "inlineSql.formatAll",
} as const;

type CommandDisposable = vscode.Disposable;

function createCommandDisposables(controller: FormatController): readonly CommandDisposable[] {
  return [
    vscode.commands.registerCommand(COMMANDS.cursor, (invocation?: FormatInvocation) =>
      controller.execute("cursor", invocation),
    ),
    vscode.commands.registerCommand(COMMANDS.selection, (invocation?: FormatInvocation) =>
      controller.execute("selection", invocation),
    ),
    vscode.commands.registerCommand(COMMANDS.all, (invocation?: FormatInvocation) =>
      controller.execute("all", invocation),
    ),
  ];
}

/** Register only the three public commands contributed by the extension. */
export function registerCommands(
  context: vscode.ExtensionContext,
  controller: FormatController,
): void {
  context.subscriptions.push(...createCommandDisposables(controller));
}

/**
 * Activation uses this variant to own module state independently of VS Code's
 * context subscription lifecycle. The public registration function remains a
 * void API for callers that only need to add the disposables to a context.
 */
export function registerCommandsAndGetDisposables(
  context: vscode.ExtensionContext,
  controller: FormatController,
): readonly CommandDisposable[] {
  const registrations = createCommandDisposables(controller);
  context.subscriptions.push(...registrations);
  return registrations;
}
