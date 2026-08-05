import * as vscode from "vscode";

import type { FormatController, FormatInvocation } from "./format-controller.js";

export const COMMANDS = {
  cursor: "inlineSql.formatAtCursor",
  selection: "inlineSql.formatSelection",
  all: "inlineSql.formatAll",
} as const;

/** Register only the three public commands contributed by the extension. */
export function registerCommandsAndGetDisposables(
  controller: FormatController,
): readonly vscode.Disposable[] {
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
